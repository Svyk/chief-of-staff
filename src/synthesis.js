/**
 * Synthesis — periodic deterministic distillation of user corrections (#102 Phase 1).
 *
 * An idle-time task scans [[Chief of Staff/Corrections]], clusters repeated
 * corrections deterministically (no LLM), and PROPOSES durable memories in a
 * report on [[Chief of Staff/Synthesis]]. Also flags stale memory entries by
 * :edit/time (#72 memory decay, absorbed). Propose-only: this module never
 * writes to memory pages, never archives, never deletes.
 *
 * Design follows the two-phase curator pattern (Hermes Agent): Phase 1 here is
 * the deterministic pass; Phase 2 (opt-in LLM distillation of qualifying
 * clusters, writes behind approval) builds on this scaffold later.
 *
 * Module template: graph-hygiene.js — DI via initSynthesis(deps), pure
 * exported functions for everything testable, one idle-task processChunk,
 * module-state result exposed via getSynthesisResult().
 *
 * Gating: the idle task re-checks hourly, but real runs are spaced by a
 * PERSISTED lastRunAt setting (idle-scheduler's own lastRun map is in-memory
 * and resets on every Roam reload — useless for a weekly cadence). First-run
 * deferral: on first registration the gate seeds lastRunAt and does nothing,
 * so the user gets one full interval before the feature produces anything.
 */

// ── DI container ────────────────────────────────────────────────────────────
let deps = {};

export function initSynthesis(injected) {
  deps = injected || {};
}

// ── Constants ────────────────────────────────────────────────────────────────
export const SYNTHESIS_IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // gate re-check cadence
export const SYNTHESIS_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;   // real run spacing
export const SYNTHESIS_WINDOW_DAYS = 30;      // corrections older than this don't cluster
export const SYNTHESIS_CLUSTER_THRESHOLD = 3; // repeats needed to qualify
export const MEMORY_STALE_DAYS = 180;         // memory entries older than this get flagged
export const CORRECTIONS_OLD_DAYS = 90;       // corrections older than this are counted as archivable
export const JACCARD_COHESION_THRESHOLD = 0.4;

const SYNTHESIS_PAGE_TITLE = "Chief of Staff/Synthesis";
const CORRECTIONS_PAGE_TITLE = "Chief of Staff/Corrections";
const MEMORY_PAGE_TITLES = ["Chief of Staff/Memory", "Chief of Staff/Decisions", "Chief of Staff/Lessons Learned"];
const LAST_RUN_SETTINGS_KEY = "synthesis-last-run-at";
const FINGERPRINTS_SETTINGS_KEY = "synthesis-proposal-fingerprints";
const FINGERPRINT_MAX = 50;
const FINGERPRINT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
const REPORT_MARKER = "**Synthesis Report**";
const PIN_PATTERN = /#pinned\b|#\[\[COS Pinned\]\]/i;
const DESCRIPTION_PREFIX = "ℹ️";
const MAX_EVIDENCE_REFS = 5;
const MAX_STALE_PER_PAGE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Module state ─────────────────────────────────────────────────────────────
let synthesisResult = null;

export function getSynthesisResult() { return synthesisResult; }

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a Roam daily-note title ("March 30th, 2026") to epoch ms, or null.
 */
export function parseRoamDateTitle(title) {
  if (!title || typeof title !== "string") return null;
  const cleaned = title.replace(/(\d{1,2})(st|nd|rd|th)/, "$1");
  const ms = Date.parse(cleaned);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalise correction text for clustering: lowercase, strip the sanitised
 * ref chars correction-capture writes (⟦⟧⦃⦄), strip punctuation, collapse
 * whitespace.
 */
export function normaliseText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[⟦⟧⦃⦄]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(text) {
  const norm = normaliseText(text);
  return new Set(norm ? norm.split(" ") : []);
}

export function jaccard(setA, setB) {
  if (!setA.size && !setB.size) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

// ── Parse ────────────────────────────────────────────────────────────────────

// Format B (flat intent feedback) — checked first because it also bolds a "source":
//   [[date]] **intent-dismissed**: "prompt" — classified as: "intent" → user said: "override"
const INTENT_LINE_RE = /^\[\[(.+?)\]\]\s+\*\*intent-(dismissed|rejected|overridden)\*\*:\s+"(.*?)"(?:\s+—\s+classified as:\s+"(.*?)")?(?:\s+→\s+user said:\s+"(.*?)")?$/;

// Format A (diff-scan) header:  [[date]] **source** — 2 edits, 1 deletion
const DIFF_HEADER_RE = /^\[\[(.+?)\]\]\s+\*\*(.+?)\*\*\s+—\s+(.+)$/;

// Format A child:  edited ((uid)): "orig" → "new"   |   deleted ((uid)): "orig"
const DIFF_CHILD_RE = /^(edited|deleted)\s+\(\((.+?)\)\):\s+"(.*?)"(?:\s+→\s+"(.*)")?$/;

/**
 * Parse the Corrections page tree into flat correction records.
 * Input shape: [{ text, uid, children: [{ text, uid }] }] (top-level blocks).
 * Returns { records, skippedCount }. Description blocks (ℹ️ prefix) are
 * ignored silently; anything else unparseable is counted, not hidden.
 */
export function parseCorrectionEntries(topLevelBlocks) {
  const records = [];
  let skippedCount = 0;

  for (const block of topLevelBlocks || []) {
    const text = String(block?.text || "").trim();
    if (!text || text.startsWith(DESCRIPTION_PREFIX)) continue;

    const intentMatch = text.match(INTENT_LINE_RE);
    if (intentMatch) {
      const [, dateTitle, type, prompt, classifiedIntent, userOverride] = intentMatch;
      records.push({
        kind: "intent",
        type,
        dateTitle,
        dateMs: parseRoamDateTitle(dateTitle),
        uid: block.uid || "",
        prompt: prompt || "",
        classifiedIntent: classifiedIntent || "",
        userOverride: userOverride || ""
      });
      continue;
    }

    const headerMatch = text.match(DIFF_HEADER_RE);
    if (headerMatch) {
      const [, dateTitle, source] = headerMatch;
      const dateMs = parseRoamDateTitle(dateTitle);
      let parsedChildren = 0;
      for (const child of block.children || []) {
        const childMatch = String(child?.text || "").match(DIFF_CHILD_RE);
        if (!childMatch) { skippedCount++; continue; }
        const [, type, uid, original, current] = childMatch;
        records.push({
          kind: "diff",
          type,
          source,
          dateTitle,
          dateMs,
          uid,
          original: original || "",
          current: current || ""
        });
        parsedChildren++;
      }
      // A header with no parseable children is itself a skip
      if (parsedChildren === 0 && (block.children || []).length === 0) skippedCount++;
      continue;
    }

    skippedCount++;
  }

  return { records, skippedCount };
}

// ── Cluster ──────────────────────────────────────────────────────────────────

/**
 * Deterministically cluster correction records.
 * - intent records: key = intent:{type}:{normalised classified intent (or prompt)}
 * - diff records:   key = diff:{source}:{type}; within a cluster, a token-Jaccard
 *   sub-group of ≥ threshold members marks the cluster cohesive and yields a
 *   shared-token hint. Cohesion affects proposal WORDING, not qualification.
 * Only clusters with ≥ threshold members inside the window qualify.
 */
export function clusterCorrections(records, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : SYNTHESIS_WINDOW_DAYS;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : SYNTHESIS_CLUSTER_THRESHOLD;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const cutoff = nowMs - windowDays * DAY_MS;

  // Records with unparseable dates stay in-window (safer to over-include)
  const inWindow = (records || []).filter(r => r.dateMs === null || r.dateMs >= cutoff);

  const byKey = new Map();
  for (const r of inWindow) {
    const key = r.kind === "intent"
      ? `intent:${r.type}:${normaliseText(r.classifiedIntent || r.prompt)}`
      : `diff:${r.source}:${r.type}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const clusters = [];
  for (const [key, members] of byKey) {
    if (members.length < threshold) continue;

    const cluster = { key, kind: members[0].kind, type: members[0].type, members, count: members.length };

    if (cluster.kind === "intent") {
      cluster.classifiedIntent = members[0].classifiedIntent || "";
      // Shortest prompt is the cleanest exemplar of the misfiring phrasing
      cluster.samplePrompt = members
        .map(m => m.prompt).filter(Boolean)
        .sort((a, b) => a.length - b.length)[0] || "";
      cluster.userOverride = members.map(m => m.userOverride).find(Boolean) || "";
    } else {
      cluster.source = members[0].source;
      const sets = members.map(m => tokenSet(m.original));
      // Neighbour count at Jaccard ≥ threshold; a member with ≥ threshold-1
      // neighbours implies a cohesive sub-group of ≥ threshold members.
      let bestIdx = -1, bestNeighbours = -1;
      for (let i = 0; i < sets.length; i++) {
        let n = 0;
        for (let j = 0; j < sets.length; j++) {
          if (i !== j && jaccard(sets[i], sets[j]) >= JACCARD_COHESION_THRESHOLD) n++;
        }
        if (n > bestNeighbours) { bestNeighbours = n; bestIdx = i; }
      }
      cluster.cohesive = bestNeighbours >= threshold - 1;
      if (cluster.cohesive) {
        // Shared tokens across the cohesive sub-group (anchor member + neighbours)
        const group = [sets[bestIdx]];
        for (let j = 0; j < sets.length; j++) {
          if (j !== bestIdx && jaccard(sets[bestIdx], sets[j]) >= JACCARD_COHESION_THRESHOLD) group.push(sets[j]);
        }
        let shared = [...group[0]];
        for (const s of group.slice(1)) shared = shared.filter(t => s.has(t));
        cluster.sharedTokens = shared.slice(0, 6);
      }
    }

    clusters.push(cluster);
  }

  // Stable output order: biggest first, then key
  clusters.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
  return clusters;
}

// ── Propose ──────────────────────────────────────────────────────────────────

function earliestDateTitle(members) {
  let best = null;
  for (const m of members) {
    if (m.dateMs === null) continue;
    if (!best || m.dateMs < best.dateMs) best = m;
  }
  return best ? best.dateTitle : (members[0]?.dateTitle || "");
}

/**
 * Template-drafted proposals — no LLM. The non-cohesive branch is deliberately
 * honest: when the template can't say anything useful, it says so (drafting
 * insight from messy clusters is Phase 2's job).
 */
export function buildProposals(clusters) {
  return (clusters || []).map(c => {
    const since = earliestDateTitle(c.members);
    const sinceNote = since ? ` since ${since}` : "";
    let text;
    if (c.kind === "intent") {
      text = `Proposed memory: When I say something like "${c.samplePrompt}", do not treat it as "${c.classifiedIntent}".`;
      if (c.userOverride) text += ` Prefer: "${c.userOverride}".`;
    } else if (c.cohesive) {
      const hint = (c.sharedTokens || []).join(", ") || "(no shared tokens)";
      text = `Proposed memory: ${c.source} outputs are corrected repeatedly (${c.count}×${sinceNote}) — edits centre on: ${hint}. Consider a standing preference.`;
    } else {
      text = `Pattern only (no draft): ${c.source} outputs were corrected ${c.count}×${sinceNote}. Review the evidence for a common thread.`;
    }
    return {
      key: c.key,
      count: c.count,
      kind: c.kind,
      text,
      evidenceUids: c.members.map(m => m.uid).filter(Boolean).slice(0, MAX_EVIDENCE_REFS)
    };
  });
}

// ── Cross-run dedupe ─────────────────────────────────────────────────────────

/**
 * Suppress proposals already reported in a previous run, unless the cluster
 * has GROWN since (count changed → re-proposed with a grewFrom note).
 * Dismissal is doing nothing: an unchanged cluster never nags twice.
 *
 * Store shape: [{ key, count, at }]; entries expire after 90 days, capped at 50.
 * Returns { fresh, store } — caller persists the updated store.
 */
export function filterNewProposals(proposals, storedFingerprints, nowMs = Date.now()) {
  const valid = (Array.isArray(storedFingerprints) ? storedFingerprints : [])
    .filter(e => e && e.key && Number.isFinite(e.at) && nowMs - e.at < FINGERPRINT_EXPIRY_MS);

  const byKey = new Map(valid.map(e => [e.key, e]));
  const fresh = [];

  for (const p of proposals || []) {
    const existing = byKey.get(p.key);
    if (!existing) {
      fresh.push(p);
      byKey.set(p.key, { key: p.key, count: p.count, at: nowMs });
    } else if (existing.count !== p.count) {
      fresh.push({ ...p, grewFrom: existing.count });
      byKey.set(p.key, { key: p.key, count: p.count, at: nowMs });
    }
    // same key + same count → suppressed
  }

  let store = [...byKey.values()].sort((a, b) => b.at - a.at);
  if (store.length > FINGERPRINT_MAX) store = store.slice(0, FINGERPRINT_MAX);
  return { fresh, store };
}

// ── Memory staleness (#72) ───────────────────────────────────────────────────

export function isPinned(text) {
  return PIN_PATTERN.test(String(text || ""));
}

/**
 * Flag top-level memory-page entries not edited in staleDays. Pure over the
 * pulled entries: [{ uid, text, editTime, pageTitle }].
 */
export function flagStaleEntries(entries, opts = {}) {
  const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : MEMORY_STALE_DAYS;
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const cutoff = nowMs - staleDays * DAY_MS;

  const flagged = [];
  for (const e of entries || []) {
    const text = String(e?.text || "");
    if (!text || text.startsWith(DESCRIPTION_PREFIX)) continue;
    if (isPinned(text)) continue;
    if (!Number.isFinite(e.editTime) || e.editTime >= cutoff) continue;
    flagged.push({
      pageTitle: e.pageTitle,
      uid: e.uid,
      textPreview: text.slice(0, 80),
      ageDays: Math.floor((nowMs - e.editTime) / DAY_MS)
    });
  }
  return flagged;
}

// ── Report ───────────────────────────────────────────────────────────────────

function sanitise(text) {
  return String(text || "")
    .replace(/\[\[/g, "⟦").replace(/\]\]/g, "⟧")
    .replace(/\{\{/g, "⦃").replace(/\}\}/g, "⦄");
}

/**
 * Build the report as a block spec: { header, children: [{ text, children }] }.
 * Pure — persistence walks this.
 */
export function buildReportBlocks({ proposals, staleMemory, oldCorrectionsCount, scannedCount, skippedCount, dateRef }) {
  const p = proposals || [];
  const stale = staleMemory || [];
  const skippedNote = skippedCount ? `, ${skippedCount} skipped` : "";
  const header = `${dateRef} ${REPORT_MARKER} — ${p.length} proposal${p.length === 1 ? "" : "s"}, ${stale.length} stale memory candidate${stale.length === 1 ? "" : "s"} (${scannedCount} correction${scannedCount === 1 ? "" : "s"} scanned${skippedNote})`;

  const children = [];

  p.forEach((prop, i) => {
    const grewNote = prop.grewFrom ? ` (grew from ${prop.grewFrom} to ${prop.count})` : "";
    const node = { text: `**Proposal ${i + 1}**${grewNote} — ${sanitise(prop.text)}`, children: [] };
    if (prop.evidenceUids.length) {
      node.children.push({ text: `evidence: ${prop.evidenceUids.map(u => `((${u}))`).join(" ")}`, children: [] });
    }
    children.push(node);
  });

  if (stale.length) {
    const staleNode = {
      text: `**Stale memory candidates** — not edited in ${MEMORY_STALE_DAYS}+ days. Review, pin with #pinned, or delete. Synthesis never deletes.`,
      children: stale.map(s => ({
        text: `${sanitise(s.pageTitle)} ((${s.uid})) "${sanitise(s.textPreview)}" (${s.ageDays} days)`,
        children: []
      }))
    };
    children.push(staleNode);
  }

  if (oldCorrectionsCount > 0) {
    children.push({
      text: `Corrections older than ${CORRECTIONS_OLD_DAYS} days: ${oldCorrectionsCount} — consider archiving (manual; synthesis never deletes).`,
      children: []
    });
  }

  return { header, children };
}

// ── Roam access (deps-backed) ────────────────────────────────────────────────

function getQueryApi() {
  const api = deps.getRoamAlphaApi?.();
  if (!api?.data?.q) return null;
  return api.data;
}

function getPageUidByTitle(queryApi, title) {
  const escaped = title.replace(/"/g, '\\"');
  return queryApi.q(`[:find ?uid . :where [?p :node/title "${escaped}"] [?p :block/uid ?uid]]`) || null;
}

/**
 * Pull the Corrections page as [{ text, uid, children: [{ text, uid }] }].
 */
function pullCorrectionsTree(queryApi) {
  const pageUid = getPageUidByTitle(queryApi, CORRECTIONS_PAGE_TITLE);
  if (!pageUid) return [];
  const tree = queryApi.pull(
    "[{:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order]}]}]",
    [":block/uid", pageUid]
  );
  const top = tree?.[":block/children"] || [];
  return top
    .slice()
    .sort((a, b) => (a?.[":block/order"] || 0) - (b?.[":block/order"] || 0))
    .map(b => ({
      text: b?.[":block/string"] || "",
      uid: b?.[":block/uid"] || "",
      children: (b?.[":block/children"] || [])
        .slice()
        .sort((x, y) => (x?.[":block/order"] || 0) - (y?.[":block/order"] || 0))
        .map(c => ({ text: c?.[":block/string"] || "", uid: c?.[":block/uid"] || "" }))
    }));
}

/**
 * Pull top-level entries of one memory page: [{ uid, text, editTime, pageTitle }].
 */
function pullMemoryEntries(queryApi, pageTitle) {
  const pageUid = getPageUidByTitle(queryApi, pageTitle);
  if (!pageUid) return [];
  const tree = queryApi.pull(
    "[{:block/children [:block/uid :block/string :edit/time]}]",
    [":block/uid", pageUid]
  );
  return (tree?.[":block/children"] || []).map(b => ({
    uid: b?.[":block/uid"] || "",
    text: b?.[":block/string"] || "",
    editTime: b?.[":edit/time"],
    pageTitle
  }));
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Latest report supersedes the previous one (graph-hygiene pattern).
 */
async function removePreviousReports(pageUid) {
  try {
    const api = deps.getRoamAlphaApi?.();
    if (!api?.data?.q) return;
    const children = api.data.q(
      `[:find ?uid ?str :where [?p :block/uid "${pageUid}"] [?p :block/children ?b] [?b :block/uid ?uid] [?b :block/string ?str]]`
    );
    if (!Array.isArray(children)) return;
    for (const [uid, str] of children) {
      if (str && str.includes(REPORT_MARKER)) {
        await api.deleteBlock({ block: { uid } });
      }
    }
  } catch (err) {
    deps.debugLog?.("[Synthesis] removePreviousReports error (non-fatal):", err?.message);
  }
}

async function persistSynthesisReport(report) {
  const pageUid = await deps.ensurePageUidByTitle?.(SYNTHESIS_PAGE_TITLE);
  if (!pageUid) return;

  await removePreviousReports(pageUid);

  const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
  const headerUid = await deps.createRoamBlock?.(pageUid, report.header, insertOrder);
  if (!headerUid) return;

  for (const child of report.children) {
    const childUid = await deps.createRoamBlock?.(headerUid, child.text, "last");
    if (!childUid) continue;
    for (const grandchild of child.children || []) {
      await deps.createRoamBlock?.(childUid, grandchild.text, "last");
    }
  }
}

// ── Idle task ────────────────────────────────────────────────────────────────

export function initialSynthesisState() {
  return { phase: "gate", memPageIndex: 0, staleMemory: [], proposals: [], scannedCount: 0, skippedCount: 0, oldCorrectionsCount: 0 };
}

/**
 * Idle task processChunk (state machine, deadline-yielding):
 *   gate → corrections → memory (one page per iteration) → report → done
 *
 * The gate no-ops cheaply when under-interval — the idle task itself re-checks
 * hourly, real runs happen every SYNTHESIS_INTERVAL_MS.
 */
export function runSynthesisChunk(state, deadline) {
  let s = state && state.phase ? state : initialSynthesisState();

  while (deadline.timeRemaining() > 10) {
    if (s.phase === "gate") {
      const extensionAPI = deps.getExtensionAPIRef?.();
      if (!extensionAPI) return { state: initialSynthesisState(), done: true };

      const lastRun = extensionAPI.settings.get(LAST_RUN_SETTINGS_KEY);
      const lastRunMs = Number(lastRun);
      if (!Number.isFinite(lastRunMs) || lastRunMs <= 0) {
        // First-run deferral (curator pattern): seed and do nothing.
        extensionAPI.settings.set(LAST_RUN_SETTINGS_KEY, Date.now());
        deps.debugLog?.("[Synthesis] First run — deferred one full interval");
        return { state: initialSynthesisState(), done: true };
      }
      if (Date.now() - lastRunMs < SYNTHESIS_INTERVAL_MS) {
        return { state: initialSynthesisState(), done: true };
      }
      s.phase = "corrections";
      continue;
    }

    if (s.phase === "corrections") {
      const queryApi = getQueryApi();
      if (!queryApi) return { state: initialSynthesisState(), done: true };

      try {
        const tree = pullCorrectionsTree(queryApi);
        const { records, skippedCount } = parseCorrectionEntries(tree);
        const clusters = clusterCorrections(records);
        s.proposals = buildProposals(clusters);
        s.scannedCount = records.length;
        s.skippedCount = skippedCount;
        const oldCutoff = Date.now() - CORRECTIONS_OLD_DAYS * DAY_MS;
        s.oldCorrectionsCount = records.filter(r => r.dateMs !== null && r.dateMs < oldCutoff).length;
      } catch (err) {
        deps.debugLog?.("[Synthesis] Corrections scan error:", err?.message);
        s.proposals = [];
        s.scannedCount = 0;
        s.skippedCount = 0;
        s.oldCorrectionsCount = 0;
      }
      s.phase = "memory";
      continue;
    }

    if (s.phase === "memory") {
      if (s.memPageIndex >= MEMORY_PAGE_TITLES.length) {
        s.phase = "report";
        continue;
      }
      const queryApi = getQueryApi();
      if (!queryApi) { s.phase = "report"; continue; }
      const pageTitle = MEMORY_PAGE_TITLES[s.memPageIndex];
      s.memPageIndex++;
      try {
        const entries = pullMemoryEntries(queryApi, pageTitle);
        const flagged = flagStaleEntries(entries).slice(0, MAX_STALE_PER_PAGE);
        s.staleMemory.push(...flagged);
      } catch (err) {
        deps.debugLog?.("[Synthesis] Memory staleness error for", pageTitle, err?.message);
      }
      continue; // one page per loop iteration; deadline re-checked at top
    }

    if (s.phase === "report") {
      finaliseRun(s);
      return { state: initialSynthesisState(), done: true };
    }

    // Unknown phase — reset defensively
    return { state: initialSynthesisState(), done: true };
  }

  return { state: s, done: false };
}

function finaliseRun(s) {
  const extensionAPI = deps.getExtensionAPIRef?.();
  const now = Date.now();

  // Cross-run dedupe against persisted fingerprints
  let fresh = s.proposals;
  try {
    const stored = extensionAPI?.settings.get(FINGERPRINTS_SETTINGS_KEY);
    const result = filterNewProposals(s.proposals, stored, now);
    fresh = result.fresh;
    extensionAPI?.settings.set(FINGERPRINTS_SETTINGS_KEY, result.store);
  } catch (err) {
    deps.debugLog?.("[Synthesis] Fingerprint dedupe error (proposing all):", err?.message);
  }

  synthesisResult = {
    ranAt: now,
    proposalCount: fresh.length,
    suppressedCount: s.proposals.length - fresh.length,
    staleMemoryCount: s.staleMemory.length,
    scannedCount: s.scannedCount,
    skippedCount: s.skippedCount,
    oldCorrectionsCount: s.oldCorrectionsCount
  };

  try {
    extensionAPI?.settings.set(LAST_RUN_SETTINGS_KEY, now);
  } catch (err) {
    deps.debugLog?.("[Synthesis] Failed to persist lastRunAt:", err?.message);
  }

  deps.debugLog?.(
    `[Synthesis] Run complete: ${fresh.length} proposals (${synthesisResult.suppressedCount} suppressed), ` +
    `${s.staleMemory.length} stale memory flags, ${s.scannedCount} corrections scanned`
  );

  // Nothing to say → no report (lastRunAt still advances)
  if (fresh.length === 0 && s.staleMemory.length === 0) return;

  const dateRef = deps.formatLogDateRef
    ? deps.formatLogDateRef(new Date())
    : `[[${deps.formatRoamDate?.(new Date()) || new Date().toISOString().slice(0, 10)}]]`;

  const report = buildReportBlocks({
    proposals: fresh,
    staleMemory: s.staleMemory,
    oldCorrectionsCount: s.oldCorrectionsCount,
    scannedCount: s.scannedCount,
    skippedCount: s.skippedCount,
    dateRef
  });

  // Fire-and-forget persistence (graph-hygiene pattern)
  persistSynthesisReport(report).then(() => {
    if (fresh.length > 0) {
      deps.showInfoToast?.(
        "Synthesis",
        `${fresh.length} memory proposal${fresh.length === 1 ? "" : "s"} — see Chief of Staff/Synthesis`
      );
    }
  }).catch(err => {
    deps.debugLog?.("[Synthesis] Persist error (non-fatal):", err?.message);
  });
}

// ── Test hooks ───────────────────────────────────────────────────────────────

export function __resetSynthesisForTests() {
  synthesisResult = null;
}

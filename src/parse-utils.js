/**
 * parse-utils.js — Pure parsing utilities extracted for testability.
 * No runtime dependencies (no DOM, no Roam API, no injected deps).
 */

/**
 * Extract all top-level balanced JSON objects from a string.
 * Used to detect Gemini concatenating multiple tool calls' arguments into one slot.
 * Returns array of { parsed, start, end } for each valid JSON object found.
 */
export function extractBalancedJsonObjects(raw) {
  if (!raw || typeof raw !== "string") return [];
  const trimmed = raw.trim();
  const results = [];
  let pos = 0;
  while (pos < trimmed.length) {
    // Skip to next '{'
    while (pos < trimmed.length && trimmed[pos] !== "{") pos++;
    if (pos >= trimmed.length) break;
    let depth = 0, inString = false, escape = false;
    let foundEnd = false;
    for (let i = pos; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(trimmed.slice(pos, i + 1));
            results.push({ parsed, start: pos, end: i + 1 });
          } catch { /* skip malformed */ }
          pos = i + 1;
          foundEnd = true;
          break;
        }
      }
    }
    if (!foundEnd) break; // unbalanced, stop
  }
  return results;
}

/**
 * Extract a compact key reference from MCP tool result texts.
 * Scans for "Name (Key: XYZ)" or "Key: XYZ" patterns and builds a
 * compact lookup table that gets appended to the conversation turn.
 */
export function extractMcpKeyReference(mcpResultTexts) {
  if (!Array.isArray(mcpResultTexts) || mcpResultTexts.length === 0) return "";
  const entries = [];
  const seen = new Set();
  for (const text of mcpResultTexts) {
    if (!text) continue;
    // Match patterns like: **Name** (Key: ABC123) or (Key: ABC123) or Key: ABC123
    const keyPattern = /\*{0,2}([^*\n(]+?)\*{0,2}\s*\(Key:\s*([A-Za-z0-9]+)\)/g;
    let match;
    while ((match = keyPattern.exec(text)) !== null) {
      const name = match[1].trim().replace(/^[-*\s]+/, "");
      const key = match[2];
      const id = `${name}::${key}`;
      if (!seen.has(id) && name && key) {
        seen.add(id);
        entries.push(`${name} → ${key}`);
      }
    }
    // Also match "Item Key: XYZ" with nearby title (cap name to 200 chars to limit backtracking)
    const itemKeyPattern = /\*\*(?:Title|Name):\*\*\s*(.{1,200})[\s\S]{0,500}?\*\*(?:Item Key|Key):\*\*\s*`?([A-Za-z0-9]+)`?/g;
    while ((match = itemKeyPattern.exec(text)) !== null) {
      const name = match[1].trim();
      const key = match[2];
      const id = `${name}::${key}`;
      if (!seen.has(id) && name && key) {
        seen.add(id);
        entries.push(`${name} → ${key}`);
      }
    }
  }
  if (entries.length === 0) return "";
  // Cap at 50 entries — raised from 30 to preserve subcollection keys
  // for libraries like Zotero with 80+ collections
  const capped = entries.slice(0, 50);
  return `[Key reference: ${capped.join("; ")}]`;
}

/**
 * True when a string looks like an intended Roam identifier rather than a page
 * title: a 9-char block UID (letters/digits/_/-) or a DNP UID (MM-DD-YYYY).
 * Used to decide whether a missing write-target should error (bad UID) or be
 * treated as a page title to create.
 */
export function looksLikeRoamUid(str) {
  const s = String(str || "").trim();
  return /^[A-Za-z0-9_-]{9}$/.test(s) || /^\d{2}-\d{2}-\d{4}$/.test(s);
}

/**
 * Format a raw tag string (from `/export /tag ...`) into a Roam tag string.
 * Comma-separates into multiple tags; each renders idiomatically as `#Tag`
 * (no spaces) or `#[[Multi Word]]` (has spaces). Strips any leading `#` or
 * `[[ ]]` the user typed, dedupes case-insensitively, and drops stray brackets
 * that would break the `#[[...]]` form. Returns "" for empty/invalid input.
 */
export function buildRoamTagString(rawTags) {
  if (!rawTags || typeof rawTags !== "string") return "";
  const out = [];
  const seen = new Set();
  for (const part of rawTags.split(",")) {
    const clean = part.replace(/[#\[\]]/g, "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(/\s/.test(clean) ? `#[[${clean}]]` : `#${clean}`);
  }
  return out.join(" ");
}

// ── Skill token accounting (#119) ───────────────────────────────────────────
//
// Models cannot reliably estimate or sum token counts: three live Skill
// Assumption Audit runs of the same skill reported totals of 351, 540 and 612
// against true sums of 627, 520 and 617. The counts must come from code.

/** Rough token estimate for English prose: ~4 characters per token. */
export function estimateTokens(text) {
  const s = String(text || "").trim();
  return s ? Math.max(1, Math.round(s.length / 4)) : 0;
}

/**
 * Structural fields are parsed by the extension's router, whitelist and budget
 * machinery — they are not model-read guardrails, and deleting one breaks skill
 * invocation. Excluded from auditable lines so an audit can never propose
 * removing them. (The prose constraint saying so was ignored once already.)
 */
const SKILL_STRUCTURAL_FIELD_RE = /^\s*-?\s*(?:Triggers?|Sources?|Tools?|Tier|Budget|Iterations|Models)\s*(?::|—)/i;

/**
 * Split a skill's `childrenContent` (one line per block) into auditable
 * guardrail lines with stable ids and deterministic token costs.
 * Returns [{ id, text, tokens }] — ids are 1-based and stable for a given skill.
 */
export function extractAuditableSkillLines(childrenContent) {
  const lines = [];
  let id = 0;
  for (const raw of String(childrenContent || "").split("\n")) {
    if (!raw.trim()) continue;
    if (SKILL_STRUCTURAL_FIELD_RE.test(raw)) continue;
    const text = raw.replace(/^\s*[-*•]\s*/, "").trim();
    if (!text) continue;
    lines.push({ id: ++id, text, tokens: estimateTokens(text) });
  }
  return lines;
}

/**
 * Exact totals for an audit. `removeIds` are the line ids classified Remove.
 * percentage is removable/total to one decimal place.
 */
export function summariseSkillTokens(lines, removeIds = []) {
  const safeLines = Array.isArray(lines) ? lines : [];
  const removeSet = new Set((Array.isArray(removeIds) ? removeIds : []).map(Number));
  const total = safeLines.reduce((sum, l) => sum + (l?.tokens || 0), 0);
  const removed = safeLines.filter((l) => removeSet.has(l?.id));
  const removable = removed.reduce((sum, l) => sum + (l?.tokens || 0), 0);
  return {
    total_tokens: total,
    removable_tokens: removable,
    percentage: total > 0 ? Math.round((removable / total) * 1000) / 10 : 0,
    line_count: safeLines.length,
    removed_line_count: removed.length,
  };
}

/**
 * Strip leading conversational fillers ("no,", "ok", "actually", "yes", …) from
 * a message so skill-invocation phrasing still routes after a filler prefix.
 * Conservative by design: only a fixed high-confidence filler set, each as a
 * whole word with an optional comma, so it can't eat a real leading command
 * word (e.g. "well-being report", "search for X"). Loops to peel stacked
 * fillers ("ok, no, run …"). (#136b2)
 */
export function stripConversationalPrefix(text) {
  return String(text || "")
    .replace(/^(?:(?:no|nope|ok|okay|yes|yeah|yep|sure|actually|alright|please)\b,?\s+)+/i, "")
    .trim();
}

/**
 * Extract natural-language trigger phrases from a skill's `Triggers:` line.
 * Returns lowercased quoted phrases with `[placeholder]` tokens and trailing
 * connector words removed. Single-word phrases are dropped — matching on them
 * would hijack unrelated requests. (#136a)
 */
export function extractSkillTriggerPhrases(skillContent) {
  const text = String(skillContent || "");
  const line = text.match(/^\s*-?\s*Triggers?\s*[:—]\s*(.+)$/im);
  if (!line) return [];
  const phrases = [];
  const seen = new Set();
  const quoteRe = /["“”‘’']([^"“”‘’']+?)["“”‘’']/g;
  let m;
  while ((m = quoteRe.exec(line[1])) !== null) {
    const p = m[1]
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, " ")               // drop [skill] placeholders
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s+(?:for|on|of|about|to)$/i, "") // drop trailing connector
      .trim();
    if (p.split(" ").filter(Boolean).length < 2) continue; // no single-word triggers
    if (!seen.has(p)) { seen.add(p); phrases.push(p); }
  }
  return phrases;
}

/**
 * Match a message against skills' own declared trigger phrases, for when the
 * explicit "run the X skill" phrasing wasn't used (e.g. "audit skill
 * assumptions for Catch Me Up"). (#136a)
 *
 * A phrase matches ONLY when it is the entire message, or is followed by an
 * explicit connector (`on`/`for`/`of`/`about`) or a colon, then a target.
 * A bare continuation must not match: trigger phrases are often generic
 * two-word openers ("what changed"), so "what changed in the Roam API" is a
 * question to answer, not a skill to run. Longest phrase wins; the remainder,
 * minus a leading article, becomes the target.
 *
 * @param {string} userMessage
 * @param {Array<{title:string, content:string}>} skillEntries
 * @returns {{ skillName:string, targetText:string, originalPrompt:string } | null}
 */
export function matchSkillByTriggerPhrase(userMessage, skillEntries) {
  const raw = stripConversationalPrefix(String(userMessage || "").trim());
  const lc = raw.toLowerCase();
  if (!lc || !Array.isArray(skillEntries)) return null;

  let best = null;
  for (const entry of skillEntries) {
    const title = String(entry?.title || "").trim();
    if (!title) continue;
    for (const p of extractSkillTriggerPhrases(entry?.content || "")) {
      let target = null;
      if (lc === p) {
        target = "";
      } else if (lc.startsWith(p)) {
        const rest = raw.slice(p.length);
        // Phrase must end on a word boundary ("catch me upon …" is not a match),
        // then carry an explicit connector or colon before the target.
        if (/^[\s:]/.test(rest)) {
          const m = rest.match(/^\s*(?::\s*|(?:on|for|of|about)\s+)(.+)$/i);
          if (m) target = m[1].trim().replace(/^(?:the|my|a)\s+/i, "").trim();
        }
      }
      if (target !== null && (!best || p.length > best.phraseLen)) {
        best = { skillName: title, phraseLen: p.length, target };
      }
    }
  }
  if (!best) return null;
  return { skillName: best.skillName, targetText: best.target, originalPrompt: String(userMessage || "").trim() };
}

/**
 * Build block strings for a chat transcript export (/export command).
 * Takes the chat panel history (array of { role, text }) and returns an
 * array of Roam block strings, one per message, prefixed with a bold
 * speaker label. Entries with no visible text are skipped; unknown roles
 * are treated as assistant (mirrors normaliseChatPanelMessage).
 */
export function buildChatTranscriptBlocks(history, { assistantName = "Chief of Staff" } = {}) {
  if (!Array.isArray(history)) return [];
  const safeName = String(assistantName || "Chief of Staff").trim() || "Chief of Staff";
  const blocks = [];
  for (const entry of history) {
    const text = String(entry?.text || "").trim();
    if (!text) continue;
    const isUser = String(entry?.role || "").toLowerCase() === "user";
    blocks.push(`**${isUser ? "User" : safeName}:** ${text}`);
  }
  return blocks;
}

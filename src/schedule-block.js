// schedule-block.js — cos_schedule_block: deterministic TimeBlock slot writer.
//
// The slot grammar `HH:MM - HH:MM (**N'**) ((task-uid))` lives HERE, in code,
// not in prose. Any LLM that can call tools extracts {date, start, end, title}
// and this tool writes the line — matching the canonical Python formatter
// (~/.claude/scripts/roam-plan-writer.py _timeblock_prefix/_duration_min),
// with the midnight wrap fixed: end <= start means "crosses midnight", and
// the written string never contains "24:00".
//
// Pure helpers (formatting, parsing, overlap, chronological ordering) take
// plain values; graph access goes through the injected `deps` the rest of
// the COS tools already use.

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
// `HH:MM - HH:MM` then optional `(**N'**)` then the rest (ref or event text).
const SLOT_LINE_RE = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(?:\(\*\*(\d+)'\*\*\)\s*)?(.*)$/;
const BLOCK_REF_RE = /\(\(([^()\s]+)\)\)/;

const NAUTILUS_MARKER = "roam-render-Nautilus-Log-cljs";
const SMARTBLOCK_MARKER = "SmartBlock:Double timestamp buttons2";
const CHILD_PULL_PATTERN = "[:block/uid {:block/children [:block/uid :block/string :block/order]}]";

// ── Pure time helpers ────────────────────────────────────────────────────────

function toMinutes(time) {
  const m = TIME_RE.exec(String(time || "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (mins > 59) return null;
  if (hours > 24 || (hours === 24 && mins !== 0)) return null; // 24:00 ok, 24:01 not
  return hours * 60 + mins;
}

/** "9:5" → null, "9:05" → "09:05", "24:00" → "00:00". Null when unparseable. */
export function normalizeTime(time) {
  const total = toMinutes(time);
  if (total == null) return null;
  const wrapped = total % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes from start to end; end at or before start wraps past midnight. */
export function durationMinutes(start, end) {
  let s = toMinutes(start);
  let e = toMinutes(end);
  if (s == null || e == null) return null;
  s %= 1440;
  e %= 1440;
  if (e <= s) e += 1440;
  return e - s;
}

/** "21:00","24:00" → "21:00 - 00:00 (**180'**)". Never emits "24:00". */
export function formatSlotPrefix(start, end) {
  const s = normalizeTime(start);
  const e = normalizeTime(end);
  const mins = durationMinutes(start, end);
  if (s == null || e == null || mins == null) return null;
  return `${s} - ${e} (**${mins}'**)`;
}

/**
 * Parse a slot line back into {start, end, mins, refUid, isEvent, text}.
 * Returns null for anything that isn't a `HH:MM - HH:MM …` line.
 */
export function parseSlotLine(line) {
  const m = SLOT_LINE_RE.exec(String(line || ""));
  if (!m) return null;
  const start = normalizeTime(m[1]);
  const end = normalizeTime(m[2]);
  if (start == null || end == null) return null;
  const text = (m[4] || "").trim();
  const ref = BLOCK_REF_RE.exec(text);
  return {
    start,
    end,
    mins: m[3] != null ? Number(m[3]) : durationMinutes(start, end),
    refUid: ref ? ref[1] : null,
    isEvent: /#Event\b/.test(text),
    text,
  };
}

/** Overlap on a 24h circle; both ranges may wrap midnight. End-exclusive. */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  let a0 = toMinutes(aStart);
  let a1 = toMinutes(aEnd);
  let b0 = toMinutes(bStart);
  let b1 = toMinutes(bEnd);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  a0 %= 1440; a1 %= 1440; b0 %= 1440; b1 %= 1440;
  if (a1 <= a0) a1 += 1440;
  if (b1 <= b0) b1 += 1440;
  // A wrapped range also occupies the previous/next day's frame — check shifts.
  for (const shift of [-1440, 0, 1440]) {
    if (a0 + shift < b1 && b0 < a1 + shift) return true;
  }
  return false;
}

function isSmartBlockChild(text) {
  return String(text || "").includes(SMARTBLOCK_MARKER);
}

/**
 * Where to insert a slot starting at `start` among `children`
 * ([{uid, string, order}], sorted by order): before the first slot that
 * starts later, else before the trailing SmartBlock buttons, else "last".
 * Returns a numeric order (Roam shifts siblings) or "last".
 */
export function insertSlotChronologically(children, start) {
  const s = toMinutes(start);
  let smartBlockOrder = null;
  for (const child of Array.isArray(children) ? children : []) {
    if (isSmartBlockChild(child.string)) {
      if (smartBlockOrder == null) smartBlockOrder = child.order;
      continue;
    }
    const slot = parseSlotLine(child.string);
    if (slot && s != null && toMinutes(slot.start) > s) return child.order;
  }
  if (smartBlockOrder != null) return smartBlockOrder;
  return "last";
}

// ── Graph helpers (deps-injected) ────────────────────────────────────────────

async function getChildBlocks(deps, uid) {
  const api = deps.getRoamAlphaApi();
  let data = null;
  try {
    if (typeof api?.data?.pull === "function") data = await api.data.pull(CHILD_PULL_PATTERN, [":block/uid", uid]);
    else if (typeof api?.pull === "function") data = await api.pull(CHILD_PULL_PATTERN, [":block/uid", uid]);
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] child pull failed for", uid, err?.message);
  }
  const kids = Array.isArray(data?.[":block/children"]) ? data[":block/children"] : [];
  return kids
    .map((c) => ({
      uid: c[":block/uid"],
      string: String(c[":block/string"] || ""),
      order: Number.isFinite(c[":block/order"]) ? c[":block/order"] : 0,
    }))
    .sort((a, b) => a.order - b.order);
}

/**
 * Find the schedule parent among a daily page's top-level children, creating
 * a plain `heading` block when none exists. Preference order:
 *   1. A Nautilus Log render block (Svy's graph) — reused as-is, never
 *      duplicated, never rewritten.
 *   2. A `#TimeBlock` / `Time Blocks` / `heading` block (legacy or generic).
 *   3. Create `heading` ("Schedule" by default). The Nautilus render is never
 *      injected onto a graph that doesn't already have it.
 */
export async function findScheduleParent(deps, pageUid, scheduleHeading) {
  const heading = String(scheduleHeading || "").trim() || "Schedule";
  const children = await getChildBlocks(deps, pageUid);

  const nautilus = children.find((c) => c.string.includes(NAUTILUS_MARKER));
  if (nautilus) return { uid: nautilus.uid, created: false };

  const legacy = children.find((c) => {
    const s = c.string.trim();
    return s.includes("#TimeBlock") || /^Time Blocks\b/.test(s) || s.startsWith(heading);
  });
  if (legacy) return { uid: legacy.uid, created: false };

  const uid = await deps.createRoamBlock(pageUid, heading, "last");
  return { uid, created: true };
}

/**
 * Fuzzy-match an existing open TODO by title: every significant word
 * (length > 3) must appear in the block text, case-insensitively.
 * Returns {uid, text} or null.
 */
export async function findExistingOpenTodo(deps, title) {
  const words = String(title || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  if (!words.length) return null;

  let rows;
  try {
    rows = await deps.queryRoamDatalog(`[:find ?uid ?str
      :where
      [?b :block/string ?str]
      [?b :block/uid ?uid]
      [(clojure.string/includes? ?str "{{[[TODO]]}}")]]`);
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] open-TODO scan failed:", err?.message);
    return null;
  }
  for (const [uid, str] of Array.isArray(rows) ? rows : []) {
    const lower = String(str || "").toLowerCase();
    if (words.every((w) => lower.includes(w))) return { uid, text: String(str) };
  }
  return null;
}

// ── The tool ─────────────────────────────────────────────────────────────────

function buildEventString(start, end, title) {
  const line = `${start} - ${end}  ${title}`;
  return /#Event\b/.test(title) ? line : `${line} #Event`;
}

export function buildScheduleBlockTool(deps) {
  async function resolveDailyPage(dateArg) {
    const raw = String(dateArg || "").trim();
    if (!raw) return deps.ensureDailyPageUid(new Date());
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (iso) {
      return deps.ensureDailyPageUid(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    }
    // Assume a Roam daily title like "August 26th, 2026" — resolve or create it.
    const pageUid = await deps.ensurePageUidByTitle(raw);
    if (!pageUid) throw new Error(`Could not resolve page "${raw}".`);
    return { pageUid, pageTitle: raw };
  }

  return {
    name: "cos_schedule_block",
    isMutating: true,
    description: "Place a timed block on a daily page. Writes the canonical slot grammar HH:MM - HH:MM (**N'**) ((task-uid)) as a child of the schedule parent (an existing Nautilus Log block, a #TimeBlock/Schedule heading, or a new \"Schedule\" heading it creates). Reuses an existing open TODO when task_uid is omitted; kind=event writes plain text tagged #Event instead. Inserts chronologically, keeps SmartBlock buttons last, and refuses on time collisions rather than overwriting. Does not flatten tables. One call places exactly one slot.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Daily page — Roam title (\"August 26th, 2026\") or ISO YYYY-MM-DD. Default: today." },
        start: { type: "string", description: "Start time, HH:MM 24-hour." },
        end: { type: "string", description: "End time, HH:MM 24-hour. 24:00 means midnight at the end of the day; the written line shows 00:00." },
        title: { type: "string", description: "What the slot is for. Used to find or create the TODO (kind=task) or as the event text (kind=event)." },
        kind: { type: "string", enum: ["task", "event"], description: "task (default) references a TODO via ((uid)); event writes the title tagged #Event, no TODO." },
        task_uid: { type: "string", description: "Existing TODO block uid to reference. Reused as-is — never duplicated." },
        project: { type: "string", description: "Page title on which to create a NEW todo. Default: the daily page." },
        parent_uid: { type: "string", description: "Explicit schedule parent block uid (sandbox / tests). Skips parent discovery." },
        schedule_heading: { type: "string", description: "Heading used to find/create the schedule parent when there is no Nautilus Log block and no parent_uid. Default \"Schedule\"." },
        collide: { type: "string", enum: ["refuse", "ask"], description: "On overlap with a different task/event: refuse (default) returns the colliding slot without writing; ask does the same but requests a user decision." }
      },
      required: ["start", "end", "title"]
    },
    execute: async (args = {}) => {
      const startNorm = normalizeTime(args.start);
      const endNorm = normalizeTime(args.end);
      const title = String(args.title || "").trim();
      if (!startNorm) throw new Error("start is required (HH:MM, 24-hour).");
      if (!endNorm) throw new Error("end is required (HH:MM, 24-hour; 24:00 allowed for midnight).");
      if (!title) throw new Error("title is required.");
      const kind = String(args.kind || "task") === "event" ? "event" : "task";
      const collide = String(args.collide || "refuse") === "ask" ? "ask" : "refuse";
      const prefix = formatSlotPrefix(startNorm, endNorm);
      const api = deps.getRoamAlphaApi();

      // 1. Resolve the schedule parent.
      let parentUid = String(args.parent_uid || "").trim();
      let createdParent = false;
      let dailyPage = null;
      if (parentUid) {
        deps.requireRoamUidExists(parentUid, "parent_uid");
      } else {
        dailyPage = await resolveDailyPage(args.date);
        if (!dailyPage?.pageUid) throw new Error("Could not resolve the daily page.");
        const parent = await findScheduleParent(deps, dailyPage.pageUid, args.schedule_heading);
        parentUid = parent.uid;
        createdParent = parent.created;
      }

      // 2. Resolve the task uid WITHOUT creating anything yet — a collision
      //    refusal must not leave an orphan TODO behind.
      let taskUid = null;
      let reusedTodo = false;
      if (kind === "task") {
        taskUid = String(args.task_uid || "").trim() || null;
        if (taskUid) {
          deps.requireRoamUidExists(taskUid, "task_uid");
          reusedTodo = true;
        } else {
          const existing = await findExistingOpenTodo(deps, title);
          if (existing) {
            taskUid = existing.uid;
            reusedTodo = true;
          }
        }
      }

      // 3. Collision check against existing slot children. Same task/event
      //    overlapping its own old slot is a reschedule; anything else refuses.
      const children = await getChildBlocks(deps, parentUid);
      let rescheduleTarget = null;
      for (const child of children) {
        const slot = parseSlotLine(child.string);
        if (!slot) continue;
        if (!rangesOverlap(startNorm, endNorm, slot.start, slot.end)) continue;
        const sameTask = kind === "task" && taskUid && slot.refUid === taskUid;
        const sameEvent = kind === "event" && slot.isEvent
          && slot.text.replace(/#Event\b/g, "").trim() === title;
        if (sameTask || sameEvent) {
          rescheduleTarget = child;
          continue;
        }
        return {
          success: false,
          error: `Time collision: ${startNorm} - ${endNorm} overlaps existing slot "${child.string}". Nothing was written.` +
            (collide === "ask"
              ? " Ask the user whether to move the existing slot or pick a different time."
              : " Pick a different time or reschedule the existing slot first."),
          colliding_uid: child.uid,
          colliding_string: child.string
        };
      }

      if (rescheduleTarget) {
        const slotString = kind === "event"
          ? buildEventString(startNorm, endNorm, title)
          : `${prefix} ((${taskUid}))`;
        await deps.withRoamWriteRetry(() =>
          api.updateBlock({ block: { uid: rescheduleTarget.uid, string: deps.truncateRoamBlockText(slotString) } })
        );
        return {
          success: true, slot_uid: rescheduleTarget.uid, slot_string: slotString,
          task_uid: taskUid, parent_uid: parentUid,
          created_todo: false, reused_todo: reusedTodo, rescheduled: true,
          created_parent: createdParent
        };
      }

      // 4. Create the TODO now that the slot is known to be writable.
      let createdTodo = false;
      if (kind === "task" && !taskUid) {
        let todoParentUid;
        const project = String(args.project || "").trim();
        if (project) {
          todoParentUid = await deps.ensurePageUidByTitle(project);
          if (!todoParentUid) throw new Error(`Could not resolve project page "${project}".`);
        } else {
          if (!dailyPage) dailyPage = await resolveDailyPage(args.date);
          todoParentUid = dailyPage.pageUid;
        }
        taskUid = await deps.createRoamBlock(todoParentUid, `{{[[TODO]]}} ${title}`, "last");
        createdTodo = true;
      }

      // 5. Write the slot, chronologically, keeping SmartBlock buttons last.
      const order = insertSlotChronologically(children, startNorm);
      let slotUid;
      let slotString;
      if (kind === "event") {
        slotString = buildEventString(startNorm, endNorm, title);
        slotUid = await deps.createRoamBlock(parentUid, slotString, order);
      } else {
        slotString = `${prefix} ((${taskUid}))`;
        // createBlock runs markdown parsing that mangles ((refs)) — create a
        // placeholder, then set the literal string via updateBlock.
        slotUid = await deps.createRoamBlock(parentUid, "PLACEHOLDER", order);
        await deps.withRoamWriteRetry(() =>
          api.updateBlock({ block: { uid: slotUid, string: deps.truncateRoamBlockText(slotString) } })
        );
      }

      return {
        success: true, slot_uid: slotUid, slot_string: slotString,
        task_uid: taskUid, parent_uid: parentUid,
        created_todo: createdTodo, reused_todo: reusedTodo,
        created_parent: createdParent
      };
    }
  };
}

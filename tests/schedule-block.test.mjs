import test from "node:test";
import assert from "node:assert/strict";
import {
  durationMinutes,
  formatSlotPrefix,
  parseSlotLine,
  rangesOverlap,
  insertSlotChronologically,
  buildScheduleBlockTool,
} from "../src/schedule-block.js";

const NAUTILUS_STRING = "{{roam/render: ((roam-render-Nautilus-Log-cljs))}}";
const SMARTBLOCK_STRING = "{{⏱:SmartBlock:Double timestamp buttons2}}";

function fmtRoamDate(date) {
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const day = date.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? "st"
    : day === 2 || day === 22 ? "nd"
      : day === 3 || day === 23 ? "rd" : "th";
  return `${months[date.getMonth()]} ${day}${suffix}, ${date.getFullYear()}`;
}

/**
 * In-memory fake of the Roam surface the tool touches: a uid → block store
 * with parent/order, page registry, and the deps object the tool is built
 * with. No live graph, no window, no roamAlphaAPI global.
 */
function makeFakeGraph() {
  let counter = 0;
  const blocks = new Map(); // uid → { string, parent, order }
  const pages = new Map();  // title → uid

  const genUid = () => `uid${String(++counter).padStart(3, "0")}`;

  const childrenOf = (parentUid) =>
    [...blocks.entries()]
      .filter(([, b]) => b.parent === parentUid)
      .map(([uid, b]) => ({ uid, string: b.string, order: b.order }))
      .sort((a, b) => a.order - b.order);

  // Numeric order inserts shift later siblings down, like Roam's createBlock.
  const insertBlock = (parentUid, text, order = "last") => {
    const siblings = childrenOf(parentUid);
    let numeric;
    if (order === "last") numeric = siblings.length;
    else if (order === "first") numeric = 0;
    else numeric = Math.max(0, Math.min(Number(order), siblings.length));
    for (const sib of siblings) {
      if (sib.order >= numeric) blocks.get(sib.uid).order += 1;
    }
    const uid = genUid();
    blocks.set(uid, { string: String(text), parent: parentUid, order: numeric });
    return uid;
  };

  const addPage = (title) => {
    if (pages.has(title)) return pages.get(title);
    const uid = genUid();
    pages.set(title, uid);
    blocks.set(uid, { string: title, parent: null, order: 0, isPage: true });
    return uid;
  };

  const api = {
    data: {
      pull: (pattern, ref) => {
        const uid = ref[1];
        if (!blocks.has(uid)) return null;
        return {
          ":block/uid": uid,
          ":block/children": childrenOf(uid).map((c) => ({
            ":block/uid": c.uid,
            ":block/string": c.string,
            ":block/order": c.order,
          })),
        };
      },
    },
    updateBlock: async ({ block }) => {
      const b = blocks.get(block.uid);
      if (!b) throw new Error(`updateBlock: block ${block.uid} not found`);
      b.string = block.string;
      return true;
    },
  };

  const deps = {
    getRoamAlphaApi: () => api,
    createRoamBlock: async (parentUid, text, order = "last") => insertBlock(parentUid, text, order),
    withRoamWriteRetry: async (fn) => fn(),
    ensureDailyPageUid: async (date = new Date()) => {
      const pageTitle = fmtRoamDate(date);
      return { pageUid: addPage(pageTitle), pageTitle };
    },
    ensurePageUidByTitle: async (title) => addPage(title),
    formatRoamDate: fmtRoamDate,
    // The module only issues the open-TODO scan; return [uid, string] rows.
    queryRoamDatalog: async () =>
      [...blocks.entries()]
        .filter(([, b]) => typeof b.string === "string" && b.string.includes("{{[[TODO]]}}") && !b.isPage)
        .map(([uid, b]) => [uid, b.string]),
    escapeForDatalog: (v) => String(v || ""),
    requireRoamUidExists: (uid, label = "UID") => {
      if (!blocks.has(uid)) throw new Error(`${label} "${uid}" not found in graph.`);
    },
    truncateRoamBlockText: (t) => String(t || ""),
    debugLog: () => {},
  };

  const todoCount = () =>
    [...blocks.values()].filter((b) => typeof b.string === "string" && b.string.includes("{{[[TODO]]}}")).length;

  return { deps, blocks, pages, addPage, insertBlock, childrenOf, todoCount };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("durationMinutes wraps midnight: 21:00 → 00:00 is 180 minutes", () => {
  assert.equal(durationMinutes("21:00", "00:00"), 180);
  assert.equal(durationMinutes("21:00", "24:00"), 180);
  assert.equal(formatSlotPrefix("21:00", "00:00"), "21:00 - 00:00 (**180'**)");
});

test("durationMinutes handles a plain same-day range", () => {
  assert.equal(durationMinutes("20:00", "21:00"), 60);
  assert.equal(formatSlotPrefix("20:00", "21:00"), "20:00 - 21:00 (**60'**)");
});

test("formatSlotPrefix never emits 24:00", () => {
  const prefix = formatSlotPrefix("21:00", "24:00");
  assert.ok(!prefix.includes("24:00"), `prefix "${prefix}" must not contain 24:00`);
  assert.equal(prefix, "21:00 - 00:00 (**180'**)");
});

test("parseSlotLine round-trips task slots, events, and rejects non-slots", () => {
  const task = parseSlotLine("21:00 - 00:00 (**180'**) ((abc123XYZ))");
  assert.deepEqual(
    { start: task.start, end: task.end, mins: task.mins, refUid: task.refUid, isEvent: task.isEvent },
    { start: "21:00", end: "00:00", mins: 180, refUid: "abc123XYZ", isEvent: false }
  );
  const event = parseSlotLine("19:00 - 21:00  Dinner with Anna #Event");
  assert.equal(event.isEvent, true);
  assert.equal(event.refUid, null);
  assert.equal(event.mins, 120);
  assert.equal(parseSlotLine("Schedule"), null);
  assert.equal(parseSlotLine(SMARTBLOCK_STRING), null);
});

test("rangesOverlap treats midnight wrap correctly", () => {
  assert.equal(rangesOverlap("21:00", "00:00", "23:00", "23:30"), true);
  assert.equal(rangesOverlap("21:00", "00:00", "00:00", "01:00"), false); // end-exclusive
  assert.equal(rangesOverlap("23:00", "01:00", "00:30", "02:00"), true);
  assert.equal(rangesOverlap("09:00", "10:00", "10:00", "11:00"), false);
});

test("insertSlotChronologically slots between existing entries and before SmartBlock", () => {
  const children = [
    { uid: "a", string: "09:00 - 10:00 (**60'**) ((t1))", order: 0 },
    { uid: "b", string: "13:00 - 14:00 (**60'**) ((t2))", order: 1 },
    { uid: "c", string: SMARTBLOCK_STRING, order: 2 },
  ];
  assert.equal(insertSlotChronologically(children, "11:00"), 1); // before 13:00
  assert.equal(insertSlotChronologically(children, "20:00"), 2); // before SmartBlock
  assert.equal(insertSlotChronologically([], "20:00"), "last");
});

// ── Tool execution against the fake graph ────────────────────────────────────

test("happy path: gaming 21:00-00:00 writes exact slot, creates TODO, keeps SmartBlock last", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const smartBlockUid = g.insertBlock(parentUid, SMARTBLOCK_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "24:00",
    title: "Gaming: league of legends",
  });

  assert.equal(result.success, true);
  assert.equal(result.created_todo, true);
  assert.equal(result.reused_todo, false);
  assert.equal(result.parent_uid, parentUid);
  assert.equal(result.slot_string, `21:00 - 00:00 (**180'**) ((${result.task_uid}))`);
  assert.equal(g.blocks.get(result.slot_uid).string, result.slot_string);
  assert.equal(g.blocks.get(result.task_uid).string, "{{[[TODO]]}} Gaming: league of legends");
  assert.equal(g.blocks.get(result.task_uid).parent, pageUid);

  const kids = g.childrenOf(parentUid);
  assert.equal(kids[kids.length - 1].uid, smartBlockUid, "SmartBlock buttons must stay last");
  assert.equal(kids[0].uid, result.slot_uid);
});

test("reuses an existing open TODO instead of creating a duplicate", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} play league of legends ranked");

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "23:00",
    title: "League of Legends",
  });

  assert.equal(result.success, true);
  assert.equal(result.reused_todo, true);
  assert.equal(result.created_todo, false);
  assert.equal(result.task_uid, todoUid);
  assert.ok(result.slot_string.includes(`((${todoUid}))`));
  assert.equal(g.todoCount(), 1, "no second TODO may be created");
});

test("ref integrity: stored slot contains ((uid)) exactly, not escaped or triple-paren", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "08:00", end: "09:30", title: "Morning writing block",
  });

  const stored = g.blocks.get(result.slot_uid).string;
  assert.ok(stored.includes(`((${result.task_uid}))`), `stored "${stored}" must contain ((uid))`);
  assert.ok(!stored.includes("((("), "no triple parens");
  assert.ok(!stored.includes("\\("), "no escaped parens");
  assert.equal(parseSlotLine(stored).refUid, result.task_uid);
});

test("collision with a different task refuses and overwrites nothing", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const otherTodo = g.insertBlock(pageUid, "{{[[TODO]]}} deep work sprint");
  const existingSlot = g.insertBlock(parentUid, `20:00 - 22:00 (**120'**) ((${otherTodo}))`);
  const before = g.blocks.get(existingSlot).string;
  const childCountBefore = g.childrenOf(parentUid).length;

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "23:00", title: "Evening yoga session",
  });

  assert.equal(result.success, false);
  assert.equal(result.colliding_uid, existingSlot);
  assert.equal(result.colliding_string, before);
  assert.match(result.error, /collision/i);
  assert.equal(g.blocks.get(existingSlot).string, before, "existing slot must be untouched");
  assert.equal(g.childrenOf(parentUid).length, childCountBefore, "no slot may be written");
  assert.equal(g.todoCount(), 1, "no orphan TODO on refusal");
});

test("same task overlapping its own slot is a reschedule in place", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} league of legends session");
  const slotUid = g.insertBlock(parentUid, `21:00 - 22:00 (**60'**) ((${todoUid}))`);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:30", end: "23:30",
    title: "irrelevant", task_uid: todoUid,
  });

  assert.equal(result.success, true);
  assert.equal(result.rescheduled, true);
  assert.equal(result.slot_uid, slotUid, "must update the existing slot block");
  assert.equal(g.blocks.get(slotUid).string, `21:30 - 23:30 (**120'**) ((${todoUid}))`);
  assert.equal(g.childrenOf(parentUid).length, 1, "no second slot");
});

test("kind=event writes #Event text and creates no TODO", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "19:00", end: "21:00",
    title: "Dinner with Anna", kind: "event",
  });

  assert.equal(result.success, true);
  assert.equal(result.slot_string, "19:00 - 21:00  Dinner with Anna #Event");
  assert.equal(g.blocks.get(result.slot_uid).string, result.slot_string);
  assert.equal(g.blocks.get(result.slot_uid).parent, parentUid);
  assert.equal(result.task_uid, null);
  assert.equal(result.created_todo, false);
  assert.equal(g.todoCount(), 0, "events must not create TODOs");
});

test("parent_uid sandbox override is used as the parent, skipping discovery", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const sandboxPage = g.addPage("Sandbox");
  const sandboxParent = g.insertBlock(sandboxPage, "Test schedule area");

  const result = await tool.execute({
    start: "10:00", end: "11:00", title: "Sandbox scheduling check",
    parent_uid: sandboxParent,
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxParent);
  assert.equal(g.blocks.get(result.slot_uid).parent, sandboxParent);
});

test("generic graph: creates a Schedule heading, never injects the Nautilus render", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, "Some journal entry");

  const first = await tool.execute({
    date: "August 26th, 2026", start: "09:00", end: "10:00", title: "Weekly planning review",
  });
  assert.equal(first.success, true);
  assert.equal(first.created_parent, true);
  assert.equal(g.blocks.get(first.parent_uid).string, "Schedule");
  assert.equal(g.blocks.get(first.parent_uid).parent, pageUid);

  // Second call reuses the same heading — no duplicate parent.
  const second = await tool.execute({
    date: "August 26th, 2026", start: "11:00", end: "12:00", title: "Weekly planning review",
  });
  assert.equal(second.parent_uid, first.parent_uid);
  assert.equal(second.created_parent, false);

  const scheduleHeadings = g.childrenOf(pageUid).filter((c) => c.string === "Schedule");
  assert.equal(scheduleHeadings.length, 1);
  const nautilus = [...g.blocks.values()].filter((b) =>
    typeof b.string === "string" && b.string.includes("roam-render-Nautilus-Log-cljs"));
  assert.equal(nautilus.length, 0, "Nautilus render must never be injected on a generic graph");
});

test("new TODO goes to the project page when project is given", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "14:00", end: "15:00",
    title: "Draft launch announcement", project: "Project Apollo",
  });

  assert.equal(result.success, true);
  assert.equal(result.created_todo, true);
  assert.equal(g.blocks.get(result.task_uid).parent, g.pages.get("Project Apollo"));
});

test("missing start, end, or title is rejected", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  await assert.rejects(() => tool.execute({ end: "10:00", title: "x" }), /start/);
  await assert.rejects(() => tool.execute({ start: "09:00", title: "x" }), /end/);
  await assert.rejects(() => tool.execute({ start: "09:00", end: "10:00" }), /title/);
  await assert.rejects(() => tool.execute({ start: "25:00", end: "26:00", title: "x" }), /start/);
});

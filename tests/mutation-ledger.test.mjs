import test from "node:test";
import assert from "node:assert/strict";
import {
  initMutationLedger,
  setLedgerRunContext,
  captureBeforeImage,
  recordToolOutcome,
  recordOtherAction,
  getUndoableBatch,
  batchHasReversibleEntries,
  buildUndoSummary,
  executeUndo,
  buildUndoReport,
  clearLedger,
  UPDATE_TOOLS,
} from "../src/mutation-ledger.js";

// ── Fake Roam API ────────────────────────────────────────────────────────────
// blocks: uid → { string, heading?, open?, children?: [uid] }
// Calls to updateBlock/deleteBlock/deletePage are captured for assertions.

function makeFakeApi(blocks = {}) {
  const calls = { updates: [], deletes: [], pageDeletes: [] };
  const api = {
    pull(pattern, ref) {
      const uid = Array.isArray(ref) ? ref[1] : ref;
      const b = blocks[uid];
      if (!b) return null;
      if (pattern.includes("{:block/children")) {
        return { ":block/children": (b.children || []).map((u) => ({ ":block/uid": u })) };
      }
      const out = { ":block/string": b.string };
      if (b.heading !== undefined) out[":block/heading"] = b.heading;
      if (b.open !== undefined) out[":block/open"] = b.open;
      if (b.props !== undefined) out[":block/props"] = b.props;
      return out;
    },
    updateBlock({ block }) {
      calls.updates.push(block);
      if (blocks[block.uid] && block.string !== undefined) blocks[block.uid].string = block.string;
    },
    deleteBlock({ block }) {
      calls.deletes.push(block.uid);
      delete blocks[block.uid];
      for (const b of Object.values(blocks)) {
        if (Array.isArray(b.children)) b.children = b.children.filter((u) => u !== block.uid);
      }
    },
    deletePage({ page }) {
      calls.pageDeletes.push(page.uid);
      delete blocks[page.uid];
    },
  };
  return { api, calls, blocks };
}

function setup(blocks = {}) {
  const fake = makeFakeApi(blocks);
  clearLedger();
  initMutationLedger({
    getRoamAlphaApi: () => fake.api,
    debugLog: () => {},
    withRoamWriteRetry: (fn) => fn(),
  });
  return fake;
}

// ═════════════════════════════════════════════════════════════════════════════
// Recording / extraction map
// ═════════════════════════════════════════════════════════════════════════════

test("no recording without a run context (cron/inbox safety)", () => {
  setup({ b1: { string: "hello" } });
  recordToolOutcome("roam_create_block", { text: "hello" }, { success: true, uid: "b1" });
  assert.equal(getUndoableBatch(), null);
});

test("roam_create_block records a single create", () => {
  setup({ b1: { string: "hello" } });
  setLedgerRunContext("add a note");
  recordToolOutcome("roam_create_block", { text: "hello" }, { success: true, uid: "b1" });
  const batch = getUndoableBatch();
  assert.equal(batch.creates.length, 1);
  assert.equal(batch.creates[0].uid, "b1");
  assert.equal(batch.creates[0].afterString, "hello");
  assert.equal(batch.prompt, "add a note");
});

test("roam_create_blocks flattens created_uids across result batches", () => {
  setup({ a: { string: "1" }, b: { string: "2" }, c: { string: "3" } });
  setLedgerRunContext("multi");
  recordToolOutcome("roam_create_blocks", {}, {
    success: true,
    total_created: 3,
    results: [
      { parent_uid: "p1", created_count: 2, created_uids: ["a", "b"] },
      { parent_uid: "p2", created_count: 1, created_uids: ["c"] },
    ],
  });
  assert.deepEqual(getUndoableBatch().creates.map((c) => c.uid), ["a", "b", "c"]);
});

test("roam_batch_write records uids", () => {
  setup({ x: { string: "x" }, y: { string: "y" } });
  setLedgerRunContext("batch");
  recordToolOutcome("roam_batch_write", {}, { success: true, parent_uid: "p", uids: ["x", "y"] });
  assert.equal(getUndoableBatch().creates.length, 2);
});

test("roam_create_page with created:true records page entry before child blocks (reverse-order reversal reaches it last)", () => {
  setup({ pg: { string: "" }, k1: { string: "line" } });
  setLedgerRunContext("make a page");
  recordToolOutcome("roam_create_page", { title: "New Page" }, {
    success: true, page_uid: "pg", title: "New Page", created: true, uids: ["k1"],
  });
  const creates = getUndoableBatch().creates;
  assert.equal(creates.length, 2);
  assert.equal(creates[0].isPage, true);
  assert.equal(creates[0].pageTitle, "New Page");
  assert.equal(creates[1].uid, "k1");
});

test("roam_create_page with created:false (pre-existing page) records only child blocks", () => {
  setup({ k1: { string: "line" } });
  setLedgerRunContext("write into existing page");
  recordToolOutcome("roam_create_page", { title: "Existing" }, {
    success: true, page_uid: "pg", title: "Existing", created: false, uids: ["k1"],
  });
  const creates = getUndoableBatch().creates;
  assert.equal(creates.length, 1);
  assert.equal(creates[0].isPage, false);
});

test("failed results are not recorded", () => {
  setup();
  setLedgerRunContext("x");
  recordToolOutcome("roam_create_block", {}, { success: false, error: "nope" });
  recordToolOutcome("roam_create_block", {}, { error: "boom" });
  recordToolOutcome("roam_create_block", {}, { dry_run: true, simulated: true });
  recordToolOutcome("roam_create_block", {}, null);
  assert.equal(getUndoableBatch(), null);
});

test("unknown non-mutating tool is ignored; unknown mutating tool records as other", () => {
  setup();
  setLedgerRunContext("x");
  recordToolOutcome("SOME_READ_TOOL", {}, { success: true });
  assert.equal(getUndoableBatch(), null);
  recordToolOutcome("cos_update_memory", { page: "memory" }, { success: true }, { isMutating: true });
  const batch = getUndoableBatch();
  assert.equal(batch.others.length, 1);
  assert.equal(batch.others[0].label, "cos_update_memory");
  assert.equal(batchHasReversibleEntries(batch), false);
});

test("roam_undo itself is never recorded (no undo-the-undo loop)", () => {
  setup();
  setLedgerRunContext("undo");
  recordToolOutcome("roam_undo", {}, { success: true }, { isMutating: true });
  assert.equal(getUndoableBatch(), null);
});

test("delete/move record as declined, not reversible", () => {
  setup();
  setLedgerRunContext("x");
  recordToolOutcome("roam_delete_block", { uid: "gone1" }, { success: true, deleted_uid: "gone1" });
  recordToolOutcome("roam_move_block", { uid: "m1" }, { success: true, moved_uid: "m1" });
  const batch = getUndoableBatch();
  assert.equal(batch.declined.length, 2);
  assert.equal(batchHasReversibleEntries(batch), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// Updates + before-images
// ═════════════════════════════════════════════════════════════════════════════

test("update records before-image and touched fields", () => {
  setup({ u1: { string: "old text", heading: 2 } });
  setLedgerRunContext("edit");
  captureBeforeImage("roam_update_block", { uid: "u1", text: "new text" });
  // simulate the write
  recordToolOutcome("roam_update_block", { uid: "u1", text: "new text" }, { success: true, updated_uid: "u1" });
  const batch = getUndoableBatch();
  assert.equal(batch.updates.length, 1);
  assert.equal(batch.updates[0].before.string, "old text");
  assert.deepEqual(batch.updates[0].touched, ["string"]);
});

test("update without prior capture is not recorded (can't restore honestly)", () => {
  setup({ u1: { string: "old" } });
  setLedgerRunContext("edit");
  recordToolOutcome("roam_update_block", { uid: "u1", text: "new" }, { success: true, updated_uid: "u1" });
  assert.equal(getUndoableBatch(), null);
});

test("UPDATE_TOOLS covers modify_todo and link_mention", () => {
  assert.ok(UPDATE_TOOLS.has("roam_modify_todo"));
  assert.ok(UPDATE_TOOLS.has("roam_link_mention"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Slot semantics
// ═════════════════════════════════════════════════════════════════════════════

test("a read-only run does not clobber the undoable batch", () => {
  setup({ b1: { string: "hi" } });
  setLedgerRunContext("write run");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "b1" });
  setLedgerRunContext("what's on my plate today?"); // read-only run: records nothing
  const batch = getUndoableBatch();
  assert.ok(batch);
  assert.equal(batch.prompt, "write run");
});

test("a new mutating run replaces the previous batch", () => {
  setup({ b1: { string: "1" }, b2: { string: "2" } });
  setLedgerRunContext("first");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "b1" });
  setLedgerRunContext("second");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "b2" });
  const batch = getUndoableBatch();
  assert.equal(batch.creates.length, 1);
  assert.equal(batch.creates[0].uid, "b2");
  assert.equal(batch.prompt, "second");
});

// ═════════════════════════════════════════════════════════════════════════════
// executeUndo
// ═════════════════════════════════════════════════════════════════════════════

test("executeUndo deletes creates in reverse order and restores updates", async () => {
  const fake = setup({
    c1: { string: "first" },
    c2: { string: "second" },
    u1: { string: "edited" },
  });
  setLedgerRunContext("do things");
  captureBeforeImage("roam_update_block", { uid: "u1", text: "edited" });
  fake.blocks.u1.string = "edited"; // post-write state
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "c1" });
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "c2" });
  recordToolOutcome("roam_update_block", { uid: "u1", text: "edited" }, { success: true, updated_uid: "u1" });

  const report = await executeUndo();
  assert.equal(report.deleted, 2);
  assert.equal(report.restored, 1);
  assert.deepEqual(fake.calls.deletes, ["c2", "c1"]); // reverse creation order
  assert.equal(fake.calls.updates[0].uid, "u1");
  // batch cleared — no double undo
  assert.equal(getUndoableBatch(), null);
  assert.equal(await executeUndo(), null);
});

test("executeUndo skips drifted blocks (user edited since)", async () => {
  const fake = setup({ c1: { string: "as written" } });
  setLedgerRunContext("write");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "c1" });
  fake.blocks.c1.string = "user changed this"; // drift
  const report = await executeUndo();
  assert.equal(report.deleted, 0);
  assert.deepEqual(report.skippedDrift, ["c1"]);
  assert.deepEqual(fake.calls.deletes, []);
});

test("executeUndo skips missing blocks without error", async () => {
  const fake = setup({ c1: { string: "x" } });
  setLedgerRunContext("write");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "c1" });
  delete fake.blocks.c1; // deleted out from under us
  const report = await executeUndo();
  assert.equal(report.deleted, 0);
  assert.deepEqual(report.skippedMissing, ["c1"]);
});

test("executeUndo restores only touched fields", async () => {
  const fake = setup({ u1: { string: "old", heading: 2 } });
  setLedgerRunContext("edit");
  captureBeforeImage("roam_update_block", { uid: "u1", heading: 0 });
  recordToolOutcome("roam_update_block", { uid: "u1", heading: 0 }, { success: true, updated_uid: "u1" });
  const report = await executeUndo();
  assert.equal(report.restored, 1);
  const written = fake.calls.updates[0];
  assert.equal(written.heading, 2);
  assert.equal(written.string, undefined); // text untouched — not clobbered
});

test("executeUndo deletes a created page only when empty", async () => {
  const fake = setup({
    pg: { string: "", children: ["k1"] },
    k1: { string: "line" },
  });
  setLedgerRunContext("make page");
  recordToolOutcome("roam_create_page", { title: "P" }, {
    success: true, page_uid: "pg", title: "P", created: true, uids: ["k1"],
  });
  const report = await executeUndo();
  // k1 deleted first (reverse order), page then has no children left → deleted
  assert.deepEqual(fake.calls.deletes, ["k1"]);
  assert.equal(report.pagesDeleted, 1);
  assert.deepEqual(fake.calls.pageDeletes, ["pg"]);
});

test("executeUndo deletes an empty created page", async () => {
  const fake = setup({ pg: { string: "", children: [] } });
  setLedgerRunContext("make empty page");
  recordToolOutcome("roam_create_page", { title: "Empty" }, {
    success: true, page_uid: "pg", title: "Empty", created: true, uids: [],
  });
  const report = await executeUndo();
  assert.equal(report.pagesDeleted, 1);
  assert.deepEqual(fake.calls.pageDeletes, ["pg"]);
});

test("executeUndo keeps a created page that gained other content", async () => {
  const fake = setup({ pg: { string: "", children: ["stranger"] }, stranger: { string: "user added" } });
  setLedgerRunContext("make page");
  recordToolOutcome("roam_create_page", { title: "Busy" }, {
    success: true, page_uid: "pg", title: "Busy", created: true, uids: [],
  });
  const report = await executeUndo();
  assert.equal(report.pagesDeleted, 0);
  assert.deepEqual(report.pagesKept, ["Busy"]);
  assert.deepEqual(fake.calls.pageDeletes, []);
});

test("executeUndo collects failures instead of throwing", async () => {
  const fake = setup({ c1: { string: "x" } });
  fake.api.deleteBlock = () => { throw new Error("boom"); };
  setLedgerRunContext("write");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "c1" });
  const report = await executeUndo();
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0], /boom/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Summary + report copy
// ═════════════════════════════════════════════════════════════════════════════

test("buildUndoSummary names counts, declined, and external actions", () => {
  setup({ b1: { string: "x" }, u1: { string: "old" } });
  setLedgerRunContext("draft my agenda");
  recordToolOutcome("roam_create_block", {}, { success: true, uid: "b1" });
  captureBeforeImage("roam_update_block", { uid: "u1", text: "new" });
  recordToolOutcome("roam_update_block", { uid: "u1", text: "new" }, { success: true, updated_uid: "u1" });
  recordToolOutcome("roam_delete_block", { uid: "d1" }, { success: true, deleted_uid: "d1" });
  recordOtherAction("GMAIL_SEND_EMAIL via Composio");
  const summary = buildUndoSummary(getUndoableBatch());
  assert.match(summary, /draft my agenda/);
  assert.match(summary, /Delete 1 block/);
  assert.match(summary, /Restore 1 block/);
  assert.match(summary, /can't safely auto-reverse/);
  assert.match(summary, /GMAIL_SEND_EMAIL/);
  assert.match(summary, /Cmd\+Z/);
});

test("buildUndoReport summarises a mixed result", () => {
  const text = buildUndoReport({
    restored: 2, deleted: 3, pagesDeleted: 0,
    skippedDrift: ["a"], skippedMissing: [], pagesKept: ["Busy"],
    failed: [], declined: ["deleted block d1"], others: ["GMAIL_SEND_EMAIL"],
  });
  assert.match(text, /deleted 3 created blocks/);
  assert.match(text, /restored 2 edited blocks/);
  assert.match(text, /edited since/);
  assert.match(text, /\[\[Busy\]\]/);
  assert.match(text, /check manually/);
  assert.match(text, /GMAIL_SEND_EMAIL/);
});

test("recordOtherAction dedupes identical labels", () => {
  setup();
  setLedgerRunContext("x");
  recordOtherAction("GMAIL_SEND_EMAIL");
  recordOtherAction("GMAIL_SEND_EMAIL");
  assert.equal(getUndoableBatch().others.length, 1);
});

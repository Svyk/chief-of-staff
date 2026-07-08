import test from "node:test";
import assert from "node:assert/strict";
import { initRoamNativeTools, getRoamNativeTools, resetRoamNativeToolsCache, ROAM_CORE_TOOLS } from "../src/roam-native-tools.js";

/** Minimal deps stub for the search tools — override per test. */
function stubDeps(overrides = {}) {
  return {
    getRoamAlphaApi: () => ({}),
    queryRoamDatalog: async () => [],
    escapeForDatalog: (s) => s,
    debugLog: () => {},
    ...overrides,
  };
}

function getNamedTool(name, depsOverrides = {}) {
  resetRoamNativeToolsCache();
  initRoamNativeTools(stubDeps(depsOverrides));
  const tool = getRoamNativeTools().find(t => t.name === name);
  assert.ok(tool, `${name} tool should exist`);
  return tool;
}

/** Roam API stub with the native search surface (Clojure-style string keys). */
function searchApi({ searchResults = [], pullRecords = {}, semanticEnabled, semanticResults } = {}) {
  const data = {
    pull_many: (pattern, eids) => eids.map(([, uid]) => pullRecords[uid] || null),
    async: {
      search: async () => searchResults,
    },
  };
  if (semanticEnabled !== undefined) data.semanticSearchEnabled = () => semanticEnabled;
  if (semanticResults !== undefined) {
    data.async.semanticSearch = async () => {
      if (semanticResults instanceof Error) throw semanticResults;
      return semanticResults;
    };
  }
  return { data };
}

// ── Registration ──────────────────────────────────────────────────────────────

test("roam_search and roam_semantic_search are direct (core) tools, not orphaned behind ROAM_ROUTE", () => {
  assert.ok(ROAM_CORE_TOOLS.has("roam_search"));
  assert.ok(ROAM_CORE_TOOLS.has("roam_semantic_search"),
    "roam_semantic_search must be in ROAM_CORE_TOOLS so the agent sees it directly");
});

test("both search tools are non-mutating", () => {
  assert.equal(getNamedTool("roam_search").isMutating, false);
  assert.equal(getNamedTool("roam_semantic_search").isMutating, false);
});

// ── roam_search: native data.async.search backend ─────────────────────────────

test("roam_search uses data.async.search and shapes blocks + pages", async () => {
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [
        { ":block/uid": "b1", ":block/string": "Tennis is fun" },
        { ":block/uid": "p1", ":node/title": "Tennis Club" },
      ],
      pullRecords: {
        b1: { ":block/uid": "b1", ":block/string": "Tennis is fun", ":block/page": { ":node/title": "Sports" } },
      },
    }),
  });
  const results = await tool.execute({ query: "tennis" });
  assert.deepEqual(results, [
    { uid: "b1", text: "Tennis is fun", page: "Sports" },
    { uid: "p1", type: "page", page: "Tennis Club" },
  ]);
});

test("roam_search truncates oversized block text around the match", async () => {
  const longText = "x".repeat(3000) + "tennis" + "y".repeat(1000);
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [{ ":block/uid": "b1", ":block/string": longText }],
    }),
  });
  const [r] = await tool.execute({ query: "tennis" });
  assert.ok(r.text.length < 450, `snippet should be capped, got ${r.text.length} chars`);
  assert.ok(r.text.includes("tennis"), "snippet must contain the match");
  assert.ok(r.text.startsWith("…"), "late-match snippet should be windowed, not head-sliced");
});

test("roam_search head-slice truncation breaks at a word boundary with an ellipsis", async () => {
  const longText = "tennis " + "tincidunt ".repeat(60); // match up front, >400 chars total
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [{ ":block/uid": "b1", ":block/string": longText }],
    }),
  });
  const [r] = await tool.execute({ query: "tennis" });
  assert.match(r.text, /tincidunt …$/, "snippet must end on a whole word followed by an ellipsis");
});

test("roam_search caps native results at max_results and appends an overflow note", async () => {
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [
        { ":block/uid": "b1", ":block/string": "one tennis" },
        { ":block/uid": "b2", ":block/string": "two tennis" },
        { ":block/uid": "b3", ":block/string": "three tennis" },
      ],
    }),
  });
  const results = await tool.execute({ query: "tennis", max_results: 2 });
  assert.equal(results.length, 3);
  assert.equal(results[0].uid, "b1");
  assert.equal(results[1].uid, "b2");
  assert.match(results[2]._note, /Showing 2 of 3 matches/);
});

test("roam_search falls back to the Datalog scan when data.async.search is unavailable", async () => {
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => ({}),
    queryRoamDatalog: async () => [["u1", "play tennis daily", "Journal"]],
  });
  const results = await tool.execute({ query: "tennis" });
  assert.deepEqual(results, [{ uid: "u1", text: "play tennis daily", page: "Journal" }]);
});

test("roam_search falls back to the Datalog scan when data.async.search throws", async () => {
  const api = searchApi({});
  api.data.async.search = async () => { throw new Error("engine offline"); };
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => api,
    queryRoamDatalog: async () => [["u1", "play tennis daily", "Journal"]],
  });
  const results = await tool.execute({ query: "tennis" });
  assert.equal(results[0].uid, "u1");
});

// ── roam_semantic_search ──────────────────────────────────────────────────────

test("roam_semantic_search hydrates skeleton results (block, page, chunk via topUids)", async () => {
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({
      semanticEnabled: true,
      semanticResults: [
        { type: "block", uid: "b1", topUids: ["b1"] },
        { type: "page", uid: "p1", topUids: ["p1"] },
        { type: "chunk", uid: "c1", topUids: ["t1"] },
      ],
      pullRecords: {
        b1: { ":block/uid": "b1", ":block/string": "Poore played racquets", ":block/page": { ":node/title": "Robert Poore" } },
        p1: { ":block/uid": "p1", ":node/title": "Arthur Ashe" },
        t1: { ":block/uid": "t1", ":block/string": "Whoop smartblock code", ":block/page": { ":node/title": "Whoop SmartBlock" } },
      },
    }),
  });
  const results = await tool.execute({ query: "racquet sports" });
  assert.deepEqual(results, [
    { uid: "b1", type: "block", text: "Poore played racquets", page: "Robert Poore" },
    { uid: "p1", type: "page", page: "Arthur Ashe" },
    { uid: "c1", type: "chunk", text: "Whoop smartblock code", page: "Whoop SmartBlock" },
  ]);
});

test("roam_semantic_search applies its own limit and dedupes (API ignores limit param)", async () => {
  const skeletons = Array.from({ length: 30 }, (_, i) => ({ type: "block", uid: `u${i}`, topUids: [`u${i}`] }));
  skeletons.splice(1, 0, { type: "chunk", uid: "u0", topUids: ["u0"] }); // duplicate uid
  const pullRecords = {};
  for (let i = 0; i < 30; i++) pullRecords[`u${i}`] = { ":block/uid": `u${i}`, ":block/string": `text ${i}` };
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({ semanticEnabled: true, semanticResults: skeletons, pullRecords }),
  });
  const results = await tool.execute({ query: "anything", max_results: 5 });
  assert.equal(results.length, 5);
  assert.deepEqual(results.map(r => r.uid), ["u0", "u1", "u2", "u3", "u4"], "duplicate uid must not appear twice");
});

test("roam_semantic_search falls back to lexical search when semantic search is not enabled", async () => {
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({
      semanticEnabled: false,
      searchResults: [{ ":block/uid": "b1", ":block/string": "burnout notes" }],
    }),
  });
  const results = await tool.execute({ query: "burnout" });
  assert.match(results[0]._note, /not enabled/i);
  assert.equal(results[1].uid, "b1");
});

test("roam_semantic_search falls back to lexical search when semanticSearch throws", async () => {
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({
      semanticEnabled: true,
      semanticResults: new Error("not signed in"),
      searchResults: [{ ":block/uid": "b1", ":block/string": "burnout notes" }],
    }),
  });
  const results = await tool.execute({ query: "burnout" });
  assert.match(results[0]._note, /Semantic search failed \(not signed in\)/);
  assert.equal(results[1].uid, "b1");
});

test("roam_search snippets are single-line with code fences stripped", async () => {
  const codeBlock = "<%JAVASCRIPTASYNC:\n```javascript\nvar user = await roam42.settings.get('WhoopUsername');\n```%> tennis " + "padding words here ".repeat(30);
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [{ ":block/uid": "b1", ":block/string": codeBlock }],
    }),
  });
  const [r] = await tool.execute({ query: "tennis" });
  assert.ok(!r.text.includes("```"), "fence markers must be stripped — a truncated open fence swallows the rest of the message");
  assert.ok(!r.text.includes("\n"), "snippets must be single-line so they can't break bullet-list rendering");
  assert.ok(r.text.includes("tennis"));
});

test("roam_search filters out COS log pages (audit trail self-pollution)", async () => {
  const tool = getNamedTool("roam_search", {
    getRoamAlphaApi: () => searchApi({
      searchResults: [
        { ":block/uid": "a1", ":block/string": "Prompt: search for tennis — success" },
        { ":block/uid": "b1", ":block/string": "Tennis is fun" },
        { ":block/uid": "p1", ":node/title": "Chief of Staff/Audit Log" },
      ],
      pullRecords: {
        a1: { ":block/uid": "a1", ":block/page": { ":node/title": "Chief of Staff/Audit Log" } },
        b1: { ":block/uid": "b1", ":block/page": { ":node/title": "Sports" } },
      },
    }),
  });
  const results = await tool.execute({ query: "tennis" });
  assert.deepEqual(results.map(r => r.uid), ["b1"], "audit-log block and page hits must be excluded");
});

test("roam_semantic_search filters out COS log pages", async () => {
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({
      semanticEnabled: true,
      semanticResults: [
        { type: "block", uid: "a1", topUids: ["a1"] },
        { type: "block", uid: "b1", topUids: ["b1"] },
      ],
      pullRecords: {
        a1: { ":block/uid": "a1", ":block/string": "Prompt: racquet sports", ":block/page": { ":node/title": "Chief of Staff/Audit Log" } },
        b1: { ":block/uid": "b1", ":block/string": "Poore played racquets", ":block/page": { ":node/title": "Robert Poore" } },
      },
    }),
  });
  const results = await tool.execute({ query: "racquet sports" });
  assert.deepEqual(results.map(r => r.uid), ["b1"]);
});

test("roam_semantic_search returns a helpful note when there are no semantic matches", async () => {
  const tool = getNamedTool("roam_semantic_search", {
    getRoamAlphaApi: () => searchApi({ semanticEnabled: true, semanticResults: [] }),
  });
  const results = await tool.execute({ query: "quantum basket weaving" });
  assert.equal(results.length, 1);
  assert.match(results[0]._note, /No semantic matches/);
});

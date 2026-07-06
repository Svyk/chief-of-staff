import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_COMMANDS, filterSlashCommands } from "../src/chat-commands.js";

// ── Registry shape ────────────────────────────────────────────────────────────

test("every command has a slash-prefixed name and a non-empty summary", () => {
  assert.ok(CHAT_COMMANDS.length > 0);
  for (const c of CHAT_COMMANDS) {
    assert.match(c.name, /^\/\w/, `name should start with /: ${c.name}`);
    assert.equal(typeof c.summary, "string");
    assert.ok(c.summary.trim().length > 0, `summary missing for ${c.name}`);
    if (c.aliases) assert.ok(Array.isArray(c.aliases));
  }
});

test("registry does not surface /allow-homoglyph", () => {
  const names = CHAT_COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]);
  assert.ok(!names.includes("/allow-homoglyph"));
});

// ── filterSlashCommands ───────────────────────────────────────────────────────

test("empty query returns every command keyed on its canonical name", () => {
  const all = filterSlashCommands("");
  assert.equal(all.length, CHAT_COMMANDS.length);
  assert.equal(all[0].matchedName, all[0].command.name);
});

test("prefix match returns all commands starting with the query", () => {
  const p = filterSlashCommands("p").map((r) => r.matchedName);
  assert.ok(p.includes("/plan"));
  assert.ok(p.includes("/power"));
  assert.ok(!p.includes("/clear"));
});

test("prefix narrows to a single command", () => {
  const ex = filterSlashCommands("ex");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].matchedName, "/export");
});

test("alias match reports the alias as matchedName, not the canonical name", () => {
  const ne = filterSlashCommands("ne");
  assert.equal(ne.length, 1);
  assert.equal(ne[0].command.name, "/clear");
  assert.equal(ne[0].matchedName, "/new");
});

test("canonical name matches by its own prefix (not just via alias)", () => {
  // "cl" matches both /clear and /claude — assert /clear is present via its name.
  const names = filterSlashCommands("cl").map((r) => r.matchedName);
  assert.ok(names.includes("/clear"));
  assert.ok(names.includes("/claude"));
});

test("match is case-insensitive", () => {
  assert.equal(filterSlashCommands("EX")[0].matchedName, "/export");
  assert.equal(filterSlashCommands("Plan")[0].matchedName, "/plan");
});

test("a leading slash in the query is tolerated", () => {
  assert.equal(filterSlashCommands("/ex")[0].matchedName, "/export");
});

test("no match returns an empty array", () => {
  assert.deepEqual(filterSlashCommands("zzz"), []);
});

test("null / undefined query behave like empty", () => {
  assert.equal(filterSlashCommands(null).length, CHAT_COMMANDS.length);
  assert.equal(filterSlashCommands(undefined).length, CHAT_COMMANDS.length);
});

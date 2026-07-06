import test from "node:test";
import assert from "node:assert/strict";
import {
  detectPlanFlag,
  stripPlanFlag,
  extractPlanStructure,
  setPendingPlan,
  getPendingPlan,
  clearPendingPlan,
  buildPlanModeAddendum,
  buildExecutionAddendum,
  PENDING_PLAN_TTL_MS,
} from "../src/plan-mode.js";

// ═════════════════════════════════════════════════════════════════════════════
// detectPlanFlag / stripPlanFlag
// ═════════════════════════════════════════════════════════════════════════════

test("detectPlanFlag matches /plan at start, end, and mid message", () => {
  assert.equal(detectPlanFlag("/plan build a summary"), true);
  assert.equal(detectPlanFlag("build a summary /plan"), true);
  assert.equal(detectPlanFlag("please /plan this"), true);
  assert.equal(detectPlanFlag("/PLAN loud"), true);
});

test("detectPlanFlag does not match substrings like /planning", () => {
  assert.equal(detectPlanFlag("/planning the week"), false);
  assert.equal(detectPlanFlag("make a plan"), false);
  assert.equal(detectPlanFlag("/planner"), false);
});

test("detectPlanFlag handles empty and non-string input", () => {
  assert.equal(detectPlanFlag(""), false);
  assert.equal(detectPlanFlag(null), false);
  assert.equal(detectPlanFlag(undefined), false);
});

test("stripPlanFlag removes the flag and trims", () => {
  assert.equal(stripPlanFlag("/plan build a summary"), "build a summary");
  assert.equal(stripPlanFlag("build a summary /plan"), "build a summary");
  assert.equal(stripPlanFlag("please /plan this"), "please  this".replace(/\s+/g, " ").trim());
  assert.equal(stripPlanFlag("/plan"), "");
});

test("stripPlanFlag leaves /planning intact", () => {
  assert.equal(stripPlanFlag("/planning the week"), "/planning the week");
});

// ═════════════════════════════════════════════════════════════════════════════
// extractPlanStructure
// ═════════════════════════════════════════════════════════════════════════════

test("extractPlanStructure parses a well-formed plan", () => {
  const response = `I'll look into this.

## Plan
1. Call roam_search to find the project page.
2. Call roam_create_block to add the summary.

Writes: [[Project X]], [[Project X/Summary]]
Mutations: 2`;
  const result = extractPlanStructure(response);
  assert.ok(result);
  assert.ok(result.planText.startsWith("## Plan"));
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.writeTargets, ["Project X", "Project X/Summary"]);
  assert.equal(result.mutationCount, 2);
});

test("extractPlanStructure returns null when no Plan heading present", () => {
  assert.equal(extractPlanStructure("Just a normal answer with no plan."), null);
  assert.equal(extractPlanStructure(""), null);
  assert.equal(extractPlanStructure(null), null);
});

test("extractPlanStructure is lenient on missing sub-fields", () => {
  const response = `## Plan\nDo the thing, then the other thing.`;
  const result = extractPlanStructure(response);
  assert.ok(result);
  assert.equal(result.steps.length, 0);
  assert.deepEqual(result.writeTargets, []);
  assert.equal(result.mutationCount, null);
});

test("extractPlanStructure treats Writes: none as no targets", () => {
  const response = `## Plan\n1. Just read things.\nWrites: none\nMutations: 0`;
  const result = extractPlanStructure(response);
  assert.deepEqual(result.writeTargets, []);
  assert.equal(result.mutationCount, 0);
});

test("extractPlanStructure accepts bold and bulleted field labels", () => {
  const response = `### Plan\n1. Step one\n- **Writes:** [[A]]\n- **Mutations:** 1`;
  const result = extractPlanStructure(response);
  assert.deepEqual(result.writeTargets, ["A"]);
  assert.equal(result.mutationCount, 1);
  assert.equal(result.steps.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// pending-plan lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test("setPendingPlan / getPendingPlan round-trips and increments id", () => {
  clearPendingPlan();
  const a = setPendingPlan({ originalPrompt: "do X", planText: "## Plan\n1. X" });
  assert.equal(getPendingPlan().originalPrompt, "do X");
  assert.equal(getPendingPlan().planText, "## Plan\n1. X");
  const firstId = a.id;
  const b = setPendingPlan({ originalPrompt: "do Y", planText: "## Plan\n1. Y" });
  assert.equal(b.id, firstId + 1);
  assert.equal(getPendingPlan().originalPrompt, "do Y");
  clearPendingPlan();
});

test("getPendingPlan returns null after clear", () => {
  setPendingPlan({ originalPrompt: "p", planText: "## Plan" });
  clearPendingPlan();
  assert.equal(getPendingPlan(), null);
});

test("getPendingPlan expires lazily after the TTL and clears state", () => {
  clearPendingPlan();
  const t0 = 1_000_000;
  setPendingPlan({ originalPrompt: "p", planText: "## Plan" }, t0);
  // Just before expiry — still present.
  assert.ok(getPendingPlan(t0 + PENDING_PLAN_TTL_MS - 1));
  // At expiry — gone, and state cleared as a side effect.
  assert.equal(getPendingPlan(t0 + PENDING_PLAN_TTL_MS), null);
  assert.equal(getPendingPlan(t0), null); // stays cleared even with an earlier clock
});

test("setPendingPlan coerces missing fields to strings", () => {
  clearPendingPlan();
  const rec = setPendingPlan({});
  assert.equal(rec.originalPrompt, "");
  assert.equal(rec.planText, "");
  clearPendingPlan();
});

// ═════════════════════════════════════════════════════════════════════════════
// addenda
// ═════════════════════════════════════════════════════════════════════════════

test("buildPlanModeAddendum instructs a ## Plan section and future tense, not inbox wording", () => {
  const addendum = buildPlanModeAddendum();
  assert.match(addendum, /PLAN MODE/);
  assert.match(addendum, /## Plan/);
  assert.match(addendum, /WILL do/);
  assert.doesNotMatch(addendum, /inbox/i);
});

test("buildExecutionAddendum embeds the approved plan verbatim and forbids re-confirmation", () => {
  const plan = "## Plan\n1. Do the thing.";
  const addendum = buildExecutionAddendum(plan);
  assert.match(addendum, /approved the following plan/);
  assert.ok(addendum.includes(plan));
  assert.match(addendum, /do not ask for confirmation again/i);
  assert.match(addendum, /stop and explain/i);
});

test("buildExecutionAddendum returns empty string for missing / blank plan", () => {
  assert.equal(buildExecutionAddendum(null), "");
  assert.equal(buildExecutionAddendum(undefined), "");
  assert.equal(buildExecutionAddendum("   "), "");
  assert.equal(buildExecutionAddendum(""), "");
});

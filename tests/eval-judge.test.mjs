import test from "node:test";
import assert from "node:assert/strict";
import { buildEvalPayload } from "../src/eval-judge.js";

const TRACE = { toolCalls: [{ name: "roam_get_page" }], guardsFired: [], iterations: 2, model: "gpt-5.4" };

// ═════════════════════════════════════════════════════════════════════════════
// buildEvalPayload — truncation flag must reflect the EFFECTIVE limit
// ═════════════════════════════════════════════════════════════════════════════

test("buildEvalPayload does not label a whole response as truncated when it fits the effective limit", () => {
  // 900 chars, evaluated with a skill-eval limit of 3000 — nothing was cut.
  const response = "x".repeat(900);
  const payload = buildEvalPayload(TRACE, "prompt", response, { responseCharLimit: 3000 });
  assert.ok(!payload.includes("truncated for eval"), "complete response must not be labelled a preview");
  assert.ok(payload.includes(response), "full response must be present");
});

test("buildEvalPayload labels a genuinely truncated response and reports the real length", () => {
  const response = "y".repeat(5000);
  const payload = buildEvalPayload(TRACE, "prompt", response, { responseCharLimit: 3000 });
  assert.ok(payload.includes("truncated for eval"));
  assert.ok(payload.includes("full response was 5000 chars"));
  // Only the first 3000 chars are included
  assert.ok(!payload.includes("y".repeat(3001)));
});

test("buildEvalPayload still truncates at the 500-char default when no limit is passed", () => {
  const response = "z".repeat(800);
  const payload = buildEvalPayload(TRACE, "prompt", response, {});
  assert.ok(payload.includes("truncated for eval"));
  assert.ok(!payload.includes("z".repeat(501)));
});

test("buildEvalPayload marks a long prompt as truncated independently of the response", () => {
  const payload = buildEvalPayload(TRACE, "p".repeat(400), "short", { responseCharLimit: 3000 });
  assert.ok(payload.includes("User prompt (preview, truncated for eval)"));
  assert.ok(!payload.includes("Response (preview"), "short response must not be flagged");
});

test("buildEvalPayload surfaces tool calls and guards for the judge", () => {
  const payload = buildEvalPayload(
    { toolCalls: [{ name: "roam_search" }, { name: "roam_get_page", error: "boom" }], guardsFired: ["stale_result"], iterations: 3, model: "m" },
    "prompt", "response", {}
  );
  assert.ok(payload.includes("roam_search (success)"));
  assert.ok(payload.includes("roam_get_page (error)"));
  assert.ok(payload.includes("Guards fired: stale_result"));
  assert.ok(payload.includes("Agent iterations: 3"));
});

test("buildEvalPayload reports none for empty tool calls and guards", () => {
  const payload = buildEvalPayload({ toolCalls: [], guardsFired: [] }, "p", "r", {});
  assert.ok(payload.includes("Tools called: none"));
  assert.ok(payload.includes("Guards fired: none"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Rubric evals must see enough of the response to verify tail-referencing checks
// ═════════════════════════════════════════════════════════════════════════════

test("a 6000-char limit admits a full skill report whose summary sits at the tail", () => {
  // Simulates a Skill Assumption Audit: long body, arithmetic summary at the end.
  const body = "- guardrail line with justification\n".repeat(120); // ~4,300 chars
  const summary = "\n~47 of this skill's ~520 tokens are removable (9.0%).";
  const response = body + summary;
  assert.ok(response.length > 3000, "fixture must exceed the old 3,000-char cap");

  const cut = buildEvalPayload(TRACE, "prompt", response, { responseCharLimit: 3000 });
  assert.ok(!cut.includes("are removable"), "at 3,000 chars the tail summary is invisible to the judge");

  const whole = buildEvalPayload(TRACE, "prompt", response, { responseCharLimit: 6000 });
  assert.ok(whole.includes("are removable"), "at 6,000 chars the judge can verify the closing total");
});

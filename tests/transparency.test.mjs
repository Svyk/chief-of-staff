import test from "node:test";
import assert from "node:assert/strict";
import {
  setLastAskMeta,
  getLastAskMeta,
  clearLastAskMeta,
  describeTierReason,
  buildWhyReport,
  buildStatusReport,
  buildVerifyReport,
} from "../src/transparency.js";

// ═════════════════════════════════════════════════════════════════════════════
// Last-ask metadata slot
// ═════════════════════════════════════════════════════════════════════════════

test("setLastAskMeta stamps a timestamp and getLastAskMeta returns it", () => {
  clearLastAskMeta();
  setLastAskMeta({ kind: "deterministic", promptPreview: "what time is it" });
  const meta = getLastAskMeta();
  assert.equal(meta.kind, "deterministic");
  assert.ok(Number.isFinite(meta.at));
  clearLastAskMeta();
  assert.equal(getLastAskMeta(), null);
});

test("setLastAskMeta(null) clears the slot", () => {
  setLastAskMeta({ kind: "agent" });
  setLastAskMeta(null);
  assert.equal(getLastAskMeta(), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// describeTierReason
// ═════════════════════════════════════════════════════════════════════════════

test("tier reason priority: provider override > ludicrous > power > plan > escalation > default", () => {
  const base = { kind: "agent", tier: "power", baseTier: "mini", flags: {}, escalation: {} };
  assert.match(describeTierReason({ ...base, flags: { providerOverride: "openai" } }), /forced the openai provider/);
  assert.match(describeTierReason({ ...base, flags: { ludicrous: true } }), /\/ludicrous/);
  assert.match(describeTierReason({ ...base, flags: { power: true } }), /\/power/);
  assert.match(describeTierReason({ ...base, flags: { plan: true } }), /[Pp]lan mode/);
  assert.match(
    describeTierReason({ ...base, escalation: { routingReason: "skill-heavy prompt" } }),
    /Auto-escalated from mini: skill-heavy prompt/
  );
  assert.match(describeTierReason({ ...base, escalation: { mcpRouted: true } }), /MCP server/);
  assert.match(describeTierReason({ ...base, escalation: { intentEscalated: true } }), /intent classifier/);
  assert.match(
    describeTierReason({ kind: "agent", tier: "mini", baseTier: "mini", flags: {}, escalation: {} }),
    /Default mini tier/
  );
});

test("describeTierReason is empty for deterministic or missing meta", () => {
  assert.equal(describeTierReason(null), "");
  assert.equal(describeTierReason({ kind: "deterministic" }), "");
});

// ═════════════════════════════════════════════════════════════════════════════
// buildWhyReport
// ═════════════════════════════════════════════════════════════════════════════

test("buildWhyReport with nothing yet", () => {
  const text = buildWhyReport(null, null);
  assert.match(text, /haven't answered anything/);
});

test("buildWhyReport for a deterministic answer names the fast path and zero cost", () => {
  const text = buildWhyReport({ kind: "deterministic", promptPreview: "open [[Foo]]" }, null);
  assert.match(text, /Instant answer — no model call/);
  assert.match(text, /open \[\[Foo\]\]/);
  assert.match(text, /No tokens/);
});

test("buildWhyReport for an agent run includes model, tier reason, tools, guards, context", () => {
  const meta = {
    kind: "agent", promptPreview: "summarise my week", tier: "power", baseTier: "mini",
    flags: {}, escalation: { routingReason: "conversation trajectory" },
  };
  const trace = {
    provider: "anthropic", model: "claude-sonnet-4-6",
    promptPreview: "summarise my week",
    startedAt: 1000, finishedAt: 8200, iterations: 3, priorContextTurns: 2,
    toolCalls: [
      { name: "roam_search", durationMs: 420 },
      { name: "roam_get_page", durationMs: 300, error: "Page not found" },
    ],
    guardsFired: ["liveData", "liveData"],
    inputBreakdown: { estInputTokens: 12345, toolPct: 41, toolCount: 23 },
  };
  const text = buildWhyReport(meta, trace);
  assert.match(text, /claude-sonnet-4-6 \(anthropic\)/);
  assert.match(text, /\*\*power\*\* tier/);
  assert.match(text, /Auto-escalated from mini: conversation trajectory/);
  assert.match(text, /3 iterations, 2 tool calls, 7\.2s/);
  assert.match(text, /`roam_search` \(420ms\)/);
  assert.match(text, /`roam_get_page`.*failed: Page not found/);
  assert.match(text, /live-data guard/);
  // duplicate guard entries are deduped
  assert.equal((text.match(/live-data guard/g) || []).length, 1);
  assert.match(text, /2 prior conversation turns/);
  assert.match(text, /~12,345 tokens \(41% tool definitions, 23 tools offered\)/);
});

test("buildWhyReport caps the tool list at 15 entries", () => {
  const trace = {
    provider: "openai", model: "gpt-5.4-mini", promptPreview: "x",
    startedAt: 0, finishedAt: 100, iterations: 1, priorContextTurns: 0,
    toolCalls: Array.from({ length: 20 }, (_, i) => ({ name: `tool_${i}`, durationMs: 5 })),
    guardsFired: [],
  };
  const text = buildWhyReport(null, trace);
  assert.match(text, /…and 5 more/);
});

test("buildWhyReport works from trace alone (no meta, e.g. after reload)", () => {
  const trace = {
    provider: "gemini", model: "gemini-3.1-flash-lite", promptPreview: "hello",
    startedAt: 0, finishedAt: 500, iterations: 1, priorContextTurns: 0, toolCalls: [], guardsFired: [],
  };
  const text = buildWhyReport(null, trace);
  assert.match(text, /gemini-3\.1-flash-lite/);
  assert.match(text, /fresh conversation/);
});

test("buildWhyReport surfaces run errors", () => {
  const trace = {
    provider: "groq", model: "llama-3.3-70b-versatile", promptPreview: "x",
    startedAt: 0, finishedAt: 10, iterations: 1, priorContextTurns: 0,
    toolCalls: [], guardsFired: [], error: "All providers failed",
  };
  assert.match(buildWhyReport(null, trace), /\*\*Error:\*\* All providers failed/);
});

// ═════════════════════════════════════════════════════════════════════════════
// buildStatusReport
// ═════════════════════════════════════════════════════════════════════════════

const NOW = 1_000_000_000_000;

test("buildStatusReport empty snapshot shows honest 'none' lines", () => {
  const text = buildStatusReport({ now: NOW });
  assert.match(text, /Composio: not connected/);
  assert.match(text, /Local MCP: none connected/);
  assert.match(text, /Remote MCP: none connected/);
  assert.match(text, /Scheduled jobs\*\*\n- None/);
  assert.match(text, /Idle scheduler not running/);
  assert.match(text, /No plan awaiting approval/);
  assert.match(text, /Nothing to undo/);
  assert.match(text, /0 requests, 0 tokens, \$0\.00/);
});

test("buildStatusReport renders connections, jobs, idle, pending, session", () => {
  const text = buildStatusReport({
    now: NOW,
    composio: { connected: true, installedCount: 4, pendingCount: 1 },
    localMcp: [{ name: "Zotero", tools: 18 }],
    remoteMcp: [{ name: "Open Brain", tools: 9 }],
    cronJobs: [
      { name: "Daily briefing", type: "cron", expression: "0 7 * * *", enabled: true, lastRun: NOW - 3_600_000 },
      { name: "Old job", type: "cron", expression: "0 0 * * *", enabled: false },
      { name: "Poller", type: "interval", intervalMinutes: 30, enabled: true, lastRun: 0, lastRunError: "timeout" },
    ],
    idle: { running: true, isCoordinator: true, registeredTasks: ["corrections", "graph-hygiene"], activeTaskId: null },
    pendingPlan: { originalPrompt: "reorganise my projects", createdAt: NOW - 120_000 },
    undoBatch: { prompt: "draft agenda", creates: [{}, {}], updates: [{}] },
    session: { totalRequests: 7, totalInputTokens: 90_000, totalOutputTokens: 10_000, totalCostUsd: 0.42 },
  });
  assert.match(text, /Composio: connected \(4 tools installed, 1 pending auth\)/);
  assert.match(text, /Local MCP: Zotero \(18 tools\)/);
  assert.match(text, /Remote MCP: Open Brain \(9 tools\)/);
  assert.match(text, /Daily briefing — `0 7 \* \* \*`, last ran 1h ago/);
  assert.match(text, /Poller — every 30m, never run ⚠️ last run failed: timeout/);
  assert.match(text, /\(1 more disabled\)/);
  assert.match(text, /this tab coordinates.*corrections, graph-hygiene/);
  assert.match(text, /Plan awaiting approval: "reorganise my projects" \(2m ago\)/);
  assert.match(text, /Undoable: my last run \("draft agenda"\) — 2 created, 1 edited/);
  assert.match(text, /7 requests, 100,000 tokens, \$0\.42/);
});

test("buildStatusReport shows sub-cent session cost in cents", () => {
  const text = buildStatusReport({ now: NOW, session: { totalRequests: 1, totalInputTokens: 100, totalOutputTokens: 50, totalCostUsd: 0.0042 } });
  assert.match(text, /0\.42¢/);
});

test("buildStatusReport formats once-type jobs with a future relative time", () => {
  const text = buildStatusReport({
    now: NOW,
    cronJobs: [{ name: "Reminder", type: "reminder", runAt: NOW + 7_200_000, enabled: true, lastRun: 0 }],
  });
  assert.match(text, /Reminder — once, in 2h/);
});

// ═════════════════════════════════════════════════════════════════════════════
// buildVerifyReport
// ═════════════════════════════════════════════════════════════════════════════

test("buildVerifyReport handles a null eval result", () => {
  assert.match(buildVerifyReport(null), /couldn't score/);
});

test("buildVerifyReport renders scores, checks, concern, and queue note", () => {
  const text = buildVerifyReport({
    scores: {
      task_completion: 5,
      factual_grounding: 2,
      safety: 5,
      checks: [
        { id: "claims_tool_backed", pass: true },
        { id: "answered_question", pass: false, reason: "response was off-topic" },
      ],
      concern: "possible stale data",
    },
    queued: true,
  });
  assert.match(text, /Task completion: 5\/5/);
  assert.match(text, /Factual grounding: 2\/5 ⚠️/);
  assert.match(text, /✅ claims_tool_backed/);
  assert.match(text, /❌ answered_question — response was off-topic/);
  assert.match(text, /Judge's concern:\*\* possible stale data/);
  assert.match(text, /Review Queue/);
});

test("buildVerifyReport omits queue note when not queued", () => {
  const text = buildVerifyReport({ scores: { task_completion: 5, factual_grounding: 5, safety: 5, checks: [] }, queued: false });
  assert.doesNotMatch(text, /Review Queue/);
});

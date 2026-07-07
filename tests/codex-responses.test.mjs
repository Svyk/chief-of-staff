import test from "node:test";
import assert from "node:assert/strict";
import {
  translateMessagesToInputItems,
  translateToolsToCodex,
  buildCodexResponsesRequest,
  createCodexStreamState,
  reduceCodexSseEvent,
  mapCodexUsage,
  decodeJwtClaims,
  extractChatGptAccountId,
  extractJwtEmail,
} from "../src/codex-responses.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

// ── translateMessagesToInputItems ────────────────────────────────────────────

test("translates plain user/assistant turns", () => {
  const items = translateMessagesToInputItems([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi there" }] },
  ]);
});

test("assistant tool_calls become function_call items with matching call_id", () => {
  const items = translateMessagesToInputItems([
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "roam_search", arguments: "{\"query\":\"x\"}" } },
      ],
    },
  ]);
  assert.deepEqual(items, [
    { type: "function_call", call_id: "call_1", name: "roam_search", arguments: "{\"query\":\"x\"}" },
  ]);
});

test("assistant with both text and tool_calls emits text item then function_call items", () => {
  const items = translateMessagesToInputItems([
    {
      role: "assistant",
      content: "Let me search.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "call_2", type: "function", function: { name: "b", arguments: { k: 1 } } },
      ],
    },
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].role, "assistant");
  assert.equal(items[1].call_id, "call_1");
  assert.equal(items[2].call_id, "call_2");
  assert.equal(items[2].arguments, "{\"k\":1}"); // non-string args stringified
});

test("role:tool messages become function_call_output items", () => {
  const items = translateMessagesToInputItems([
    { role: "tool", tool_call_id: "call_1", content: "{\"ok\":true}" },
    { role: "tool", tool_call_id: "call_2", content: { raw: "object" } },
  ]);
  assert.deepEqual(items[0], { type: "function_call_output", call_id: "call_1", output: "{\"ok\":true}" });
  assert.equal(items[1].output, "{\"raw\":\"object\"}");
});

test("multi-turn agent transcript round-trips in order", () => {
  const items = translateMessagesToInputItems([
    { role: "user", content: "what's on today?" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "roam_get_daily_page", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "daily page content" },
    { role: "assistant", content: "You have 3 tasks." },
    { role: "user", content: "thanks" },
  ]);
  assert.deepEqual(
    items.map((i) => (i.type === "message" ? i.role : i.type)),
    ["user", "function_call", "function_call_output", "assistant", "user"]
  );
});

test("stray system messages map to user input text; malformed entries skipped", () => {
  const items = translateMessagesToInputItems([
    { role: "system", content: "be brief" },
    null,
    "junk",
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].role, "user");
  assert.equal(items[0].content[0].text, "be brief");
});

// ── translateToolsToCodex / buildCodexResponsesRequest ───────────────────────

test("tools translate to FLAT Responses format with sanitiser applied", () => {
  const sanitise = (schema) => ({ ...schema, sanitised: true });
  const out = translateToolsToCodex(
    [{ name: "roam_search", description: "Search", input_schema: { type: "object" } }],
    sanitise
  );
  assert.deepEqual(out, [{
    type: "function",
    name: "roam_search",
    description: "Search",
    parameters: { type: "object", sanitised: true },
    strict: false,
  }]);
  assert.equal(out[0].function, undefined); // NOT nested under `function`
});

test("buildCodexResponsesRequest sends Codex instructions verbatim; host system prompt becomes a developer input message", () => {
  const body = buildCodexResponsesRequest({
    model: "gpt-5.5",
    system: "You are COS.",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    codexInstructions: "OFFICIAL CODEX PROMPT",
  });
  assert.equal(body.model, "gpt-5.5");
  // The codex backend rejects arbitrary instructions — must be the official prompt
  assert.equal(body.instructions, "OFFICIAL CODEX PROMPT");
  assert.deepEqual(body.input[0], {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: "You are COS." }],
  });
  assert.equal(body.input[1].role, "user");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  // max_output_tokens is NOT supported by the codex backend
  assert.equal(body.max_output_tokens, undefined);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" });
  assert.deepEqual(body.text, { verbosity: "medium" });
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.tools, undefined); // omitted when empty
  assert.equal(body.tool_choice, undefined);
});

test("buildCodexResponsesRequest omits the developer message when system is empty", () => {
  const body = buildCodexResponsesRequest({
    model: "gpt-5.5",
    system: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    codexInstructions: "OFFICIAL CODEX PROMPT",
  });
  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].role, "user");
});

test("buildCodexResponsesRequest includes tools + tool_choice when tools present", () => {
  const body = buildCodexResponsesRequest({
    model: "gpt-5.5",
    system: "",
    messages: [],
    tools: [{ name: "t", description: "d", input_schema: {} }],
  });
  assert.equal(body.tools.length, 1);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
});

// ── SSE reducer ──────────────────────────────────────────────────────────────

test("output_text.delta accumulates and fires onTextChunk", () => {
  const state = createCodexStreamState();
  const chunks = [];
  reduceCodexSseEvent(state, { type: "response.output_text.delta", delta: "Hel" }, { onTextChunk: (d) => chunks.push(d) });
  reduceCodexSseEvent(state, { type: "response.output_text.delta", delta: "lo" }, { onTextChunk: (d) => chunks.push(d) });
  assert.equal(state.textContent, "Hello");
  assert.deepEqual(chunks, ["Hel", "lo"]);
});

test("text accumulation respects the 120k soft cap but chunks still stream", () => {
  const state = createCodexStreamState();
  state.textContent = "x".repeat(120001);
  let streamed = "";
  reduceCodexSseEvent(state, { type: "response.output_text.delta", delta: "more" }, { onTextChunk: (d) => { streamed += d; } });
  assert.equal(state.textContent.length, 120001); // no further accumulation
  assert.equal(streamed, "more");                 // but chunk still forwarded
});

test("output_item.done collects function_call items", () => {
  const state = createCodexStreamState();
  reduceCodexSseEvent(state, {
    type: "response.output_item.done",
    item: { type: "function_call", call_id: "call_9", name: "roam_search", arguments: "{\"query\":\"a\"}" },
  });
  reduceCodexSseEvent(state, { type: "response.output_item.done", item: { type: "message" } }); // non-function ignored
  assert.deepEqual(state.toolCalls, [{ id: "call_9", name: "roam_search", arguments: "{\"query\":\"a\"}" }]);
});

test("response.completed maps usage to chat-completions names", () => {
  const state = createCodexStreamState();
  reduceCodexSseEvent(state, {
    type: "response.completed",
    response: { usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 } },
  });
  assert.deepEqual(state.usage, { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 });
});

test("response.failed and error events set state.error", () => {
  const state = createCodexStreamState();
  reduceCodexSseEvent(state, { type: "response.failed", response: { error: { message: "boom" } } });
  assert.equal(state.error, "boom");
  const state2 = createCodexStreamState();
  reduceCodexSseEvent(state2, { type: "error", message: "stream broke" });
  assert.equal(state2.error, "stream broke");
});

test("unknown event types are no-ops", () => {
  const state = createCodexStreamState();
  reduceCodexSseEvent(state, { type: "response.reasoning_summary.delta", delta: "thinking" });
  reduceCodexSseEvent(state, { type: "response.in_progress" });
  reduceCodexSseEvent(state, {});
  reduceCodexSseEvent(state, null);
  assert.equal(state.textContent, "");
  assert.equal(state.toolCalls.length, 0);
  assert.equal(state.error, null);
});

test("mapCodexUsage computes total when absent and handles garbage", () => {
  assert.deepEqual(mapCodexUsage({ input_tokens: 10, output_tokens: 5 }), { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  assert.equal(mapCodexUsage(null), null);
  assert.equal(mapCodexUsage("junk"), null);
});

// ── JWT helpers ──────────────────────────────────────────────────────────────

test("decodeJwtClaims decodes a valid payload", () => {
  const claims = decodeJwtClaims(makeJwt({ chatgpt_account_id: "acct_1", email: "m@example.com" }));
  assert.equal(claims.chatgpt_account_id, "acct_1");
  assert.equal(claims.email, "m@example.com");
});

test("decodeJwtClaims returns null on garbage", () => {
  assert.equal(decodeJwtClaims("not-a-jwt"), null);
  assert.equal(decodeJwtClaims("a.!!!.c"), null);
  assert.equal(decodeJwtClaims(null), null);
  assert.equal(decodeJwtClaims(42), null);
});

test("extractChatGptAccountId tries all three fallbacks in order", () => {
  assert.equal(extractChatGptAccountId({ chatgpt_account_id: "top" }), "top");
  assert.equal(extractChatGptAccountId({ "https://api.openai.com/auth": { chatgpt_account_id: "nested" } }), "nested");
  assert.equal(extractChatGptAccountId({ organizations: [{ id: "org_1" }] }), "org_1");
  assert.equal(extractChatGptAccountId({}), null);
  assert.equal(extractChatGptAccountId(null), null);
});

test("top-level account id wins over nested and orgs", () => {
  const id = extractChatGptAccountId({
    chatgpt_account_id: "top",
    "https://api.openai.com/auth": { chatgpt_account_id: "nested" },
    organizations: [{ id: "org_1" }],
  });
  assert.equal(id, "top");
});

test("extractJwtEmail reads top-level then namespaced claim", () => {
  assert.equal(extractJwtEmail({ email: "a@b.c" }), "a@b.c");
  assert.equal(extractJwtEmail({ "https://api.openai.com/auth": { email: "n@b.c" } }), "n@b.c");
  assert.equal(extractJwtEmail({}), "");
});

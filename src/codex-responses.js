// ═══════════════════════════════════════════════════════════════════════════════
// Codex Responses API — pure translation helpers
// ═══════════════════════════════════════════════════════════════════════════════
//
// The ChatGPT-subscription endpoint (chatgpt.com/backend-api/codex/responses)
// speaks the OpenAI Responses API, not chat completions. This module translates
// the extension's chat-completions-shaped internals (system string, messages
// with role/content/tool_calls, tools with input_schema) into Responses API
// request bodies, and reduces the Responses SSE event stream back into the
// { textContent, toolCalls, usage } shape callOpenAIStreaming returns.
//
// Everything here is pure and dependency-free (like parse-utils.js) so it can
// be unit-tested without DI or network mocks. JWT helpers live here too so the
// auth module can import them without pulling in fetch-dependent code.
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_TEXT_CONTENT_CHARS = 120000; // same soft cap as callOpenAIStreaming
const MAX_TOOL_ARGS_CHARS = 32768;     // same bound as chat-completions tool deltas

// ── Request translation ──────────────────────────────────────────────────────

function contentToString(content) {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Translate chat-completions-shaped messages into Responses API input items.
 * - user/assistant text → { role, content: [{ type: input_text|output_text, text }] }
 * - assistant tool_calls → { type: "function_call", call_id, name, arguments } items
 * - role:"tool" results  → { type: "function_call_output", call_id, output }
 */
export function translateMessagesToInputItems(messages) {
  const items = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: contentToString(msg.content)
      });
      continue;
    }
    if (msg.role === "assistant") {
      const text = contentToString(msg.content);
      if (text) {
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const args = tc?.function?.arguments;
          items.push({
            type: "function_call",
            call_id: tc?.id || "",
            name: tc?.function?.name || "",
            arguments: typeof args === "string" ? args : JSON.stringify(args || {})
          });
        }
      }
      continue;
    }
    // user (and any stray system) messages become input text
    items.push({
      type: "message",
      role: msg.role === "system" ? "user" : (msg.role || "user"),
      content: [{ type: "input_text", text: contentToString(msg.content) }]
    });
  }
  return items;
}

/**
 * Translate COS tool definitions ({ name, description, input_schema }) into
 * Responses API tools. The Responses format is FLAT — name/description/
 * parameters sit beside type:"function", not nested under a `function` key.
 * The schema sanitiser is passed in so llm-providers' existing
 * sanitiseToolSchema is reused without creating a dependency.
 */
export function translateToolsToCodex(tools, sanitiseSchema) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: sanitiseSchema ? sanitiseSchema(tool.input_schema) : tool.input_schema,
    strict: false
  }));
}

/**
 * Build the full Responses API request body for a codex streaming call.
 *
 * The chatgpt.com codex backend is strict about shape (confirmed by every
 * working third-party implementation and the Codex CLI itself):
 * - `instructions` MUST be the official Codex CLI prompt — arbitrary system
 *   prompts are rejected with 400. The host's real system prompt goes into
 *   `input` as a developer message instead.
 * - `store: false` is required; `include: ["reasoning.encrypted_content"]`
 *   pairs with it for stateless reasoning continuity.
 * - `max_output_tokens` is NOT supported and must be omitted.
 */
export function buildCodexResponsesRequest({ model, system, messages, tools, sanitiseSchema, codexInstructions }) {
  const input = translateMessagesToInputItems(messages);
  if (system) {
    input.unshift({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: system }]
    });
  }
  const body = {
    model,
    instructions: codexInstructions || "",
    input,
    store: false,
    stream: true,
    reasoning: { effort: "medium", summary: "auto" },
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"]
  };
  const codexTools = translateToolsToCodex(tools, sanitiseSchema);
  if (codexTools.length) {
    body.tools = codexTools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  return body;
}

// ── SSE stream reduction ─────────────────────────────────────────────────────

export function createCodexStreamState() {
  return {
    textContent: "",
    toolCalls: [], // { id, name, arguments: raw JSON string }
    usage: null,
    error: null,
    responseId: null
  };
}

/**
 * Map Responses API usage ({ input_tokens, output_tokens }) to the
 * chat-completions names agent-loop's accounting expects.
 */
export function mapCodexUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = usage.input_tokens || 0;
  const completion = usage.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.total_tokens || prompt + completion
  };
}

/**
 * Feed one parsed SSE event into the stream state. Unknown event types are
 * no-ops (the Responses stream emits many bookkeeping events we don't need).
 */
export function reduceCodexSseEvent(state, event, { onTextChunk } = {}) {
  if (!state || !event || typeof event.type !== "string") return state;
  switch (event.type) {
    case "response.created":
      if (event.response?.id) state.responseId = event.response.id;
      break;
    case "response.output_text.delta": {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) break;
      if (state.textContent.length < MAX_TEXT_CONTENT_CHARS) state.textContent += delta;
      if (onTextChunk) onTextChunk(delta);
      break;
    }
    case "response.output_item.done": {
      const item = event.item;
      if (item?.type === "function_call" && item.name) {
        const rawArgs = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {});
        state.toolCalls.push({
          id: item.call_id || item.id || "",
          name: item.name,
          arguments: rawArgs.slice(0, MAX_TOOL_ARGS_CHARS)
        });
      }
      break;
    }
    case "response.completed":
      if (event.response?.usage) state.usage = mapCodexUsage(event.response.usage);
      break;
    case "response.failed":
      state.error = event.response?.error?.message || "Codex response failed";
      break;
    case "response.incomplete":
      // Truncated (e.g. max_output_tokens) — keep partial text, record usage if present
      if (event.response?.usage) state.usage = mapCodexUsage(event.response.usage);
      break;
    case "error":
      state.error = event.message || event.error?.message || "Codex stream error";
      break;
    default:
      break;
  }
  return state;
}

// ── JWT helpers (for ChatGPT account id extraction) ──────────────────────────

/**
 * Decode the payload claims of a JWT without verification (we only need to
 * read the account id from tokens OpenAI just issued to us over TLS).
 * Returns null on anything malformed.
 */
export function decodeJwtClaims(jwt) {
  if (typeof jwt !== "string") return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const json = typeof atob === "function"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("utf8");
    // atob returns latin1; JWT payloads are UTF-8 — re-decode via escape trick
    const utf8 = decodeURIComponent(
      json.split("").map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    );
    return JSON.parse(utf8);
  } catch {
    try {
      // Fallback: payload was plain ASCII and the UTF-8 re-decode broke it
      let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const json = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("utf8");
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
}

// The claim namespace OpenAI uses for auth metadata in Codex id_tokens.
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * Extract the ChatGPT account id from decoded JWT claims. Tried in the same
 * order as the official Codex CLI: top-level claim → namespaced auth claim →
 * first organization id. Returns null when absent.
 */
export function extractChatGptAccountId(claims) {
  if (!claims || typeof claims !== "object") return null;
  if (claims.chatgpt_account_id) return claims.chatgpt_account_id;
  const authClaim = claims[OPENAI_AUTH_CLAIM];
  if (authClaim?.chatgpt_account_id) return authClaim.chatgpt_account_id;
  if (Array.isArray(claims.organizations) && claims.organizations[0]?.id) {
    return claims.organizations[0].id;
  }
  return null;
}

/**
 * Extract the user's email from decoded JWT claims (display only).
 */
export function extractJwtEmail(claims) {
  if (!claims || typeof claims !== "object") return "";
  if (typeof claims.email === "string") return claims.email;
  const authClaim = claims[OPENAI_AUTH_CLAIM];
  if (typeof authClaim?.email === "string") return authClaim.email;
  return "";
}

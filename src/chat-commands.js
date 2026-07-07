/**
 * chat-commands.js — display registry for chat-panel slash commands.
 *
 * Pure leaf module (no DOM, no deps) shared by the `/` autocomplete menu
 * (chat-panel.js) and the `/help` summary (deterministic-router.js) so the two
 * discovery surfaces can't drift. This is DISPLAY ONLY — command dispatch still
 * lives in the send handler (chat-panel.js) and askChiefOfStaff (index.js);
 * their exact-match vs inline-anywhere semantics are intentionally not unified.
 *
 * `/allow-homoglyph` is deliberately omitted — it's a niche safety-bypass flag
 * we don't want to surface for discovery (it still works via the flag parser).
 */

// Display order = menu order, roughly most-useful first.
export const CHAT_COMMANDS = [
  { name: "/plan", summary: "Draft a read-only plan, then approve before executing" },
  { name: "/export", summary: "Save this chat to today's page (add /tag Name to tag it)" },
  { name: "/undo", summary: "Reverse the changes I made in my last run" },
  { name: "/why", summary: "Explain how I produced my last response" },
  { name: "/status", summary: "Show connections, scheduled jobs, and pending state" },
  { name: "/verify", summary: "Score my last response with an independent judge" },
  { name: "/clear", aliases: ["/new"], summary: "Clear the chat and start fresh" },
  { name: "/compact", summary: "Summarise older turns to free up context" },
  { name: "/help", summary: "Show what I can do" },
  { name: "/doctor", summary: "Run a health check on keys, MCP, memory, skills, cron" },
  { name: "/lesson", summary: "Record lessons from this chat (add a topic to focus)" },
  { name: "/power", summary: "Use a more capable model for this message" },
  { name: "/ludicrous", summary: "Use the most capable model for this message" },
  // Providers are peers with no usefulness ranking — alphabetical for tidiness.
  { name: "/claude", summary: "Force the Anthropic provider for this message" },
  { name: "/gemini", summary: "Force the Google Gemini provider for this message" },
  { name: "/groq", summary: "Force the Groq provider for this message" },
  { name: "/mistral", summary: "Force the Mistral provider for this message" },
  { name: "/openai", summary: "Force the OpenAI provider for this message" },
];

/**
 * Filter the command registry by a typed query (the text after the leading
 * `/`, e.g. "ex" for "/ex" — a leading "/" in the query is tolerated). Prefix-
 * matches, case-insensitively, against each command's name and aliases.
 *
 * @returns {{ command, matchedName }[]} — matchedName is the specific
 *   name/alias that matched, so completion inserts what the user was typing
 *   (e.g. "/ne" → matchedName "/new", not "/clear"). Empty query returns every
 *   command keyed on its canonical name. Order follows CHAT_COMMANDS.
 */
export function filterSlashCommands(query) {
  const q = String(query || "").replace(/^\//, "").toLowerCase();
  const results = [];
  for (const command of CHAT_COMMANDS) {
    const names = [command.name, ...(command.aliases || [])];
    if (q === "") {
      results.push({ command, matchedName: command.name });
      continue;
    }
    // First name/alias whose bare form starts with the query.
    const matched = names.find((n) => n.replace(/^\//, "").toLowerCase().startsWith(q));
    if (matched) results.push({ command, matchedName: matched });
  }
  return results;
}

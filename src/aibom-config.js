export const LLM_API_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  // ChatGPT-subscription (Codex device OAuth) — Responses API, not chat
  // completions. Single swap point if the Roam CORS proxy can't pass it.
  "openai-codex": "https://chatgpt.com/backend-api/codex/responses"
};

export const DEFAULT_LLM_MODELS = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.1-flash-lite",
  mistral: "mistral-small-latest",
  groq: "llama-3.3-70b-versatile",
  // Mirrors the openai API tiers — the codex backend accepts the general
  // lineup (confirmed via Hermes model picker), and lighter models preserve
  // the subscription's weekly quota on trivial queries.
  "openai-codex": "gpt-5.4-mini"
};

export const POWER_LLM_MODELS = {
  // Sonnet 5: near-Opus agentic quality at sonnet-4-6's sticker price
  // ($2/$10 intro through 2026-08-31). callAnthropic pins thinking off for it.
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-terra",
  // 3.6-flash: newer stable, same input as 3.5-flash, 17% cheaper output ($7.50 vs $9.00)
  gemini: "gemini-3.6-flash",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  "openai-codex": "gpt-5.6-terra"
};

export const LUDICROUS_LLM_MODELS = {
  // Opus 5: strict upgrade over Opus 4.8 at identical $5/$25. Thinking is pinned
  // off in callAnthropic so the 8,192-token budget stays available for output.
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-sol",
  gemini: "gemini-3.1-pro-preview-customtools",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  "openai-codex": "gpt-5.6-sol"
};

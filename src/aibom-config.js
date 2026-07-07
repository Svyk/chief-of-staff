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
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  gemini: "gemini-3.5-flash",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  "openai-codex": "gpt-5.4"
};

export const LUDICROUS_LLM_MODELS = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  gemini: "gemini-3.1-pro-preview-customtools",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  "openai-codex": "gpt-5.5"
};

// ═══════════════════════════════════════════════════════════════════════════════
// OpenAI Codex Auth Module — ChatGPT-subscription OAuth (device-code flow)
// ═══════════════════════════════════════════════════════════════════════════════
//
// EXPERIMENTAL. Lets users authenticate with their ChatGPT Plus/Pro subscription
// instead of an API key, so GPT calls are billed to the subscription's weekly
// quota rather than per-token API pricing. Uses OpenAI's Codex device-code
// flow (the same one `codex login --device-auth` and Hermes Agent use):
//
//   1. POST /api/accounts/deviceauth/usercode { client_id }
//        → { device_auth_id, user_code, interval }
//   2. User opens https://auth.openai.com/codex/device and enters the code
//      (15-minute expiry).
//   3. Poll POST /api/accounts/deviceauth/token { device_auth_id, user_code }
//        — 403/404 while pending; 200 → { authorization_code, code_challenge,
//          code_verifier } (the server generates the PKCE pair).
//   4. POST /oauth/token grant_type=authorization_code
//        → { id_token, access_token, refresh_token, expires_in }.
//
// All auth endpoints send `access-control-allow-origin: *`, so the entire flow
// runs browser-direct — no popup, no CORS proxy, no localhost callback.
//
// Refresh tokens ROTATE: every refresh returns a new refresh_token that must
// be persisted. A terminal refresh failure (4xx / invalid_grant) marks the
// credential dead — it is never replayed (Hermes' quarantine pattern) and the
// user is pointed at the Reconnect command.
//
// Initialise once via initOpenAiCodexAuth({ ... }).
// ═══════════════════════════════════════════════════════════════════════════════

import {
  createRoamStorageAdapter,
  saveTokens,
  loadTokens,
  clearTokens,
  isTokenExpired
} from "./roam-oauth-client.js";
import {
  decodeJwtClaims,
  extractChatGptAccountId,
  extractJwtEmail
} from "./codex-responses.js";

// ── DI container ─────────────────────────────────────────────────────────────
let deps = {};

export function initOpenAiCodexAuth(injected) {
  deps = injected;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Official Codex CLI public client — there is no third-party registration path.
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_BASE = "https://auth.openai.com";
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_AUTH_BASE}/codex/device`;
const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE}/deviceauth/callback`;
const DEVICE_AUTH_HARD_TIMEOUT_MS = 15 * 60 * 1000; // user code expires in 15 min
const MIN_POLL_INTERVAL_MS = 3000;
const MAX_POLL_INTERVAL_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 5000;

const CODEX_STORAGE_EXTENSION_ID = "chief-of-staff";
const CODEX_STORAGE_PROVIDER = "openai-codex";

export const CODEX_RECONNECT_HINT =
  "Reconnect via command palette: Chief of Staff: Connect ChatGPT Subscription (Codex).";

// ── Module state ─────────────────────────────────────────────────────────────

let activePollState = null;     // { running, stopped, timeoutId, hardTimeoutId }
let refreshInFlight = null;     // single-flight refresh promise

function getStorage(extensionAPI) {
  return createRoamStorageAdapter(extensionAPI || deps.getExtensionAPIRef());
}

function loadStoredCodexTokens(extensionAPI) {
  return loadTokens(CODEX_STORAGE_EXTENSION_ID, CODEX_STORAGE_PROVIDER, getStorage(extensionAPI));
}

function saveStoredCodexTokens(payload, extensionAPI) {
  saveTokens(CODEX_STORAGE_EXTENSION_ID, CODEX_STORAGE_PROVIDER, payload, getStorage(extensionAPI));
}

// ── Device flow ──────────────────────────────────────────────────────────────

/**
 * Step 1 — request a user code. Returns { deviceAuthId, userCode, intervalMs }.
 */
export async function requestDeviceCode() {
  const res = await fetch(`${CODEX_AUTH_BASE}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
  });
  if (!res.ok) {
    throw new Error(`Codex device code request failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (!data?.device_auth_id || !(data.user_code || data.usercode)) {
    throw new Error("Codex device code response missing device_auth_id/user_code");
  }
  const parsedInterval = parseInt(String(data.interval || "").trim(), 10);
  const intervalMs = Number.isFinite(parsedInterval)
    ? Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, parsedInterval * 1000))
    : DEFAULT_POLL_INTERVAL_MS;
  return {
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code || data.usercode,
    intervalMs
  };
}

/**
 * Step 3 — one poll tick. Returns null while the user hasn't approved yet
 * (the endpoint answers 403/404 until then), the PKCE triple on success,
 * and throws on any other status.
 */
export async function pollDeviceToken(deviceAuthId, userCode) {
  const res = await fetch(`${CODEX_AUTH_BASE}/api/accounts/deviceauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
  });
  if (res.status === 403 || res.status === 404) return null; // pending
  if (!res.ok) throw new Error(`Codex device auth failed (HTTP ${res.status})`);
  return res.json(); // { authorization_code, code_challenge, code_verifier }
}

/**
 * Step 4 — exchange the authorization code (with the server-issued PKCE
 * verifier) for tokens.
 */
export async function exchangeAuthorizationCode({ authorizationCode, codeVerifier }) {
  const res = await fetch(`${CODEX_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI
    })
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`Codex token exchange failed (HTTP ${res.status}): ${deps.redactForLog ? deps.redactForLog(text) : text}`);
  }
  return res.json(); // { id_token, access_token, refresh_token, expires_in? }
}

function buildStoredPayloadFromTokenResponse(tokenResponse, existing = null) {
  const claims = decodeJwtClaims(tokenResponse.id_token) || decodeJwtClaims(tokenResponse.access_token) || {};
  const accountId = extractChatGptAccountId(claims) || existing?.account_id || "";
  const email = extractJwtEmail(claims) || existing?.email || "";
  return {
    access_token: tokenResponse.access_token,
    // Rotating refresh tokens — always take the newest one when present
    refresh_token: tokenResponse.refresh_token || existing?.refresh_token || "",
    expires_in: tokenResponse.expires_in || existing?.expires_in || 3600,
    account_id: accountId,
    email
  };
}

/**
 * Orchestrate the full connect flow. Lifecycle-safe polling modelled on
 * composio-ui's startToolAuthPolling: recursive setTimeout, stopped-guards
 * after every await, hard timeout at the 15-minute code expiry.
 *
 * onCode({ userCode, verifyUrl, expiresInMinutes }) fires once the code is
 * ready to show; onSuccess(status) / onError(error) settle the flow.
 */
export async function startCodexDeviceConnect(extensionAPI, { onCode, onSuccess, onError } = {}) {
  stopCodexAuthPolling();

  let device;
  try {
    device = await requestDeviceCode();
  } catch (error) {
    deps.debugLog?.("[Codex auth] Device code request failed:", error?.message);
    if (onError) onError(error);
    return;
  }

  if (onCode) {
    onCode({
      userCode: device.userCode,
      verifyUrl: CODEX_DEVICE_VERIFY_URL,
      expiresInMinutes: 15
    });
  }

  const pollState = { running: false, stopped: false, timeoutId: null, hardTimeoutId: null };
  activePollState = pollState;

  const finish = (fn, arg) => {
    pollState.stopped = true;
    if (pollState.timeoutId) clearTimeout(pollState.timeoutId);
    if (pollState.hardTimeoutId) clearTimeout(pollState.hardTimeoutId);
    if (activePollState === pollState) activePollState = null;
    if (fn) fn(arg);
  };

  const scheduleNextPoll = () => {
    if (pollState.stopped) return;
    pollState.timeoutId = setTimeout(runPoll, device.intervalMs);
  };

  const runPoll = async () => {
    if (pollState.running || pollState.stopped) return;
    pollState.running = true;
    try {
      const codeResp = await pollDeviceToken(device.deviceAuthId, device.userCode);
      if (pollState.stopped) return;
      if (!codeResp) return; // still pending — finally clause reschedules
      const tokenResponse = await exchangeAuthorizationCode({
        authorizationCode: codeResp.authorization_code,
        codeVerifier: codeResp.code_verifier
      });
      if (pollState.stopped) return;
      const payload = buildStoredPayloadFromTokenResponse(tokenResponse);
      saveStoredCodexTokens(payload, extensionAPI);
      deps.debugLog?.("[Codex auth] Connected as", deps.redactForLog ? deps.redactForLog(payload.email) : "(email hidden)");
      finish(onSuccess, getCodexAuthStatus(extensionAPI));
    } catch (error) {
      deps.debugLog?.("[Codex auth] Device poll error:", error?.message);
      finish(onError, error);
    } finally {
      pollState.running = false;
      if (!pollState.stopped) scheduleNextPoll();
    }
  };

  pollState.hardTimeoutId = setTimeout(() => {
    deps.debugLog?.("[Codex auth] Device auth timed out (15 min)");
    finish(onError, new Error("Device sign-in timed out after 15 minutes. Run the Connect command again for a fresh code."));
  }, DEVICE_AUTH_HARD_TIMEOUT_MS);

  runPoll();
}

/**
 * Stop any in-progress device-auth polling (onunload safety).
 */
export function stopCodexAuthPolling() {
  if (!activePollState) return;
  activePollState.stopped = true;
  if (activePollState.timeoutId) clearTimeout(activePollState.timeoutId);
  if (activePollState.hardTimeoutId) clearTimeout(activePollState.hardTimeoutId);
  activePollState = null;
}

// ── Token lifecycle ──────────────────────────────────────────────────────────

/**
 * Refresh the stored token set. Rotating refresh tokens: the new
 * refresh_token is always persisted. Terminal failures (4xx/invalid_grant)
 * quarantine the credential — it is marked dead and never replayed.
 * Transient failures (5xx/network) throw without marking dead.
 */
export async function refreshCodexTokens(stored, extensionAPI) {
  const res = await fetch(`${CODEX_AUTH_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: stored.refresh_token
    })
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const terminal = res.status >= 400 && res.status < 500;
    if (terminal) {
      saveStoredCodexTokens({
        ...stored,
        dead: true,
        deadReason: `HTTP ${res.status}${/invalid_grant/i.test(text) ? " (invalid_grant)" : ""}`,
        deadAt: Date.now()
      }, extensionAPI);
      throw new Error(`ChatGPT subscription auth expired (HTTP ${res.status}). ${CODEX_RECONNECT_HINT}`);
    }
    throw new Error(`ChatGPT subscription token refresh failed (HTTP ${res.status}) — will retry on next call.`);
  }
  const tokenResponse = await res.json();
  const payload = buildStoredPayloadFromTokenResponse(tokenResponse, stored);
  saveStoredCodexTokens(payload, extensionAPI);
  return payload;
}

/**
 * Return { accessToken, accountId } for a request, refreshing when expired.
 * Single-flight: parallel agent-loop iterations share one refresh so the
 * rotating refresh token is never raced.
 */
export async function getValidCodexToken(extensionAPI) {
  const ext = extensionAPI || deps.getExtensionAPIRef();
  const stored = loadStoredCodexTokens(ext);
  if (!stored?.access_token) {
    throw new Error(`ChatGPT subscription is not connected. ${CODEX_RECONNECT_HINT}`);
  }
  if (stored.dead) {
    throw new Error(`ChatGPT subscription auth expired (${stored.deadReason || "refresh failed"}). ${CODEX_RECONNECT_HINT}`);
  }
  if (!isTokenExpired(stored)) {
    return { accessToken: stored.access_token, accountId: stored.account_id || "" };
  }
  if (!stored.refresh_token) {
    throw new Error(`ChatGPT subscription token expired and no refresh token is stored. ${CODEX_RECONNECT_HINT}`);
  }
  if (!refreshInFlight) {
    refreshInFlight = refreshCodexTokens(stored, ext).finally(() => { refreshInFlight = null; });
  }
  const payload = await refreshInFlight;
  return { accessToken: payload.access_token, accountId: payload.account_id || "" };
}

// ── Codex base instructions ──────────────────────────────────────────────────
//
// The chatgpt.com codex backend validates the `instructions` field — requests
// with an arbitrary system prompt are rejected with HTTP 400. Every working
// third-party implementation sends the official Codex CLI prompt as
// `instructions` and passes the host app's real system prompt as an input
// message instead. The prompts live in the openai/codex repo and
// raw.githubusercontent.com is CORS-open (`*`), so we fetch at runtime and
// cache in Roam Depot settings (7-day TTL) with an in-memory layer on top.

const CODEX_PROMPT_BASE = "https://raw.githubusercontent.com/openai/codex/main/codex-rs/core";
const CODEX_INSTRUCTIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const codexInstructionsMemoryCache = {}; // family -> content

function codexPromptFamily(model) {
  const m = String(model || "").toLowerCase();
  // Newest available prompt per family; general-purpose models (gpt-5.5)
  // use the latest general prompt, codex-tuned models the codex one.
  return m.includes("codex")
    ? { family: "codex", file: "gpt-5.2-codex_prompt.md" }
    : { family: "general", file: "gpt_5_2_prompt.md" };
}

/**
 * Return the official Codex CLI base instructions for a model. Cached in
 * memory and in settings; falls back to a stale cached copy when the fetch
 * fails, and throws only when no copy has ever been fetched.
 */
export async function getCodexInstructions(model, extensionAPI) {
  const { family, file } = codexPromptFamily(model);
  if (codexInstructionsMemoryCache[family]) return codexInstructionsMemoryCache[family];

  const ext = extensionAPI || deps.getExtensionAPIRef();
  const settingKey = `openai-codex-instructions-${family}`;
  let cached = null;
  try {
    const raw = ext?.settings?.get?.(settingKey);
    if (raw) cached = JSON.parse(raw);
  } catch { /* treat as no cache */ }

  if (cached?.content && Date.now() - (cached.fetchedAt || 0) < CODEX_INSTRUCTIONS_TTL_MS) {
    codexInstructionsMemoryCache[family] = cached.content;
    return cached.content;
  }

  try {
    const res = await fetch(`${CODEX_PROMPT_BASE}/${file}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    if (!content || content.length < 500) throw new Error("suspiciously short prompt file");
    codexInstructionsMemoryCache[family] = content;
    try { ext?.settings?.set?.(settingKey, JSON.stringify({ content, fetchedAt: Date.now() })); } catch { /* cache only */ }
    return content;
  } catch (error) {
    if (cached?.content) {
      // Stale copy beats no copy — the prompt changes rarely
      deps.debugLog?.("[Codex auth] Instructions refresh failed, using stale cache:", error?.message);
      codexInstructionsMemoryCache[family] = cached.content;
      return cached.content;
    }
    throw new Error(
      `Could not load Codex base instructions (${error?.message}). `
      + "The ChatGPT subscription endpoint requires them — check network access to raw.githubusercontent.com and retry."
    );
  }
}

// ── Status & disconnect ──────────────────────────────────────────────────────

export function isCodexConnected(extensionAPI) {
  try {
    const stored = loadStoredCodexTokens(extensionAPI);
    return !!(stored?.access_token && !stored.dead);
  } catch {
    return false;
  }
}

export function getCodexAuthStatus(extensionAPI) {
  try {
    const stored = loadStoredCodexTokens(extensionAPI);
    if (!stored?.access_token) return { connected: false, dead: false };
    const expiresAt = stored.saved_at && stored.expires_in
      ? stored.saved_at + stored.expires_in * 1000
      : null;
    return {
      connected: !stored.dead,
      dead: !!stored.dead,
      deadReason: stored.deadReason || "",
      accountId: stored.account_id || "",
      email: stored.email || "",
      expiresAt
    };
  } catch {
    return { connected: false, dead: false };
  }
}

export function disconnectCodex(extensionAPI) {
  stopCodexAuthPolling();
  clearTokens(CODEX_STORAGE_EXTENSION_ID, CODEX_STORAGE_PROVIDER, getStorage(extensionAPI));
}

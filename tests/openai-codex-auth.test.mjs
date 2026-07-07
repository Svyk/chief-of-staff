import test from "node:test";
import assert from "node:assert/strict";
import {
  initOpenAiCodexAuth,
  requestDeviceCode,
  pollDeviceToken,
  exchangeAuthorizationCode,
  startCodexDeviceConnect,
  stopCodexAuthPolling,
  refreshCodexTokens,
  getValidCodexToken,
  getCodexInstructions,
  isCodexConnected,
  getCodexAuthStatus,
  disconnectCodex,
  CODEX_CLIENT_ID,
} from "../src/openai-codex-auth.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "roam_oauth_chief-of-staff_openai-codex";

function makeExtensionAPI(overrides = {}) {
  const store = { ...overrides };
  return {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
    },
    _store: store,
  };
}

function initWithExt(ext) {
  initOpenAiCodexAuth({
    debugLog: () => {},
    redactForLog: (s) => s,
    getExtensionAPIRef: () => ext,
  });
  return ext;
}

function makeJwt(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.sig`;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Install a scripted fetch: each call shifts the next handler. */
function mockFetch(t, handlers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const handler = handlers.length > 1 ? handlers.shift() : handlers[0];
    return typeof handler === "function" ? handler(url, opts) : handler;
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function writeStoredTokens(ext, payload) {
  ext.settings.set(STORAGE_KEY, JSON.stringify(payload));
}

function readStoredTokens(ext) {
  const raw = ext.settings.get(STORAGE_KEY);
  return raw ? JSON.parse(raw) : null;
}

// ── requestDeviceCode ────────────────────────────────────────────────────────

test("requestDeviceCode parses response and converts string interval to ms", async (t) => {
  const calls = mockFetch(t, [jsonResponse(200, { device_auth_id: "da_1", user_code: "ABCD-EFGHI", interval: "5" })]);
  const out = await requestDeviceCode();
  assert.deepEqual(out, { deviceAuthId: "da_1", userCode: "ABCD-EFGHI", intervalMs: 5000 });
  assert.match(calls[0].url, /auth\.openai\.com\/api\/accounts\/deviceauth\/usercode$/);
  assert.equal(JSON.parse(calls[0].opts.body).client_id, CODEX_CLIENT_ID);
});

test("requestDeviceCode clamps interval to [3s, 30s] and defaults on garbage", async (t) => {
  mockFetch(t, [jsonResponse(200, { device_auth_id: "d", user_code: "U", interval: "1" })]);
  assert.equal((await requestDeviceCode()).intervalMs, 3000);
  mockFetch(t, [jsonResponse(200, { device_auth_id: "d", user_code: "U", interval: "120" })]);
  assert.equal((await requestDeviceCode()).intervalMs, 30000);
  mockFetch(t, [jsonResponse(200, { device_auth_id: "d", user_code: "U", interval: "soon" })]);
  assert.equal((await requestDeviceCode()).intervalMs, 5000);
});

test("requestDeviceCode throws on HTTP error and on malformed body", async (t) => {
  mockFetch(t, [jsonResponse(500, {})]);
  await assert.rejects(requestDeviceCode(), /HTTP 500/);
  mockFetch(t, [jsonResponse(200, { nope: true })]);
  await assert.rejects(requestDeviceCode(), /missing/);
});

// ── pollDeviceToken ──────────────────────────────────────────────────────────

test("pollDeviceToken returns null on 403/404 (pending), payload on 200, throws otherwise", async (t) => {
  mockFetch(t, [jsonResponse(403, {})]);
  assert.equal(await pollDeviceToken("d", "U"), null);
  mockFetch(t, [jsonResponse(404, {})]);
  assert.equal(await pollDeviceToken("d", "U"), null);
  const pkce = { authorization_code: "ac", code_challenge: "cc", code_verifier: "cv" };
  const calls = mockFetch(t, [jsonResponse(200, pkce)]);
  assert.deepEqual(await pollDeviceToken("d", "U"), pkce);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { device_auth_id: "d", user_code: "U" });
  mockFetch(t, [jsonResponse(500, {})]);
  await assert.rejects(pollDeviceToken("d", "U"), /HTTP 500/);
});

// ── exchangeAuthorizationCode ────────────────────────────────────────────────

test("exchangeAuthorizationCode sends the full grant body incl. redirect_uri", async (t) => {
  const calls = mockFetch(t, [jsonResponse(200, { access_token: "at", refresh_token: "rt" })]);
  await exchangeAuthorizationCode({ authorizationCode: "ac_1", codeVerifier: "cv_1" });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.client_id, CODEX_CLIENT_ID);
  assert.equal(body.code, "ac_1");
  assert.equal(body.code_verifier, "cv_1");
  assert.equal(body.redirect_uri, "https://auth.openai.com/deviceauth/callback");
  assert.match(calls[0].url, /auth\.openai\.com\/oauth\/token$/);
});

// ── startCodexDeviceConnect (state machine) ──────────────────────────────────

test("connect flow: code shown, first poll succeeds, tokens saved with account id + email", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const idToken = makeJwt({ chatgpt_account_id: "acct_9", email: "mark@example.com" });
  mockFetch(t, [
    jsonResponse(200, { device_auth_id: "da", user_code: "CODE-12345", interval: "5" }),
    jsonResponse(200, { authorization_code: "ac", code_challenge: "cc", code_verifier: "cv" }),
    jsonResponse(200, { id_token: idToken, access_token: "at_1", refresh_token: "rt_1", expires_in: 3600 }),
  ]);

  let codeShown = null;
  const status = await new Promise((resolve, reject) => {
    startCodexDeviceConnect(ext, {
      onCode: (c) => { codeShown = c; },
      onSuccess: resolve,
      onError: reject,
    });
  });

  assert.equal(codeShown.userCode, "CODE-12345");
  assert.equal(codeShown.verifyUrl, "https://auth.openai.com/codex/device");
  assert.equal(status.connected, true);
  assert.equal(status.email, "mark@example.com");
  const stored = readStoredTokens(ext);
  assert.equal(stored.access_token, "at_1");
  assert.equal(stored.refresh_token, "rt_1");
  assert.equal(stored.account_id, "acct_9");
  assert.ok(stored.saved_at > 0);
});

test("connect flow: onError fires when the device code request fails; no polling starts", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const calls = mockFetch(t, [jsonResponse(500, {})]);
  const error = await new Promise((resolve) => {
    startCodexDeviceConnect(ext, { onError: resolve, onSuccess: () => resolve(new Error("should not succeed")) });
  });
  assert.match(String(error.message), /HTTP 500/);
  assert.equal(calls.length, 1);
});

test("stopCodexAuthPolling prevents further fetches after a pending poll", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  let pollCount = 0;
  mockFetch(t, [
    (url) => {
      if (/usercode/.test(String(url))) return jsonResponse(200, { device_auth_id: "da", user_code: "U", interval: "5" });
      pollCount++;
      return jsonResponse(403, {}); // always pending
    },
  ]);
  await new Promise((resolve) => {
    startCodexDeviceConnect(ext, {
      onCode: () => setTimeout(resolve, 10), // let the first poll run
      onError: () => {},
    });
  });
  const countAtStop = pollCount;
  stopCodexAuthPolling();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(pollCount, countAtStop); // no polls after stop
  assert.ok(countAtStop >= 1);
});

// ── refreshCodexTokens ───────────────────────────────────────────────────────

test("refresh success persists the ROTATED refresh token", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const stored = { access_token: "old_at", refresh_token: "old_rt", expires_in: 3600, saved_at: 1, account_id: "acct", email: "e@x.y" };
  writeStoredTokens(ext, stored);
  const calls = mockFetch(t, [jsonResponse(200, { access_token: "new_at", refresh_token: "new_rt", expires_in: 3600 })]);
  const payload = await refreshCodexTokens(stored, ext);
  assert.equal(payload.access_token, "new_at");
  assert.equal(payload.refresh_token, "new_rt");
  assert.equal(payload.account_id, "acct"); // carried from existing
  assert.equal(readStoredTokens(ext).refresh_token, "new_rt");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "old_rt");
});

test("terminal 4xx quarantines the credential (dead) and throws reconnect hint", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const stored = { access_token: "at", refresh_token: "rt", expires_in: 3600, saved_at: 1 };
  writeStoredTokens(ext, stored);
  mockFetch(t, [{ ok: false, status: 400, headers: { get: () => null }, text: async () => "{\"error\":\"invalid_grant\"}", json: async () => ({}) }]);
  await assert.rejects(refreshCodexTokens(stored, ext), /expired.*Reconnect/s);
  const after = readStoredTokens(ext);
  assert.equal(after.dead, true);
  assert.match(after.deadReason, /400.*invalid_grant/);
});

test("5xx refresh failure throws but does NOT mark dead", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const stored = { access_token: "at", refresh_token: "rt", expires_in: 3600, saved_at: 1 };
  writeStoredTokens(ext, stored);
  mockFetch(t, [jsonResponse(503, {})]);
  await assert.rejects(refreshCodexTokens(stored, ext), /HTTP 503/);
  assert.equal(readStoredTokens(ext).dead, undefined);
});

// ── getValidCodexToken ───────────────────────────────────────────────────────

test("fresh token returned without any fetch", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  writeStoredTokens(ext, { access_token: "at", refresh_token: "rt", expires_in: 3600, saved_at: Date.now(), account_id: "acct_5" });
  const calls = mockFetch(t, [jsonResponse(500, {})]);
  const out = await getValidCodexToken(ext);
  assert.deepEqual(out, { accessToken: "at", accountId: "acct_5" });
  assert.equal(calls.length, 0);
});

test("not connected / dead credential throw reconnect errors WITHOUT fetching", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const calls = mockFetch(t, [jsonResponse(500, {})]);
  await assert.rejects(getValidCodexToken(ext), /not connected/i);
  writeStoredTokens(ext, { access_token: "at", refresh_token: "rt", dead: true, deadReason: "HTTP 400", saved_at: 1, expires_in: 3600 });
  await assert.rejects(getValidCodexToken(ext), /expired.*Reconnect/s);
  assert.equal(calls.length, 0);
});

test("expired token triggers refresh; concurrent calls share ONE refresh (single-flight)", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  writeStoredTokens(ext, { access_token: "old", refresh_token: "rt", expires_in: 3600, saved_at: Date.now() - 4000 * 1000, account_id: "acct" });
  let refreshCalls = 0;
  mockFetch(t, [
    async () => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 10)); // widen the race window
      return jsonResponse(200, { access_token: "fresh", refresh_token: "rt2", expires_in: 3600 });
    },
  ]);
  const [a, b] = await Promise.all([getValidCodexToken(ext), getValidCodexToken(ext)]);
  assert.equal(a.accessToken, "fresh");
  assert.equal(b.accessToken, "fresh");
  assert.equal(refreshCalls, 1);
});

// ── status & disconnect ──────────────────────────────────────────────────────

test("isCodexConnected / getCodexAuthStatus / disconnectCodex lifecycle", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.equal(isCodexConnected(ext), false);
  assert.deepEqual(getCodexAuthStatus(ext), { connected: false, dead: false });

  writeStoredTokens(ext, { access_token: "at", refresh_token: "rt", expires_in: 3600, saved_at: 1000, account_id: "acct", email: "m@x.y" });
  assert.equal(isCodexConnected(ext), true);
  const status = getCodexAuthStatus(ext);
  assert.equal(status.connected, true);
  assert.equal(status.email, "m@x.y");
  assert.equal(status.expiresAt, 1000 + 3600 * 1000);

  writeStoredTokens(ext, { access_token: "at", refresh_token: "rt", expires_in: 3600, saved_at: 1000, dead: true, deadReason: "HTTP 400" });
  assert.equal(isCodexConnected(ext), false);
  assert.equal(getCodexAuthStatus(ext).dead, true);

  disconnectCodex(ext);
  assert.equal(isCodexConnected(ext), false);
  assert.equal(readStoredTokens(ext), null);
});

// ── getCodexInstructions ─────────────────────────────────────────────────────
// NOTE: the module keeps an in-memory cache per prompt family, so test order
// matters: failure cases for the codex family run before its success case.

test("getCodexInstructions throws when fetch fails and nothing is cached", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  mockFetch(t, [jsonResponse(500, {})]);
  await assert.rejects(getCodexInstructions("gpt-5.3-codex", ext), /Could not load Codex base instructions/);
});

test("getCodexInstructions falls back to a stale settings cache when fetch fails", async (t) => {
  const ext = initWithExt(makeExtensionAPI({
    "openai-codex-instructions-codex": JSON.stringify({ content: "STALE CODEX PROMPT ".repeat(40), fetchedAt: 1 }),
  }));
  mockFetch(t, [jsonResponse(500, {})]);
  const out = await getCodexInstructions("gpt-5.3-codex", ext);
  assert.match(out, /STALE CODEX PROMPT/);
});

test("getCodexInstructions fetches, caches in settings, then serves from memory without fetching", async (t) => {
  const ext = initWithExt(makeExtensionAPI());
  const prompt = "You are GPT running in the Codex CLI. ".repeat(20);
  const calls = mockFetch(t, [{
    ok: true, status: 200,
    headers: { get: () => null },
    text: async () => prompt,
  }]);
  const first = await getCodexInstructions("gpt-5.5", ext);
  assert.equal(first, prompt);
  assert.match(calls[0].url, /raw\.githubusercontent\.com\/openai\/codex\/main\/codex-rs\/core\/gpt_5_2_prompt\.md/);
  const cached = JSON.parse(ext.settings.get("openai-codex-instructions-general"));
  assert.equal(cached.content, prompt);
  // Second call: memory cache — no further fetch
  const second = await getCodexInstructions("gpt-5.5", ext);
  assert.equal(second, prompt);
  assert.equal(calls.length, 1);
});

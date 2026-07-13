/**
 * cors-proxy.js — honest failure messages for CORS-proxy problems (#137).
 *
 * Pure module, no state, no DI.
 *
 * ── Why there is no Codex routing here ──────────────────────────────────────
 *
 * The original plan for #137 was to route openai-codex through the user's own
 * roam-mcp-proxy Cloudflare Worker, because Roam's built-in CORS proxy is a
 * cloud function that times out at ~60s and kills long Codex generations.
 *
 * That cannot work, and the reason is worth writing down so nobody rebuilds it:
 *
 *   Cloudflare's runtime stamps a `Cf-Worker` header onto every subrequest a
 *   Worker makes. It is added AFTER user code runs, so headers.delete() does
 *   nothing. OpenAI's WAF blocks any request carrying it and returns a 403 HTML
 *   block page. Bisected 2026-07-13: an otherwise identical curl to
 *   chatgpt.com/backend-api/codex/responses returns 401 (token checked, request
 *   well-formed), and returns 403 the moment `Cf-Worker` is added by hand.
 *
 * So NO Cloudflare Worker can proxy chatgpt.com — not this one, not a new one.
 * Roam's proxy (Google Cloud Functions) is not affected, which is why Codex
 * works there at all. The ~60s ceiling is therefore a live constraint of the
 * ChatGPT-subscription path, not something the proxy can fix; escaping it needs
 * a proxy on a non-Cloudflare platform. Until then the honest answer to a user
 * hitting it is "use an API-key provider for long runs", which is what
 * describeCodexTimeoutFailure() says.
 */

export const PROXY_REPO_URL = "https://github.com/mlava/roam-mcp-proxy";

// roam-mcp-proxy version that allows api.cloudflare.com out of the box.
export const MIN_PROXY_VERSION = 2;

// Roam's proxy dies at ~60s. Only blame it for a failure that actually ran long
// enough to have hit that wall — a 502 three seconds in is a different bug.
const PROXY_TIMEOUT_SUSPICION_MS = 45_000;

/**
 * Did the PROXY reject this request, as opposed to the upstream service?
 *
 * This distinction is load-bearing and easy to get wrong. roam-mcp-proxy answers
 * 403 "Forbidden target" for a host it doesn't allow — but 403 is also what the
 * Cloudflare API returns for a bad API token, and what chatgpt.com returns when
 * its WAF blocks you. Status alone cannot tell them apart, so the body marker is
 * the only reliable signal. Get this backwards and the user is sent off to
 * re-authorise a credential that was never the problem.
 */
export function isProxyRejection(status, bodyText) {
  return status === 403 && String(bodyText || "").includes("Forbidden target");
}

/**
 * roam_web_fetch: when the proxy refuses api.cloudflare.com, say so, instead of
 * reporting it as "Cloudflare API returned HTTP 403", which sends the user off
 * to check a Cloudflare token that is probably fine.
 *
 * Deliberately reactive rather than pre-flight. We do NOT refuse to make the
 * request on the grounds that a capability probe didn't list api.cloudflare.com:
 * the old README told web-fetch users to hand-add that host to a pre-v2 worker,
 * and those workers work fine. Gating on the absence of a signal would break
 * them. Only an actual "Forbidden target" proves the proxy said no.
 */
export function describeWebFetchProxyFailure({ status, bodyText = "" } = {}) {
  if (!isProxyRejection(status, bodyText)) return null;
  return `Your CORS proxy refused api.cloudflare.com, so web fetch can't reach Cloudflare's Browser Rendering API. `
    + `This means the proxy predates v${MIN_PROXY_VERSION}, which allows that host out of the box. `
    + `Redeploy roam-mcp-proxy from ${PROXY_REPO_URL} — your proxy URL doesn't change, and no settings need updating. `
    + `(Your Cloudflare API token is almost certainly fine; this is the proxy, not Cloudflare.)`;
}

/**
 * openai-codex: a gateway error after a long run is Roam's ~60s proxy timeout.
 *
 * The remedy is NOT "deploy a Cloudflare Worker" — see the module header; that
 * is a dead end, and telling the user to go set one up would waste their time.
 */
export function describeCodexTimeoutFailure({ status, elapsedMs = 0 } = {}) {
  const isGatewayError = status === 502 || status === 504;
  if (!isGatewayError || elapsedMs < PROXY_TIMEOUT_SUSPICION_MS) return null;

  const seconds = Math.round(elapsedMs / 1000);
  return `The ChatGPT-subscription request died after ${seconds}s (HTTP ${status}). Roam's shared CORS proxy times out `
    + `at ~60s, and ChatGPT-subscription calls have to go through it, so generations longer than that can't complete — `
    + `heavy skill runs hit this reliably. Short requests are unaffected. For long runs, switch to an API-key provider `
    + `(e.g. Anthropic), which Chief of Staff calls directly with no proxy and no time limit.`;
}

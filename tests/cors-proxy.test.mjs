import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  isProxyRejection,
  describeWebFetchProxyFailure,
  describeCodexTimeoutFailure,
  MIN_PROXY_VERSION,
} from "../src/cors-proxy.js";

describe("isProxyRejection", () => {
  // The whole point of this helper: 403 is ambiguous. roam-mcp-proxy says
  // "Forbidden target" when it refuses a host; the Cloudflare API says 403 for a
  // bad token; chatgpt.com says 403 when its WAF blocks you. Only the body
  // marker identifies the proxy as the one that said no.
  test("only a 403 carrying the proxy's own marker counts", () => {
    assert.equal(isProxyRejection(403, "Forbidden target"), true);
    assert.equal(isProxyRejection(403, '{"error":"invalid token"}'), false);
    assert.equal(isProxyRejection(403, "<html>blocked by WAF</html>"), false);
    assert.equal(isProxyRejection(401, "Forbidden target"), false);
    assert.equal(isProxyRejection(403, ""), false);
  });
});

describe("describeWebFetchProxyFailure", () => {
  test("proxy refusing the host → redeploy, not 'check your Cloudflare token'", () => {
    const msg = describeWebFetchProxyFailure({ status: 403, bodyText: "Forbidden target" });
    assert.match(msg, /Redeploy/i);
    assert.match(msg, new RegExp(`v${MIN_PROXY_VERSION}`));
    assert.match(msg, /proxy, not Cloudflare/i);
  });

  test("a real Cloudflare 403 is left alone", () => {
    assert.equal(describeWebFetchProxyFailure({
      status: 403,
      bodyText: '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}',
    }), null);
  });

  test("other statuses pass through", () => {
    assert.equal(describeWebFetchProxyFailure({ status: 429, bodyText: "" }), null);
    assert.equal(describeWebFetchProxyFailure({ status: 500, bodyText: "Forbidden target" }), null);
  });
});

describe("describeCodexTimeoutFailure", () => {
  test("502 after a long run → names the ~60s proxy timeout", () => {
    const msg = describeCodexTimeoutFailure({ status: 502, elapsedMs: 63_300 });
    assert.match(msg, /63s/);
    assert.match(msg, /~60s/);
  });

  test("does NOT tell the user to deploy a Cloudflare Worker", () => {
    // A Worker cannot proxy chatgpt.com at all — OpenAI's WAF blocks the
    // Cf-Worker header the runtime adds and user code cannot strip it. Sending
    // someone off to deploy one would waste their time on a dead end.
    const msg = describeCodexTimeoutFailure({ status: 502, elapsedMs: 63_300 });
    assert.doesNotMatch(msg, /worker/i);
    assert.doesNotMatch(msg, /roam-mcp-proxy/i);
    assert.doesNotMatch(msg, /deploy/i);
    // It points at the one thing that actually works today.
    assert.match(msg, /API-key provider/i);
    assert.match(msg, /Anthropic/);
  });

  test("504 counts too", () => {
    assert.ok(describeCodexTimeoutFailure({ status: 504, elapsedMs: 61_000 }));
  });

  test("a fast 502 is a different bug and is not blamed on the timeout", () => {
    assert.equal(describeCodexTimeoutFailure({ status: 502, elapsedMs: 3_000 }), null);
  });

  test("unrelated statuses pass through to the normal error handling", () => {
    // 429 = weekly quota, 401/403 = auth. Those have their own messages.
    assert.equal(describeCodexTimeoutFailure({ status: 429, elapsedMs: 70_000 }), null);
    assert.equal(describeCodexTimeoutFailure({ status: 403, elapsedMs: 70_000 }), null);
    assert.equal(describeCodexTimeoutFailure({ status: 500, elapsedMs: 70_000 }), null);
  });
});

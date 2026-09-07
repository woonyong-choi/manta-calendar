import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.mjs";
import { createRelayState, readRelayState } from "../src/protocol.mjs";

const env = {
  GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  PLUGIN_REDIRECT_URI: "obsidian://link-calendar-google",
  PUBLIC_BASE_URL: "https://relay.example/",
  STATE_SECRET: "a-state-secret-that-is-at-least-32-characters",
};

test("health identifies the compatible relay protocol", async () => {
  const response = await worker.fetch(new Request("https://relay.example/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    origin: "https://relay.example",
    protocol: 1,
    status: "ok",
  });
});

test("public homepage and privacy policy describe the narrow integration", async () => {
  const home = await worker.fetch(new Request("https://relay.example/"), env);
  assert.equal(home.status, 200);
  assert.match(home.headers.get("content-type"), /^text\/html/);
  assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await home.text(), /calendar\.app\.created/);

  const privacy = await worker.fetch(new Request("https://relay.example/privacy"), env);
  assert.equal(privacy.status, 200);
  const body = await privacy.text();
  assert.match(body, /Privacy policy/);
  assert.match(body, /without persisting tokens, notes, events, or analytics/);
  assert.match(body, /not sold/);
});

test("health rejects a public base URL that is not an exact HTTPS origin", async () => {
  const response = await worker.fetch(
    new Request("https://relay.example/health"),
    { ...env, PUBLIC_BASE_URL: "https://relay.example/unexpected-path" },
  );
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "invalid_server_configuration" });
});

test("authorize redirects with PKCE and a signed short-lived state", async () => {
  const request = new Request(
    `https://relay.example/oauth/authorize?client_state=${"s".repeat(43)}&code_challenge=${"c".repeat(43)}&locale=en`,
  );
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin, "https://accounts.google.com");
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
  assert.equal(target.searchParams.get("hl"), "en");
  assert.equal(target.searchParams.get("redirect_uri"), "https://relay.example/oauth/callback");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const relay = await readRelayState(env.STATE_SECRET, target.searchParams.get("state"));
  assert.equal(relay.clientState, "s".repeat(43));
  assert.equal(relay.challenge, "c".repeat(43));
});

test("callback offers an automatic and explicit return to the fixed Obsidian protocol", async () => {
  const relay = await createRelayState(env.STATE_SECRET, {
    challenge: "c".repeat(43),
    clientState: "s".repeat(43),
    expiresAt: Date.now() + 60_000,
  });
  const response = await worker.fetch(new Request(
    `https://relay.example/oauth/callback?code=google-code&state=${encodeURIComponent(relay)}`,
  ), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-[^']+'/);
  const body = await response.text();
  assert.match(body, /Open Obsidian/);
  const href = body.match(/class="action" href="([^"]+)"/)?.[1].replaceAll("&amp;", "&");
  assert.ok(href);
  const target = new URL(href);
  assert.equal(target.protocol, "obsidian:");
  assert.equal(target.hostname, "link-calendar-google");
  assert.equal(target.searchParams.get("code"), "google-code");
  assert.equal(target.searchParams.get("state"), "s".repeat(43));
  assert.match(body, /window\.location\.assign\(returnUri\)/);
});

test("callback keeps the signed locale for recovery instructions", async () => {
  const relay = await createRelayState(env.STATE_SECRET, {
    challenge: "c".repeat(43),
    clientState: "s".repeat(43),
    expiresAt: Date.now() + 60_000,
    locale: "ko",
  });
  const response = await worker.fetch(new Request(
    `https://relay.example/oauth/callback?error=access_denied&state=${encodeURIComponent(relay)}`,
  ), env);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<html lang="ko">/);
  assert.match(body, /Obsidian 열기/);
  assert.match(body, /error=access_denied/);
});

test("token exchange verifies PKCE before forwarding credentials", async () => {
  const verifier = "v".repeat(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const relay = await createRelayState(env.STATE_SECRET, {
    challenge,
    clientState: "s".repeat(43),
    expiresAt: Date.now() + 60_000,
  });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    return Response.json({
      access_token: "access",
      expires_in: 3600,
      refresh_token: "refresh",
      scope: "https://www.googleapis.com/auth/calendar.app.created",
    });
  };
  try {
    const response = await worker.fetch(new Request("https://relay.example/oauth/token", {
      body: JSON.stringify({ code: "google-code", relayState: relay, verifier }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }), env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      accessToken: "access",
      expiresIn: 3600,
      refreshToken: "refresh",
      scopes: [
        "https://www.googleapis.com/auth/calendar.app.created",
      ],
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, "https://oauth2.googleapis.com/token");
    assert.match(String(requests[0].init.body), /client_secret=client-secret/);
    assert.match(String(requests[0].init.body), /code_verifier=/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tampered state and wrong content type fail closed", async () => {
  const response = await worker.fetch(new Request("https://relay.example/oauth/token", {
    body: "{}",
    headers: { "Content-Type": "text/plain" },
    method: "POST",
  }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_content_type" });

  const callback = await worker.fetch(new Request(
    "https://relay.example/oauth/callback?code=code&state=payload.signature",
  ), env);
  assert.equal(callback.status, 400);
  assert.deepEqual(await callback.json(), { error: "invalid_state" });
});

test("token endpoints reject malformed or oversized JSON before forwarding", async () => {
  const malformed = await worker.fetch(new Request("https://relay.example/oauth/refresh", {
    body: "{",
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }), env);
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "invalid_request" });

  const oversized = await worker.fetch(new Request("https://relay.example/oauth/refresh", {
    body: JSON.stringify({ refreshToken: "r".repeat(5_000) }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  }), env);
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "request_too_large" });
});

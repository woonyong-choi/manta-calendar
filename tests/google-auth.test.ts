// @vitest-environment node
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthManager, type SecretStore } from "../src/google-auth";
import type { GoogleHttpRequest, GoogleHttpResponse } from "../src/google-calendar";

vi.mock("node:timers", () => ({
  setTimeout: (callback: () => void, delay?: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => { globalThis.clearTimeout(timer); },
}));

const clientId = "1234567890-desktop.apps.googleusercontent.com";
const scope = "https://www.googleapis.com/auth/calendar.app.created";
const secretKey = "link-calendar-google-desktop-authorization";
const validToken = { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope, token_type: "Bearer" };
const managers: GoogleAuthManager[] = [];
afterEach(() => { managers.forEach(auth => { auth.cancel(); }); managers.length = 0; vi.useRealTimers(); });

class Secrets implements SecretStore {
  values = new Map<string, string>();
  getSecret(key: string) { return this.values.get(key) || null; }
  setSecret(key: string, value: string) { this.values.set(key, value); }
}

function fixture(handler?: (request: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>) {
  const secrets = new Secrets();
  const requests: GoogleHttpRequest[] = [];
  const auth = new GoogleAuthManager(clientId, async request => {
    requests.push(request);
    return handler ? handler(request) : { status: 200, json: validToken };
  }, secrets);
  managers.push(auth);
  return { auth, secrets, requests };
}

async function start(auth: GoogleAuthManager) {
  let opened!: (url: URL) => void;
  const browser = new Promise<URL>(resolve => { opened = resolve; });
  const done = auth.connect("en", url => { opened(new URL(url)); });
  void done.catch(() => {});
  const url = await browser;
  const callback = new URL(url.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", url.searchParams.get("state") ?? "");
  callback.searchParams.set("code", "test-code");
  return { callback, done };
}

async function approve(url: string) {
  const authorization = new URL(url);
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
  callback.searchParams.set("code", "test-code");
  await fetch(callback);
}

function rawRequest(url: URL, host: string, path = url.pathname + url.search): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, headers: { Host: host } }, response => {
      response.resume();
      response.once("end", () => { resolve(response.statusCode ?? 0); });
    });
    request.once("error", reject);
    request.end();
  });
}

describe("desktop OAuth trust boundary", () => {
  it("rejects foreign hosts, malformed URLs, duplicate parameters and wrong state before contacting Google", async () => {
    const { auth, requests } = fixture();
    const { callback, done } = await start(auth);
    expect(await rawRequest(callback, "attacker.example")).toBe(400);
    expect(await rawRequest(callback, callback.host, "http://[")).toBe(400);
    expect((await fetch(callback, { method: "POST" })).status).toBe(405);
    for (const value of ["wrong", ""]) {
      const invalid = new URL(callback);
      invalid.searchParams.set("state", value);
      expect((await fetch(invalid)).status).toBe(400);
    }
    for (const key of ["code", "state", "error"]) {
      const duplicate = new URL(callback);
      duplicate.searchParams.append(key, "duplicate");
      expect((await fetch(duplicate)).status).toBe(400);
    }
    const wrongPath = new URL(callback); wrongPath.pathname = "/other";
    expect((await fetch(wrongPath)).status).toBe(404);
    expect(requests).toHaveLength(0);
    expect(auth.connectionPhase()).toBe("waiting");
    await fetch(callback);
    await done;
    expect(requests).toHaveLength(1);
    await expect(fetch(callback)).rejects.toThrow();
  });

  it("closes the pending port when the user cancels or the plugin unloads", async () => {
    const { auth, requests } = fixture();
    const { callback, done } = await start(auth);
    const rejected = expect(done).rejects.toThrow("cancelled");
    auth.cancel();
    await rejected;
    await expect(fetch(callback)).rejects.toThrow();
    expect(requests).toHaveLength(0);
    expect(auth.connectionPhase()).toBe("idle");
  });

  it("expires the callback after ten minutes and closes its port", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { auth, requests } = fixture();
    const { callback, done } = await start(auth);
    const rejected = expect(done).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(600000);
    await rejected;
    vi.useRealTimers();
    await expect(fetch(callback)).rejects.toThrow();
    expect(auth.connectionPhase()).toBe("expired");
    expect(requests).toHaveLength(0);
  });

  it("closes the callback when opening the browser fails and allows a fresh connection", async () => {
    const { auth, requests } = fixture();
    let callback = "";
    await expect(auth.connect("en", url => {
      callback = new URL(url).searchParams.get("redirect_uri") ?? "";
      throw new Error("Could not open the browser");
    })).rejects.toThrow("Could not open the browser");
    await expect(fetch(callback)).rejects.toThrow();
    expect(requests).toHaveLength(0);
    await auth.connect("en", approve);
    expect(auth.isConnected()).toBe(true);
  });

  it("replaces an unfinished connection without accepting its old callback", async () => {
    const { auth, requests } = fixture();
    const first = await start(auth);
    const rejected = expect(first.done).rejects.toThrow("cancelled");
    const second = await start(auth);
    await rejected;
    await expect(fetch(first.callback)).rejects.toThrow();
    await fetch(second.callback);
    await second.done;
    expect(requests).toHaveLength(1);
    expect(auth.isConnected()).toBe(true);
  });

  it("handles denied consent without sending a token exchange", async () => {
    const { auth, requests } = fixture();
    const { callback, done } = await start(auth);
    callback.searchParams.delete("code"); callback.searchParams.set("error", "access_denied");
    const rejected = expect(done).rejects.toThrow("cancelled");
    expect((await fetch(callback)).status).toBe(200);
    await rejected;
    expect(auth.isConnected()).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it("preserves legacy relay tokens without using them as desktop credentials", async () => {
    const { auth, secrets, requests } = fixture();
    secrets.setSecret("link-calendar-google-refresh-token", "legacy-refresh");
    secrets.setSecret(secretKey, JSON.stringify({ clientId: "different-client", refreshToken: "foreign-refresh" }));
    expect(auth.isConnected()).toBe(false);
    await expect(auth.getAccessToken()).rejects.toThrow("not connected");
    expect(secrets.getSecret("link-calendar-google-refresh-token")).toBe("legacy-refresh");
    expect(requests).toHaveLength(0);
  });

  it.each([
    { ...validToken, scope: "email" },
    { ...validToken, expires_in: -1 },
    { ...validToken, expires_in: Number.POSITIVE_INFINITY },
    { ...validToken, token_type: "unexpected" },
    { ...validToken, refresh_token: "" },
    { ...validToken, access_token: "" },
  ])("does not store a token when Google returns invalid credentials or insufficient scope", async token => {
    const { auth, secrets } = fixture(() => ({ status: 200, json: token }));
    await expect(auth.connect("en", approve)).rejects.toThrow();
    expect(auth.isConnected()).toBe(false);
    expect(secrets.getSecret(secretKey)).toBeNull();
  });

  it("revokes directly at Google and keeps the credential if revocation fails", async () => {
    let status = 503;
    const { auth, secrets, requests } = fixture(() => ({ status, json: null }));
    secrets.setSecret(secretKey, JSON.stringify({ clientId, refreshToken: "private-refresh" }));
    await expect(auth.disconnect()).rejects.toThrow("could not be revoked");
    expect(auth.isConnected()).toBe(true);
    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(requests[0]?.body).get("token")).toBe("private-refresh");
    status = 200;
    await auth.disconnect();
    expect(auth.isConnected()).toBe(false);
  });

  it.each(["refresh", "authorization"])("does not restore a disconnected account after a late %s response", async operation => {
    let deliver!: (response: GoogleHttpResponse) => void;
    let reached!: () => void;
    const token = new Promise<GoogleHttpResponse>(resolve => { deliver = resolve; });
    const requested = new Promise<void>(resolve => { reached = resolve; });
    const { auth, secrets } = fixture(request => {
      if (request.url.endsWith("/revoke")) return { status: 200, json: null };
      reached(); return token;
    });
    secrets.setSecret(secretKey, JSON.stringify({ clientId, refreshToken: "existing" }));
    const pending = operation === "refresh" ? auth.getAccessToken() : auth.connect("en", approve);
    const rejected = expect(pending).rejects.toThrow("connection changed");
    await requested;
    await auth.disconnect();
    deliver({ status: 200, json: validToken });
    await rejected;
    expect(auth.isConnected()).toBe(false);
    expect(auth.connectionPhase()).toBe("idle");
  });

  it("does not expose provider error text or send requests when no client is configured", async () => {
    const { auth } = fixture(() => ({ status: 400, json: { error: "invalid_grant", error_description: "private-token" } }));
    await expect(auth.connect("en", approve)).rejects.toThrow("expired or was revoked");
    const http = vi.fn();
    const unavailable = new GoogleAuthManager("", http, new Secrets());
    await expect(unavailable.connect("en", () => {})).rejects.toThrow("not configured");
    expect(http).not.toHaveBeenCalled();
  });
});

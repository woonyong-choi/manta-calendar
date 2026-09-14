// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GoogleAuthManager, type SecretStore } from "../src/google-auth";
import type { GoogleHttpRequest } from "../src/google-calendar";

const clientId = "1234567890-desktop.apps.googleusercontent.com";
const clientSecret = "desktop-test-registration";
const scope = "https://www.googleapis.com/auth/calendar.app.created";

class Secrets implements SecretStore {
  values = new Map<string, string>();
  getSecret(key: string) { return this.values.get(key) || null; }
  setSecret(key: string, value: string) { this.values.set(key, value); }
}

describe("direct desktop Google authorization", () => {
  it("accepts a desktop client ID and never treats a relay address as a client", () => {
    const http = async () => ({ status: 500, json: {} });
    expect(new GoogleAuthManager(clientId, clientSecret, http, new Secrets()).isAvailable()).toBe(true);
    expect(new GoogleAuthManager("https://relay.example", clientSecret, http, new Secrets()).isAvailable()).toBe(false);
    expect(new GoogleAuthManager(clientId, "", http, new Secrets()).isAvailable()).toBe(false);
  });

  it("receives approval on loopback and exchanges and refreshes only with Google", async () => {
    const secrets = new Secrets();
    const requests: GoogleHttpRequest[] = [];
    const http = async (request: GoogleHttpRequest) => {
      requests.push(request);
      return { status: 200, json: { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope, token_type: "Bearer" } };
    };
    const auth = new GoogleAuthManager(clientId, clientSecret, http, secrets);
    let authorization!: URL;
    let callback!: URL;
    await auth.connect("ko", async (url: string) => {
      authorization = new URL(url);
      expect(authorization.origin).toBe("https://accounts.google.com");
      expect(authorization.pathname).toBe("/o/oauth2/v2/auth");
      expect(authorization.searchParams.get("client_id")).toBe(clientId);
      expect(authorization.searchParams.get("scope")).toBe(scope);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.has("code_verifier")).toBe(false);
      expect(authorization.searchParams.has("client_secret")).toBe(false);
      callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
      expect(callback.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      callback.searchParams.set("code", "one-use-code");
      callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
      const response = await fetch(callback);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await response.text();
      expect(page).toContain("Google Calendar 연결이 완료되었습니다.");
      expect(page).toContain("Obsidian 열기");
      expect(page).not.toContain("one-use-code");
      expect(auth.isConnected()).toBe(true);
    });
    expect(auth.isConnected()).toBe(true);
    expect(await auth.getAccessToken()).toBe("access");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://oauth2.googleapis.com/token");
    const exchange = new URLSearchParams(requests[0]?.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("one-use-code");
    expect(exchange.get("client_id")).toBe(clientId);
    expect(exchange.get("client_secret")).toBe(clientSecret);
    expect(exchange.get("redirect_uri")).toBe(authorization.searchParams.get("redirect_uri"));
    expect(createHash("sha256").update(exchange.get("code_verifier") ?? "").digest("base64url"))
      .toBe(authorization.searchParams.get("code_challenge"));
    expect([...secrets.values.values()].join(" ")).not.toContain("one-use-code");
    await expect(fetch(callback)).rejects.toThrow();

    const reloaded = new GoogleAuthManager(clientId, clientSecret, http, secrets);
    expect(await reloaded.getAccessToken()).toBe("access");
    expect(requests[1]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(new URLSearchParams(requests[1]?.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(requests[1]?.body).get("refresh_token")).toBe("refresh");
    expect(new URLSearchParams(requests[1]?.body).get("client_secret")).toBe(clientSecret);
  });
});

import { describe, expect, it } from "vitest";

import { GoogleAuthError, GoogleAuthManager, parseGoogleReturnLink, type SecretStore } from "../src/google-auth";
import type { GoogleHttpRequest, GoogleHttpResponse } from "../src/google-calendar";

const scopes = [
  "https://www.googleapis.com/auth/calendar.app.created",
];

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  getSecret(id: string): string | null {
    return this.values.get(id) || null;
  }

  setSecret(id: string, secret: string): void {
    this.values.set(id, secret);
  }
}

function manager(
  secrets: MemorySecrets,
  handler: (request: GoogleHttpRequest) => GoogleHttpResponse | Promise<GoogleHttpResponse>,
  now = () => 1_000,
) {
  return new GoogleAuthManager("https://relay.example", async (request) => handler(request), secrets, now);
}

describe("Google OAuth client", () => {
  it("finishes a pending connection from a pasted return link when the app handoff never fires", async () => {
    const secrets = new MemorySecrets();
    let exchanges = 0;
    const auth = manager(secrets, () => {
      exchanges++;
      return { status: 200, json: { accessToken: "access", refreshToken: "refresh", expiresIn: 3600, scopes } };
    });
    const request = new URL(await auth.beginAuthorization("en"));
    const link = new URL("obsidian://link-calendar-google");
    link.searchParams.set("code", "fresh-code");
    link.searchParams.set("relay_state", "signed-state");
    link.searchParams.set("state", request.searchParams.get("client_state") ?? "");
    expect(auth.connectionPhase()).toBe("waiting");
    await auth.completeAuthorization(parseGoogleReturnLink(link.toString()));
    expect(auth.isConnected()).toBe(true);
    expect(exchanges).toBe(1);
    await expect(auth.completeAuthorization(parseGoogleReturnLink(link.toString()))).rejects.toThrow("expired");
    expect(exchanges).toBe(1);
    expect([...secrets.values.values()].join(" ")).not.toContain("fresh-code");
  });

  it("rejects unrelated and ambiguous pasted links without making an exchange", () => {
    for (const link of [
      "https://example.com/oauth/callback?code=secret",
      "obsidian://other-action?code=secret",
      "obsidian://link-calendar-google/other?code=secret",
      "obsidian://link-calendar-google?state=a&state=b",
      "obsidian://link-calendar-google?code=a&code=b",
      "obsidian://link-calendar-google?code=a#fragment",
    ]) expect(() => parseGoogleReturnLink(link)).toThrow(GoogleAuthError);
  });

  it("starts PKCE without exposing the verifier and accepts only the matching callback", async () => {
    const secrets = new MemorySecrets();
    const requests: GoogleHttpRequest[] = [];
    const auth = manager(secrets, (request) => {
      requests.push(request);
      return {
        json: {
          accessToken: "access",
          expiresIn: 3_600,
          refreshToken: "refresh",
          scopes,
        },
        status: 200,
      };
    });
    expect(auth.connectionPhase()).toBe("idle");
    const authorizeUrl = new URL(await auth.beginAuthorization("ko"));
    expect(auth.connectionPhase()).toBe("waiting");
    expect(authorizeUrl.origin).toBe("https://relay.example");
    expect(authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(authorizeUrl.searchParams.get("locale")).toBe("ko");
    expect(authorizeUrl.searchParams.has("verifier")).toBe(false);
    const state = authorizeUrl.searchParams.get("client_state") ?? "";

    await auth.completeAuthorization({
      code: "authorization-code",
      relay_state: "signed-relay-state",
      state,
    });
    expect(auth.connectionPhase()).toBe("connected");
    expect(auth.isConnected()).toBe(true);
    expect(await auth.getAccessToken()).toBe("access");
    expect(requests).toHaveLength(1);
    const tokenRequest: unknown = JSON.parse(requests[0]?.body ?? "{}");
    expect(tokenRequest).toMatchObject({
      code: "authorization-code",
      relayState: "signed-relay-state",
    });
    expect(tokenRequest).toHaveProperty("verifier");
    if (!tokenRequest || typeof tokenRequest !== "object" || !("verifier" in tokenRequest)) {
      throw new Error("missing verifier");
    }
    expect(tokenRequest.verifier).toMatch(/^[A-Za-z0-9_-]{80,90}$/);
  });

  it("rejects callback state mismatch and an expired pending request", async () => {
    const secrets = new MemorySecrets();
    const auth = manager(secrets, () => ({ json: {}, status: 500 }));
    await auth.beginAuthorization("en");
    await expect(auth.completeAuthorization({
      code: "code",
      relay_state: "relay",
      state: "wrong-state",
    })).rejects.toBeInstanceOf(GoogleAuthError);

    let now = 1_000;
    const expired = manager(secrets, () => ({ json: {}, status: 500 }), () => now);
    await expired.beginAuthorization("en");
    now += 11 * 60 * 1_000;
    expect(expired.connectionPhase()).toBe("expired");
    await expect(expired.completeAuthorization({
      code: "code",
      relay_state: "relay",
      state: "state",
    })).rejects.toThrow("expired");
    expect(expired.connectionPhase()).toBe("failed");
  });

  it("refreshes access without putting the refresh token in a URL", async () => {
    const secrets = new MemorySecrets();
    secrets.setSecret("link-calendar-google-refresh-token", "refresh-secret");
    const requests: GoogleHttpRequest[] = [];
    const auth = manager(secrets, (request) => {
      requests.push(request);
      return {
        json: { accessToken: "renewed", expiresIn: 3_600, refreshToken: "", scopes },
        status: 200,
      };
    });
    expect(await auth.getAccessToken()).toBe("renewed");
    expect(requests[0]?.url).toBe("https://relay.example/oauth/refresh");
    expect(requests[0]?.url).not.toContain("refresh-secret");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ refreshToken: "refresh-secret" });
  });

  it("does not clear the local token when remote revocation fails", async () => {
    const secrets = new MemorySecrets();
    secrets.setSecret("link-calendar-google-refresh-token", "refresh-secret");
    const auth = manager(secrets, () => ({ json: { error: "failed" }, status: 503 }));
    await expect(auth.disconnect()).rejects.toThrow("could not be revoked");
    expect(auth.isConnected()).toBe(true);
  });

  it("revokes remotely before clearing local secrets", async () => {
    const secrets = new MemorySecrets();
    secrets.setSecret("link-calendar-google-refresh-token", "refresh-secret");
    secrets.setSecret("link-calendar-google-pending-oauth", "pending");
    const requests: GoogleHttpRequest[] = [];
    const auth = manager(secrets, (request) => {
      requests.push(request);
      return { json: { revoked: true }, status: 200 };
    });

    await auth.disconnect();

    expect(requests[0]?.url).toBe("https://relay.example/oauth/revoke");
    expect(requests[0]?.url).not.toContain("refresh-secret");
    expect(auth.isConnected()).toBe(false);
    expect(secrets.getSecret("link-calendar-google-pending-oauth")).toBeNull();
  });

  it("accepts the single least-privilege app-created scope", async () => {
    const secrets = new MemorySecrets();
    const auth = manager(secrets, () => ({
      json: {
        accessToken: "access",
        expiresIn: 3_600,
        refreshToken: "must-not-be-stored",
        scopes: [scopes[0]],
      },
      status: 200,
    }));
    const authorizeUrl = new URL(await auth.beginAuthorization("en"));

    await expect(auth.completeAuthorization({
      code: "authorization-code",
      relay_state: "signed-relay-state",
      state: authorizeUrl.searchParams.get("client_state") ?? "",
    })).resolves.toBeUndefined();
    expect(auth.isConnected()).toBe(true);
  });

  it("rejects a token response that omits the required app-created scope", async () => {
    const secrets = new MemorySecrets();
    const auth = manager(secrets, () => ({
      json: {
        accessToken: "access",
        expiresIn: 3_600,
        refreshToken: "must-not-be-stored",
        scopes: ["https://www.googleapis.com/auth/calendar.events.owned"],
      },
      status: 200,
    }));
    const authorizeUrl = new URL(await auth.beginAuthorization("en"));
    await expect(auth.completeAuthorization({
      code: "authorization-code",
      relay_state: "signed-relay-state",
      state: authorizeUrl.searchParams.get("client_state") ?? "",
    })).rejects.toThrow("permission");
    expect(auth.isConnected()).toBe(false);
  });

  it("fails closed when a token response or relay configuration is invalid", async () => {
    const secrets = new MemorySecrets();
    const auth = manager(secrets, () => ({ json: { error: "invalid_grant" }, status: 400 }));
    secrets.setSecret("link-calendar-google-refresh-token", "refresh-secret");
    await expect(auth.getAccessToken()).rejects.toThrow("invalid_grant");

    const unavailable = new GoogleAuthManager("", async () => ({ json: {}, status: 500 }), secrets);
    expect(unavailable.isAvailable()).toBe(false);
    await expect(unavailable.beginAuthorization("en")).rejects.toThrow("not configured");
  });
});

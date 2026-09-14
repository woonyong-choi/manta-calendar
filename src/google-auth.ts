import type { GoogleHttpClient } from "./google-calendar";
import { listenForGoogleAuthorization } from "./google-loopback";

const TOKEN_SECRET = "link-calendar-google-desktop-authorization";
const REQUIRED_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export type ConnectionPhase = "idle" | "waiting" | "exchanging" | "connected" | "failed" | "expired";

export class GoogleAuthManager {
  private phase: ConnectionPhase = "idle";
  private connectionGeneration = 0;
  private pending?: Awaited<ReturnType<typeof listenForGoogleAuthorization>>;
  private accessToken = "";
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly http: GoogleHttpClient,
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  connectionPhase(): ConnectionPhase {
    return this.phase === "idle" && this.isConnected() ? "connected" : this.phase;
  }

  isAvailable(): boolean { return /^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(this.clientId) && Boolean(this.clientSecret); }
  isConnected(): boolean { return this.isAvailable() && Boolean(this.refreshToken()); }

  async connect(locale: string, openBrowser: (url: string) => void | Promise<void>): Promise<void> {
    if (!this.isAvailable()) throw new Error("Google desktop connection is not configured.");
    this.cancel();
    const generation = this.connectionGeneration;
    this.phase = "waiting";
    const state = randomBase64Url(32);
    const verifier = randomBase64Url(64);
    let listener: Awaited<ReturnType<typeof listenForGoogleAuthorization>> | undefined;
    try {
      listener = await listenForGoogleAuthorization(state, locale, async (code, redirectUri, signal) => {
        this.requireCurrentConnection(generation);
        this.phase = "exchanging";
        const token = await this.postToken({
          code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri,
        });
        this.requireCurrentConnection(generation);
        signal.throwIfAborted();
        this.acceptToken(token, true);
        this.phase = "connected";
      });
      this.requireCurrentConnection(generation);
      this.pending = listener;
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: this.clientId,
        redirect_uri: listener.redirectUri,
        response_type: "code",
        scope: REQUIRED_SCOPE,
        access_type: "offline",
        prompt: "consent",
        code_challenge: await sha256Base64Url(verifier),
        code_challenge_method: "S256",
        state,
        hl: locale === "ko" ? "ko" : "en",
      }).toString();
      this.requireCurrentConnection(generation);
      await openBrowser(url.toString());
      await listener.completed;
    } catch (error) {
      if (generation === this.connectionGeneration) {
        this.phase = error instanceof Error && error.name === "TimeoutError" ? "expired" : "failed";
      }
      throw error;
    } finally {
      listener?.close();
      if (this.pending === listener) this.pending = undefined;
    }
  }

  cancel(): void {
    this.connectionGeneration++;
    this.pending?.close();
    this.pending = undefined;
    this.phase = "idle";
  }

  async getAccessToken(): Promise<string> {
    const generation = this.connectionGeneration;
    if (this.accessToken && this.accessTokenExpiresAt - this.now() > 60_000) return this.accessToken;
    const refreshToken = this.refreshToken();
    if (!refreshToken) throw new Error("Google Calendar is not connected. Connect again using direct desktop sign-in.");
    const token = await this.postToken({ grant_type: "refresh_token", refresh_token: refreshToken });
    this.requireCurrentConnection(generation);
    this.acceptToken(token, false);
    return this.accessToken;
  }

  async disconnect(): Promise<void> {
    this.cancel();
    const refreshToken = this.refreshToken();
    if (refreshToken) {
      const response = await this.http({
        url: REVOKE_URL,
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error("Google access could not be revoked. Try again before disconnecting locally.");
      }
    }
    this.cancel();
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.secrets.setSecret(TOKEN_SECRET, "");
  }

  private refreshToken(): string {
    try {
      const value: unknown = JSON.parse(this.secrets.getSecret(TOKEN_SECRET) ?? "null");
      return isRecord(value) && value.clientId === this.clientId && typeof value.refreshToken === "string" ? value.refreshToken : "";
    } catch { return ""; }
  }

  private requireCurrentConnection(generation: number): void {
    if (generation !== this.connectionGeneration) throw new Error("Google connection changed while authorization was pending. Try again from settings.");
  }

  private async postToken(parameters: Record<string, string>): Promise<unknown> {
    if (!this.isAvailable()) throw new Error("Google desktop connection is not configured.");
    const response = await this.http({
      url: TOKEN_URL,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      // Google requires this Desktop app registration value even with PKCE.
      // It identifies the distributed app; it is not a user credential.
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...parameters }).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      const reason = isRecord(response.json) && response.json.error === "invalid_grant"
        ? "Google access expired or was revoked. Connect again."
        : "Google authorization failed. Check your connection and try again.";
      throw new Error(reason);
    }
    return response.json;
  }

  private acceptToken(value: unknown, requireRefreshToken: boolean): void {
    if (!isRecord(value) || typeof value.access_token !== "string" || !value.access_token
      || typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0
      || value.token_type !== "Bearer") throw new Error("Google returned an invalid authorization response.");
    const scope = typeof value.scope === "string" ? value.scope.split(/\s+/) : [];
    if ((requireRefreshToken || value.scope !== undefined) && !scope.includes(REQUIRED_SCOPE)) {
      throw new Error("Required Google Calendar permission was not granted.");
    }
    if (requireRefreshToken && (typeof value.refresh_token !== "string" || !value.refresh_token)) {
      throw new Error("Google did not return offline access. Connect again and allow Calendar access.");
    }
    this.accessToken = value.access_token;
    this.accessTokenExpiresAt = this.now() + value.expires_in * 1000;
    if (typeof value.refresh_token === "string" && value.refresh_token) {
      this.secrets.setSecret(TOKEN_SECRET, JSON.stringify({ clientId: this.clientId, refreshToken: value.refresh_token }));
    }
  }
}

function randomBase64Url(length: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

import type { GoogleHttpClient } from "./google-calendar";

const PENDING_SECRET = "link-calendar-google-pending-oauth";
const REFRESH_TOKEN_SECRET = "link-calendar-google-refresh-token";
const REQUIRED_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar.app.created",
]);
const PENDING_MAX_AGE_MS = 10 * 60 * 1_000;

export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

export interface OAuthProtocolData {
  code?: string;
  error?: string;
  relay_state?: string;
  state?: string;
}

interface TokenResponse {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
  scopes: string[];
}

interface PendingAuthorization {
  createdAt: number;
  state: string;
  verifier: string;
}

export class GoogleAuthError extends Error {}

export function parseGoogleReturnLink(value: string): OAuthProtocolData {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new GoogleAuthError("Paste the link from the Open Obsidian button, not the Google page address."); }
  if (url.protocol !== "obsidian:" || url.hostname !== "link-calendar-google"
    || url.pathname !== "" || url.username || url.password || url.port || url.hash) {
    throw new GoogleAuthError("This is not a Link Calendar authorization return link.");
  }
  for (const key of ["code", "error", "relay_state", "state"]) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new GoogleAuthError("The authorization return link contains duplicate parameters.");
    }
  }
  return Object.fromEntries(["code", "error", "relay_state", "state"].map(
    (key) => [key, url.searchParams.get(key) ?? ""],
  ));
}

export type ConnectionPhase = "idle" | "waiting" | "returned" | "exchanging" | "connected" | "failed" | "expired";

export class GoogleAuthManager {
  private phase: ConnectionPhase = "idle";
  private connectionGeneration = 0;

  connectionPhase(): ConnectionPhase {
    if (this.phase === "waiting" || this.phase === "idle") {
      try { this.readPending(); return "waiting"; }
      catch { if (this.phase === "waiting") return "expired"; }
    }
    return this.phase === "idle" && this.isConnected() ? "connected" : this.phase;
  }
  private accessToken = "";
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly relayUrl: string,
    private readonly http: GoogleHttpClient,
    private readonly secrets: SecretStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isAvailable(): boolean {
    return /^https:\/\//.test(this.relayUrl);
  }

  isConnected(): boolean {
    return Boolean(this.secrets.getSecret(REFRESH_TOKEN_SECRET));
  }

  async beginAuthorization(locale: string): Promise<string> {
    if (!this.isAvailable()) throw new GoogleAuthError("Google Calendar connection is not configured.");
    const state = randomBase64Url(32);
    const verifier = randomBase64Url(64);
    const challenge = await sha256Base64Url(verifier);
    this.secrets.setSecret(PENDING_SECRET, JSON.stringify({ createdAt: this.now(), state, verifier }));
    const url = new URL("oauth/authorize", ensureTrailingSlash(this.relayUrl));
    url.searchParams.set("client_state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("locale", locale === "ko" ? "ko" : "en");
    this.phase = "waiting";
    return url.toString();
  }

  async completeAuthorization(data: OAuthProtocolData): Promise<void> {
    const generation = this.connectionGeneration;
    this.phase = "returned";
    try {
      const pending = this.readPending();
      if (data.error) throw new GoogleAuthError("Google authorization was cancelled. Start a new connection from settings.");
      if (!data.code || !data.relay_state || !data.state || data.state !== pending.state) {
        throw new GoogleAuthError("Google authorization response did not match this connection request.");
      }
      this.secrets.setSecret(PENDING_SECRET, "");
      this.phase = "exchanging";
      const token = await this.postToken("oauth/token", {
        code: data.code,
        relayState: data.relay_state,
        verifier: pending.verifier,
      });
      this.requireCurrentConnection(generation);
      this.acceptToken(token, true);
      this.phase = "connected";
    } catch (error) {
      if (generation === this.connectionGeneration) this.phase = "failed";
      throw error;
    }
  }

  async getAccessToken(): Promise<string> {
    const generation = this.connectionGeneration;
    if (this.accessToken && this.accessTokenExpiresAt - this.now() > 60_000) return this.accessToken;
    const refreshToken = this.secrets.getSecret(REFRESH_TOKEN_SECRET);
    if (!refreshToken) throw new GoogleAuthError("Google Calendar is not connected.");
    const token = await this.postToken("oauth/refresh", { refreshToken });
    this.requireCurrentConnection(generation);
    this.acceptToken(token, false);
    return this.accessToken;
  }

  async disconnect(): Promise<void> {
    // A completed revocation must not be undone by an older token response.
    this.connectionGeneration += 1;
    const refreshToken = this.secrets.getSecret(REFRESH_TOKEN_SECRET);
    if (refreshToken && this.isAvailable()) {
      const response = await this.http({
        body: JSON.stringify({ refreshToken }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        url: new URL("oauth/revoke", ensureTrailingSlash(this.relayUrl)).toString(),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new GoogleAuthError("Google access could not be revoked. Try again before disconnecting locally.");
      }
    }
    this.connectionGeneration += 1;
    this.phase = "idle";
    this.accessToken = "";
    this.accessTokenExpiresAt = 0;
    this.secrets.setSecret(REFRESH_TOKEN_SECRET, "");
    this.secrets.setSecret(PENDING_SECRET, "");
  }

  private requireCurrentConnection(generation: number): void {
    if (generation !== this.connectionGeneration) {
      throw new GoogleAuthError("Google connection changed while authorization was pending. Try again from settings.");
    }
  }

  private readPending(): PendingAuthorization {
    const raw = this.secrets.getSecret(PENDING_SECRET);
    if (!raw) throw new GoogleAuthError("The Google connection request expired. Start again from settings.");
    try {
      const value: unknown = JSON.parse(raw);
      if (!isRecord(value)
        || typeof value.createdAt !== "number"
        || typeof value.state !== "string"
        || typeof value.verifier !== "string"
        || this.now() - value.createdAt > PENDING_MAX_AGE_MS) {
        throw new Error("invalid pending authorization");
      }
      return value as unknown as PendingAuthorization;
    } catch {
      throw new GoogleAuthError("The Google connection request expired. Start again from settings.");
    }
  }

  private async postToken(path: string, body: Record<string, string>): Promise<TokenResponse> {
    if (!this.isAvailable()) throw new GoogleAuthError("Google Calendar connection is not configured.");
    const response = await this.http({
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      url: new URL(path, ensureTrailingSlash(this.relayUrl)).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      const value = isRecord(response.json) ? response.json : {};
      const message = typeof value.error === "string" ? value.error : "Google authorization failed.";
      throw new GoogleAuthError(message);
    }
    return normalizeTokenResponse(response.json, this.now());
  }

  private acceptToken(token: TokenResponse, requireRefreshToken: boolean): void {
    if (requireRefreshToken && !token.refreshToken) {
      throw new GoogleAuthError("Google did not return offline access. Revoke access and connect again.");
    }
    for (const scope of REQUIRED_SCOPES) {
      if (!token.scopes.includes(scope)) throw new GoogleAuthError("Required Google Calendar permission was not granted.");
    }
    this.accessToken = token.accessToken;
    this.accessTokenExpiresAt = token.expiresAt;
    if (token.refreshToken) this.secrets.setSecret(REFRESH_TOKEN_SECRET, token.refreshToken);
  }
}

function normalizeTokenResponse(value: unknown, now: number): TokenResponse {
  if (!isRecord(value)) throw new GoogleAuthError("Google returned an invalid authorization response.");
  const accessToken = typeof value.accessToken === "string" ? value.accessToken : "";
  const refreshToken = typeof value.refreshToken === "string" ? value.refreshToken : "";
  const expiresIn = typeof value.expiresIn === "number" ? value.expiresIn : 0;
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === "string")
    : [];
  if (!accessToken || expiresIn <= 0) {
    throw new GoogleAuthError("Google returned an invalid authorization response.");
  }
  return { accessToken, expiresAt: now + expiresIn * 1_000, refreshToken, scopes };
}

function randomBase64Url(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64Url(bytes);
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

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

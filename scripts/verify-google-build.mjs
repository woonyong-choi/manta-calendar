import { readFile } from "node:fs/promises";
import { googleClientId, googleClientSecret } from "./google-build-config.mjs";

const errors = [];
if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId)) {
  errors.push("Register a Google Desktop app and set its public client ID in google-oauth-client.json before releasing");
}
const bundle = await readFile("main.js", "utf8");
if (process.argv.includes("--require-configured") && !googleClientSecret) {
  errors.push("Release builds require MANTA_GOOGLE_DESKTOP_CLIENT_SECRET from the registered Desktop app");
}
if (googleClientId && !bundle.includes(googleClientId)) errors.push("main.js is missing the versioned Google client ID");
if (googleClientSecret && !bundle.includes(googleClientSecret)) errors.push("main.js is missing the configured Desktop app registration value");
for (const [value] of bundle.matchAll(/GOCSPX-[A-Za-z0-9_-]+/gu)) {
  if (value !== googleClientSecret) errors.push("main.js contains an unexpected OAuth credential");
}
for (const endpoint of [
  "https://accounts.google.com/o/oauth2/v2/auth",
  "https://oauth2.googleapis.com/token",
  "https://oauth2.googleapis.com/revoke",
  "https://www.googleapis.com/calendar/v3",
  "http://127.0.0.1:",
]) {
  if (!bundle.includes(endpoint)) errors.push(`main.js is missing the direct Google endpoint: ${endpoint}`);
}
const allowedHosts = new Set(["accounts.google.com", "oauth2.googleapis.com", "www.googleapis.com", "127.0.0.1"]);
for (const [origin] of bundle.matchAll(/https?:\/\/[a-zA-Z0-9.-]+/gu)) {
  if (!allowedHosts.has(new URL(origin).hostname)) errors.push(`Unexpected network origin in main.js: ${origin}`);
}
for (const forbidden of ["STATE_SECRET", "link-calendar-google-refresh-token", "obsidian://link-calendar-google"]) {
  if (bundle.includes(forbidden)) errors.push(`main.js contains obsolete authentication or secret material: ${forbidden}`);
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify({ clientId: googleClientId, authentication: "direct-desktop-pkce", configured: Boolean(googleClientSecret), status: "ok" }));

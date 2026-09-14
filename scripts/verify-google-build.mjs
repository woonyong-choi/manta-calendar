import { readFile } from "node:fs/promises";
import { googleClientId } from "./google-build-config.mjs";

const errors = [];
if (!/^\d+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(googleClientId)) {
  errors.push("Register a Google Desktop app and set its public client ID in google-oauth-client.json before releasing");
}
const bundle = await readFile("main.js", "utf8");
if (googleClientId && !bundle.includes(googleClientId)) errors.push("main.js is missing the versioned Google client ID");
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
for (const forbidden of ["GOOGLE_CLIENT_SECRET", "STATE_SECRET", "client_secret", "GOCSPX-", "link-calendar-google-refresh-token", "obsidian://link-calendar-google"]) {
  if (bundle.includes(forbidden)) errors.push(`main.js contains obsolete authentication or secret material: ${forbidden}`);
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify({ clientId: googleClientId, authentication: "direct-desktop-pkce", status: "ok" }));

import { readFile } from "node:fs/promises";
import { googleRelayUrl as relay, officialGoogleRelayUrl } from "./google-build-config.mjs";

const relayRequired = process.env.LINK_CALENDAR_REQUIRE_GOOGLE_RELAY === "1";
const errors = [];
if (relayRequired && relay !== officialGoogleRelayUrl) {
  errors.push("Official releases must use the versioned Google OAuth relay origin for reproducible builds");
}
let url;

if (relay) {
  try {
    url = new URL(relay);
  } catch {
    errors.push("LINK_CALENDAR_GOOGLE_RELAY_URL must be an absolute HTTPS URL");
  }
} else if (relayRequired) {
  errors.push("LINK_CALENDAR_GOOGLE_RELAY_URL is required for a release build");
}

if (url) {
  if (url.protocol !== "https:") errors.push("Google OAuth relay must use HTTPS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    errors.push("Google OAuth relay URL must be an origin without credentials, a path, a query, or a fragment");
  }
  if (url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname.endsWith(".invalid")
    || url.hostname.endsWith(".example")
    || /^(?:.+\.)?example\.(?:com|net|org)$/u.test(url.hostname)) {
    errors.push("Google OAuth relay URL must be a deployed production origin");
  }
}

const bundle = await readFile("main.js", "utf8");
if (relay && !bundle.includes(relay)) {
  errors.push("main.js does not contain the configured Google OAuth relay URL");
}
for (const forbidden of ["GOOGLE_CLIENT_SECRET", "STATE_SECRET", "link-calendar-google-refresh-token="]) {
  if (bundle.includes(forbidden)) errors.push(`main.js exposes forbidden secret material: ${forbidden}`);
}

if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify({ relay: url?.origin ?? null, required: relayRequired, status: "ok" }));

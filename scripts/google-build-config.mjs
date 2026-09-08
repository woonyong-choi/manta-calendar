import { readFile } from "node:fs/promises";

// The public relay origin is already versioned with its deployment route.
// Reuse it so a clean checkout reproduces the official plugin without CI variables.
const worker = JSON.parse(await readFile(new URL("../oauth-worker/wrangler.jsonc", import.meta.url), "utf8"));
const route = worker.routes.find((entry) => entry.custom_domain);
if (!route) throw new Error("Google OAuth relay requires a versioned custom domain");

export const officialGoogleRelayUrl = `https://${route.pattern}`;
export const googleRelayUrl = process.env.LINK_CALENDAR_GOOGLE_RELAY_URL?.trim() ?? officialGoogleRelayUrl;

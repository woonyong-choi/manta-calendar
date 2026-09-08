import { googleRelayUrl as relay } from "./google-build-config.mjs";
let relayUrl;
try {
  relayUrl = new URL(relay);
} catch {
  throw new Error("LINK_CALENDAR_GOOGLE_RELAY_URL must be an absolute HTTPS origin");
}
if (relayUrl.protocol !== "https:"
  || relayUrl.username
  || relayUrl.password
  || relayUrl.pathname !== "/"
  || relayUrl.search
  || relayUrl.hash) {
  throw new Error("LINK_CALENDAR_GOOGLE_RELAY_URL must be an exact HTTPS origin");
}
const health = new URL("health", relayUrl);
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 10_000);

try {
  let response;
  try {
    response = await fetch(health, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    const detail = error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : error instanceof Error ? error.message : "unknown network error";
    throw new Error(`Google OAuth relay is unreachable at ${health.origin}: ${detail}`);
  }
  const body = await response.json();
  if (!response.ok
    || body?.status !== "ok"
    || body?.protocol !== 1
    || body?.origin !== relayUrl.origin) {
    throw new Error(`Google OAuth relay health check failed (${String(response.status)})`);
  }
  console.log(JSON.stringify({ relay: health.origin, status: "ok" }));
} finally {
  clearTimeout(timeout);
}

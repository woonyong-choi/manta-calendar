import { readFile } from "node:fs/promises";

// Desktop OAuth client IDs identify the app; they are public, not credentials.
const client = JSON.parse(await readFile(new URL("../google-oauth-client.json", import.meta.url), "utf8"));
if (client.type !== "desktop") throw new Error("Google connection requires a desktop OAuth client");
if (typeof client.clientId !== "string" || Object.keys(client).some(key => !["type", "clientId"].includes(key))) {
  throw new Error("Google build configuration must contain only a type and public client ID");
}
export const googleClientId = client.clientId;
// Keep the Desktop registration value out of Git. Installed apps cannot keep it
// confidential; release builds embed it as required by Google's native flow.
export const googleClientSecret = process.env.MANTA_GOOGLE_DESKTOP_CLIENT_SECRET?.trim() ?? "";
if (googleClientSecret && !/^GOCSPX-[A-Za-z0-9_-]+$/.test(googleClientSecret)) {
  throw new Error("Invalid Google Desktop app registration value");
}

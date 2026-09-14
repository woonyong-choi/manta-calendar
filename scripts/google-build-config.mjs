import { readFile } from "node:fs/promises";

// Desktop OAuth client IDs identify the app; they are public, not credentials.
const client = JSON.parse(await readFile(new URL("../google-oauth-client.json", import.meta.url), "utf8"));
if (client.type !== "desktop") throw new Error("Google connection requires a desktop OAuth client");
if (typeof client.clientId !== "string" || Object.keys(client).some(key => !["type", "clientId"].includes(key))) {
  throw new Error("Google build configuration must contain only a type and public client ID");
}
export const googleClientId = client.clientId;

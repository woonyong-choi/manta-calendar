import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const errors = [];
const sourceFiles = (await readdir("src")).filter((file) => file.endsWith(".ts"));
const source = await Promise.all(sourceFiles.map((file) => readFile(`src/${file}`, "utf8")));
const publicDocs = await Promise.all(
  ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "PRIVACY.md", "SECURITY.md", "docs/google-calendar.md"]
    .map((file) => readFile(file, "utf8")),
);
const oauthProtocol = await readFile("oauth-worker/src/protocol.mjs", "utf8");
const oauthWorkerConfig = JSON.parse(await readFile("oauth-worker/wrangler.jsonc", "utf8"));
const styles = await readFile("styles.css", "utf8");
const media = JSON.parse(await readFile("docs/release-media.json", "utf8"));
const requiredMedia = [
  "docs/media/link-calendar-demo.gif",
  "docs/media/link-calendar-overview.png",
  "docs/media/link-calendar-agenda.png",
];

const imageDimensions = (bytes, path) => {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  const gifHeader = bytes.subarray(0, 6).toString("ascii");
  if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  errors.push(`${path} must contain real PNG or GIF bytes`);
  return { width: 0, height: 0 };
};

const { stdout: trackedBundle } = await run("git", ["ls-files", "main.js"]);
if (trackedBundle.trim()) errors.push("main.js must be a release asset, not a tracked source file");

if (manifest.id !== "link-calendar") errors.push("manifest id must be link-calendar");
if (manifest.name !== "Link Calendar Navigator") {
  errors.push("manifest name must be Link Calendar Navigator");
}
if (packageJson.name !== "link-calendar") errors.push("package name must be link-calendar");
if (!packageJson.repository?.url?.endsWith("woonyong-choi/obsidian-link-calendar-navigator.git")) {
  errors.push("package repository must be woonyong-choi/obsidian-link-calendar-navigator");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push("manifest version must use exact x.y.z format");
if (manifest.version !== packageJson.version) errors.push("manifest/package versions differ");
if (versions[manifest.version] !== manifest.minAppVersion) errors.push("versions.json does not match manifest");
if (media.version !== manifest.version) errors.push("release media version does not match manifest");
if (media.publicSafeSample !== true) errors.push("release media must use public-safe sample content");
if (manifest.minAppVersion !== "1.13.0") errors.push("declarative settings require minAppVersion 1.13.0");
if (manifest.description.length > 250 || !manifest.description.endsWith(".")) {
  errors.push("manifest description must be at most 250 characters and end with a period");
}
for (const key of ["name", "description", "author", "authorUrl", "minAppVersion"]) {
  if (!manifest[key]) errors.push(`manifest is missing ${key}`);
}
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  if ((await stat(file)).size === 0) errors.push(`${file} is empty`);
}
if ((await stat("main.js")).size > 1_000_000) errors.push("main.js exceeds 1 MB");
if (publicDocs.some((content) => content.includes("\\x60"))) {
  errors.push("public documentation contains escaped backtick literals");
}
for (const forbidden of [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /require\(["'](?:fs|child_process|http|https)["']\)/,
  /\.style\./,
  /setAttribute\(["']style["']/,
  /\bgetFiles\s*\(/,
  /instanceof\s+InputEvent/,
  /as\s+InputEvent/,
]) {
  if (source.some((content) => forbidden.test(content))) {
    errors.push(`source contains forbidden capability: ${String(forbidden)}`);
  }
}
if (!source.some((content) => content.includes("getMarkdownFiles()"))) {
  errors.push("automatic timeline index must use the Markdown-only Vault boundary");
}
if (!source.some((content) => content.includes("extractMarkdownTemporal"))) {
  errors.push("automatic timeline index must keep body extraction in its adapter");
}
if (!source.some((content) => content.includes("getSettingDefinitions()"))) {
  errors.push("settings must use the declarative settings API");
}
if (!source.some((content) => content.includes('registerObsidianProtocolHandler("link-calendar-google"'))) {
  errors.push("Google OAuth callback must use the fixed link-calendar protocol handler");
}
if (!oauthProtocol.includes('"https://www.googleapis.com/auth/calendar.app.created"')) {
  errors.push("Google OAuth relay must request the app-created calendar scope");
}
for (const broadScope of [
  '"https://www.googleapis.com/auth/calendar"',
  '"https://www.googleapis.com/auth/calendar.events"',
  '"https://www.googleapis.com/auth/calendar.events.owned"',
  '"https://www.googleapis.com/auth/calendar.calendarlist.readonly"',
]) {
  if (oauthProtocol.includes(broadScope)) errors.push(`OAuth relay contains a broader scope: ${broadScope}`);
}
if (oauthWorkerConfig.observability?.enabled !== false) {
  errors.push("OAuth relay observability must remain disabled");
}
if (oauthWorkerConfig.vars?.PLUGIN_REDIRECT_URI !== "obsidian://link-calendar-google") {
  errors.push("OAuth relay must return only to the fixed Obsidian protocol URI");
}
if (!publicDocs[0].includes("[privacy policy](PRIVACY.md)")) {
  errors.push("README must link the Google data privacy policy");
}
if (!source.some((content) => content.includes('VIEW_TYPE = "link-calendar-view"'))) {
  errors.push("view type must use the link-calendar namespace");
}
if (source.some((content) => content.includes('VIEW_TYPE = "context-calendar-view"'))) {
  errors.push("legacy context-calendar view type would collide during migration");
}
if (source.some((content) => content.includes('registerMarkdownCodeBlockProcessor("context-calendar"'))) {
  errors.push("legacy context-calendar code block would collide during migration");
}
if (styles.includes("!important")) errors.push("styles.css must not use !important");
if (/\.link-calendar button\.link-calendar__marker(?:\.[^{\s]+)*\s*\{[^}]*border-left(?:-color)?\s*:/su.test(styles)) {
  errors.push("month event cards must not render a left accent stripe");
}
for (const removedSelector of ["link-calendar__preview", "link-calendar__properties", "link-calendar__relation"]) {
  if (styles.includes(removedSelector)) errors.push(`styles contain removed UI: ${removedSelector}`);
}
if (source.some((content) => content.includes('setIcon(link, "arrow-up-right")'))) {
  errors.push("agenda links must use the visible note title, not an arrow icon");
}
const mediaRecords = new Map(media.assets.map((asset) => [asset.path, asset]));
if (mediaRecords.size !== requiredMedia.length) errors.push("release media record is incomplete");
for (const path of requiredMedia) {
  const record = mediaRecords.get(path);
  if (!record) {
    errors.push(`release media record is missing ${path}`);
    continue;
  }
  if (path.endsWith(".gif") && !publicDocs[0].includes(`](${path})`)) errors.push(`README does not embed ${path}`);
  const bytes = await readFile(path);
  const dimensions = imageDimensions(bytes, path);
  if (dimensions.width < 1600 || dimensions.height < 900) errors.push(`${path} is too small`);
  if (dimensions.width * 9 !== dimensions.height * 16) errors.push(`${path} must use a 16:9 frame`);
  if (record.width !== dimensions.width || record.height !== dimensions.height) {
    errors.push(`${path} dimensions are stale`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (record.sha256 !== sha256) errors.push(`${path} SHA-256 is stale`);
}

if (errors.length) throw new Error(errors.join("\n"));
console.log(JSON.stringify({ status: "ok", id: manifest.id, version: manifest.version }));

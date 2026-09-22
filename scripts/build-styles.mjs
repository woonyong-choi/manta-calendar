import { readFile, writeFile } from "node:fs/promises";

const sources = [
  // manta-tokens 가 생성한다. 정본은 ../manta-tokens/tokens.json.
  "src/styles/manta-tokens.css",
  "src/styles/tokens.css",
  "src/styles/shell.css",
  "src/styles/month-grid.css",
  "src/styles/event-detail.css",
  "src/styles/supporting.css",
];

const parts = await Promise.all(sources.map((path) => readFile(path, "utf8")));
const components = parts.slice(2).join("\n");
const tokens = parts[1];
const forbidden = [
  [/(?:^|[^-])#[0-9a-f]{3,8}\b/iu, "literal color"],
  [/\brgba?\(/u, "literal rgb color"],
  [/\.theme-(?:dark|light)\b/u, "appearance-specific selector"],
  [/\bcupertino\b/iu, "theme-specific selector"],
  [/var\(--(?!cc-)/u, "unscoped design token"],
  [/!important\b/u, "important override"],
  [/\b\d+(?:\.\d+)?px\b/u, "literal pixel geometry"],
];

for (const [pattern, label] of forbidden) {
  if (pattern.test(components)) throw new Error(`Component CSS contains ${label}`);
}

if (/(?:^|\})\s*(?:body|html|:root)\b/mu.test(tokens)) {
  throw new Error("Token CSS contains a global root selector");
}

const hostTokensOnly = tokens;
if (/(?:^|[^-])#[0-9a-f]{3,8}\b/iu.test(hostTokensOnly) || /\brgba?\(/u.test(hostTokensOnly)) {
  throw new Error("Only the shared Wiki canvas may own a literal color");
}

const hostTokens = new Set([
  "--anim-duration-fast",
  "--anim-duration-moderate",
  "--anim-motion-smooth",
  "--background-modifier-active-hover",
  "--background-modifier-border-hover",
  "--background-modifier-hover",
  "--background-primary",
  "--background-secondary",
  "--background-secondary-alt",
  "--border-width",
  "--color-blue",
  "--color-cyan",
  "--color-green",
  "--color-orange",
  "--color-pink",
  "--color-purple",
  "--color-red",
  "--color-yellow",
  "--divider-color",
  "--focus-ring-width",
  "--font-bold",
  "--font-interface",
  "--font-medium",
  "--font-monospace",
  "--font-semibold",
  "--font-ui-large",
  "--font-ui-medium",
  "--font-ui-small",
  "--font-ui-smaller",
  "--h3-size",
  "--h4-size",
  "--icon-size",
  "--input-height",
  "--interactive-accent",
  "--interactive-accent-hover",
  "--letter-spacing-tight",
  "--letter-spacing-wide",
  "--line-height-normal",
  "--radius-l",
  "--radius-m",
  "--radius-s",
  "--radius-xl",
  "--shadow-l",
  "--size-4-1",
  "--size-4-2",
  "--size-4-3",
  "--size-4-4",
  "--size-4-5",
  "--size-4-6",
  "--size-4-8",
  "--text-error",
  "--text-faint",
  "--text-muted",
  "--text-normal",
  "--text-on-accent",
  "--text-warning",
]);
for (const match of tokens.matchAll(/var\((--[a-z0-9-]+)/gu)) {
  const name = match[1];
  if (name && !name.startsWith("--cc-") && !name.startsWith("--manta-") && !hostTokens.has(name)) {
    throw new Error(`Token CSS aliases unsupported host variable: ${name}`);
  }
}

for (const [index, part] of parts.entries()) {
  const opens = [...part.matchAll(/\{/gu)].length;
  const closes = [...part.matchAll(/\}/gu)].length;
  if (opens !== closes) {
    throw new Error(`${sources[index]} has unbalanced braces: ${opens} open, ${closes} close`);
  }
}

await writeFile("styles.css", `${parts.map((part) => part.trim()).join("\n\n")}\n`, "utf8");

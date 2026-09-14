import esbuild from "esbuild";
import { googleClientId, googleClientSecret } from "./scripts/google-build-config.mjs";

const production = process.argv[2] === "production";
const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  define: {
    __MANTA_GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
    __MANTA_GOOGLE_CLIENT_SECRET__: JSON.stringify(googleClientSecret),
  },
  external: ["node:http", "node:timers", "obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  logLevel: "info",
  minify: production,
  outfile: "main.js",
  platform: "browser",
  sourcemap: production ? false : "inline",
  target: "es2022",
  treeShaking: true,
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}

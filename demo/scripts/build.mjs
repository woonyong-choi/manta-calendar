import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recipes = JSON.parse(readFileSync(join(root, "recipes.json"), "utf8"));
const selected = new Set(process.argv.slice(2));

if (selected.size && recipes.every((recipe) => !selected.has(recipe.id))) {
  throw new Error(`Unknown demo: ${[...selected].join(", ")}`);
}

mkdirSync(join(root, "dist"), { recursive: true });

for (const recipe of recipes) {
  if (selected.size && !selected.has(recipe.id)) continue;
  build(recipe);
}

function build(recipe) {
  if (recipe.width * 9 !== recipe.height * 16 || recipe.width < 1600 || recipe.height < 900) {
    throw new Error(`${recipe.id} must render at a sharp 16:9 size of at least 1600x900`);
  }
  const output = join(root, "dist", recipe.output);
  const temporaryOutput = `${output}.${String(process.pid)}.tmp.gif`;
  const inputArgs = [];
  const filters = [];

  for (const [index, frame] of recipe.frames.entries()) {
    const input = join(root, frame);
    statSync(input);
    const dimensions = probeDimensions(input);
    if (dimensions.width * 9 !== dimensions.height * 16) {
      throw new Error(`${frame} must be captured at 16:9, not stretched during GIF assembly`);
    }
    if (dimensions.width < recipe.width || dimensions.height < recipe.height) {
      throw new Error(`${frame} is smaller than ${String(recipe.width)}x${String(recipe.height)}`);
    }
    inputArgs.push(
      "-loop", "1",
      "-framerate", String(recipe.fps),
      "-t", String(recipe.frameDuration),
      "-i", input,
    );
    filters.push(
      `[${String(index)}:v]scale=${String(recipe.width)}:${String(recipe.height)}:flags=lanczos,format=rgba[v${String(index)}]`,
    );
  }

  let previous = "v0";
  for (let index = 1; index < recipe.frames.length; index += 1) {
    const outputLabel = `x${String(index)}`;
    const offset = (recipe.frameDuration - recipe.fadeDuration) * index;
    filters.push(
      `[${previous}][v${String(index)}]xfade=transition=fade:duration=${String(recipe.fadeDuration)}:offset=${offset.toFixed(3)}[${outputLabel}]`,
    );
    previous = outputLabel;
  }
  filters.push(
    `[${previous}]split[palette-source][gif-source]`,
    "[palette-source]palettegen=stats_mode=diff[palette]",
    "[gif-source][palette]paletteuse=dither=sierra2_4a[gif]",
  );

  try {
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      ...inputArgs,
      "-filter_complex", filters.join(";"),
      "-map", "[gif]",
      "-loop", "0",
      temporaryOutput,
    ], { stdio: "inherit" });
    renameSync(temporaryOutput, output);
  } finally {
    rmSync(temporaryOutput, { force: true });
  }

  const bytes = readFileSync(output);
  console.log(JSON.stringify({
    id: recipe.id,
    output,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: recipe.width,
    height: recipe.height,
  }));
}

function probeDimensions(path) {
  const output = execFileSync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "json",
    path,
  ], { encoding: "utf8" });
  const stream = JSON.parse(output).streams?.[0];
  if (!Number.isInteger(stream?.width) || !Number.isInteger(stream?.height)) {
    throw new Error(`Could not read image dimensions: ${path}`);
  }
  return stream;
}

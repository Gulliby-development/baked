/**
 * Stages the local speech engine into dist/.stage/voice, which electron-builder copies to
 * resources/voice and a source run reads directly:
 *
 *   bun run stage:voice [-- --model <whistle.cact>]
 *
 * The cactus-needle package is copied as is (it is ESM with its own worker and WebAssembly, so it
 * cannot go through the CommonJS main bundle). The Whistle model comes from `--model`, else from
 * .cache/voice, else it is downloaded once from Hugging Face; its size and SHA-256 must match the
 * pins in the package's manifest either way.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..");
const stage = join(root, "dist", ".stage", "voice");
const MODEL_FILE = "whistle.cact";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { model: { type: "string" } },
});

function fail(message: string): never {
  console.error(`stage-voice: ${message}`);
  process.exit(1);
}

interface Manifest {
  speechModel: { size: number; sha256: string; revision: string; repository: string };
}

const packageDir = dirname(createRequire(import.meta.url).resolve("cactus-needle/package.json"));
const manifest = JSON.parse(
  readFileSync(join(packageDir, "vendor", "manifest.json"), "utf8"),
) as Manifest;
const pin = manifest.speechModel;

function verify(path: string): void {
  const data = readFileSync(path);
  if (data.length !== pin.size) fail(`${path} is ${data.length} bytes, expected ${pin.size}`);
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== pin.sha256) fail(`${path} has SHA-256 ${sha}, expected ${pin.sha256}`);
}

async function modelSource(): Promise<string> {
  if (values.model) return resolve(values.model);
  const { downloadModel } = (await import(
    pathToFileURL(join(packageDir, "dist", "index.js")).href
  )) as { downloadModel(options: { model: "whistle"; cacheDir: string }): Promise<string> };
  console.log(`stage-voice: fetching ${pin.repository}@${pin.revision.slice(0, 7)} (cached)`);
  return downloadModel({ model: "whistle", cacheDir: join(root, ".cache", "voice") });
}

const model = await modelSource().catch((error: unknown) =>
  fail(`could not get the speech model: ${error instanceof Error ? error.message : error}`),
);
if (!existsSync(model)) fail(`no model at ${model}`);
verify(model);

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "cactus-needle"), { recursive: true });
for (const entry of ["package.json", "LICENSE", "dist", "vendor"]) {
  const from = join(packageDir, entry);
  if (existsSync(from)) cpSync(from, join(stage, "cactus-needle", entry), { recursive: true });
}
// The AI SDK adapters import packages the app does not ship.
rmSync(join(stage, "cactus-needle", "dist", "ai-sdk"), { recursive: true, force: true });
cpSync(model, join(stage, MODEL_FILE));
console.log(`stage-voice: staged the speech engine in ${stage}`);

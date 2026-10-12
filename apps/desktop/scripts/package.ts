/**
 * Builds the app and packages it for the current platform with electron-builder.
 *
 *   bun run package -- --baked <path-to-baked-binary> [--arch x64|arm64] [--target <name>]
 *
 * The binary (or BAKED_BINARY) is copied to resources/bin; a `deps/` folder next to it, as in the
 * release bundles, goes along so the compiled binary can hydrate its workers and native libraries.
 * The speech engine and its model are staged into resources/voice (scripts/stage-voice.ts).
 * Installers land in dist/. `--target` replaces the platform's targets from electron-builder.yml,
 * e.g. `--target portable` for a Windows exe that runs without installing.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..");
const ARCHS = ["x64", "arm64"] as const;
type Arch = (typeof ARCHS)[number];
const PLATFORM_FLAGS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "--mac",
  linux: "--linux",
  win32: "--win",
};

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    baked: { type: "string" },
    arch: { type: "string" },
    target: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`package: ${message}`);
  process.exit(1);
}

const platformFlag = PLATFORM_FLAGS[process.platform] ?? fail(`unsupported platform ${process.platform}`);
const arch = (values.arch ?? process.arch) as Arch;
if (!ARCHS.includes(arch)) fail(`unsupported architecture ${arch}; use x64 or arm64`);

const bakedArg = values.baked ?? process.env.BAKED_BINARY;
if (!bakedArg) fail("pass --baked <path-to-baked-binary> or set BAKED_BINARY");
const baked = resolve(bakedArg);
if (!existsSync(baked)) fail(`no baked binary at ${baked}`);

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: root, stdio: ["inherit", "inherit", "inherit"] });
  if (result.exitCode !== 0) fail(`${command.join(" ")} exited with ${result.exitCode}`);
}

const stage = join(root, "dist", ".stage", "bin");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
const exe = join(stage, process.platform === "win32" ? "baked.exe" : "baked");
cpSync(baked, exe);
chmodSync(exe, 0o755);
const deps = join(dirname(baked), "deps");
if (existsSync(deps)) cpSync(deps, join(stage, "deps"), { recursive: true });
else console.warn(`package: no deps/ next to ${baked}; workflows need the bundle's deps folder`);

// The local speech engine for voice input lands in resources/voice.
run([process.execPath, "scripts/stage-voice.ts"]);
run([process.execPath, "scripts/build.ts"]);

// Installers carry the repository's version, which is what release tags name.
const rootPackage = join(root, "..", "..", "package.json");
const version = existsSync(rootPackage)
  ? (JSON.parse(readFileSync(rootPackage, "utf8")) as { version: string }).version
  : null;

// electron-builder is a Node program and is run with Node.
const cli = createRequire(import.meta.url).resolve("electron-builder/cli.js");
run([
  "node",
  cli,
  platformFlag,
  ...(values.target ? [values.target] : []),
  `--${arch}`,
  "--publish",
  "never",
  ...(version ? [`-c.extraMetadata.version=${version}`] : []),
]);

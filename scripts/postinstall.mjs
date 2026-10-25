#!/usr/bin/env bun
/**
 * Postinstall: hydrate native libs into the per-user data dir.
 *
 * Runs after `bun install` of `@baked/baked`. Plain ESM so it works
 * under Bun's lifecycle hook runner.
 *
 * Locates whichever platform-specific optional deps the package manager
 * installed (`@opentui/core-<plat>-<arch>`)
 * and copies their native binaries into:
 *
 *   Windows:  %LOCALAPPDATA%\baked\native\<plat>-<arch>\
 *   POSIX:    ~/.baked/native/<plat>-<arch>/
 *
 * The runtime resolver in scripts/build.ts (and the OpenTUI native plugin)
 * looks in exactly those paths, so once postinstall runs the bundle has
 * everything it needs to start.
 *
 * Idempotent. Soft-fails: any copy error is logged but does not abort
 * install. The runtime prints a clear error if something genuinely went
 * wrong; rerun it with `bun scripts/postinstall.mjs` from the package directory.
 *
 * Skipped when BAKED_SKIP_POSTINSTALL=1.
 */
import { existsSync, copyFileSync, mkdirSync, readdirSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const QUIET = process.env.BAKED_POSTINSTALL_QUIET === "1";
const SKIP = process.env.BAKED_SKIP_POSTINSTALL === "1";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(msg) {
  if (!QUIET) console.log(`[baked postinstall] ${msg}`);
}
function warn(msg) {
  console.warn(`[baked postinstall] ${msg}`);
}

function appDataDir() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "baked");
  }
  return join(process.env.HOME ?? homedir(), ".baked");
}

function nativeDir() {
  return join(appDataDir(), "native", `${process.platform}-${process.arch}`);
}

function opentuiLibName() {
  if (process.platform === "win32") return "opentui.dll";
  if (process.platform === "darwin") return "libopentui.dylib";
  return "libopentui.so";
}

/** Walk up from this script to find the platform-specific @opentui/core-<plat>-<arch> dir. */
function findOpentuiNativePackage() {
  const triplet = `${process.platform}-${process.arch}`;
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "node_modules", "@opentui", `core-${triplet}`);
    if (existsSync(join(p, opentuiLibName()))) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function findPackageRoot(name) {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    const p = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(p, "package.json"))) return p;
    dir = resolve(dir, "..");
  }
  return null;
}

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  if (process.platform !== "win32") {
    try {
      chmodSync(dest, 0o755);
    } catch {}
  }
}

function copyTree(src, dest) {
  const stat = statSync(src);
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      copyTree(join(src, name), join(dest, name));
    }
  } else {
    copyFile(src, dest);
  }
}

async function main() {
  if (SKIP) {
    log("skipped (BAKED_SKIP_POSTINSTALL=1)");
    return;
  }

  log(`hydrating native runtime for ${process.platform}-${process.arch}`);
  log(`target: ${nativeDir()}`);
  mkdirSync(nativeDir(), { recursive: true });

  // ── OpenTUI native lib (required) ──
  const opentuiPkg = findOpentuiNativePackage();
  if (opentuiPkg) {
    try {
      copyFile(join(opentuiPkg, opentuiLibName()), join(nativeDir(), opentuiLibName()));
      log(`✓ ${opentuiLibName()}`);
    } catch (err) {
      warn(`failed to copy ${opentuiLibName()}: ${err.message}`);
    }
  } else {
    warn(
      `@opentui/core-${process.platform}-${process.arch} not found in node_modules — ` +
        "your package manager may have skipped the os-specific optional dep. " +
        "Reinstall with `bun install` so optional platform deps are included.",
    );
  }

  // ── tree-sitter WASM (required for repo map / syntax) ──
  const wasmDir = join(appDataDir(), "wasm");
  mkdirSync(wasmDir, { recursive: true });
  // tree-sitter.wasm (0.25.10) serves OpenTUI's syntax highlighting, web-tree-sitter.wasm (0.27,
  // the web-tree-sitter-engine alias) the code intelligence backend.
  for (const [pkg, file] of [
    ["web-tree-sitter", "tree-sitter.wasm"],
    ["web-tree-sitter-engine", "web-tree-sitter.wasm"],
  ]) {
    const root = findPackageRoot(pkg);
    const src = root ? join(root, file) : null;
    if (!src || !existsSync(src)) continue;
    try {
      copyFile(src, join(wasmDir, file));
      log(`✓ ${file}`);
    } catch (err) {
      warn(`failed to copy ${file}: ${err.message}`);
    }
  }
  const tsWasms = findPackageRoot("tree-sitter-wasms");
  if (tsWasms && existsSync(join(tsWasms, "out"))) {
    try {
      let count = 0;
      for (const name of readdirSync(join(tsWasms, "out"))) {
        if (name.endsWith(".wasm")) {
          copyFile(join(tsWasms, "out", name), join(wasmDir, name));
          count += 1;
        }
      }
      log(`✓ tree-sitter grammars (${count})`);
    } catch (err) {
      warn(`failed to copy tree-sitter grammars: ${err.message}`);
    }
  }

  // Grammars tree-sitter-wasms lacks (SQL, #1499), vendored in the package's vendor/tree-sitter.
  const vendored = join(__dirname, "..", "vendor", "tree-sitter");
  if (existsSync(vendored)) {
    try {
      for (const name of readdirSync(vendored)) {
        if (name.endsWith(".wasm")) copyFile(join(vendored, name), join(wasmDir, name));
      }
      log("✓ vendored tree-sitter grammars");
    } catch (err) {
      warn(`failed to copy vendored tree-sitter grammars: ${err.message}`);
    }
  }

  // ── OpenTUI assets (glyphs, parser.worker) ──
  const opentuiCore = findPackageRoot("@opentui/core");
  if (opentuiCore && existsSync(join(opentuiCore, "assets"))) {
    try {
      copyTree(join(opentuiCore, "assets"), join(appDataDir(), "opentui-assets"));
      log("✓ opentui-assets");
    } catch (err) {
      warn(`failed to copy opentui-assets: ${err.message}`);
    }
  }

  log("done");
}

main().catch((err) => {
  warn(`unexpected error: ${err.stack ?? err}`);
  // Never fail install.
  process.exit(0);
});

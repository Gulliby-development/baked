/**
 * Runtime self-heal for the compiled binary.
 *
 * When the .exe boots, copy bundled assets from `deps/` (sibling to the
 * binary) into the per-user data dir so workers, wasm, and opentui assets
 * resolve at well-known paths regardless of where the user dropped the zip.
 *
 * Idempotent: skips files only when their bytes match.
 * Soft-fail: any copy error is logged but never aborts boot.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dataDir, IS_WIN, isCompiledBinary } from "../platform/index.js";

function logHydrationError(op: string, src: string, dest: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[hydrate-runtime] ${op} failed: ${src} -> ${dest}: ${msg}\n`);
}

function sameContents(src: string, dest: string): boolean {
  const source = openSync(src, "r");
  try {
    const target = openSync(dest, "r");
    try {
      const sourceChunk = Buffer.allocUnsafe(64 * 1024);
      const targetChunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const count = readSync(source, sourceChunk, 0, sourceChunk.length, null);
        if (count === 0) return readSync(target, targetChunk, 0, 1, null) === 0;
        if (readSync(target, targetChunk, 0, count, null) !== count) return false;
        if (!sourceChunk.subarray(0, count).equals(targetChunk.subarray(0, count))) return false;
      }
    } finally {
      closeSync(target);
    }
  } finally {
    closeSync(source);
  }
}

export function copyRuntimeFileIfNeeded(src: string, dest: string): void {
  try {
    if (existsSync(dest)) {
      try {
        const a = statSync(src).size;
        const b = statSync(dest).size;
        if (a === b && sameContents(src, dest)) return;
      } catch (err) {
        logHydrationError("compare", src, dest, err);
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    const temp = `${dest}.${randomUUID()}.tmp`;
    try {
      copyFileSync(src, temp);
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { force: true });
    }
  } catch (err) {
    logHydrationError("copy", src, dest, err);
  }
}

function copyTreeIfNeeded(src: string, dest: string): void {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(src);
  } catch (err) {
    logHydrationError("stat-tree", src, dest, err);
    return;
  }
  if (stat.isDirectory()) {
    try {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(src)) {
        copyTreeIfNeeded(join(src, name), join(dest, name));
      }
    } catch (err) {
      logHydrationError("copy-tree", src, dest, err);
    }
  } else {
    copyRuntimeFileIfNeeded(src, dest);
  }
}

export function hydrateCompiledRuntime(): void {
  if (!isCompiledBinary(import.meta.url)) return;

  const triplet = `${IS_WIN ? "win32" : process.platform}-${process.arch}`;

  // Candidate deps/ locations next to the exe (zip layout) or one level up.
  const exeDir = dirname(process.execPath);
  const candidates = [resolve(exeDir, "deps"), resolve(exeDir, "..", "deps")];
  const depsRoot = candidates.find((c) => existsSync(c));
  if (!depsRoot) return;

  const base = dataDir();

  const workersSrc = join(depsRoot, "workers");
  if (existsSync(workersSrc)) copyTreeIfNeeded(workersSrc, join(base, "workers"));

  const wasmSrc = join(depsRoot, "wasm");
  if (existsSync(wasmSrc)) copyTreeIfNeeded(wasmSrc, join(base, "wasm"));

  const assetsSrc = join(depsRoot, "opentui-assets");
  if (existsSync(assetsSrc)) copyTreeIfNeeded(assetsSrc, join(base, "opentui-assets"));

  const nativeSrc = join(depsRoot, "native", triplet);
  if (existsSync(nativeSrc)) copyTreeIfNeeded(nativeSrc, join(base, "native", triplet));
}

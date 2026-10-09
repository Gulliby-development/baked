#!/usr/bin/env node
/**
 * Cross-platform launcher for the npm-published @baked/baked package.
 *
 * npm auto-generates the correct OS shim from the `bin` field:
 *   - On POSIX: a symlink invoking `node` with this file's shebang.
 *   - On Windows: a `.cmd` wrapper that calls `node launcher.mjs %*`.
 *
 * We then locate `bun` (PATH or well-known install locations) and spawn the
 * real entrypoint `dist/index.js` under it. If bun isn't found we print a
 * clear, OS-aware install instruction and exit 1.
 *
 * Why not just exec bun directly from bin.sh / bin.cmd?
 *   - bin.sh works on posix but Windows shells can't run shell scripts.
 *   - bin.cmd works on Windows but breaks under msys/cygwin shells.
 *   - A node launcher works everywhere npm-style shims work.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isWindows = process.platform === "win32";

function findBun() {
  // 1. PATH lookup (honour PATHEXT on Windows).
  const exe = isWindows ? "bun.exe" : "bun";
  const pathDirs = (process.env.PATH ?? "").split(isWindows ? ";" : ":").filter(Boolean);
  for (const d of pathDirs) {
    const p = join(d, exe);
    if (existsSync(p)) return p;
  }
  // 2. Well-known install dirs (mirrors bun.sh/install.ps1 + curl|bash).
  const candidates = isWindows
    ? [
        join(process.env.USERPROFILE ?? homedir(), ".bun", "bin", "bun.exe"),
        join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "bun", "bin", "bun.exe"),
      ]
    : [join(homedir(), ".bun", "bin", "bun"), "/usr/local/bin/bun", "/opt/homebrew/bin/bun"];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function bunMissing() {
  const cmd = isWindows
    ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
    : "curl -fsSL https://bun.sh/install | bash";
  process.stderr.write(
    [
      "baked requires Bun (https://bun.sh)",
      "",
      "Install Bun:",
      `  ${cmd}`,
      "",
      "Then re-run: baked",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const bun = findBun();
if (!bun) bunMissing();

// dist/index.js is one level up from scripts/launcher.mjs.
// Layout in the published package:
//   scripts/launcher.mjs    <- bin entry (this file)
//   dist/index.js           <- bun runtime entrypoint
const entry = resolve(__dirname, "..", "dist", "index.js");
if (!existsSync(entry)) {
  process.stderr.write(`baked runtime missing: ${entry}\nReinstall the package.\n`);
  process.exit(1);
}

// detached:true puts the child in its own process group (POSIX) / detaches
// from the parent console (Windows). The child's cleanup path calls
// `kill(-pid, SIGTERM)` to reap orphaned grandchildren — without a separate
// group that signal would also terminate this launcher, causing zsh/bash to
// print "terminated baked" and scroll past the child's exit banner.
const child = spawn(bun, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  detached: !isWindows,
  windowsHide: false,
});

// Forward terminal signals to the child's group. On POSIX with detached:true
// the TTY no longer broadcasts SIGINT to the child automatically, so we relay.
// On Windows the console still routes Ctrl+C/Break to the child; these
// handlers are harmless no-ops there (signal forwarding via process.kill on
// Windows just terminates — child handles its own console events).
const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"];
for (const sig of FORWARDED) {
  process.on(sig, () => {
    try {
      if (isWindows) {
        // Windows: signal the child directly; no process-group concept.
        child.kill(sig);
      } else {
        // POSIX: signal the child's process group so its own children get it too.
        process.kill(-child.pid, sig);
      }
    } catch {
      // Child already gone — let our own exit logic run.
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    // Re-raise so the parent shell sees the correct exit status, but only
    // for genuine signal terminations — clean exits with code 0 fall through.
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
child.on("error", (err) => {
  process.stderr.write(`failed to spawn bun: ${err.message}\n`);
  process.exit(1);
});

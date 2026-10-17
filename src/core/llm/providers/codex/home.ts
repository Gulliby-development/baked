import { existsSync, linkSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { dataDir, userHome } from "../../../platform/index.js";

/** What a model turn needs from the user's Codex home: the sign-in and the provider settings. */
const SHARED_FILES = ["auth.json", "config.toml"] as const;

/** User instructions Codex reads from its home whatever the config says (#1462). */
const USER_INSTRUCTIONS = ["AGENTS.md", "AGENTS.override.md"] as const;

/** The CODEX_HOME the user's own Codex uses. */
export function userCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(userHome(), ".codex");
}

/**
 * The CODEX_HOME BAKED runs model turns in (#1462). Codex always loads `AGENTS.md` and
 * `skills/` from its home, and no config key turns the user-level file off, so a turn in the
 * user's own home carries their personal instructions. This BAKED-owned home links the user's
 * `auth.json` and `config.toml` and holds nothing else of theirs. Codex rewrites `auth.json` in
 * place when it refreshes a token, so through the link both homes stay signed in.
 * Returns null, and the turn uses the user's home, when there is no `auth.json` to link (keyring
 * storage, or not signed in) or the file system allows neither a symlink nor a hard link.
 */
export function isolatedCodexHome(
  source: string = userCodexHome(),
  target: string = join(dataDir(), "codex-home"),
): string | null {
  if (resolve(source) === resolve(target)) return null;
  if (!existsSync(join(source, "auth.json"))) return null;
  try {
    mkdirSync(target, { recursive: true });
    for (const name of USER_INSTRUCTIONS) rmSync(join(target, name), { force: true });
    for (const name of SHARED_FILES) shareFile(join(source, name), join(target, name));
    return target;
  } catch {
    return null;
  }
}

/** The environment of a Codex process that runs model turns: the isolated home when there is one. */
export function codexRunEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = isolatedCodexHome(userCodexHome(env));
  return home ? { ...env, CODEX_HOME: home } : env;
}

function shareFile(from: string, to: string): void {
  if (!existsSync(from)) {
    rmSync(to, { force: true });
    return;
  }
  if (sameFile(from, to)) return;
  rmSync(to, { force: true });
  try {
    symlinkSync(from, to, "file");
  } catch {
    // Windows without Developer Mode refuses symlinks; a hard link needs no privilege.
    linkSync(from, to);
  }
}

/** Whether `to` already resolves to `from`: a symlink to it, or a hard link Codex has not replaced. */
function sameFile(from: string, to: string): boolean {
  try {
    const a = statSync(from, { bigint: true });
    const b = statSync(to, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

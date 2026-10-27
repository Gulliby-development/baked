/** Git plumbing for delivery. Nothing here touches the checkout, the index or HEAD of the user. */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSafeEnv, processOutput } from "../spawn.js";

/** Detects atomic replacement as well as in-place writes, including sub-millisecond changes. */
export function gitFileStamp(path: string): string | null {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    return null;
  }
}

interface WorktreePaths {
  top: string;
  prefix: string;
  index: string;
}
const worktreePaths = new Map<string, { stamp: string; value: Promise<WorktreePaths | null> }>();

/** Git environment overrides can select another repository or index in the same directory. */
export function gitEnvironmentKey(): string {
  return JSON.stringify(
    Object.entries(process.env)
      .filter(([key]) => key.toUpperCase().startsWith("GIT_"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** Cache only locations, never mutable refs, HEAD or status. Recreated worktrees get a new stamp. */
export async function gitWorktreePaths(workspace: string): Promise<WorktreePaths | null> {
  const key = `${resolve(workspace)}\0${gitEnvironmentKey()}`;
  const stamp = gitFileStamp(join(workspace, ".git"));
  const cached = worktreePaths.get(key);
  if (stamp && cached?.stamp === stamp) return cached.value;
  const value = (async () => {
    const result = await git(workspace, [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--show-prefix",
      "--git-path",
      "index",
    ]);
    if (result.code !== 0) return null;
    const [top, prefix, index] = result.stdout.trimEnd().split("\n");
    return top && index && prefix !== undefined ? { top, prefix, index } : null;
  })();
  // A subdirectory has no marker to validate, so it is deliberately not cached.
  if (stamp) {
    if (worktreePaths.size >= 128) worktreePaths.delete(worktreePaths.keys().next().value ?? "");
    const entry = { stamp, value };
    worktreePaths.set(key, entry);
    void value.then(
      (paths) => {
        if (!paths && worktreePaths.get(key) === entry) worktreePaths.delete(key);
      },
      () => {
        if (worktreePaths.get(key) === entry) worktreePaths.delete(key);
      },
    );
  }
  return value;
}

export interface GitResult {
  code: number;
  stdout: string;
  bytes: Uint8Array;
  stderr: string;
}

export async function git(
  workspace: string,
  args: string[],
  options: { env?: Record<string, string>; input?: Uint8Array | string; timeoutMs?: number } = {},
): Promise<GitResult> {
  const proc = Bun.spawn(["git", "--no-optional-locks", "-C", workspace, ...args], {
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...buildSafeEnv(), ...options.env } as Record<string, string>,
    timeout: options.timeoutMs ?? 60000,
  });
  const { code, stdout: bytes, stderr } = await processOutput(proc);
  return {
    code,
    bytes,
    stdout: new TextDecoder().decode(bytes),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Why a push or remote query failed, read from Git's own messages. */
export type RemoteFailure =
  | "non_fast_forward"
  | "hook_rejected"
  | "auth"
  | "remote_unreachable"
  | "failed";
export function classifyRemoteFailure(stderr: string): RemoteFailure {
  const text = stderr.toLowerCase();
  if (/non-fast-forward|\(fetch first\)|\[rejected\]|stale info|already exists/.test(text))
    return "non_fast_forward";
  if (/hook declined|pre-receive hook|pre-push hook|hook.*(failed|declined|rejected)/.test(text))
    return "hook_rejected";
  if (
    /authentication failed|could not read username|could not read password|permission denied|access denied|403|401|terminal prompts disabled|invalid credentials/.test(
      text,
    )
  )
    return "auth";
  if (
    /does not appear to be a git repository|could not resolve host|unable to access|connection refused|could not read from remote|no such file or directory|repository not found|timed out/.test(
      text,
    )
  )
    return "remote_unreachable";
  return "failed";
}

const SECRET_NAMES = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^credentials(\.json)?$/i,
  /\.(pem|key|crt|cer|der|p12|pfx|jks|keystore|kdbx|asc|gpg|ovpn)$/i,
];
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** A path or content that looks like a credential, a key or a certificate; never committed. */
export function looksSecret(path: string, content?: Uint8Array): boolean {
  const name = path.split("/").at(-1) ?? path;
  if (SECRET_NAMES.some((pattern) => pattern.test(name))) return true;
  if (!content) return false;
  return PRIVATE_KEY.test(new TextDecoder().decode(content.subarray(0, 1024 * 1024)));
}

/** Paths delivery never commits regardless of who wrote them. */
export function internalPath(path: string): boolean {
  return (
    path === ".baked" || path.startsWith(".baked/") || path === ".git" || path.startsWith(".git/")
  );
}

/**
 * Whether a commit of the run carries its published spec artifacts (`specs/<feature>/`): only
 * when the base already tracks a `specs` folder of its own (#680). The delivery plan and the run
 * branch commit both ask this, so a run branch never brings a new top-level `specs/` into a
 * project: setuptools' flat-layout discovery takes it for a second package and `pip install .`
 * fails (#1998, R64 spdxok-update). The spec folders of an initiative's features (`prefix`, from
 * `initiativeSpecPrefix`) are not the project's own: a base that holds only those ships none
 * (#2017, R65 uritpl).
 */
export async function shipsSpecs(
  workspace: string,
  base: string,
  prefix: string | null = null,
): Promise<boolean> {
  const listed = await git(workspace, ["ls-tree", "-r", "-z", "--name-only", base, "--", "specs"]);
  return treeShipsSpecs(listed.stdout.split("\0").filter(Boolean), prefix);
}

/** `shipsSpecs` for a caller that already listed the base tree recursively. */
export function treeShipsSpecs(paths: Iterable<string>, prefix: string | null = null): boolean {
  for (const path of paths)
    if (path.startsWith("specs/") && !(prefix && path.startsWith(prefix))) return true;
  return false;
}

/**
 * The path prefix of the spec folders of an initiative's feature runs (`specs/<initiative>_`), or
 * null for a run outside an initiative. A feature run's workflow feature ID is
 * `<initiative>_<feature>` (`runFeatureId`), and `_` occurs in neither part.
 */
export function initiativeSpecPrefix(
  featureId: string,
  bounds: { featureId: string } | null | undefined,
): string | null {
  if (!bounds || !featureId.endsWith(`_${bounds.featureId}`)) return null;
  return `specs/${featureId.slice(0, -bounds.featureId.length)}`;
}

/** A path under the run's own spec folder, or under any spec folder of its initiative. */
export function runSpecPath(
  path: string,
  featureId: string,
  prefix: string | null = null,
): boolean {
  return path.startsWith(`specs/${featureId}/`) || (prefix !== null && path.startsWith(prefix));
}

/** Whether a file's first bytes are a shebang (`#!`), so it is run directly. */
export function hasShebang(head: Uint8Array | null | undefined): boolean {
  return !!head && head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;
}

/**
 * Mode of a new file as Git stores it: executable when the working tree says so or when it starts
 * with a shebang. A Windows working tree has no executable bit, so a launcher a run wrote there
 * (`exe/tool`, `bin/tool`, a `.sh` script) was committed `100644` and failed a Unix CI (#2331).
 * Every path that commits a new file takes its mode from here.
 */
export function gitMode(mode: number, head?: Uint8Array | null): "100755" | "100644" {
  return mode & 0o111 || hasShebang(head) ? "100755" : "100644";
}

/** The first bytes of a file, enough for `hasShebang`; null when it cannot be read. */
export function fileHead(path: string): Uint8Array | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = new Uint8Array(2);
    return head.subarray(0, readSync(fd, head, 0, 2, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Modes keyed by literal path from one recursive, NUL-delimited ls-tree read. */
export function treeModes(output: string): Map<string, "100755" | "100644"> {
  const modes = new Map<string, "100755" | "100644">();
  for (const entry of output.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab >= 0)
      modes.set(entry.slice(tab + 1), entry.startsWith("100755 ") ? "100755" : "100644");
  }
  return modes;
}

/** Paths of `git status --porcelain=v1 -z` output; a rename or copy lists its target path. */
export function statusPaths(output: string): string[] {
  const entries = output.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? "";
    paths.push(entry.slice(3));
    // A rename or copy carries its source path as the next entry.
    if (/^[RC]/.test(entry) || /^.[RC]/.test(entry)) i++;
  }
  return paths;
}

/** Git plumbing for delivery. Nothing here touches the checkout, the index or HEAD of the user. */
import { buildSafeEnv } from "../spawn.js";

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
  const [buffer, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const bytes = new Uint8Array(buffer);
  return { code, bytes, stdout: new TextDecoder().decode(bytes), stderr };
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

/** Mode of a file as Git stores it: executable or regular. */
export function gitMode(mode: number): "100755" | "100644" {
  return mode & 0o111 ? "100755" : "100644";
}

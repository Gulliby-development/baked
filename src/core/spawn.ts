import type { ChildProcess, SpawnOptions } from "node:child_process";
import { IS_WIN } from "./platform/index.js";

const SECRET_ENV_PATTERN = /_API_KEY$|_SECRET$|_TOKEN$|_PASSWORD$|_CREDENTIAL$|_PRIVATE_KEY$/;

const ENV_ALLOWLIST = new Set([
  // POSIX
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TERM_PROGRAM",
  "EDITOR",
  "VISUAL",
  "TMPDIR",
  "GOPATH",
  "GOROOT",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "BUN_INSTALL",
  "NODE_PATH",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "SSH_AUTH_SOCK",
  "GPG_TTY",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "BAKED_NO_REPOMAP",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "OTUI_TREE_SITTER_WORKER_PATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
]);

export function buildSafeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Windows names it `Path`; callers read `env.PATH`, and the child sees it case-insensitively.
    const key = IS_WIN && name.toUpperCase() === "PATH" ? "PATH" : name;
    if (ENV_ALLOWLIST.has(key) || key.startsWith("LC_") || key.startsWith("XDG_")) {
      env[key] = value;
    } else if (!SECRET_ENV_PATTERN.test(key)) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  // Silence Git Credential Manager prompts on Windows (no interactive UI in headless/TUI flows).
  if (IS_WIN) {
    env.GCM_INTERACTIVE = "Never";
    env.GIT_ASK_YESNO = "false";
  }
  return env;
}

export const SAFE_STDIO: SpawnOptions["stdio"] = ["ignore", "pipe", "pipe"];

/**
 * Spawn options that fully isolate a child from the TUI:
 * - stdin ignored (no inherited fd)
 * - detached: true → child becomes its own process group / session leader on POSIX,
 *   so it has no controlling terminal and cannot read /dev/tty.
 *   Prevents tools like `security`, `ssh`, `sudo`, `gpg`, `pass`, etc.
 *   from prompting the user (and hanging) when stdin is closed.
 * - detached only on POSIX: on Windows a detached child has no console, so a console program it
 *   starts (any command `cmd.exe /c` runs) gets a new console of its own and writes its output
 *   there instead of into the pipes, while still inheriting the pipe handles (#2657; the LSP
 *   spawn notes the same console behaviour). Tree kill on Windows goes through taskkill, so no process
 *   group is needed there.
 * - windowsHide: true → no console window flashes up for the child.
 */
export const SAFE_SPAWN_OPTS: Pick<SpawnOptions, "stdio" | "detached" | "windowsHide"> = {
  stdio: SAFE_STDIO,
  detached: !IS_WIN,
  windowsHide: true,
};

/**
 * How long output is still read after a command exited. A process it started that inherited the
 * output pipes keeps them open for as long as it runs; on Windows a timeout kill cannot reach it
 * once its parent is gone, so waiting for the pipes to close could last forever.
 */
export const OUTPUT_GRACE_MS = 2000;

async function drain(stream: ReadableStream<Uint8Array>, stop: Promise<void>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  void stop.then(() => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } catch {
    // A cancelled or broken pipe ends the output; what was read is kept.
  }
  return Buffer.concat(chunks);
}

/**
 * The exit code and piped output of a `Bun.spawn` process. Reading stops `OUTPUT_GRACE_MS` after
 * the process exited, so a descendant holding the pipes cannot keep the caller waiting.
 */
export async function processOutput(proc: {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}): Promise<{ code: number; stdout: Uint8Array; stderr: Uint8Array }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const stop = proc.exited.then(
    () =>
      new Promise<void>((resolve) => {
        if (!finished) timer = setTimeout(resolve, OUTPUT_GRACE_MS);
      }),
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      drain(proc.stdout, stop),
      drain(proc.stderr, stop),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
  }
}

/** The note a command's result carries when `onOutputHeld` stopped reading its output. */
export const OUTPUT_HELD_NOTE =
  "[baked] The command exited, but a process it started kept its output open; later output is not captured.";

/**
 * The `processOutput` bound for a `node:child_process` child whose result waits for `close`.
 * `close` fires only once every handle to the output pipes is closed, so a process that holds one
 * (one the command started, or on Windows any process created while the pipes were inheritable)
 * keeps the wait open past the command's own exit, out of reach of a timeout kill of the command.
 * `OUTPUT_GRACE_MS` after the child exited with its pipes still open, this closes them and calls
 * `held` with the exit status, so the caller returns what it read (#1029, #2657). Returns a
 * function that cancels it; call it once the result is settled.
 */
export function onOutputHeld(
  child: ChildProcess,
  held: (code: number | null, signal: NodeJS.Signals | null) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    timer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      held(code, signal);
    }, OUTPUT_GRACE_MS);
  };
  child.once("exit", onExit);
  return () => {
    if (timer) clearTimeout(timer);
    child.off("exit", onExit);
  };
}

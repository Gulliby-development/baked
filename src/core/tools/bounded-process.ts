import { bunShellArgs, IS_WIN, killTree } from "../platform/index.js";

export interface BoundedResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the deadline expired and the process tree was killed. */
  timedOut: boolean;
}

/** How long the output pipes may stay open after the tree was killed before they are abandoned. */
const PIPE_GRACE_MS = 1_000;

/**
 * Runs a shell command line with a hard deadline. On expiry the whole process tree is killed (on
 * Windows `taskkill /T /F`, elsewhere the process group), not only the shell wrapper, and the
 * output pipes are read against a timer: a surviving grandchild that keeps a pipe open cannot
 * hold the caller past `timeoutMs` plus a short grace (bench round 8: a formatter child kept
 * `edit_file` waiting for 20+ minutes after the file was written).
 */
export async function runBoundedShell(
  command: string,
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv; stdin?: string },
): Promise<BoundedResult> {
  const proc = Bun.spawn(bunShellArgs(command), {
    cwd: options.cwd,
    windowsVerbatimArguments: IS_WIN,
    stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    // A process group of its own, so the group kill reaches the wrapper's children.
    ...(IS_WIN ? {} : { detached: true }),
    env: { ...(options.env ?? process.env), FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const collected = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  collected.catch(() => {});
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), options.timeoutMs);
  });
  try {
    const first = await Promise.race([collected, expired]);
    if (first !== "timeout") {
      const [stdout, stderr, exitCode] = first;
      return { exitCode, stdout, stderr, timedOut };
    }
    timedOut = true;
    killTree(proc.pid, "SIGKILL");
    try {
      proc.kill("SIGKILL");
    } catch {}
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      collected,
      new Promise<null>((resolve) => {
        grace = setTimeout(() => resolve(null), PIPE_GRACE_MS);
      }),
    ]);
    if (grace) clearTimeout(grace);
    if (settled) return { exitCode: settled[2], stdout: settled[0], stderr: settled[1], timedOut };
    return { exitCode: null, stdout: "", stderr: "", timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

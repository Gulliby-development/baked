import { isCompiledBinary } from "./platform/index.js";

export interface RestartSpec {
  command: string;
  args: string[];
}

interface RestartSpecOptions {
  execPath?: string;
  argv?: string[];
  moduleUrl?: string;
  /** Replaces the user-facing arguments of the current process. */
  userArgs?: string[];
}

/** Arguments that name a session to resume; the value follows the flag. */
const SESSION_FLAGS = new Set(["--session", "--resume", "-s"]);

/**
 * The arguments for running BAKED again in another folder: `--cwd` points at `folder`, any
 * session to resume is dropped (sessions belong to a folder) and `--wizard` is not repeated.
 * `sessionId`, when given, resumes that session of the new folder.
 */
export function projectSwitchArgs(
  userArgs: readonly string[],
  folder: string,
  sessionId?: string,
): string[] {
  const args: string[] = [];
  for (let i = 0; i < userArgs.length; i++) {
    const arg = userArgs[i] ?? "";
    if (arg === "--cwd" || SESSION_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("--cwd=") || arg.startsWith("--session=") || arg.startsWith("--resume="))
      continue;
    if (arg === "--wizard") continue;
    args.push(arg);
  }
  args.push("--cwd", folder);
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export function getRestartSpec(options: RestartSpecOptions = {}): RestartSpec {
  const execPath = options.execPath ?? process.execPath ?? "";
  const argv = options.argv ?? process.argv;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  const entrypoint = argv[1] ?? "";
  const userArgs = options.userArgs ?? argv.slice(2);
  const isCompiled =
    isCompiledBinary(moduleUrl) ||
    entrypoint.startsWith("/$bunfs/") ||
    entrypoint.includes("B:~BUN") ||
    entrypoint.includes("B:\\~BUN");

  // Compiled Bun binaries expose an internal /$bunfs entry in argv[1].
  // Relaunch the real executable and only forward the user-facing args.
  if (isCompiled) {
    return { command: execPath || argv[0] || "baked", args: userArgs };
  }

  if (entrypoint) {
    return { command: execPath || argv[0] || "bun", args: [entrypoint, ...userArgs] };
  }

  return { command: execPath || argv[0] || "baked", args: userArgs };
}

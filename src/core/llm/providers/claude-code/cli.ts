import { spawn, spawnSync } from "node:child_process";
import stripAnsi from "strip-ansi";
import { describeSearch, resolveCli } from "../../../platform/cli-path.js";
import { trackProcess } from "../../../process-tracker.js";

export interface ClaudeCodeLoginStatus {
  installed: boolean;
  loggedIn: boolean;
  /** `claude auth status` auth method, e.g. "claude.ai" or "oauth_token"; null when unknown. */
  authMethod: string | null;
  message: string;
}

/** Flags BAKED cannot run Claude Code without; older CLIs lack them. */
export const REQUIRED_CLAUDE_CODE_FLAGS = ["--input-format", "--json-schema", "--tools"] as const;

const STATUS_TTL_MS = 30_000;
let cachedStatus: { at: number; status: ClaudeCodeLoginStatus } | null = null;
let cachedFlags: Set<string> | null = null;

/**
 * The Claude Code executable. `BAKED_CLAUDE_CODE_PATH` overrides it; otherwise `claude` from
 * PATH (on Windows the native `claude.exe`), the login shell PATH or a known install folder such
 * as `~/.local/bin` or `~/.claude/local`, which a shell alias may be the only route to.
 */
export function claudeCodeCommand(): string {
  return process.env.BAKED_CLAUDE_CODE_PATH?.trim() || resolveCli("claude").command;
}

function claudeCodeNotFoundMessage(error: Error): string {
  const override = process.env.BAKED_CLAUDE_CODE_PATH?.trim();
  if (override) return `Claude Code CLI not found at BAKED_CLAUDE_CODE_PATH (${override}).`;
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    return `Claude Code CLI not found (${error.message}). Install Claude Code, then run \`claude auth login\`.`;
  }
  const searched = describeSearch(resolveCli("claude"));
  return `Claude Code CLI not found${searched ? ` (looked in ${searched})` : ""}. Install Claude Code or set BAKED_CLAUDE_CODE_PATH, then run \`claude auth login\`.`;
}

/** Parses `claude auth status` (JSON on current versions, text on older ones). */
export function parseClaudeCodeAuthStatus(
  status: number | null,
  output: string,
): ClaudeCodeLoginStatus {
  const trimmed = output.trim();
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(start)) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        email?: unknown;
      };
      if (typeof parsed.loggedIn === "boolean") {
        const authMethod = typeof parsed.authMethod === "string" ? parsed.authMethod : null;
        const email = typeof parsed.email === "string" ? ` as ${parsed.email}` : "";
        return {
          installed: true,
          loggedIn: parsed.loggedIn,
          authMethod,
          message: parsed.loggedIn
            ? `Logged in${email}${authMethod ? ` (${authMethod})` : ""}`
            : "Not logged in. Run `claude auth login`.",
        };
      }
    } catch {
      // Not JSON: fall through to the exit code.
    }
  }
  const loggedOut = /not logged in|no credentials|login required/i.test(trimmed);
  const loggedIn = status === 0 && !loggedOut;
  return {
    installed: true,
    loggedIn,
    authMethod: null,
    message: trimmed || (loggedIn ? "Logged in" : "Not logged in. Run `claude auth login`."),
  };
}

/** Login state of the local Claude Code CLI, cached briefly because each check spawns it. */
export function getClaudeCodeLoginStatus(
  options: { refresh?: boolean } = {},
): ClaudeCodeLoginStatus {
  if (!options.refresh && cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) {
    return cachedStatus.status;
  }
  let status: ClaudeCodeLoginStatus;
  try {
    const result = spawnSync(claudeCodeCommand(), ["auth", "status"], {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (result.error) {
      status = {
        installed: false,
        loggedIn: false,
        authMethod: null,
        message: claudeCodeNotFoundMessage(result.error),
      };
    } else {
      status = parseClaudeCodeAuthStatus(
        result.status,
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      );
    }
  } catch (error) {
    status = {
      installed: false,
      loggedIn: false,
      authMethod: null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  cachedStatus = { at: Date.now(), status };
  return status;
}

export function invalidateClaudeCodeStatus(): void {
  cachedStatus = null;
}

/** Long flags named in a `--help` text. */
export function parseClaudeCodeFlags(help: string): Set<string> {
  return new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
}

/** Flags the installed CLI supports, read once from `claude --help`. */
export function getClaudeCodeFlags(): Set<string> {
  if (cachedFlags) return cachedFlags;
  try {
    const result = spawnSync(claudeCodeCommand(), ["--help"], {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const flags = parseClaudeCodeFlags(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    if (flags.size > 0) cachedFlags = flags;
    return flags;
  } catch {
    return new Set();
  }
}

export function assertClaudeCodeReady(): void {
  const status = getClaudeCodeLoginStatus();
  if (!status.installed) {
    throw new Error(status.message);
  }
  if (!status.loggedIn) {
    throw new Error("Claude Code is not logged in. Run `claude auth login` and try again.");
  }
  const flags = getClaudeCodeFlags();
  const missing = REQUIRED_CLAUDE_CODE_FLAGS.filter((flag) => !flags.has(flag));
  if (flags.size > 0 && missing.length > 0) {
    throw new Error(
      `This Claude Code version lacks ${missing.join(", ")}. Run \`claude update\` and try again.`,
    );
  }
}

export interface ClaudeCodeLogoutResult {
  ok: boolean;
  message: string;
}

export function logoutClaudeCode(): ClaudeCodeLogoutResult {
  try {
    const result = spawnSync(claudeCodeCommand(), ["auth", "logout"], {
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    invalidateClaudeCodeStatus();
    if (result.error) return { ok: false, message: result.error.message };
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    return result.status === 0
      ? { ok: true, message: output || "Logged out of Claude Code." }
      : { ok: false, message: output || "Failed to log out of Claude Code." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Runs `claude auth login`, which opens the browser for the Claude account sign-in, and
 * reports each output line (the sign-in URL among them) through `onLine`.
 */
export function runClaudeCodeLogin(onLine?: (line: string) => void): {
  promise: Promise<void>;
  abort: () => void;
  /**
   * Sends the code the manual sign-in page shows to the CLI's "Paste code here" prompt. The CLI
   * waits for it and for its own localhost callback at once, so either finishes the sign-in.
   */
  submitCode: (code: string) => void;
} {
  const child = spawn(claudeCodeCommand(), ["auth", "login"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  trackProcess(child);
  const output: string[] = [];
  const forward = (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const clean = stripAnsi(line).trim();
      if (!clean) continue;
      output.push(clean);
      onLine?.(clean);
    }
  };
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);
  // A write after the CLI exits fails with EPIPE; the exit already settles the login.
  child.stdin?.on("error", () => {});

  const promise = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      invalidateClaudeCodeStatus();
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? "Claude Code login cancelled."
              : (output.at(-1) ?? `claude auth login exited with code ${code ?? 1}`),
          ),
        );
    });
  });
  return {
    promise,
    abort: () => {
      if (child.exitCode === null) child.kill();
    },
    submitCode: (code) => {
      const clean = code.trim();
      if (!clean || child.exitCode !== null || !child.stdin?.writable) return;
      child.stdin.write(`${clean}\n`);
    },
  };
}

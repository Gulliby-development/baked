import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { launchedCommand } from "./launcher.js";
import { maskNonCode } from "./quality/code-mask.js";
import { toolchainCommand } from "./toolchain.js";

/** One default for suite, task, mutation and acceptance tests (#1548). */
export const DEFAULT_PER_TEST_TIMEOUT_MS = 30_000;

const TIMEOUT_FLAG = /^--(?:timeout|testTimeout|test-timeout)(?:=|$)/;
type Runner = "bun" | "jest" | "vitest" | "pytest";
type Command = { executable: string; args: string[] };

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function manifest(cwd: string): { scripts?: Record<string, string>; jest?: unknown } {
  try {
    const value: unknown = JSON.parse(read(resolve(cwd, "package.json")));
    return value !== null && typeof value === "object"
      ? (value as { scripts?: Record<string, string>; jest?: unknown })
      : {};
  } catch {
    return {};
  }
}

/** Resolve only simple package scripts; shell expressions cannot safely receive runner flags. */
function runnerOf(
  command: Command,
  cwd: string,
  depth = 0,
): { runner: Runner; args: string[] } | null {
  if (depth > 5) return null;
  const { program, args } = toolchainCommand(command.executable, command.args);
  if (args.some((arg) => TIMEOUT_FLAG.test(arg))) return null;
  if (program === "bun" && args[0] === "test") return { runner: "bun", args };
  if (program === "pytest" || program === "py.test") return { runner: "pytest", args };
  if (/^python[\d.]*$/.test(program) && args[0] === "-m" && args[1] === "pytest")
    return { runner: "pytest", args };
  if (program === "jest" || program === "vitest") return { runner: program, args };
  if ((program === "npx" || program === "bunx") && /^(jest|vitest)$/.test(args[0] ?? ""))
    return { runner: args[0] as Runner, args };
  if (!["bun", "npm"].includes(program)) return null;
  // Nested npm scripts need their own separator to forward flags to the runner.
  if (depth > 0 && program === "npm" && !args.includes("--")) return null;
  const at = args[0] === "run" || args[0] === "run-script" ? 1 : 0;
  const name = args[at];
  const script = name && manifest(cwd).scripts?.[name];
  if (typeof script !== "string") return null;
  const inner = launchedCommand("sh", ["-c", script]);
  if (inner.program === "sh") return null;
  return runnerOf(
    {
      executable: inner.program,
      args: [...inner.args, ...args.slice(at + 1).filter((a) => a !== "--")],
    },
    cwd,
    depth + 1,
  );
}

const PYTEST_SECTION = /^\[(?:pytest|tool:pytest|tool\.pytest\.ini_options)\]\s*$/;

/** The lines of the pytest sections of a configuration file. */
function pytestSection(text: string): string[] {
  const lines: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inside = PYTEST_SECTION.test(line.trim());
    else if (inside) lines.push(line);
  }
  return lines;
}

const PYTEST_CONFIGS = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"];

/**
 * Whether pytest cannot take a per-test limit here: pytest has none of its own, and `--timeout`
 * is an error without the pytest-timeout plugin, so the flag goes only to a project that declares
 * it and does not set `timeout` in its pytest configuration (#1655).
 */
function pytestConfigured(cwd: string): boolean {
  const declared = [
    ...PYTEST_CONFIGS,
    "Pipfile",
    ...readdirSafe(cwd).filter((name) => /^requirements.*\.txt$/i.test(name)),
  ].some((name) => /\bpytest[-_]timeout\b/i.test(read(resolve(cwd, name))));
  if (!declared) return true;
  return PYTEST_CONFIGS.some((name) =>
    pytestSection(read(resolve(cwd, name))).some((line) => /^\s*timeout\s*=/.test(line)),
  );
}

function readdirSafe(cwd: string): string[] {
  try {
    return readdirSync(cwd);
  } catch {
    return [];
  }
}

/** Read configuration without loading project code into the host. */
function configured(runner: Runner, cwd: string, args: string[]): boolean {
  if (runner === "pytest") return pytestConfigured(cwd);
  if (runner === "bun") {
    try {
      const config = Bun.TOML.parse(read(resolve(cwd, "bunfig.toml"))) as {
        test?: { timeout?: unknown };
      };
      return config.test?.timeout !== undefined;
    } catch {
      return false;
    }
  }
  const hasTimeout = (text: string): boolean => {
    const code = maskNonCode("config.ts", text);
    return [...text.matchAll(/(?:\btestTimeout|["']testTimeout["'])\s*:/g)].some(
      (match) => code[match.index + match[0].length - 1] === ":",
    );
  };
  const configAt = args.findIndex((arg) => arg === "--config" || arg === "-c");
  const explicit = args.find((arg) => arg.startsWith("--config="))?.slice(9) ?? args[configAt + 1];
  if ((configAt !== -1 || args.some((arg) => arg.startsWith("--config="))) && explicit)
    return hasTimeout(explicit) || hasTimeout(read(resolve(cwd, explicit)));
  if (runner === "jest" && hasTimeout(JSON.stringify(manifest(cwd).jest ?? {}))) return true;
  const bases = runner === "jest" ? ["jest.config"] : ["vitest.config", "vite.config"];
  for (const base of bases) {
    for (const ext of ["ts", "js", "mts", "mjs", "cts", "cjs", "json"]) {
      const path = resolve(cwd, `${base}.${ext}`);
      if (existsSync(path)) return hasTimeout(read(path));
    }
  }
  return false;
}

/**
 * Execution arguments only. Definitions and approval hashes retain the project's command.
 * A project flag or timeout configuration wins; the enclosing process deadline is unchanged.
 */
export function withPerTestTimeout(command: Command, cwd: string): string[] {
  const resolved = runnerOf(command, cwd);
  if (!resolved || configured(resolved.runner, cwd, resolved.args)) return command.args;
  const { runner } = resolved;
  const launched = toolchainCommand(command.executable, command.args);
  const flags =
    runner === "bun"
      ? ["--timeout", String(DEFAULT_PER_TEST_TIMEOUT_MS)]
      : runner === "pytest"
        ? [`--timeout=${String(DEFAULT_PER_TEST_TIMEOUT_MS / 1000)}`]
        : [`--testTimeout=${DEFAULT_PER_TEST_TIMEOUT_MS}`];
  const args = [...launched.args];
  if (launched.program === "npm" && !args.includes("--")) args.push("--");
  // A direct runner's `--` ends option parsing; package managers consume their separator.
  const separator = args.indexOf("--");
  const direct =
    ["bun", "jest", "vitest", "npx", "bunx"].includes(launched.program) &&
    !(launched.program === "bun" && args[0] === "run");
  args.splice(direct && separator !== -1 ? separator : args.length, 0, ...flags);
  return launched.launch(args)?.args ?? command.args;
}

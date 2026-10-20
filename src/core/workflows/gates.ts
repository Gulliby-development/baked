import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, saveProjectConfig } from "../../config/index.js";
import { gateSandbox } from "../security/sandbox.js";
import { workspacePath } from "../specs/validate.js";
import { ruffSource as pythonRuffSource } from "../tools/python-tooling.js";
import { buildCheckEnv, executeCheckCommand, exitStatus } from "../verification/check-runner.js";
import {
  MISSING_GATE_REPORT,
  readGateReport,
  renderGateReport,
} from "../verification/gate-report.js";
import { validateChecks } from "./check-policy.js";
import { parseWorkflowConfig, type WorkflowConfig } from "./config-policy.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { dotnetFiles } from "./language.js";
import { ProcessScope } from "./process-scope.js";
import { redactSecrets } from "./redaction.js";
import { CheckSchema, SafeId } from "./schemas.js";
import { pythonEnvironment } from "./toolchain.js";
import type { Check } from "./types.js";

/** Gates are the project's `workflows.policy.checks`; this module is the only editor of that list. */
export type { WorkflowConfig };

const OUTPUT_TAIL_LINES = 40;

// --- Command line text <-> argv --------------------------------------------------------------

/** Splits a command line into argv. Single and double quotes group words; backslashes are literal. */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && text[i + 1] === '"') {
        current += '"';
        i++;
      } else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error(`Unclosed ${quote} in the command`);
  if (started) words.push(current);
  return words;
}
export function formatCommandLine(executable: string, args: string[]): string {
  return [executable, ...args]
    .map((word) => (word === "" || /[\s"']/.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word))
    .join(" ");
}

// --- Reading and writing the configured gates ------------------------------------------------

export function readGates(workspace: string, fallback?: WorkflowConfig): Check[] {
  const project = loadProjectConfig(workspace)?.workflows;
  return (project ?? fallback)?.policy?.checks ?? [];
}

/**
 * Writes the gate list into the project's `.baked/config.json` and keeps every other setting.
 * A project without a `workflows` block gets one with the default policy; a partial policy stays
 * partial on disk and is checked merged over the defaults.
 * Runs that already started keep the policy they froze; only new runs read this list.
 */
export function writeGates(workspace: string, checks: Check[], fallback?: WorkflowConfig): void {
  const parsed = checks.map((check) => CheckSchema.parse(check));
  validateChecks(workspace, { ...defaultWorkflowPolicy, checks: parsed });
  const base: WorkflowConfig = loadProjectConfig(workspace)?.workflows ??
    fallback ?? {
      enabled: true,
      importsEnabled: false,
      defaultWorkflow: "sdd",
      policy: defaultWorkflowPolicy,
    };
  const next = { ...base, policy: { ...base.policy, checks: parsed } };
  parseWorkflowConfig(next, ".baked/config.json");
  saveProjectConfig(workspace, { workflows: next });
}

// --- Editing drafts --------------------------------------------------------------------------

/** What the editor shows: every field is text or a toggle so a form can edit it directly. */
export interface GateDraft {
  id: string;
  command: string;
  cwd: string;
  timeoutSeconds: string;
  required: boolean;
  scope: Check["scope"];
  envNames: string;
  writes: string;
  /** The command prints a JSON report that decides the result (`Check.report`). */
  jsonReport: boolean;
}
export const emptyGateDraft = (): GateDraft => ({
  id: "",
  command: "",
  cwd: ".",
  timeoutSeconds: "120",
  required: true,
  scope: "feature",
  envNames: "",
  writes: "",
  jsonReport: false,
});
export function draftFromCheck(check: Check): GateDraft {
  return {
    id: check.id,
    command: formatCommandLine(check.executable, check.args),
    cwd: check.cwd,
    timeoutSeconds: String(Math.round(check.timeoutMs / 1000)),
    required: check.required,
    scope: check.scope,
    envNames: check.envNames.join(", "),
    writes: check.writes.join(", "),
    jsonReport: check.report === "json",
  };
}
const list = (text: string): string[] =>
  text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Validates a draft against the schema and the same rules the runtime applies when a run starts.
 * `others` are the remaining gates, so a duplicate ID is reported here and not when a run starts.
 */
export function checkFromDraft(
  draft: GateDraft,
  workspace: string,
  others: Check[],
): { ok: true; check: Check } | { ok: false; error: string } {
  // Report problems in the order the form shows its fields.
  if (!SafeId.safeParse(draft.id.trim()).success)
    return {
      ok: false,
      error: "ID: letters, digits, - and _ only, starting with a letter or digit",
    };
  let words: string[];
  try {
    words = splitCommandLine(draft.command);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const [executable, ...args] = words;
  if (!executable) return { ok: false, error: "Enter the command to run" };
  const seconds = Number(draft.timeoutSeconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600)
    return { ok: false, error: "Timeout: a whole number of seconds from 1 to 3600" };
  const parsed = CheckSchema.safeParse({
    id: draft.id.trim(),
    executable,
    args,
    cwd: draft.cwd.trim() || ".",
    timeoutMs: seconds * 1000,
    required: draft.required,
    scope: draft.scope,
    envNames: list(draft.envNames),
    writes: list(draft.writes),
    ...(draft.jsonReport ? { report: "json" } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "gate");
    return {
      ok: false,
      error:
        field === "id"
          ? "ID: letters, digits, - and _ only, starting with a letter or digit"
          : `${field}: ${issue?.message ?? "invalid"}`,
    };
  }
  try {
    validateChecks(workspace, { ...defaultWorkflowPolicy, checks: [...others, parsed.data] });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, check: parsed.data };
}

// --- Detection -------------------------------------------------------------------------------

export interface GateSuggestion {
  check: Check;
  /** The file or setting the suggestion comes from, shown so the user can judge it. */
  source: string;
  reason: string;
  /** Included when workflows are enabled with the suggested gates; builds are offered but optional. */
  preselected: boolean;
}

export const pythonExecutable = (): string => (process.platform === "win32" ? "python" : "python3");

const gate = (
  id: string,
  executable: string,
  args: string[],
  timeoutMs: number,
  required = true,
): Check => ({
  id,
  executable,
  args,
  cwd: ".",
  timeoutMs,
  required,
  scope: "feature",
  envNames: [],
  writes: [],
});
const read = (workspace: string, name: string): string | null => {
  try {
    return readFileSync(join(workspace, name), "utf8");
  } catch {
    return null;
  }
};
const has = (workspace: string, name: string): boolean => existsSync(join(workspace, name));

function scriptGates(workspace: string): GateSuggestion[] {
  const text = read(workspace, "package.json");
  if (text === null) return [];
  let scripts: Record<string, unknown>;
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
  } catch {
    return [];
  }
  const runner =
    has(workspace, "bun.lock") || has(workspace, "bun.lockb")
      ? "bun"
      : has(workspace, "pnpm-lock.yaml")
        ? "pnpm"
        : has(workspace, "yarn.lock")
          ? "yarn"
          : "npm";
  const script = (names: string[]): string | undefined =>
    names.find((name) => {
      const body = scripts[name];
      // The npm init placeholder fails on purpose; it is not a test suite.
      return typeof body === "string" && !/no test specified/i.test(body);
    });
  const wanted: [string, string[], number, boolean][] = [
    ["typecheck", ["typecheck", "type-check", "check-types"], 120000, true],
    ["lint", ["lint"], 120000, true],
    ["tests", ["test"], 600000, true],
    ["build", ["build"], 600000, false],
  ];
  return wanted.flatMap(([id, names, timeoutMs, required]) => {
    const name = script(names);
    return name
      ? [
          {
            check: gate(id, runner, ["run", name], timeoutMs, required),
            source: `package.json script "${name}"`,
            reason: `${runner} run ${name}`,
            preselected: id !== "build",
          },
        ]
      : [];
  });
}

function pythonGates(workspace: string): GateSuggestion[] {
  const pyproject = read(workspace, "pyproject.toml") ?? "";
  const requirements = readdirSync(workspace)
    .filter((name) => /^requirements.*\.txt$/i.test(name))
    .map((name) => read(workspace, name) ?? "")
    .join("\n");
  const out: GateSuggestion[] = [];
  const pytestSource = has(workspace, "pytest.ini")
    ? "pytest.ini"
    : /\[tool\.pytest/.test(pyproject)
      ? "pyproject.toml [tool.pytest]"
      : /\[tool:pytest\]/.test(read(workspace, "setup.cfg") ?? "")
        ? "setup.cfg [tool:pytest]"
        : /^\[pytest\]/m.test(read(workspace, "tox.ini") ?? "")
          ? "tox.ini [pytest]"
          : has(workspace, "conftest.py") || has(workspace, "tests/conftest.py")
            ? "conftest.py"
            : /^\s*pytest\b/im.test(requirements) || /["']pytest[<>=~!\s"']/.test(pyproject)
              ? "declared pytest dependency"
              : null;
  // A project whose lockfile names its environment (uv, poetry, pipenv, pdm) runs its tools in
  // it: the bare interpreter outside an activated environment has no pytest (#1655).
  const environment = pythonEnvironment((file) => has(workspace, file));
  const inEnvironment = (program: string, args: string[]) =>
    environment
      ? { executable: environment[0], args: [environment[1], program, ...args] }
      : { executable: program, args };
  const pytest = environment
    ? inEnvironment("pytest", ["-q"])
    : { executable: pythonExecutable(), args: ["-m", "pytest", "-q"] };
  if (pytestSource)
    out.push({
      check: gate("pytest", pytest.executable, pytest.args, 600000),
      source: environment ? `${pytestSource}, ${environment.join(" ")}` : pytestSource,
      reason: environment ? `${environment.join(" ")} pytest -q` : "python -m pytest -q",
      preselected: true,
    });
  const ruffSource = pythonRuffSource({
    ruffToml: has(workspace, "ruff.toml"),
    dotRuffToml: has(workspace, ".ruff.toml"),
    pyproject,
    requirements,
  });
  const ruff = (args: string[]) => inEnvironment("ruff", args);
  const prefix = environment ? `${environment.join(" ")} ` : "";
  if (ruffSource)
    out.push({
      check: {
        ...gate("ruff", ruff(["check", "."]).executable, ruff(["check", "."]).args, 120000),
        fix: ruff(["check", "--fix"]),
      },
      source: ruffSource,
      reason: `${prefix}ruff check .`,
      preselected: true,
    });
  // `ruff check` reports no formatting, so formatting drift passed unverified (#1480). A project
  // that configures the formatter gets its check preselected; one that only uses ruff as a linter
  // may format with another tool, so the gate is offered there but not preselected.
  const ruffConfig = `${read(workspace, "ruff.toml") ?? ""}\n${read(workspace, ".ruff.toml") ?? ""}`;
  const formatSource = /\[tool\.ruff\.format\]/.test(pyproject)
    ? "pyproject.toml [tool.ruff.format]"
    : /^\s*\[format\]/m.test(ruffConfig)
      ? "ruff.toml [format]"
      : null;
  if (ruffSource)
    out.push({
      check: {
        ...gate(
          "ruff-format",
          ruff(["format", "--check", "."]).executable,
          ruff(["format", "--check", "."]).args,
          120000,
        ),
        fix: ruff(["format"]),
      },
      source: formatSource ?? ruffSource,
      reason: `${prefix}ruff format --check . (fixer: ${prefix}ruff format)`,
      preselected: formatSource !== null,
    });
  return out;
}

function goGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "go.mod")) return [];
  // `go vet` passes on unformatted code and is a whole-unit check, so its fixer never ran on a
  // task's files; formatting is a file-local gate of its own. `gofmt -l` exits 0 whatever it
  // lists, and the check runner fails it on any listed file (#1480).
  return [
    {
      check: {
        ...gate("gofmt", "gofmt", ["-l", "."], 120000),
        fix: { executable: "go", args: ["fmt", "./..."] },
      },
      source: "go.mod",
      reason: "gofmt -l . (fails on a listed file; fixer: go fmt ./...)",
      preselected: true,
    },
    {
      check: gate("go-vet", "go", ["vet", "./..."], 300000),
      source: "go.mod",
      reason: "go vet ./...",
      preselected: true,
    },
    {
      check: gate("go-test", "go", ["test", "./..."], 600000),
      source: "go.mod",
      reason: "go test ./...",
      preselected: true,
    },
  ];
}

function dotnetGates(workspace: string): GateSuggestion[] {
  const files = dotnetFiles(workspace);
  const target = files[0];
  if (!target) return [];
  // A folder with several solution or project files makes dotnet stop with an ambiguity error.
  const arg = files.length > 1 ? [target] : [];
  return [
    {
      check: gate("dotnet-build", "dotnet", ["build", ...arg, "--nologo"], 600000),
      source: target,
      reason: "dotnet build",
      preselected: true,
    },
    {
      check: {
        ...gate("dotnet-format", "dotnet", ["format", ...arg, "--verify-no-changes"], 300000),
        fix: { executable: "dotnet", args: ["format", ...arg] },
      },
      source: target,
      reason: "dotnet format --verify-no-changes (fixer: dotnet format)",
      preselected: true,
    },
    {
      check: gate("dotnet-test", "dotnet", ["test", ...arg, "--nologo"], 900000),
      source: target,
      reason: "dotnet test",
      preselected: true,
    },
  ];
}

function cargoGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "Cargo.toml")) return [];
  return [
    {
      check: {
        ...gate("cargo-fmt", "cargo", ["fmt", "--check"], 120000),
        fix: { executable: "cargo", args: ["fmt"] },
      },
      source: "Cargo.toml",
      reason: "cargo fmt --check (fixer: cargo fmt)",
      preselected: true,
    },
    {
      check: gate(
        "cargo-clippy",
        "cargo",
        ["clippy", "--all-targets", "--", "-D", "warnings"],
        900000,
      ),
      source: "Cargo.toml",
      reason: "cargo clippy --all-targets -- -D warnings",
      preselected: true,
    },
    {
      check: gate("cargo-test", "cargo", ["test"], 900000),
      source: "Cargo.toml",
      reason: "cargo test",
      preselected: true,
    },
  ];
}

function mavenGates(workspace: string): GateSuggestion[] {
  return has(workspace, "pom.xml")
    ? [
        {
          check: gate("maven-verify", "mvn", ["-B", "-q", "verify"], 1200000),
          source: "pom.xml",
          reason: "mvn -B -q verify",
          preselected: true,
        },
      ]
    : [];
}

/**
 * Looks for the project's own test and lint commands. Nothing is written: the result is a list the
 * user confirms. Gates already configured (same ID or same command) are left out.
 */
/**
 * The gates a project's own task runner or CI names, for a project whose toolchain no detector
 * above knows (a Lua, PHP or C project with a Makefile, #1488). Each kind takes the first source
 * that has it: a `Makefile`, `justfile` or `Taskfile.yml` target, then a single-command run step of
 * a GitHub Actions workflow. A command that needs a shell (pipes, `&&`, variables) is not offered,
 * since a check runs without one.
 */
const RUNNER_KINDS: { id: string; targets: string[]; timeoutMs: number }[] = [
  { id: "typecheck", targets: ["typecheck", "type-check", "types"], timeoutMs: 120000 },
  { id: "lint", targets: ["lint"], timeoutMs: 120000 },
  {
    id: "format",
    targets: ["fmt-check", "format-check", "check-fmt", "check-format", "fmtcheck"],
    timeoutMs: 120000,
  },
  { id: "tests", targets: ["test", "tests"], timeoutMs: 600000 },
  { id: "check", targets: ["check"], timeoutMs: 600000 },
];

/** Target names of a Makefile: `name:` rules, not variables (`name := x`) or special targets. */
export function makeTargets(text: string): string[] {
  return [
    ...text.matchAll(/^([A-Za-z0-9][\w.-]*(?:[ \t]+[A-Za-z0-9][\w.-]*)*)[ \t]*:(?![=:])/gm),
  ].flatMap((m) => (m[1] ?? "").split(/[ \t]+/));
}

/** Recipe names of a justfile: `name args:` lines, not settings or assignments (`x := y`). */
export function justRecipes(text: string): string[] {
  return [...text.matchAll(/^@?([A-Za-z0-9][\w-]*)(?:\s+[^:=\n]*)?:(?!=)/gm)].map(
    (m) => m[1] ?? "",
  );
}

/** Task names of a Taskfile: the keys under `tasks:`. */
export function taskfileTasks(text: string): string[] {
  const block = /^tasks:\s*\n((?:[ \t]+.*\n?|\s*\n)*)/m.exec(text)?.[1] ?? "";
  const indent = /^([ \t]+)\S/m.exec(block)?.[1] ?? "  ";
  return [...block.matchAll(new RegExp(`^${indent}([\\w.-]+):`, "gm"))].map((m) => m[1] ?? "");
}

/** The single-line `run:` commands of a GitHub Actions workflow. */
export function workflowRunCommands(text: string): string[] {
  const commands: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const value = (match[2] ?? "").trim();
    if (value && !/^[|>]/.test(value)) {
      commands.push(value.replace(/^(['"])(.*)\1$/, "$2"));
      continue;
    }
    // A block scalar: its one command line, when it has exactly one.
    const body: string[] = [];
    const base = (match[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() && line.length - line.trimStart().length <= base) break;
      if (line.trim() && !line.trim().startsWith("#")) body.push(line.trim());
    }
    if (body.length === 1 && body[0]) commands.push(body[0]);
  }
  return commands;
}

const SHELL_SYNTAX = /[|&;<>`$(){}*?\\]|^\w+=/;
/** Steps that set the job up rather than check the code: `luarocks install busted`. */
const SETUP_COMMAND = /\b(?:install|add|setup|update|upgrade|download|fetch|restore|cache)\b/i;
const CI_KIND: [string, RegExp][] = [
  ["typecheck", /\b(?:typecheck|type-check|mypy|pyright|tsc|phpstan|psalm)\b/i],
  [
    "lint",
    /\b(?:lint|luacheck|rubocop|shellcheck|ktlint|swiftlint|clang-tidy|golangci-lint|flake8|pylint|eslint)\b/i,
  ],
  [
    "format",
    /\b(?:fmt|format|stylua|prettier|pint|black)\b.*(?:--check|--verify|-check|--dry-run)\b/i,
  ],
  ["tests", /\b(?:test|tests|busted|rspec|phpunit|pest|ctest|bats|pester|prove)\b/i],
];

function runnerGates(workspace: string): GateSuggestion[] {
  const sources: { name: string; tool: string; names: string[] }[] = [];
  for (const name of ["Makefile", "GNUmakefile", "makefile"]) {
    const text = read(workspace, name);
    if (text !== null) {
      sources.push({ name, tool: "make", names: makeTargets(text) });
      break;
    }
  }
  for (const name of ["justfile", ".justfile", "Justfile"]) {
    const text = read(workspace, name);
    if (text !== null) {
      sources.push({ name, tool: "just", names: justRecipes(text) });
      break;
    }
  }
  for (const name of ["Taskfile.yml", "Taskfile.yaml"]) {
    const text = read(workspace, name);
    if (text !== null) {
      sources.push({ name, tool: "task", names: taskfileTasks(text) });
      break;
    }
  }
  const out: GateSuggestion[] = [];
  for (const kind of RUNNER_KINDS) {
    for (const source of sources) {
      const target = kind.targets.find((t) => source.names.includes(t));
      if (!target) continue;
      out.push({
        check: gate(kind.id, source.tool, [target], kind.timeoutMs),
        source: `${source.name} target "${target}"`,
        reason: `${source.tool} ${target}`,
        preselected: true,
      });
      break;
    }
  }
  const workflows = join(workspace, ".github", "workflows");
  let files: string[] = [];
  try {
    files = readdirSync(workflows)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort();
  } catch {
    // No workflows.
  }
  for (const file of files) {
    for (const command of workflowRunCommands(read(workflows, file) ?? "")) {
      if (SHELL_SYNTAX.test(command) || SETUP_COMMAND.test(command)) continue;
      const kind = CI_KIND.find(([, pattern]) => pattern.test(command))?.[0];
      if (!kind || out.some((s) => s.check.id === kind)) continue;
      let words: string[];
      try {
        words = splitCommandLine(command);
      } catch {
        continue;
      }
      const [executable, ...args] = words;
      if (!executable) continue;
      const timeoutMs = RUNNER_KINDS.find((k) => k.id === kind)?.timeoutMs ?? 600000;
      out.push({
        check: gate(kind, executable, args, timeoutMs),
        source: `.github/workflows/${file} run step`,
        reason: command,
        preselected: true,
      });
    }
  }
  return out;
}

export function detectGates(workspace: string, configured: Check[] = []): GateSuggestion[] {
  const known = new Set(configured.map((c) => formatCommandLine(c.executable, c.args)));
  const ids = new Set(configured.map((c) => c.id));
  const toolchain = [
    ...scriptGates(workspace),
    ...pythonGates(workspace),
    ...goGates(workspace),
    ...dotnetGates(workspace),
    ...cargoGates(workspace),
    ...mavenGates(workspace),
  ];
  return (toolchain.length ? toolchain : runnerGates(workspace)).filter(
    (s) => !ids.has(s.check.id) && !known.has(formatCommandLine(s.check.executable, s.check.args)),
  );
}

// --- Running a gate on demand ----------------------------------------------------------------

export interface GateRunResult {
  status: "passed" | "failed" | "timeout" | "cancelled" | "error";
  exitCode: number | null;
  durationMs: number;
  /** Last lines of combined output, with ANSI codes removed and known secrets masked. */
  outputTail: string;
  truncated: boolean;
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences needs ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function outputTail(output: string, lines = OUTPUT_TAIL_LINES): string {
  return redactSecrets(output.replace(ANSI, "").replaceAll("\r\n", "\n"))
    .trimEnd()
    .split("\n")
    .slice(-lines)
    .join("\n");
}

/**
 * Runs one gate the way a run would (safe environment, declared env names, timeout) but outside any
 * run: nothing is recorded as evidence. The caller decides whether the workspace is free to run in.
 */
export async function executeGate(
  workspace: string,
  check: Check,
  signal: AbortSignal,
): Promise<GateRunResult> {
  const parsed = CheckSchema.parse(check);
  validateChecks(workspace, { ...defaultWorkflowPolicy, checks: [parsed] });
  const scope = new ProcessScope();
  const started = performance.now();
  try {
    const result = await executeCheckCommand(
      scope,
      parsed.executable === "bun" ? process.execPath : parsed.executable,
      parsed.args,
      {
        cwd: parsed.cwd === "." ? workspace : workspacePath(workspace, parsed.cwd),
        env: buildCheckEnv(parsed),
        timeoutMs: parsed.timeoutMs,
        signal,
        sandbox: gateSandbox(workspace),
      },
    );
    const finished = !result.timedOut && !result.cancelled;
    const report = finished && parsed.report === "json" ? readGateReport(result.output) : undefined;
    const output =
      report === undefined
        ? result.output
        : `${result.output}\n\n${report ? renderGateReport(report) : MISSING_GATE_REPORT}`;
    return {
      status: result.timedOut
        ? "timeout"
        : result.cancelled
          ? "cancelled"
          : report !== undefined
            ? report?.status === "failed" || (report?.status === "passed" && result.exitCode === 0)
              ? report.status
              : "error"
            : result.exitCode === null
              ? "failed"
              : exitStatus(parsed, result.exitCode, result.output),
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputTail: outputTail(output),
      truncated: result.truncated,
    };
  } catch (error) {
    if (signal.aborted)
      return {
        status: "cancelled",
        exitCode: null,
        durationMs: Math.ceil(performance.now() - started),
        outputTail: "",
        truncated: false,
      };
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: "error",
      exitCode: null,
      durationMs: Math.ceil(performance.now() - started),
      outputTail:
        code === "ENOENT"
          ? `Command not found: ${parsed.executable}. Install it or give its full path.`
          : error instanceof Error
            ? error.message
            : String(error),
      truncated: false,
    };
  } finally {
    await scope.stop();
  }
}

/** A gate run must not race a run that edits or checks the same tree. */
export function assertWorkspaceFreeForGate(busy: boolean): void {
  if (busy)
    throw new WorkflowFault(
      "WORKSPACE_BUSY",
      "A workflow run holds the workspace. Pause it, or run the gate after it finishes.",
    );
}

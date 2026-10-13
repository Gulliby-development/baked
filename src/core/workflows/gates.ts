import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, saveProjectConfig } from "../../config/index.js";
import { gateSandbox } from "../security/sandbox.js";
import { workspacePath } from "../specs/validate.js";
import { buildCheckEnv } from "../verification/check-runner.js";
import {
  MISSING_GATE_REPORT,
  readGateReport,
  renderGateReport,
} from "../verification/gate-report.js";
import { validateChecks } from "./check-policy.js";
import { defaultWorkflowPolicy } from "./defaults.js";
import { WorkflowFault } from "./errors.js";
import { dotnetFiles } from "./language.js";
import { ProcessScope } from "./process-scope.js";
import { redactSecrets } from "./redaction.js";
import { CheckSchema, SafeId, WorkflowConfigSchema } from "./schemas.js";
import type { Check } from "./types.js";

/** Gates are the project's `workflows.policy.checks`; this module is the only editor of that list. */
export type WorkflowConfig = NonNullable<ReturnType<typeof WorkflowConfigSchema.parse>>;

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
  return (project ?? fallback)?.policy.checks ?? [];
}

/**
 * Writes the gate list into the project's `.baked/config.json` and keeps every other setting.
 * A project without a `workflows` block gets one with the default policy.
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
  const next = WorkflowConfigSchema.parse({ ...base, policy: { ...base.policy, checks: parsed } });
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
  if (pytestSource)
    out.push({
      check: gate("pytest", pythonExecutable(), ["-m", "pytest", "-q"], 600000),
      source: pytestSource,
      reason: "python -m pytest -q",
      preselected: true,
    });
  const ruffSource = has(workspace, "ruff.toml")
    ? "ruff.toml"
    : has(workspace, ".ruff.toml")
      ? ".ruff.toml"
      : /\[tool\.ruff/.test(pyproject)
        ? "pyproject.toml [tool.ruff]"
        : /^\s*ruff\b/im.test(requirements)
          ? "declared ruff dependency"
          : null;
  if (ruffSource)
    out.push({
      check: {
        ...gate("ruff", "ruff", ["check", "."], 120000),
        fix: { executable: "ruff", args: ["check", "--fix"] },
      },
      source: ruffSource,
      reason: "ruff check .",
      preselected: true,
    });
  return out;
}

function goGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "go.mod")) return [];
  // `gofmt -l` exits 0 whatever it lists, so formatting is applied by the vet gate's fixer
  // rather than verified by a check of its own.
  return [
    {
      check: {
        ...gate("go-vet", "go", ["vet", "./..."], 300000),
        fix: { executable: "go", args: ["fmt", "./..."] },
      },
      source: "go.mod",
      reason: "go vet ./... (fixer: go fmt ./...)",
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
export function detectGates(workspace: string, configured: Check[] = []): GateSuggestion[] {
  const known = new Set(configured.map((c) => formatCommandLine(c.executable, c.args)));
  const ids = new Set(configured.map((c) => c.id));
  return [
    ...scriptGates(workspace),
    ...pythonGates(workspace),
    ...goGates(workspace),
    ...dotnetGates(workspace),
    ...cargoGates(workspace),
    ...mavenGates(workspace),
  ].filter(
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
    const result = await scope.execute(
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
            : result.exitCode === 0
              ? "passed"
              : "failed",
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

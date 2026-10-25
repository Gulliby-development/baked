import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, saveProjectConfig } from "../../config/index.js";
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../intelligence/language-records.js";
import { pwshExecutable } from "../platform/index.js";
import { gateSandbox } from "../security/sandbox.js";
import { workspacePath } from "../specs/validate.js";
import { BUN_FMT, bunFmtConfigured } from "../tools/bun-fmt.js";
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
import { PESTER_RUN } from "./pester.js";
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
  let manifest: { scripts?: Record<string, unknown>; prettier?: unknown };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return [];
  }
  const scripts = manifest.scripts ?? {};
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
    // Formatting drift passed unverified when only `lint` was offered (#1685).
    [
      "format",
      ["format:check", "fmt:check", "check-format", "format-check", "prettier:check"],
      120000,
      true,
    ],
    ["tests", ["test"], 600000, true],
    ["build", ["build"], 600000, false],
  ];
  const fixer = script(["format", "fmt", "prettier"]);
  const out = wanted.flatMap(([id, names, timeoutMs, required]): GateSuggestion[] => {
    const name = script(names);
    if (!name) return [];
    const check = gate(id, runner, ["run", name], timeoutMs, required);
    return [
      {
        check:
          id === "format" && fixer
            ? { ...check, fix: { executable: runner, args: ["run", fixer] } }
            : check,
        source: `package.json script "${name}"`,
        reason:
          id === "format" && fixer
            ? `${runner} run ${name} (fixer: ${runner} run ${fixer})`
            : `${runner} run ${name}`,
        preselected: id !== "build",
      },
    ];
  });
  if (out.some((s) => s.check.id === "format")) return out;
  // A formatter configured without a check script is offered, not preselected: the project may
  // run it only in an editor, and its whole tree may not be formatted yet.
  const formatter = jsFormatter(workspace, manifest.prettier !== undefined);
  if (formatter) {
    // `yarn <bin>` runs a package binary in Yarn 1 and in Yarn 2+; `bun fmt` runs in Bun itself.
    const [executable, ...prefix] = formatter.executable
      ? [formatter.executable]
      : runner === "bun"
        ? ["bunx"]
        : runner === "npm"
          ? ["npx"]
          : runner === "pnpm"
            ? ["pnpm", "exec"]
            : ["yarn"];
    out.push({
      check: {
        ...gate("format", executable, [...prefix, ...formatter.check], 120000),
        fix: { executable, args: [...prefix, ...formatter.fix] },
      },
      source: formatter.source,
      reason: `${[executable, ...prefix, ...formatter.check].join(" ")} (fixer: ${[executable, ...prefix, ...formatter.fix].join(" ")})`,
      preselected: false,
    });
  }
  return out;
}

const PRETTIER_CONFIG =
  /^(?:\.prettierrc(?:\.(?:json5?|ya?ml|toml|[cm]?[jt]s))?|prettier\.config\.[cm]?[jt]s)$/;

/** The JavaScript formatter a project configures, as a check and its fixer. */
function jsFormatter(
  workspace: string,
  prettierKey: boolean,
): { check: string[]; fix: string[]; source: string; executable?: string } | null {
  for (const name of ["biome.json", "biome.jsonc"])
    if (has(workspace, name))
      return {
        check: ["biome", "format", "."],
        fix: ["biome", "format", "--write", "."],
        source: name,
      };
  for (const name of ["dprint.json", "dprint.jsonc", ".dprint.json", ".dprint.jsonc"])
    if (has(workspace, name))
      return { check: ["dprint", "check"], fix: ["dprint", "fmt"], source: name };
  // `bun fmt` reads a Prettier config and formats like Prettier: a project that opted into it
  // runs it ahead of `prettier`, through Bun rather than a package runner (#1920).
  if (bunFmtConfigured(workspace)) {
    const [executable = "bun", ...words] = BUN_FMT.split(" ");
    return {
      check: [...words, "--check", "."],
      fix: [...words, "."],
      source: "bunfig.toml [fmt]",
      executable,
    };
  }
  const config = prettierKey
    ? "package.json prettier"
    : readdirSync(workspace).find((name) => PRETTIER_CONFIG.test(name));
  return config
    ? { check: ["prettier", "--check", "."], fix: ["prettier", "--write", "."], source: config }
    : null;
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
        // A rule whose only fix is unsafe (ISC004 in ruff 0.17's defaults) cost skillcomb 3.83M
        // tokens of correctives on two test files; on a test file the fix cannot change what the
        // program does (#2095).
        fixUnsafe: ruff(["check", "--fix", "--unsafe-fixes"]),
        fixUnsafeScope: "tests",
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
  // Black and the type checkers had no gate although the edit profile runs them (#1685).
  const setupCfg = read(workspace, "setup.cfg") ?? "";
  const declared = (name: string) =>
    new RegExp(`^\\s*${name}(?![\\w.-])`, "im").test(requirements) ||
    new RegExp(`["']${name}[<>=~!\\s\\[;"']`).test(pyproject);
  const blackSource = /\[tool\.black\]/.test(pyproject)
    ? "pyproject.toml [tool.black]"
    : declared("black")
      ? "declared black dependency"
      : null;
  if (blackSource && !formatSource) {
    const black = inEnvironment("black", ["--check", "."]);
    out.push({
      check: {
        ...gate("black", black.executable, black.args, 120000),
        fix: inEnvironment("black", ["."]),
      },
      source: blackSource,
      reason: `${prefix}black --check . (fixer: ${prefix}black .)`,
      preselected: true,
    });
  }
  const mypySource = has(workspace, "mypy.ini")
    ? "mypy.ini"
    : has(workspace, ".mypy.ini")
      ? ".mypy.ini"
      : /\[tool\.mypy\]/.test(pyproject)
        ? "pyproject.toml [tool.mypy]"
        : /^\[mypy\]/m.test(setupCfg)
          ? "setup.cfg [mypy]"
          : null;
  const pyrightSource = has(workspace, "pyrightconfig.json")
    ? "pyrightconfig.json"
    : /\[tool\.pyright\]/.test(pyproject)
      ? "pyproject.toml [tool.pyright]"
      : null;
  if (pyrightSource) {
    const pyright = inEnvironment("pyright", []);
    out.push({
      check: gate("pyright", pyright.executable, pyright.args, 300000),
      source: pyrightSource,
      reason: `${prefix}pyright`,
      preselected: true,
    });
  } else if (mypySource) {
    const mypy = inEnvironment("mypy", ["."]);
    out.push({
      check: gate("mypy", mypy.executable, mypy.args, 300000),
      source: mypySource,
      reason: `${prefix}mypy .`,
      preselected: true,
    });
  }
  return out;
}

/**
 * SQLFluff lints and fixes the project's SQL (#1499) where the project configures it: a `.sqlfluff`
 * file, or a `[tool.sqlfluff]` section in `pyproject.toml`, `[sqlfluff]` in `setup.cfg` or
 * `tox.ini`. It reads one file at a time, so it covers each task's SQL and its fixer takes the
 * task's file; with the dbt templater it compiles the whole dbt project, so that gate is
 * whole-unit (`sqlfluff-dbt`). A dbt project also gets `dbt build`, offered but not preselected:
 * it needs a database profile. SQLFluff is a Python tool and runs in the project's Python
 * environment where a lockfile names one.
 */
function sqlfluffGates(workspace: string): GateSuggestion[] {
  const config = read(workspace, ".sqlfluff");
  const pyproject = read(workspace, "pyproject.toml") ?? "";
  const section = (name: string) =>
    /^\[sqlfluff(?:[:\]])/m.test(read(workspace, name) ?? "") ? `${name} [sqlfluff]` : null;
  const source =
    config !== null
      ? ".sqlfluff"
      : /^\[tool\.sqlfluff(?:[.\]])/m.test(pyproject)
        ? "pyproject.toml [tool.sqlfluff]"
        : (section("setup.cfg") ?? section("tox.ini"));
  const dbt = has(workspace, "dbt_project.yml");
  const out: GateSuggestion[] = [];
  if (source) {
    const environment = pythonEnvironment((file) => has(workspace, file));
    const run = (args: string[]) =>
      environment
        ? { executable: environment[0], args: [environment[1], "sqlfluff", ...args] }
        : { executable: "sqlfluff", args };
    const prefix = environment ? `${environment.join(" ")} ` : "";
    const templater = /^\s*templater\s*=\s*["']?(\w+)/m.exec(`${config ?? ""}\n${pyproject}`)?.[1];
    const lint = run(["lint", "."]);
    out.push({
      check: {
        ...gate(
          templater === "dbt" ? "sqlfluff-dbt" : "sqlfluff",
          lint.executable,
          lint.args,
          300000,
        ),
        fix: run(["fix"]),
      },
      source: templater === "dbt" ? `${source}, templater = dbt` : source,
      reason: `${prefix}sqlfluff lint . (fixer: ${prefix}sqlfluff fix)`,
      preselected: true,
    });
  }
  if (dbt)
    out.push({
      check: gate("dbt-build", "dbt", ["build"], 1800000),
      source: "dbt_project.yml",
      reason: "dbt build (needs the project's database profile)",
      preselected: false,
    });
  return out;
}

const PWSH = ["-NoProfile", "-NonInteractive", "-Command"];
/** The folders a PowerShell project keeps its Pester tests in, besides the root. */
const PESTER_DIRS = ["tests", "Tests", "test", "Test"];
/**
 * PSScriptAnalyzer on the whole tree, parse errors, errors and warnings only: `-EnableExit` alone
 * exits with the count of every severity, so a missing help comment (Information) failed the gate,
 * and `-Severity Error,Warning` without `ParseError` passed a script that does not parse. Each
 * finding is one sorted `path:line:column: Severity Rule: message` line, since the rules run in
 * parallel and the default table cuts paths to file names.
 */
export const PSSA_LINT =
  "Invoke-ScriptAnalyzer -Path . -Recurse -Severity ParseError,Error,Warning -EnableExit | Sort-Object ScriptPath, Line, Column, RuleName | ForEach-Object { '{0}:{1}:{2}: {3} {4}: {5}' -f $_.ScriptPath, $_.Line, $_.Column, $_.Severity, $_.RuleName, $_.Message }";

/**
 * Pester tests and PSScriptAnalyzer for a PowerShell project (#1498): Pester when the project has
 * a `*.Tests.ps1` file at its root or in a test folder; PSScriptAnalyzer when it has a
 * `PSScriptAnalyzerSettings.psd1`, and offered without one (not preselected) when it has a module
 * manifest or a script at its root, since the default rules may already fail on its code. The
 * analyzer reads one file at a time, so it covers each task's scripts, and its fixer
 * (`Invoke-ScriptAnalyzer -Fix -Path <file>`) takes the task's file.
 */
function pwshGates(workspace: string): GateSuggestion[] {
  const names = (dir: string): string[] => {
    try {
      return readdirSync(join(workspace, dir));
    } catch {
      return [];
    }
  };
  const root = names(".");
  const testDir = ["", ...PESTER_DIRS].find((dir) =>
    names(dir || ".").some((name) => /\.Tests\.ps1$/i.test(name)),
  );
  const settings = root.find((name) => /^PSScriptAnalyzerSettings\.psd1$/i.test(name));
  const scripts = root.find((name) => /\.(?:ps1|psm1|psd1)$/i.test(name));
  const exe = pwshExecutable();
  const out: GateSuggestion[] = [];
  if (testDir !== undefined)
    out.push({
      check: gate("pester", exe, [...PWSH, PESTER_RUN], 600000),
      source: testDir ? `${testDir}/*.Tests.ps1` : "*.Tests.ps1",
      reason: `${exe} -Command Invoke-Pester`,
      preselected: true,
    });
  if (settings || scripts || testDir !== undefined)
    out.push({
      check: {
        ...gate("psscriptanalyzer", exe, [...PWSH, PSSA_LINT], 300000),
        fix: { executable: exe, args: [...PWSH, "Invoke-ScriptAnalyzer", "-Fix", "-Path"] },
      },
      source: settings ?? scripts ?? `${testDir || "."}/*.Tests.ps1`,
      reason: `${exe} -Command Invoke-ScriptAnalyzer -Recurse (fixer: Invoke-ScriptAnalyzer -Fix)`,
      preselected: settings !== undefined,
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

/**
 * The command that runs a project's build wrapper (`mvnw`, `gradlew`) when the project has one,
 * else the build tool on the PATH: the wrapper pins the version the project builds with, and a
 * machine with Java but without the tool still builds (#1749). On Windows the `.cmd`/`.bat`
 * wrapper runs through `cmd /d /c`, which the check routing unwraps (#1507).
 */
export function buildWrapper(
  workspace: string,
  name: "mvnw" | "gradlew",
  tool: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[]; source: string | null } {
  if (platform === "win32") {
    const script = name === "mvnw" ? "mvnw.cmd" : "gradlew.bat";
    return has(workspace, script)
      ? { executable: "cmd", args: ["/d", "/c", script], source: script }
      : { executable: tool, args: [], source: null };
  }
  return has(workspace, name)
    ? { executable: `./${name}`, args: [], source: name }
    : { executable: tool, args: [], source: null };
}

function mavenGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "pom.xml")) return [];
  const mvn = buildWrapper(workspace, "mvnw", "mvn");
  const args = [...mvn.args, "-B", "-q", "verify"];
  return [
    {
      check: gate("maven-verify", mvn.executable, args, 1200000),
      source: "pom.xml",
      reason: formatCommandLine(mvn.executable, args),
      preselected: true,
    },
  ];
}

const GRADLE_BUILD = ["build.gradle.kts", "build.gradle", "settings.gradle.kts", "settings.gradle"];

/**
 * Gradle's `check` task runs the tests and every verification task the build applies (ktlint,
 * detekt, Checkstyle, Spotless check), so it is the one preselected gate (#1749).
 */
function gradleGates(workspace: string): GateSuggestion[] {
  const source = GRADLE_BUILD.find((name) => has(workspace, name));
  if (!source || has(workspace, "pom.xml")) return [];
  const gradle = buildWrapper(workspace, "gradlew", "gradle");
  const args = [...gradle.args, "--console=plain", "-q", "check"];
  return [
    {
      check: gate("gradle-check", gradle.executable, args, 1200000),
      source,
      reason: formatCommandLine(gradle.executable, args),
      preselected: true,
    },
  ];
}

/** sbt runs a Scala build's tests with `sbt test`; `-batch` keeps it from waiting for input. */
function sbtGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "build.sbt")) return [];
  return [
    {
      check: gate("sbt-test", "sbt", ["-batch", "test"], 1200000),
      source: "build.sbt",
      reason: "sbt -batch test",
      preselected: true,
    },
  ];
}

/** SwiftPM builds and tests a package from `Package.swift` (#1753). */
function swiftGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "Package.swift")) return [];
  return [
    {
      check: gate("swift-build", "swift", ["build"], 900000),
      source: "Package.swift",
      reason: "swift build",
      preselected: true,
    },
    {
      check: gate("swift-test", "swift", ["test"], 900000),
      source: "Package.swift",
      reason: "swift test",
      preselected: true,
    },
  ];
}

/**
 * Mix compiles, formats and tests an Elixir project from `mix.exs` (#1753). `mix format` reads its
 * inputs from `.formatter.exs` and stops with an error without one, so the format gate needs it;
 * its fixer formats the file it is given.
 */
function mixGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "mix.exs")) return [];
  const out: GateSuggestion[] = [];
  if (has(workspace, ".formatter.exs"))
    out.push({
      check: {
        ...gate("mix-format", "mix", ["format", "--check-formatted"], 120000),
        fix: { executable: "mix", args: ["format"] },
      },
      source: ".formatter.exs",
      reason: "mix format --check-formatted (fixer: mix format)",
      preselected: true,
    });
  out.push(
    {
      check: gate("mix-compile", "mix", ["compile", "--warnings-as-errors"], 600000),
      source: "mix.exs",
      reason: "mix compile --warnings-as-errors",
      preselected: true,
    },
    {
      check: gate("mix-test", "mix", ["test"], 600000),
      source: "mix.exs",
      reason: "mix test",
      preselected: true,
    },
  );
  return out;
}

/**
 * Dart formats, analyzes and tests a package from `pubspec.yaml` (#1753); a Flutter package
 * (`sdk: flutter`) analyzes and tests with `flutter`, which runs the Flutter test bindings. The
 * format fixer is `dart format` with the file it is given.
 */
function dartGates(workspace: string): GateSuggestion[] {
  const pubspec = read(workspace, "pubspec.yaml");
  if (pubspec === null) return [];
  const tool = /^\s*sdk:\s*flutter\b/m.test(pubspec) ? "flutter" : "dart";
  return [
    {
      check: {
        ...gate(
          "dart-format",
          "dart",
          ["format", "--output=none", "--set-exit-if-changed", "."],
          120000,
        ),
        fix: { executable: "dart", args: ["format"] },
      },
      source: "pubspec.yaml",
      reason: "dart format --output=none --set-exit-if-changed . (fixer: dart format)",
      preselected: true,
    },
    {
      check: gate(`${tool}-analyze`, tool, ["analyze"], 300000),
      source: "pubspec.yaml",
      reason: `${tool} analyze`,
      preselected: true,
    },
    {
      check: gate(`${tool}-test`, tool, ["test"], 600000),
      source: "pubspec.yaml",
      reason: `${tool} test`,
      preselected: true,
    },
  ];
}

/** `zig build test` runs the test step `build.zig` declares; `zig fmt --check` fails on any unformatted file (#1753). */
function zigGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "build.zig")) return [];
  return [
    {
      check: {
        ...gate("zig-fmt", "zig", ["fmt", "--check", "."], 120000),
        fix: { executable: "zig", args: ["fmt"] },
      },
      source: "build.zig",
      reason: "zig fmt --check . (fixer: zig fmt)",
      preselected: true,
    },
    {
      check: gate("zig-build-test", "zig", ["build", "test"], 900000),
      source: "build.zig",
      reason: "zig build test",
      preselected: true,
    },
  ];
}

/** dune builds and tests an OCaml project from `dune-project` (#1753). */
function duneGates(workspace: string): GateSuggestion[] {
  if (!has(workspace, "dune-project")) return [];
  return [
    {
      check: gate("dune-build", "dune", ["build"], 600000),
      source: "dune-project",
      reason: "dune build",
      preselected: true,
    },
    {
      check: gate("dune-test", "dune", ["test"], 600000),
      source: "dune-project",
      reason: "dune test",
      preselected: true,
    },
  ];
}

/**
 * A Bundler project's gates. The linter first (#1493): Standard when the bundle names it, else
 * RuboCop when it names `rubocop` or one of its plugins; both lint file by file, so their safe
 * autocorrect (`--fix`, `-a`) is the fixer of the task's file. Then the tests (#1753): RSpec when
 * the bundle names it or the project has a `spec/` folder or `.rspec`, else Rake's `test` task when
 * the project has a Rakefile or the bundle names rake. Everything runs through `bundle exec`, which
 * loads the Gemfile's versions. A gem's Gemfile often says only `gemspec`: its development
 * dependencies are in the gemspec, read as well.
 */
function rubyGates(workspace: string): GateSuggestion[] {
  const gemfile = read(workspace, "Gemfile");
  if (gemfile === null) return [];
  const gemspecs = /^\s*gemspec\b/m.test(gemfile)
    ? readdirSync(workspace)
        .filter((name) => name.endsWith(".gemspec"))
        .sort()
    : [];
  const bundle = [gemfile, ...gemspecs.map((name) => read(workspace, name) ?? "")].join("\n");
  const named = (gem: string) =>
    new RegExp(
      `^\\s*(?:gem|\\w+\\.add_(?:development_|runtime_)?dependency)\\s*\\(?\\s*["']${gem}["']`,
      "m",
    );
  const source = (gem: string) =>
    named(gem).test(gemfile)
      ? "Gemfile"
      : (gemspecs.find((n) => named(gem).test(read(workspace, n) ?? "")) ?? "Gemfile");
  const names = (gem: string) => named(gem).test(bundle);
  const out: GateSuggestion[] = [];
  if (names("standard"))
    out.push({
      check: {
        ...gate("standardrb", "bundle", ["exec", "standardrb"], 300000),
        fix: { executable: "bundle", args: ["exec", "standardrb", "--fix"] },
      },
      source: source("standard"),
      reason: "bundle exec standardrb (fixer: bundle exec standardrb --fix)",
      preselected: true,
    });
  else if (names("rubocop(?:-[\\w-]+)?"))
    out.push({
      check: {
        ...gate("rubocop", "bundle", ["exec", "rubocop"], 300000),
        fix: { executable: "bundle", args: ["exec", "rubocop", "-a"] },
      },
      source: source("rubocop(?:-[\\w-]+)?"),
      reason: "bundle exec rubocop (fixer: bundle exec rubocop -a)",
      preselected: true,
    });
  const rspec =
    names("rspec") || names("rspec-core") || has(workspace, ".rspec") || has(workspace, "spec");
  if (rspec) {
    out.push({
      check: gate("rspec", "bundle", ["exec", "rspec"], 600000),
      source:
        names("rspec") || names("rspec-core")
          ? source(names("rspec") ? "rspec" : "rspec-core")
          : has(workspace, ".rspec")
            ? ".rspec"
            : "spec/",
      reason: "bundle exec rspec",
      preselected: true,
    });
    return out;
  }
  const rakefile = ["Rakefile", "rakefile", "Rakefile.rb"].find((name) => has(workspace, name));
  if (!rakefile && !names("rake")) return out;
  out.push({
    check: gate("rake-test", "bundle", ["exec", "rake", "test"], 600000),
    source: rakefile ?? source("rake"),
    reason: "bundle exec rake test",
    preselected: true,
  });
  return out;
}

/**
 * The packages a `composer.json` requires, `require` and `require-dev` together, lowercase; null
 * when the file does not parse.
 */
export function composerPackages(text: string): Set<string> | null {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const names = ["require", "require-dev"].flatMap((key) => {
      const table = parsed?.[key];
      return table && typeof table === "object" ? Object.keys(table) : [];
    });
    return new Set(names.map((name) => name.toLowerCase()));
  } catch {
    return null;
  }
}

/** A Composer-installed tool: `php vendor/bin/NAME`, which runs the same on every platform. */
const vendorBin = (name: string, args: string[]): { executable: string; args: string[] } => ({
  executable: "php",
  args: [`vendor/bin/${name}`, ...args],
});

/**
 * A Composer project's gates (#1491): Pest or PHPUnit for the tests, PHPStan or Psalm when the
 * project configures one (both need their config file to know what to analyse), and Pint or
 * PHP-CS-Fixer as a format check whose fixer formats the task's file. The tools run as
 * `php vendor/bin/NAME`: Composer's `vendor/bin` proxies are PHP scripts, and on Windows only their
 * `.bat` twins run without `php`. `composer install` must have run first, as for any project
 * dependency.
 */
export function composerGates(workspace: string): GateSuggestion[] {
  const text = read(workspace, "composer.json");
  if (text === null) return [];
  const packages = composerPackages(text) ?? new Set<string>();
  const first = (names: string[]) => names.find((name) => has(workspace, name));
  const out: GateSuggestion[] = [];
  const suggest = (
    id: string,
    tool: { executable: string; args: string[] },
    source: string,
    timeoutMs: number,
    fix?: { executable: string; args: string[] },
  ) =>
    out.push({
      check: { ...gate(id, tool.executable, tool.args, timeoutMs), ...(fix ? { fix } : {}) },
      source,
      reason: `${formatCommandLine(tool.executable, tool.args)}${fix ? ` (fixer: ${formatCommandLine(fix.executable, fix.args)})` : ""}`,
      preselected: true,
    });
  const pint = packages.has("laravel/pint") ? "composer.json" : first(["pint.json"]);
  const csFixer = first([".php-cs-fixer.php", ".php-cs-fixer.dist.php"]);
  if (pint) suggest("pint", vendorBin("pint", ["--test"]), pint, 120000, vendorBin("pint", []));
  else if (csFixer)
    suggest(
      "php-cs-fixer",
      vendorBin("php-cs-fixer", ["fix", "--dry-run", "--diff"]),
      csFixer,
      120000,
      vendorBin("php-cs-fixer", ["fix"]),
    );
  const phpstan = first(["phpstan.neon", "phpstan.neon.dist", "phpstan.dist.neon"]);
  const psalm = first(["psalm.xml", "psalm.xml.dist"]);
  if (phpstan)
    suggest("phpstan", vendorBin("phpstan", ["analyse", "--no-progress"]), phpstan, 300000);
  else if (psalm) suggest("psalm", vendorBin("psalm", ["--no-progress"]), psalm, 300000);
  const phpunitXml = first(["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"]);
  if (packages.has("pestphp/pest")) suggest("pest", vendorBin("pest", []), "composer.json", 600000);
  // Without a phpunit.xml PHPUnit runs nothing it is not given (it prints its help), so the
  // gate names the conventional `tests` folder.
  else if (packages.has("phpunit/phpunit") || phpunitXml)
    suggest(
      "phpunit",
      vendorBin("phpunit", phpunitXml ? [] : ["tests"]),
      packages.has("phpunit/phpunit") ? "composer.json" : (phpunitXml as string),
      600000,
    );
  return out;
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

/** The toolchain detectors, in the order their gates are suggested. */
const TOOLCHAIN_GATES = {
  npm: scriptGates,
  python: pythonGates,
  sqlfluff: sqlfluffGates,
  pwsh: pwshGates,
  go: goGates,
  dotnet: dotnetGates,
  cargo: cargoGates,
  maven: mavenGates,
  gradle: gradleGates,
  sbt: sbtGates,
  swift: swiftGates,
  mix: mixGates,
  dart: dartGates,
  zig: zigGates,
  dune: duneGates,
  bundler: rubyGates,
  composer: composerGates,
} as const;
export type GateToolchain = keyof typeof TOOLCHAIN_GATES;

/**
 * The toolchains whose gates each supported language gets (#1717, #1733), the usual one first. A language without a
 * detector has a `none` row: its gates come from a Makefile, justfile, Taskfile or CI run step
 * (`runnerGates`).
 */
export const GATE_TOOLCHAINS: LanguageRecord<readonly GateToolchain[]> = {
  typescript: ["npm"],
  javascript: ["npm"],
  vue: ["npm"],
  svelte: ["npm"],
  rescript: ["npm"],
  python: ["python"],
  go: ["go"],
  rust: ["cargo"],
  csharp: ["dotnet"],
  java: ["maven", "gradle"],
  kotlin: ["gradle", "maven"],
  scala: ["sbt", "gradle", "maven"],
  c: none("C builds through Make or CMake, read by the runner detector"),
  cpp: none("C++ builds through Make or CMake, read by the runner detector"),
  ruby: ["bundler"],
  php: ["composer"],
  swift: ["swift"],
  lua: none("LuaRocks has no gate detector yet (#1495)"),
  elixir: ["mix"],
  dart: ["dart"],
  zig: ["zig"],
  bash: none("shell scripts have no toolchain"),
  ocaml: ["dune"],
  objc: none("Xcode projects have no gate detector"),
  solidity: none("Foundry has no gate detector; a Hardhat project is an npm package"),
  sql: ["sqlfluff"],
  powershell: ["pwsh"],
};

export function detectGates(workspace: string, configured: Check[] = []): GateSuggestion[] {
  const known = new Set(configured.map((c) => formatCommandLine(c.executable, c.args)));
  const ids = new Set(configured.map((c) => c.id));
  const used = new Set(SUPPORTED_LANGUAGES.flatMap((l) => rowOf(GATE_TOOLCHAINS, l) ?? []));
  const toolchain = (Object.keys(TOOLCHAIN_GATES) as GateToolchain[])
    .filter((key) => used.has(key))
    .flatMap((key) => TOOLCHAIN_GATES[key](workspace));
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

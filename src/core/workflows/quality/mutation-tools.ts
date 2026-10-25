/**
 * Ecosystem mutation tools for the mutation gate (#702): Stryker (JavaScript and TypeScript),
 * mutmut (Python), cargo-mutants (Rust), PIT (Java and Kotlin) and go-mutesting (Go). One runs
 * instead of the built-in engine when the project already has it; nothing is ever installed. Its
 * report maps to the gate's own mutants, kept only on the lines the run added, so the findings,
 * thresholds and run report stay the same whichever engine made them.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type LanguageRecord, none, rowOf } from "../../intelligence/language-records.js";
import { isManifestFile } from "../../intelligence/language-traits.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";
import { readablePath } from "../../specs/validate.js";
import { isTestCodePath } from "./duplication.js";
import type { MutantOutcome, MutationEngine } from "./mutation.js";
import { addedLines, type ChangedFile } from "./rules.js";

export type MutationTool = Exclude<MutationEngine, "built-in">;

/** The machine as a tool adapter sees it; the scheduler runs everything in the run's root. */
export interface ToolShell {
  /** The run's root, absolute. */
  root: string;
  /** A directory outside the workspace for what a tool keeps between gates (incremental state). */
  scratch: string;
  platform: NodeJS.Platform;
  run(
    executable: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }>;
  /** A file's text, by a path under the root or an absolute one; null when it does not exist. */
  read(path: string): string | null;
  exists(path: string): boolean;
  /** Removes a file or directory under the root. */
  remove(path: string): void;
  which(command: string): string | null;
  now(): number;
}

/**
 * How a tool shell reads the run's root: an absolute path as it is, a relative one under the root,
 * with a worktree's linked `node_modules` read in place (`readablePath`).
 */
export function toolShellFiles(root: string): Pick<ToolShell, "read" | "exists"> {
  const absolute = (path: string) => (isAbsolute(path) ? path : readablePath(root, path));
  return {
    read: (path) => {
      try {
        return readFileSync(absolute(path), "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(absolute(path)),
  };
}

/** A tool's mutant before the gate numbers it. */
export type ToolMutant = Omit<MutantOutcome, "id" | "blocking">;

export type ToolRun =
  | { tool: MutationTool; mutants: ToolMutant[]; note?: string }
  | { tool: MutationTool; failure: string };

interface Adapter {
  tool: MutationTool;
  /**
   * Files and directories under the root the tool may create; each one that did not exist
   * before the run is removed after it, so the run's working copy keeps only its own changes.
   */
  outputs: readonly string[];
  /** The command that starts the tool, or null when the project does not have it. */
  detect(shell: ToolShell): { executable: string; args: string[] } | null;
  run(
    shell: ToolShell,
    command: { executable: string; args: string[] },
    files: ChangedFile[],
    budgetMs: number,
  ): Promise<ToolMutant[] | string>;
}

/** Mutants kept from a tool's report, survivors first: the artifact stays small on a big module. */
const MAX_TOOL_MUTANTS = 200;

const slash = (path: string) => path.replaceAll("\\", "/");

/** A report path relative to the root: tools print relative, absolute or `./` paths. */
function relativePath(rootPath: string, path: string): string {
  const root = slash(rootPath).replace(/\/$/, "");
  const normalized = slash(path).replace(/^\.\//, "");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

const lineAt = (file: ChangedFile | undefined, line: number) =>
  file?.content.split("\n")[line - 1] ?? "";

/** The line with the 1-based columns `[start, end)` replaced, or null when the span is wider. */
function replaceSpan(
  text: string,
  start: { line: number; column: number },
  end: { line: number; column: number },
  replacement: string,
): string | null {
  if (start.line !== end.line || replacement.includes("\n")) return null;
  return text.slice(0, start.column - 1) + replacement + text.slice(end.column - 1);
}

/** The first removed and added line of a unified diff, with the removed line's number. */
export function diffChange(
  diff: string,
): { line: number; original: string; mutated: string } | null {
  let line = 0;
  let original: { line: number; text: string } | null = null;
  let mutated: string | null = null;
  for (const row of diff.split("\n")) {
    const hunk = /^@@ -(\d+)/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!line || row.startsWith("---") || row.startsWith("+++")) continue;
    if (row.startsWith("-")) {
      original ??= { line, text: row.slice(1) };
      line++;
    } else if (row.startsWith("+")) mutated ??= row.slice(1);
    else line++;
    if (original && mutated !== null) break;
  }
  return original ? { line: original.line, original: original.text, mutated: mutated ?? "" } : null;
}

const STRYKER_BIN = "node_modules/@stryker-mutator/core/bin/stryker.js";
const STRYKER_REPORT = "reports/mutation/mutation.json";

interface StrykerReport {
  files?: Record<
    string,
    {
      mutants?: {
        id?: string;
        mutatorName?: string;
        replacement?: string;
        status?: string;
        location?: {
          start: { line: number; column: number };
          end: { line: number; column: number };
        };
      }[];
    }
  >;
}

/** Stryker's mutation-testing-elements report (`reports/mutation/mutation.json`). */
export function strykerMutants(report: string, files: ChangedFile[], root: string): ToolMutant[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out: ToolMutant[] = [];
  const statuses: Record<string, ToolMutant["status"]> = {
    Killed: "killed",
    Survived: "survived",
    NoCoverage: "survived",
    Timeout: "timeout",
    Pending: "not-run",
  };
  for (const [path, entry] of Object.entries((JSON.parse(report) as StrykerReport).files ?? {})) {
    const file = byPath.get(relativePath(root, path));
    if (!file) continue;
    for (const mutant of entry.mutants ?? []) {
      // Compile and runtime errors are invalid mutants, ignored ones were excluded: neither counts.
      const status = statuses[mutant.status ?? ""];
      if (!status || !mutant.location) continue;
      const { start, end } = mutant.location;
      const original = lineAt(file, start.line);
      const replacement = mutant.replacement ?? "";
      const mutated = replaceSpan(original, start, end, replacement);
      out.push({
        file: file.path,
        line: start.line,
        operator: mutant.mutatorName ?? "stryker",
        original,
        mutated: mutated ?? original,
        ...(mutated === null
          ? { description: `${mutant.mutatorName ?? "mutant"}: ${replacement.slice(0, 120)}` }
          : {}),
        status,
        ...(status === "killed" ? { killedBy: "stryker" } : {}),
      });
    }
  }
  return out;
}

/** The changed Python file a mutmut mutant name (`pkg.mod.x_fn__mutmut_3`) belongs to. */
function mutmutFile(name: string, files: ChangedFile[]): ChangedFile | undefined {
  const module = name.replace(/\.x[_\u01c1][^.]*$/, "");
  return files.find((f) => {
    const parts = f.path
      .replace(/\.py$/, "")
      .replace(/\/__init__$/, "")
      .split("/");
    // A module is the tail of its path: `src/calc/__init__.py` is `calc`.
    for (let i = 0; i < parts.length; i++) if (parts.slice(i).join(".") === module) return true;
    return false;
  });
}

/**
 * The file line a mutmut mutant changed. `mutmut show` numbers the lines of the function, not of
 * the file, so the line is the first one after the function's `def` with the original's text.
 */
export function mutmutLine(name: string, original: string, file: ChangedFile): number {
  const fn =
    (name.split(".").at(-1) ?? "")
      .replace(/__mutmut_\d+$/, "")
      .split(/\u01c1/)
      .at(-1) ?? "";
  const lines = file.content.split("\n");
  const def = lines.findIndex((l) =>
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${fn.replace(/^x_/, "")}\\s*\\(`).test(l),
  );
  const index = lines.findIndex((l, i) => i >= Math.max(def, 0) && l.trim() === original.trim());
  return index + 1;
}

/** `mutmut results --all true` lines: `    pkg.mod.x_fn__mutmut_3: survived`. */
export function mutmutResults(output: string): { name: string; status: string }[] {
  return [...output.matchAll(/^\s*(\S+__mutmut_\d+): (.+?)\s*$/gm)].map((m) => ({
    name: m[1] ?? "",
    status: m[2] ?? "",
  }));
}

const MUTMUT_STATUS: Record<string, ToolMutant["status"]> = {
  killed: "killed",
  "caught by type check": "killed",
  segfault: "killed",
  survived: "survived",
  "no tests": "survived",
  timeout: "timeout",
  suspicious: "timeout",
  "not checked": "not-run",
};
/** Mutants mutmut is asked to show, survivors first: each `mutmut show` is a process. */
const MAX_MUTMUT_SHOWN = 60;

/** cargo-mutants' `mutants.out/outcomes.json`. */
export function cargoMutants(report: string, files: ChangedFile[]): ToolMutant[] | string {
  const parsed = JSON.parse(report) as {
    outcomes?: {
      scenario:
        | string
        | {
            Mutant?: {
              name?: string;
              file?: string;
              span?: {
                start: { line: number; column: number };
                end: { line: number; column: number };
              };
              replacement?: string;
              genre?: string;
            };
          };
      summary?: string;
    }[];
  };
  const byPath = new Map(files.map((f) => [f.path, f]));
  const statuses: Record<string, ToolMutant["status"]> = {
    CaughtMutant: "killed",
    MissedMutant: "survived",
    Timeout: "timeout",
  };
  const out: ToolMutant[] = [];
  for (const outcome of parsed.outcomes ?? []) {
    if (outcome.scenario === "Baseline") {
      if (outcome.summary !== "Success") return "the tests fail without mutants";
      continue;
    }
    const mutant = typeof outcome.scenario === "object" ? outcome.scenario.Mutant : undefined;
    const file = byPath.get(slash(mutant?.file ?? ""));
    const status = statuses[outcome.summary ?? ""];
    if (!mutant?.span || !file || !status) continue;
    const original = lineAt(file, mutant.span.start.line);
    const mutated = replaceSpan(
      original,
      mutant.span.start,
      mutant.span.end,
      mutant.replacement ?? "",
    );
    out.push({
      file: file.path,
      line: mutant.span.start.line,
      operator: mutant.genre ?? "cargo-mutants",
      original,
      mutated: mutated ?? original,
      ...(mutated === null ? { description: (mutant.name ?? "").replace(/^\S+: /, "") } : {}),
      status,
      ...(status === "killed" ? { killedBy: "cargo test" } : {}),
    });
  }
  return out;
}

const xmlText = (block: string, tag: string) =>
  (new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .trim();

/** PIT's `mutations.xml`. PIT mutates bytecode, so a mutant is its line and description. */
export function pitMutants(report: string, files: ChangedFile[]): ToolMutant[] {
  const statuses: Record<string, ToolMutant["status"]> = {
    KILLED: "killed",
    MEMORY_ERROR: "killed",
    RUN_ERROR: "killed",
    SURVIVED: "survived",
    NO_COVERAGE: "survived",
    TIMED_OUT: "timeout",
    NOT_STARTED: "not-run",
    STARTED: "not-run",
  };
  const out: ToolMutant[] = [];
  for (const match of report.matchAll(/<mutation\b([^>]*)>([\s\S]*?)<\/mutation>/g)) {
    const status = statuses[/status=['"]([A-Z_]+)['"]/.exec(match[1] ?? "")?.[1] ?? ""];
    const block = match[2] ?? "";
    // `com.example.Calc$Inner` in `Calc.java` is `com/example/Calc.java` under a source root.
    const pkg = xmlText(block, "mutatedClass").split("$")[0]?.split(".").slice(0, -1) ?? [];
    const suffix = [...pkg, xmlText(block, "sourceFile")].join("/");
    const file = files.find((f) => f.path === suffix || f.path.endsWith(`/${suffix}`));
    const line = Number(xmlText(block, "lineNumber"));
    if (!status || !file || !line) continue;
    const original = lineAt(file, line);
    out.push({
      file: file.path,
      line,
      operator: xmlText(block, "mutator").split(".").at(-1) ?? "pit",
      original,
      mutated: original,
      description: xmlText(block, "description") || "mutated by PIT",
      status,
      ...(status === "killed" ? { killedBy: "pit" } : {}),
    });
  }
  return out;
}

/** go-mutesting's `report.json` (the maintained avito-tech fork writes it). */
export function goMutants(report: string, files: ChangedFile[]): ToolMutant[] {
  type Entry = {
    mutator?: { mutatorName?: string; originalFilePath?: string; originalStartLine?: number };
    diff?: string;
  };
  const parsed = JSON.parse(report) as Record<string, Entry[] | unknown>;
  const lists: [string, ToolMutant["status"]][] = [
    ["killed", "killed"],
    ["escaped", "survived"],
    ["timeouted", "timeout"],
  ];
  const out: ToolMutant[] = [];
  for (const [key, status] of lists) {
    const entries = parsed[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Entry[]) {
      const path = slash(entry.mutator?.originalFilePath ?? "").replace(/^\.\//, "");
      const file = files.find((f) => f.path === path || f.path.endsWith(`/${path}`));
      const change = diffChange(entry.diff ?? "");
      const line = entry.mutator?.originalStartLine ?? change?.line ?? 0;
      if (!file || !line) continue;
      const original = lineAt(file, line);
      out.push({
        file: file.path,
        line,
        operator: entry.mutator?.mutatorName ?? "go-mutesting",
        original,
        mutated: change && change.original.trim() === original.trim() ? change.mutated : original,
        ...(change && change.original.trim() === original.trim()
          ? {}
          : { description: entry.mutator?.mutatorName ?? "mutated by go-mutesting" }),
        status,
        ...(status === "killed" ? { killedBy: "go test" } : {}),
      });
    }
  }
  return out;
}

const javaClass = (path: string) =>
  /(?:^|\/)src\/main\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path)?.[1]?.replaceAll("/", ".");

const ADAPTERS: readonly Adapter[] = [
  {
    tool: "stryker",
    outputs: [STRYKER_REPORT, "reports/mutation", "reports"],
    detect: (shell) => {
      if (!shell.exists(STRYKER_BIN)) return null;
      return { executable: shell.which("node") ?? process.execPath, args: [STRYKER_BIN] };
    },
    run: async (shell, command, files, budgetMs) => {
      const result = await shell.run(
        command.executable,
        [
          ...command.args,
          "run",
          "--mutate",
          files.map((f) => f.path).join(","),
          "--reporters",
          "json",
          "--incremental",
          "--incrementalFile",
          `${shell.scratch}/stryker-incremental.json`,
          "--tempDirName",
          `${shell.scratch}/stryker-tmp`,
          "--cleanTempDir",
          "always",
        ],
        budgetMs,
      );
      if (result.timedOut) return "timeout";
      // A score under the project's own `thresholds.break` exits non-zero with a full report.
      const report = shell.read(STRYKER_REPORT);
      if (!report) return `exit ${result.exitCode}: ${result.output.trim().slice(-300)}`;
      return strykerMutants(report, files, shell.root);
    },
  },
  {
    tool: "mutmut",
    outputs: ["mutants"],
    detect: (shell) => {
      const local = shell.platform === "win32" ? ".venv/Scripts/mutmut.exe" : ".venv/bin/mutmut";
      if (shell.exists(local)) return { executable: `${shell.root}/${local}`, args: [] };
      const found = shell.which("mutmut");
      return found ? { executable: found, args: [] } : null;
    },
    run: async (shell, command, files, budgetMs) => {
      const started = shell.now();
      const left = () => budgetMs - (shell.now() - started);
      // mutmut 3 mutates the project's `paths_to_mutate`; the gate keeps the changed files' mutants.
      const run = await shell.run(command.executable, [...command.args, "run"], left());
      if (run.timedOut) return "timeout";
      const listed = await shell.run(
        command.executable,
        [...command.args, "results", "--all", "true"],
        Math.max(1000, left()),
      );
      const results = mutmutResults(listed.output);
      if (!results.length)
        return `no results (mutmut 3 or newer is needed): ${(run.output + listed.output).trim().slice(-300)}`;
      const scoped = results
        .map((r) => ({ ...r, file: mutmutFile(r.name, files), status: MUTMUT_STATUS[r.status] }))
        .filter((r) => r.file && r.status)
        .sort((a, b) => Number(b.status === "survived") - Number(a.status === "survived"))
        .slice(0, MAX_MUTMUT_SHOWN);
      const out: ToolMutant[] = [];
      for (const r of scoped) {
        if (left() <= 0) break;
        const shown = await shell.run(
          command.executable,
          [...command.args, "show", r.name],
          Math.min(30_000, left()),
        );
        const change = diffChange(shown.output);
        const line = change && r.file ? mutmutLine(r.name, change.original, r.file) : 0;
        if (!change || !r.file || !r.status || !line) continue;
        out.push({
          file: r.file.path,
          line,
          operator: "mutmut",
          original: lineAt(r.file, line),
          mutated: change.mutated,
          status: r.status,
          ...(r.status === "killed" ? { killedBy: "mutmut" } : {}),
        });
      }
      return out;
    },
  },
  {
    tool: "cargo-mutants",
    outputs: [],
    detect: (shell) => {
      const cargo = shell.which("cargo");
      return shell.exists("Cargo.toml") && cargo && shell.which("cargo-mutants")
        ? { executable: cargo, args: ["mutants"] }
        : null;
    },
    run: async (shell, command, files, budgetMs) => {
      const output = `${shell.scratch}/cargo-mutants`;
      const result = await shell.run(
        command.executable,
        [
          ...command.args,
          ...files.flatMap((f) => ["--file", f.path]),
          "--output",
          output,
          "--no-shuffle",
          "--colors",
          "never",
        ],
        budgetMs,
      );
      if (result.timedOut) return "timeout";
      // Exit 2 and 3 report missed and timed-out mutants; the outcomes say which.
      const report = shell.read(`${output}/mutants.out/outcomes.json`);
      if (!report) return `exit ${result.exitCode}: ${result.output.trim().slice(-300)}`;
      return cargoMutants(report, files);
    },
  },
  {
    tool: "pit",
    outputs: ["target/pit-reports", "build/reports/pitest"],
    detect: (shell) => {
      const wrapper = (name: string) =>
        shell.platform === "win32" ? `${shell.root}/${name}.cmd` : `${shell.root}/${name}`;
      if (shell.read("pom.xml")?.includes("pitest-maven")) {
        const mvn = shell.exists(shell.platform === "win32" ? "mvnw.cmd" : "mvnw")
          ? wrapper("mvnw")
          : shell.which("mvn");
        return mvn ? { executable: mvn, args: ["-B", "-q"] } : null;
      }
      const gradle = shell.read("build.gradle.kts") ?? shell.read("build.gradle");
      if (gradle?.includes("info.solidsoft.pitest")) {
        const exe = shell.exists(shell.platform === "win32" ? "gradlew.bat" : "gradlew")
          ? shell.platform === "win32"
            ? `${shell.root}/gradlew.bat`
            : `${shell.root}/gradlew`
          : shell.which("gradle");
        return exe ? { executable: exe, args: ["-q"] } : null;
      }
      return null;
    },
    run: async (shell, command, files, budgetMs) => {
      const maven = command.args.includes("-B");
      const classes = files.map((f) => javaClass(f.path)).filter((c): c is string => !!c);
      const result = await shell.run(
        command.executable,
        maven
          ? [
              ...command.args,
              "test-compile",
              "org.pitest:pitest-maven:mutationCoverage",
              "-DoutputFormats=XML",
              "-DtimestampedReports=false",
              ...(classes.length ? [`-DtargetClasses=${classes.join(",")}`] : []),
            ]
          : [...command.args, "pitest"],
        budgetMs,
      );
      if (result.timedOut) return "timeout";
      const report = shell.read(
        maven ? "target/pit-reports/mutations.xml" : "build/reports/pitest/mutations.xml",
      );
      if (!report)
        return maven
          ? `exit ${result.exitCode}: ${result.output.trim().slice(-300)}`
          : "no build/reports/pitest/mutations.xml: add XML to the pitest block's outputFormats";
      return pitMutants(report, files);
    },
  },
  {
    tool: "go-mutesting",
    outputs: ["report.json"],
    detect: (shell) => {
      const found = shell.exists("go.mod") ? shell.which("go-mutesting") : null;
      return found ? { executable: found, args: [] } : null;
    },
    run: async (shell, command, files, budgetMs) => {
      const result = await shell.run(
        command.executable,
        [...command.args, ...files.map((f) => f.path)],
        budgetMs,
      );
      if (result.timedOut) return "timeout";
      const report = shell.read("report.json");
      if (!report)
        return `no report.json (the avito-tech/go-mutesting fork writes one): exit ${result.exitCode}`;
      return goMutants(report, files);
    },
  },
];

/**
 * The ecosystem mutation tool of each supported language (#1717, #1733); a language without one
 * gets the built-in engine.
 */
export const MUTATION_TOOLS: LanguageRecord<MutationTool> = {
  typescript: "stryker",
  javascript: "stryker",
  vue: none(
    "Stryker mutates Vue single-file components only with a plugin this gate does not set up",
  ),
  svelte: none("Stryker does not mutate Svelte components"),
  rescript: none("Stryker mutates the compiled JavaScript, not ReScript sources"),
  python: "mutmut",
  rust: "cargo-mutants",
  java: "pit",
  kotlin: "pit",
  go: "go-mutesting",
  scala: none("no Scala mutation tool is integrated (Stryker4s)"),
  csharp: none("Stryker.NET is not integrated yet"),
  c: none("no C mutation tool is integrated"),
  cpp: none("no C++ mutation tool is integrated (Mull)"),
  ruby: none("no Ruby mutation tool is integrated (mutant)"),
  php: none("Infection is not integrated yet (#1491)"),
  swift: none("no Swift mutation tool is integrated (Muter)"),
  lua: none("no Lua mutation tool is integrated"),
  elixir: none("no Elixir mutation tool is integrated"),
  dart: none("no Dart mutation tool is integrated"),
  zig: none("no Zig mutation tool exists"),
  bash: none("no shell mutation tool exists"),
  ocaml: none("no OCaml mutation tool is integrated"),
  objc: none("no Objective-C mutation tool is integrated"),
  solidity: none("no Solidity mutation tool is integrated (Gambit)"),
  sql: none("no SQL mutation tool is integrated"),
};

/** The changed non-test code files a tool would mutate, by tool; build scripts are not mutated. */
const toolFiles = (adapter: Adapter, files: ChangedFile[]) =>
  files.filter(
    (f) =>
      rowOf(MUTATION_TOOLS, detectLanguageFromPath(f.path)) === adapter.tool &&
      !isTestCodePath(f.path) &&
      !isManifestFile(f.path),
  );

/**
 * The installed tool for the language most of the changed code is in, or null: the built-in
 * engine then runs. Only what the project or the machine already has is used.
 */
export function detectMutationTool(
  files: ChangedFile[],
  shell: ToolShell,
): { tool: MutationTool; files: ChangedFile[] } | null {
  const ranked = ADAPTERS.map((adapter) => ({ adapter, files: toolFiles(adapter, files) }))
    .filter((entry) => entry.files.length)
    .sort((a, b) => b.files.length - a.files.length);
  for (const entry of ranked)
    if (entry.adapter.detect(shell)) return { tool: entry.adapter.tool, files: entry.files };
  return null;
}

/**
 * Runs a detected tool on `files` and keeps its mutants on the lines the run added. The files it
 * creates in the working copy are removed afterwards; its incremental state stays in `scratch`.
 */
export async function runMutationTool(
  tool: MutationTool,
  files: ChangedFile[],
  shell: ToolShell,
  budgetMs: number,
): Promise<ToolRun> {
  const adapter = ADAPTERS.find((a) => a.tool === tool);
  const command = adapter?.detect(shell);
  if (!adapter || !command) return { tool, failure: "not installed" };
  const fresh = adapter.outputs.filter((path) => !shell.exists(path));
  let mutants: ToolMutant[] | string;
  try {
    mutants = await adapter.run(shell, command, files, budgetMs);
  } catch (error) {
    mutants = error instanceof SyntaxError ? `unreadable report: ${error.message}` : "";
    if (!mutants) throw error;
  } finally {
    for (const path of fresh) if (shell.exists(path)) shell.remove(path);
  }
  if (mutants === "timeout")
    return {
      tool,
      mutants: [],
      note: `${tool} did not finish within the time budget of ${Math.round(budgetMs / 1000)}s`,
    };
  if (typeof mutants === "string") return { tool, failure: mutants };
  const added = new Map(files.map((f) => [f.path, addedLines(f.before, f.content)]));
  const kept = mutants
    .filter((m) => added.get(m.file)?.has(m.line - 1))
    .sort((a, b) => Number(b.status === "survived") - Number(a.status === "survived"));
  return {
    tool,
    mutants: kept.slice(0, MAX_TOOL_MUTANTS),
    ...(kept.length > MAX_TOOL_MUTANTS
      ? { note: `${kept.length - MAX_TOOL_MUTANTS} more mutants of ${tool} were left out` }
      : {}),
  };
}

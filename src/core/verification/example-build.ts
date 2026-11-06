import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../intelligence/language-records.js";

/**
 * A toolchain command that builds before it runs, and how a documented example reuses the build
 * the run's checks already made (#2505). The examples run in a copy of the workspace's source
 * files, with no build output: R81 hintsieve-update's README ran `swift run hintsieve ...` eight
 * times, each one compiled from nothing under the 30 s example timeout and was killed (244 s of a
 * 687 s run), and no example of a compiled language was ever compared with its output.
 */
export interface ExampleBuild {
  /** The toolchain program. */
  program: string;
  /** The subcommand words that build and run (`run`, `build run`, `exec`). */
  subcommand: readonly string[];
  /** Build directories, by name, linked from the workspace into the copy wherever they are. */
  link: readonly string[];
  /** Flags placed after the subcommand so the run reuses the linked build instead of building. */
  noBuild: readonly string[];
}

const interpreted = (what: string) => none(`${what} runs from source, with nothing to build`);

/** Per supported language, its build-and-run command (#2505), golden in each fixture's `exampleBuild`. */
export const EXAMPLE_BUILD: LanguageRecord<ExampleBuild> = {
  swift: { program: "swift", subcommand: ["run"], link: [".build"], noBuild: ["--skip-build"] },
  csharp: { program: "dotnet", subcommand: ["run"], link: ["bin", "obj"], noBuild: ["--no-build"] },
  // cargo checks its fingerprints in the linked target and builds nothing that is fresh.
  rust: { program: "cargo", subcommand: ["run"], link: ["target"], noBuild: [] },
  elixir: { program: "mix", subcommand: ["run"], link: ["_build"], noBuild: ["--no-compile"] },
  zig: {
    program: "zig",
    subcommand: ["build", "run"],
    link: ["zig-out", ".zig-cache"],
    noBuild: [],
  },
  dart: { program: "dart", subcommand: ["run"], link: [".dart_tool"], noBuild: [] },
  ocaml: { program: "dune", subcommand: ["exec"], link: ["_build"], noBuild: ["--no-build"] },
  scala: none(
    "sbt starts a JVM and loads the build on every run, past the example timeout; the first timeout stops the rest",
  ),
  go: none("go run reuses the shared build cache, outside the workspace"),
  java: none("Maven and Gradle entry points link target/ and build/ (ENTRY_POINTS)"),
  kotlin: none("Maven and Gradle entry points link target/ and build/ (ENTRY_POINTS)"),
  c: none("a binary is a build output the example names by path, linked when it exists"),
  cpp: none("a binary is a build output the example names by path, linked when it exists"),
  objc: none("a binary is a build output the example names by path, linked when it exists"),
  typescript: interpreted("TypeScript through bun or node"),
  javascript: interpreted("JavaScript"),
  vue: interpreted("a Vue project's script"),
  svelte: interpreted("a Svelte project's script"),
  rescript: interpreted("the JavaScript ReScript compiles to"),
  python: interpreted("Python"),
  ruby: interpreted("Ruby"),
  php: interpreted("PHP"),
  lua: interpreted("Lua"),
  bash: interpreted("a shell script"),
  powershell: interpreted("PowerShell"),
  r: interpreted("R"),
  sql: none("SQL runs in a database client, not as a command"),
  solidity: none("contracts are deployed, not run as commands"),
};

const ROWS: readonly ExampleBuild[] = SUPPORTED_LANGUAGES.flatMap(
  (l) => rowOf(EXAMPLE_BUILD, l) ?? [],
);

/** The build-and-run row an argument vector starts with, or null. */
export function exampleBuildOf(argv: readonly string[]): ExampleBuild | null {
  return (
    ROWS.find(
      (row) => argv[0] === row.program && row.subcommand.every((word, i) => argv[i + 1] === word),
    ) ?? null
  );
}

/** Directories that hold no build output of the project's own. */
const SKIPPED = new Set(["node_modules", ".git", ".baked", ".venv", "venv", "deps"]);

/** The workspace paths of directories named `names`, at most `depth` levels down. */
export function buildDirectories(root: string, names: readonly string[], depth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number) => {
    let entries: string[];
    try {
      entries = readdirSync(join(root, dir));
    } catch {
      return;
    }
    for (const name of entries) {
      const path = dir ? `${dir}/${name}` : name;
      try {
        if (!statSync(join(root, path)).isDirectory()) continue;
      } catch {
        continue;
      }
      if (names.includes(name)) out.push(path);
      else if (level < depth && !SKIPPED.has(name)) walk(path, level + 1);
    }
  };
  walk("", 1);
  return out.sort();
}

/**
 * The example's argument vector to run in the copy, after linking the workspace's build
 * directories of its row into it: the row's no-build flags follow the subcommand when a build
 * directory was linked, so the run reuses the build the checks made. Without a row, or with no
 * build directory in the workspace, the argument vector is unchanged.
 */
export function prepareExampleBuild(argv: readonly string[], root: string, copy: string): string[] {
  const row = exampleBuildOf(argv);
  if (!row) return [...argv];
  let linked = 0;
  for (const path of buildDirectories(root, row.link)) {
    if (existsSync(join(copy, path))) continue;
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    symlinkSync(
      join(root, path),
      join(copy, path),
      process.platform === "win32" ? "junction" : "dir",
    );
    linked++;
  }
  if (!linked && !row.link.some((name) => existsSync(join(copy, name)))) return [...argv];
  const at = 1 + row.subcommand.length;
  const flags = row.noBuild.filter((flag) => !argv.includes(flag));
  return [...argv.slice(0, at), ...flags, ...argv.slice(at)];
}

/** The program and subcommand an example's timeout stands for: later ones of it would wait the same. */
export function commandShape(argv: readonly string[]): string {
  const row = exampleBuildOf(argv);
  if (row) return [row.program, ...row.subcommand].join(" ");
  const first = argv.slice(1).find((arg) => !arg.startsWith("-"));
  return [argv[0], ...(first ? [first] : [])].join(" ");
}

/**
 * Links the build output an example names by path (`./build/x`, `src/App/bin/Release/x.dll`) from
 * the workspace into the copy, when the workspace has it: the checks built it, and the copy holds
 * only source files. The deepest build directory of the path is linked.
 */
export function linkBuildOutput(
  argv: readonly string[],
  root: string,
  copy: string,
  buildDirs: ReadonlySet<string>,
): void {
  for (const arg of argv) {
    if (arg.startsWith("-") || !/[\\/]/.test(arg)) continue;
    const segments = arg.split(/[\\/]+/).filter((s) => s && s !== ".");
    const at = segments.slice(0, -1).findLastIndex((s) => buildDirs.has(s));
    if (at < 0) continue;
    const dir = segments.slice(0, at + 1).join("/");
    if (existsSync(join(copy, dir)) || !existsSync(join(root, dir))) continue;
    mkdirSync(dirname(join(copy, dir)), { recursive: true });
    symlinkSync(
      join(root, dir),
      join(copy, dir),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
}

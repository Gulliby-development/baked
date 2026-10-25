import { type LanguageRecord, none, rowOf } from "../intelligence/language-records.js";
import { detectLanguageFromPath } from "../intelligence/types.js";

/**
 * How a test file says it runs only under a build gate, and the flags of the language's test
 * command that turn the gate on (#1832). The host's check of the test files a task wrote runs
 * a gated file with its gate: tonemath-update (bench round 56) wrote `tests/unicode_tests.rs`
 * behind `#![cfg(feature = "unicode")]`, its check ran `cargo test --test unicode_tests` without
 * the feature, printed "running 0 tests" and passed, and the five tests first ran in the review.
 * A language whose gate is not a flag of its test command has a `none` row: its gated or skipped
 * file runs no test, which fails the check (`requireTests`), and the task makes the file run.
 */
export interface TestGate {
  /** The toolchain whose test command takes `flags` (`cargo test`, `go test`). */
  program: string;
  /** The gate names a test file declares for itself. */
  read: (text: string) => string[];
  /** The test command's arguments that turn the named gates on. */
  flags: (names: readonly string[]) => string[];
}

const IDENT = /^[A-Za-z_][\w-]*$/;

/** The features of a file-level `#![cfg(feature = "x")]`, also inside `all(...)`. */
function cargoFeatures(text: string): string[] {
  const attribute = /^\s*#!\[cfg\((.*)\)\]\s*$/m.exec(text)?.[1] ?? "";
  // `not(feature = "x")` or `any(...)` needs no feature, or one of several: the file stays as is.
  if (/\b(?:not|any)\s*\(/.test(attribute)) return [];
  return [...attribute.matchAll(/\bfeature\s*=\s*"([^"]+)"/g)]
    .map((m) => m[1] ?? "")
    .filter((name) => IDENT.test(name));
}

/** The tags of a `//go:build` line that needs all of them: `a`, `a && b`. */
function goTags(text: string): string[] {
  // The constraint comes before the package clause.
  const at = text.search(/^package\s/m);
  const head = at < 0 ? text : text.slice(0, at);
  const expression = /^\/\/go:build\s+(.+)$/m.exec(head)?.[1]?.trim() ?? "";
  if (!expression || /[|!()]/.test(expression)) return [];
  const tags = expression.split(/\s*&&\s*/);
  // The tags Go sets itself (an operating system, an architecture, a version) need no flag.
  return tags.every((tag) => IDENT.test(tag)) ? tags.filter((tag) => !GO_IMPLICIT.test(tag)) : [];
}
const GO_IMPLICIT =
  /^(?:linux|darwin|windows|freebsd|netbsd|openbsd|android|ios|js|wasip1|plan9|solaris|aix|illumos|dragonfly|unix|amd64|arm64|386|arm|wasm|riscv64|ppc64le|s390x|mips\w*|loong64|cgo|gc|gccgo|go1\.\d+|ignore)$/;

export const TEST_GATES: LanguageRecord<TestGate> = {
  rust: {
    program: "cargo",
    read: cargoFeatures,
    flags: (names) => ["--features", names.join(",")],
  },
  go: { program: "go", read: goTags, flags: (names) => ["-tags", names.join(",")] },
  typescript: none(
    "bun, jest and vitest skip a file with skipIf, which no flag of the runner undoes",
  ),
  javascript: none(
    "bun, jest and vitest skip a file with skipIf, which no flag of the runner undoes",
  ),
  vue: none("vitest and jest skip a file with skipIf, which no flag of the runner undoes"),
  svelte: none("vitest and jest skip a file with skipIf, which no flag of the runner undoes"),
  rescript: none("vitest and jest skip a file with skipIf, which no flag of the runner undoes"),
  python: none("pytest skips a module by importorskip or skipif, which no pytest flag undoes"),
  java: none("a Maven profile or a surefire group decides which tests run, not the test file"),
  kotlin: none("a Gradle property or source set decides which tests run, not the test file"),
  scala: none("an sbt configuration decides which tests run, not the test file"),
  csharp: none("an #if symbol comes from the project's DefineConstants, not from a test file"),
  c: none("a preprocessor symbol comes from the build system, not from a test command flag"),
  cpp: none("a preprocessor symbol comes from the build system, not from a test command flag"),
  ruby: none("RSpec and Minitest tags are filters of the command, not declared gates"),
  php: none("PHPUnit groups are filters of the command, not declared gates"),
  swift: none("a compilation condition comes from Package.swift, not from a test file"),
  lua: none("busted tags are filters of the command, not declared gates"),
  elixir: none("ExUnit tags are filters of the command, not declared gates"),
  dart: none("dart test tags are filters of the command, not declared gates"),
  zig: none("build options come from build.zig, not from a test file"),
  bash: none("bats has no build gate"),
  ocaml: none("dune enables a test by its stanza, not by a flag of dune test"),
  objc: none("a preprocessor symbol comes from the Xcode project, not from a test file"),
  solidity: none("forge has no build gate for a test file"),
  sql: none("pgTAP and dbt tests have no build gate"),
  powershell: none("Pester tags are filters of the command, not declared gates"),
};

/**
 * The gate flags of each toolchain for the test files given with their text: the union of the
 * gates the files declare, by the program whose test command takes them.
 */
export function testGateFlags(
  files: readonly { path: string; text: string }[],
): Map<string, string[]> {
  const names = new Map<string, { gate: TestGate; names: Set<string> }>();
  for (const { path, text } of files) {
    const gate = rowOf(TEST_GATES, detectLanguageFromPath(path));
    if (!gate) continue;
    const found = gate.read(text);
    if (!found.length) continue;
    const entry = names.get(gate.program) ?? { gate, names: new Set<string>() };
    for (const name of found) entry.names.add(name);
    names.set(gate.program, entry);
  }
  return new Map(
    [...names].map(([program, { gate, names: set }]) => [program, gate.flags([...set])]),
  );
}

/**
 * `args` with a gate flag (`--features a`, `-tags a`) turned on: its names joined to a value the
 * command already gives (`-tags x` becomes `-tags x,a`, since Go keeps only the last), or else
 * inserted at `at`, right after the subcommand.
 */
export function withGateFlags(
  args: readonly string[],
  flags: readonly string[] | undefined,
  at: number,
): string[] {
  const [flag, value] = flags ?? [];
  if (!flag || !value) return [...args];
  const i = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (i < 0) return [...args.slice(0, at), flag, value, ...args.slice(at)];
  const inline = args[i]?.startsWith(`${flag}=`);
  const current = (inline ? args[i]?.slice(flag.length + 1) : args[i + 1]) ?? "";
  const merged = [
    ...new Set([...current.split(/[,\s]+/), ...value.split(",")].filter(Boolean)),
  ].join(",");
  const out = [...args];
  if (inline) out[i] = `${flag}=${merged}`;
  else out[i + 1] = merged;
  return out;
}

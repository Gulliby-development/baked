import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciCheckDrift, ciCheckDriftSummary, fileGateCommands, looksLikeCommand, type ScriptTables, scriptTables, toolCommand } from "../src/core/workflows/ci-check-drift.js";
import { PSSA_LINT } from "../src/core/workflows/gates.js";
import { PESTER_RUN } from "../src/core/workflows/pester.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2284, R73 evalpin: the delivery feature wrote `.github/workflows/ci.yml` with
// `cargo clippy --offline --all-targets -- -D warnings`, the run's clippy check ran
// `cargo clippy -- -D warnings`, all features were accepted, and the delivered CI failed on
// `clippy::type_complexity` in tests/commands.rs. Nothing compared the two.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const check = (id: string, command: string) => {
  const [executable = "", ...args] = command.split(" ");
  return { id, executable, args };
};
const workflow = (...commands: string[]) =>
  `name: CI\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${commands.map((c) => `      - run: ${c}`).join("\n")}\n`;
const CI = ".github/workflows/ci.yml";

describe("ciCheckDrift: CI commands against the configured checks (#2284)", () => {
  test("Rust: a ci.yml clippy with --all-targets against a clippy check without it", () => {
    const drift = ciCheckDrift(
      [{ path: CI, text: workflow("cargo fetch", "cargo fmt --all -- --check", "cargo clippy --offline --all-targets -- -D warnings", "cargo test --offline") }],
      [check("fmt", "cargo fmt --all -- --check"), check("clippy", "cargo clippy -- -D warnings"), check("tests", "cargo test")],
    );
    expect(drift).toEqual([
      {
        file: CI,
        command: "cargo clippy --offline --all-targets -- -D warnings",
        tool: "cargo clippy",
        check: { id: "clippy", command: "cargo clippy -- -D warnings" },
        missing: ["--all-targets"],
      },
    ]);
    expect(ciCheckDriftSummary(drift[0]!)).toContain('runs "cargo clippy --offline --all-targets -- -D warnings", but check clippy runs "cargo clippy -- -D warnings" without --all-targets');
  });

  test("Go: go test -race ./... against go test ./...", () => {
    const drift = ciCheckDrift([{ path: CI, text: workflow("go vet ./...", "go test -race ./...") }], [check("vet", "go vet ./..."), check("tests", "go test ./...")]);
    expect(drift.map((d) => [d.command, d.check?.id, d.missing])).toEqual([["go test -race ./...", "tests", ["-race"]]]);
  });

  test("Python: mypy --strict through uv against a plain mypy check", () => {
    const drift = ciCheckDrift(
      [{ path: ".github/workflows/lint.yaml", text: workflow("uv run ruff check .", "uv run mypy --strict src") }],
      [check("ruff", "ruff check"), check("types", "python -m mypy src")],
    );
    expect(drift.map((d) => [d.tool, d.check?.id, d.missing])).toEqual([["mypy", "types", ["--strict"]]]);
  });

  test("TypeScript: eslint --max-warnings 0 and a tsc project the checks never run", () => {
    const drift = ciCheckDrift(
      [{ path: CI, text: workflow("npm ci", "npx eslint . --max-warnings=0", "npx tsc --noEmit -p tsconfig.test.json", "npm test") }],
      [check("lint", "npx eslint ."), check("typecheck", "npx tsc --noEmit"), check("tests", "npm test")],
    );
    expect(drift.map((d) => [d.tool, d.missing])).toEqual([
      ["eslint", ["--max-warnings", "0"]],
      ["tsc", ["-p", "tsconfig.test.json"]],
    ]);
  });

  test("a gate command no check runs is recorded with no check; a non-gate command is not", () => {
    const drift = ciCheckDrift([{ path: CI, text: workflow("cargo build --release", "cargo clippy -- -D warnings") }], [check("tests", "cargo test")]);
    expect(drift).toEqual([{ file: CI, command: "cargo clippy -- -D warnings", tool: "cargo clippy", check: null, missing: [] }]);
    expect(ciCheckDriftSummary(drift[0]!)).toContain("no configured check runs cargo clippy");
  });

  test("a matching CI file records nothing: same words in any order, output-only flags, stricter checks", () => {
    expect(
      ciCheckDrift(
        [{ path: CI, text: workflow("cargo clippy --locked --all-targets -- -D warnings", "cargo test --color always", "go test ./...") }],
        [check("clippy", "cargo clippy --all-targets --all-features -- -D warnings"), check("tests", "cargo test"), check("go", "go test -race ./...")],
      ),
    ).toEqual([]);
  });

  test("a README's shell block is read; other files and prose are not", () => {
    const readme = "# evalpin\n\n## Development\n\n```sh\n$ cargo clippy --offline --all-targets -- -D warnings\ncargo run -- --help\n```\n\n```rust\ncargo clippy --all-features\n```\n";
    expect(fileGateCommands("README.md", readme)).toEqual(["cargo clippy --offline --all-targets -- -D warnings", "cargo run -- --help"]);
    expect(fileGateCommands("docs/guide.md", readme)).toEqual([]);
    const drift = ciCheckDrift([{ path: "README.md", text: readme }], [check("clippy", "cargo clippy -- -D warnings")]);
    expect(drift.map((d) => [d.file, d.missing])).toEqual([["README.md", ["--all-targets"]]]);
  });

  test("tool identity: wrappers, script paths and subcommands", () => {
    expect(toolCommand("./vendor/bin/phpstan", ["analyse", "--level=max"])).toEqual({ tool: "phpstan", words: ["analyse", "--level", "max"] });
    expect(toolCommand("bun", ["run", "typecheck"])).toEqual({ tool: "bun run typecheck", words: [] });
    expect(toolCommand("cargo.exe", ["+nightly", "clippy", "--offline"])).toEqual({ tool: "cargo clippy", words: [] });
    expect(toolCommand("python3", ["-m", "pytest", "-q"])).toEqual({ tool: "pytest", words: [] });
    expect(toolCommand("./gradlew", ["check"])).toEqual({ tool: "gradle check", words: [] });
  });
});

/** A `cargo` (or other program) stand-in that passes, so a check runs without its toolchain. */
function cargoShim(program = "cargo"): string {
  const bin = mkdtempSync(join(tmpdir(), "baked-cargo-shim-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  const file = join(bin, process.platform === "win32" ? `${program}.cmd` : program);
  writeFileSync(file, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

/** The fixture flow, whose one task also writes the delivered CI workflow (or other files). */
class DeliveryExecutor extends FixtureExecutor {
  private files: Record<string, string>;
  constructor(
    private workspace: string,
    files: string | Record<string, string>,
  ) {
    super(workspace);
    this.files = typeof files === "string" ? { [CI]: files } : files;
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      for (const path of Object.keys(this.files)) graph.tasks[0]?.writes.push({ path, action: "create" });
    }
    if (request.profile.output === "implementation") {
      for (const [path, text] of Object.entries(this.files)) {
        mkdirSync(join(this.workspace, path, ".."), { recursive: true });
        writeFileSync(join(this.workspace, path), text);
      }
    }
    return result;
  }
}

async function deliver(ci: string, workflowId: "sdd" | "quick" = "sdd") {
  const cargo = cargoShim();
  const policy: RunPolicy = {
    ...fixturePolicy,
    ...(workflowId === "quick" ? { clarification: "assume" as const } : {}),
    checks: [
      ...fixturePolicy.checks,
      { id: "clippy", executable: cargo, args: ["clippy", "--", "-D", "warnings"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] },
    ],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new DeliveryExecutor(root, ci) });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: "Create ready value and its CI", ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const wouldStops = fixture.service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; mode: string; key: string; summary: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "ci_check_drift");
  return { final: await fixture.service.get(run.runId), wouldStops, cargo };
}

describe("scenario: a run delivers a ci.yml whose clippy no check runs (#2284)", () => {
  test("the checks stage records a shadow ci_check_drift naming the command, and the run still completes", async () => {
    const { final, wouldStops, cargo } = await deliver(workflow("cargo clippy --offline --all-targets -- -D warnings"));
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({
      mode: "shadow",
      key: `${CI}#cargo clippy --offline --all-targets -- -D warnings`,
      inputs: {
        file: CI,
        command: "cargo clippy --offline --all-targets -- -D warnings",
        tool: "cargo clippy",
        check: { id: "clippy", command: `${cargo} clippy -- -D warnings` },
        missing: ["--all-targets"],
      },
    });
    expect(wouldStops[0]?.summary).toContain("without --all-targets");
    // Shadow: nothing stops.
    expect(final.status).toBe("completed");
  });

  test("the quick workflow's command-gate stage records it too", async () => {
    const { wouldStops } = await deliver(workflow("cargo clippy --offline --all-targets -- -D warnings"), "quick");
    expect(wouldStops.map((w) => w.inputs.missing)).toEqual([["--all-targets"]]);
  });

  test("a delivered ci.yml that runs the checks' own commands records nothing", async () => {
    const { final, wouldStops } = await deliver(workflow("cargo clippy --offline -- -D warnings"));
    expect(wouldStops).toEqual([]);
    expect(final.status).toBe("completed");
  });
});

// #2416, R76 url-shortener: the README said `bun run test`, package.json had `"test": "bun test"`
// and the run's check was `bun test`; the reason read the README's tool as `bun run test` and
// recorded a false would-stop with no check. Script runners now resolve through the script tables.
const URL_SHORTENER_PACKAGE = { "package.json": JSON.stringify({ name: "url-shortener", scripts: { test: "bun test", typecheck: "tsc --noEmit", lint: "biome check ." } }) };
const tablesFrom =
  (byDir: Record<string, Record<string, string>>) =>
  (dir: string): ScriptTables =>
    scriptTables((name) => byDir[dir]?.[name] ?? null);
const readme = (...lines: string[]) => `# project\n\n## Development\n\n\`\`\`sh\n${lines.join("\n")}\n\`\`\`\n`;

describe("ciCheckDrift: script runners resolve through the project's scripts (#2416)", () => {
  test("R76 url-shortener: README `bun run test` with \"test\": \"bun test\" against a `bun test` check records nothing", () => {
    const scripts = tablesFrom({ ".": URL_SHORTENER_PACKAGE });
    expect(ciCheckDrift([{ path: "README.md", text: readme("bun install", "bun run test", "bun run dev") }], [check("tests", "bun test")], scripts)).toEqual([]);
  });

  test("npm run lint with \"lint\": \"biome check .\" against a biome check, and the other way round", () => {
    const scripts = tablesFrom({ ".": URL_SHORTENER_PACKAGE });
    expect(ciCheckDrift([{ path: CI, text: workflow("npm run lint") }], [check("lint", "biome check .")], scripts)).toEqual([]);
    expect(ciCheckDrift([{ path: CI, text: workflow("npx biome check .", "bunx tsc --noEmit") }], [check("lint", "npm run lint"), check("types", "bun run typecheck")], scripts)).toEqual([]);
  });

  test("a script that adds --max-warnings 0 the check lacks is a drift naming it and the script", () => {
    const scripts = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { lint: "eslint . --max-warnings 0" } }) } });
    const drift = ciCheckDrift([{ path: CI, text: workflow("npm run lint") }], [check("lint", "npx eslint .")], scripts);
    expect(drift).toEqual([{ file: CI, command: "npm run lint", tool: "eslint", script: "eslint . --max-warnings 0", check: { id: "lint", command: "npx eslint ." }, missing: ["--max-warnings", "0"] }]);
    expect(ciCheckDriftSummary(drift[0]!)).toContain('runs "npm run lint" (script: "eslint . --max-warnings 0"), but check lint runs "npx eslint ." without --max-warnings 0');
    // Words after the script name are the script's words too.
    const passed = ciCheckDrift([{ path: CI, text: workflow("npm run lint -- --max-warnings 0") }], [check("lint", "npm run lint")], tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) } }));
    expect(passed.map((d) => [d.tool, d.check?.id, d.missing])).toEqual([["eslint", "lint", ["--max-warnings", "0"]]]);
  });

  test("a script the host cannot read records nothing: unknown script, no package.json, several commands", () => {
    const tests = [check("tests", "bun test")];
    expect(ciCheckDrift([{ path: CI, text: workflow("npm run test:e2e") }], tests, tablesFrom({ ".": URL_SHORTENER_PACKAGE }))).toEqual([]);
    expect(ciCheckDrift([{ path: "README.md", text: readme("bun run test") }], tests)).toEqual([]);
    const compound = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { test: "tsc && vitest run" } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow("npm test") }], tests, compound)).toEqual([]);
  });

  test("a resolved gate script no check runs is still a drift with no check", () => {
    const drift = ciCheckDrift([{ path: CI, text: workflow("bun run typecheck") }], [check("tests", "bun test")], tablesFrom({ ".": URL_SHORTENER_PACKAGE }));
    expect(drift).toEqual([{ file: CI, command: "bun run typecheck", tool: "tsc", script: "tsc --noEmit", check: null, missing: [] }]);
  });

  test.each([
    ["npm", "npm run test", "npm test"],
    ["npm run-script", "npm run-script test", "npm test"],
    ["npm test", "npm test", "npm run test"],
    ["pnpm", "pnpm run test", "pnpm test"],
    ["yarn", "yarn run test", "yarn test"],
    ["bun", "bun run test", "npm test"],
  ])("package.json scripts through %s: %s against a check of the underlying runner, and %s", (_name, command, other) => {
    const scripts = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { test: "vitest run --coverage" } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow(command, other) }], [check("tests", "npx vitest run --coverage")], scripts)).toEqual([]);
    // The script without the check's coverage is fine (the check is stricter); with more, a drift.
    const stricter = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { test: "vitest run --coverage --bail 1" } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow(command) }], [check("tests", "npx vitest run --coverage")], stricter).map((d) => d.missing)).toEqual([["--bail", "1"]]);
  });

  test("bun test is Bun's own runner, never the test script", () => {
    const scripts = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow("bun test --coverage") }], [check("tests", "bun test")], scripts).map((d) => [d.tool, d.missing])).toEqual([["bun test", ["--coverage"]]]);
  });

  test("a check's own cwd decides its package.json", () => {
    const scripts = tablesFrom({ ".": { "package.json": JSON.stringify({ scripts: { lint: "eslint ." } }) }, web: { "package.json": JSON.stringify({ scripts: { lint: "biome check ." } }) } });
    const drift = ciCheckDrift([{ path: CI, text: workflow("npx biome check . --error-on-warnings") }], [{ ...check("web-lint", "npm run lint"), cwd: "web" }], scripts);
    expect(drift.map((d) => [d.tool, d.check?.id, d.missing])).toEqual([["biome check", "web-lint", ["--error-on-warnings"]]]);
  });

  test("Composer: run-script, run, a bare script and a reference resolve; @php and callbacks do not", () => {
    const composer = { "composer.json": JSON.stringify({ scripts: { test: "phpunit", "test:all": ["@test"], analyse: "@php vendor/bin/phpstan analyse", setup: "App\\Setup::run", lint: ["phpcs", "phpstan"] } }) };
    const scripts = tablesFrom({ ".": composer });
    const checks = [check("tests", "vendor/bin/phpunit")];
    expect(ciCheckDrift([{ path: CI, text: workflow("composer run-script test", "composer run test", "composer test", "composer test:all") }], checks, scripts)).toEqual([]);
    expect(ciCheckDrift([{ path: CI, text: workflow("composer analyse", "composer run-script lint") }], checks, scripts)).toEqual([]);
    const stricter = tablesFrom({ ".": { "composer.json": JSON.stringify({ scripts: { test: "phpunit --stop-on-failure" } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow("composer run-script test") }], checks, stricter).map((d) => [d.tool, d.missing])).toEqual([["phpunit", ["--stop-on-failure"]]]);
  });

  test("Deno: deno task through deno.json tasks, as a string or { command }", () => {
    const scripts = tablesFrom({ ".": { "deno.json": JSON.stringify({ tasks: { lint: "deno lint", check: { command: "deno check main.ts", description: "types" } } }) } });
    expect(ciCheckDrift([{ path: CI, text: workflow("deno task lint", "deno task check") }], [check("lint", "deno lint"), check("types", "deno check main.ts")], scripts)).toEqual([]);
    expect(ciCheckDrift([{ path: CI, text: workflow("deno task lint") }], [check("lint", "deno lint --rules-exclude=no-explicit-any")], scripts)).toEqual([]);
    expect(toolCommand("deno", ["task", "lint"])).toEqual({ tool: "deno task lint", words: [] });
  });

  test.each(["make lint", "just lint", "rake rubocop", "task lint"])("an opaque runner (%s) with no check running it records nothing", (command) => {
    expect(ciCheckDrift([{ path: CI, text: workflow(command) }], [check("lint", "biome check .")], tablesFrom({ ".": URL_SHORTENER_PACKAGE }))).toEqual([]);
  });

  test("an opaque runner is compared with the same command; an opaque check hides only the no-check verdict", () => {
    expect(ciCheckDrift([{ path: CI, text: workflow("make test ARGS=-race") }], [check("tests", "make test")]).map((d) => d.missing)).toEqual([["ARGS=-race"]]);
    // A `make check` check may run clippy: no verdict that no check runs it.
    expect(ciCheckDrift([{ path: CI, text: workflow("cargo clippy -- -D warnings") }], [check("all", "make check")])).toEqual([]);
    // The R73 true positive stays: a check runs clippy without --all-targets.
    expect(ciCheckDrift([{ path: CI, text: workflow("cargo clippy --all-targets") }], [check("all", "make check"), check("clippy", "cargo clippy")]).map((d) => d.missing)).toEqual([["--all-targets"]]);
  });

  test("a README drift says the documented command, not the delivered CI, can fail", () => {
    const [drift] = ciCheckDrift([{ path: "README.md", text: readme("cargo clippy --all-targets") }], [check("clippy", "cargo clippy")]);
    expect(ciCheckDriftSummary(drift!)).toEndWith("the documented command can fail on what no configured check ran");
  });

  test("scriptTables reads package.json and composer.json scripts and deno.json tasks; a broken manifest gives none", () => {
    const files: Record<string, string> = { "package.json": '{"scripts":{"test":"bun test"}}', "composer.json": "{ not json", "deno.jsonc": '{"tasks":{"fmt":"deno fmt --check"}}' };
    expect(scriptTables((name) => files[name] ?? null)).toEqual({ package: { test: "bun test" }, deno: { fmt: "deno fmt --check" } });
    expect(scriptTables(() => '{"name":"x"}')).toEqual({ package: {}, composer: {}, deno: {} });
  });
});

describe("scenario: a run delivers a README whose `bun run test` runs the `bun test` check (#2416)", () => {
  test("R76 url-shortener: no ci_check_drift for a script the check runs, one for a script no check runs", async () => {
    const bun = cargoShim("bun");
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [...fixturePolicy.checks, { id: "tests", executable: bun, args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
    };
    const files = { ...URL_SHORTENER_PACKAGE, "README.md": readme("bun install", "bun run test", "bun run typecheck") };
    const fixture = workflowFixture({ policy, executor: (root) => new DeliveryExecutor(root, files) });
    cleanups.push(fixture.dispose);
    const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value and its README", ownerLabel: "test", policy });
    let current = await fixture.service.drive(run.runId, new AbortController().signal);
    for (let i = 0; i < 5 && current.status === "waiting"; i++) {
      if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
      await fixture.approve(run.runId);
      current = await fixture.service.drive(run.runId, new AbortController().signal);
    }
    const wouldStops = fixture.service.store
      .eventsOfType(run.runId, "decision.would_stop")
      .map((e) => e.payload as { reason: string; key: string; inputs: Record<string, unknown> })
      .filter((p) => p.reason === "ci_check_drift");
    // `bun run test` is the `bun test` check; `bun run typecheck` (tsc) is a gate no check runs.
    expect(wouldStops.map((w) => [w.key, w.inputs.tool, w.inputs.script])).toEqual([["README.md#bun run typecheck", "tsc", "tsc --noEmit"]]);
    expect((await fixture.service.get(run.runId)).status).toBe("completed");
  });
});

// Bench round 83, pnmforge docs (#2567): the README documented `clang-format -i src/*.cpp ...` (the
// check's fixer) and `clang-format --dry-run --Werror src/*.cpp src/*.hpp tests/*.cpp tests/*.hpp`
// (the check, with globs where the check lists 14 files): 2 of 2 `ci_check_drift` records false.
describe("ciCheckDrift: a check's fixer form and globs over its files are no drift (#2567)", () => {
  const readme = (...lines: string[]) => `# Project\n\n\`\`\`sh\n${lines.join("\n")}\n\`\`\`\n`;
  const FILES = ["src/codec.cpp", "src/codec.hpp", "src/main.cpp", "tests/harness.hpp", "tests/scaffold_test.cpp"];
  const clangFormat = { ...check("clang-format", `clang-format --dry-run --Werror ${FILES.join(" ")}`), fix: { executable: "clang-format", args: ["-i"] } };

  test("C++ pnmforge: the fixer with globs and the check with globs over its files record nothing", () => {
    const drift = ciCheckDrift(
      [{ path: "README.md", text: readme("clang-format -i src/*.cpp src/*.hpp tests/*.cpp tests/*.hpp", "clang-format --dry-run --Werror src/*.cpp src/*.hpp tests/*.cpp tests/*.hpp") }],
      [clangFormat],
    );
    expect(drift).toEqual([]);
  });

  test("a glob that misses a file the check lists still records", () => {
    const drift = ciCheckDrift([{ path: "README.md", text: readme("clang-format --dry-run --Werror src/*.cpp src/*.hpp") }], [clangFormat]);
    expect(drift.map((d) => [d.check?.id, d.missing])).toEqual([["clang-format", ["src/*.cpp", "src/*.hpp"]]]);
  });

  test("a recursive glob and a folder cover the files below them", () => {
    expect(ciCheckDrift([{ path: "README.md", text: readme("clang-format --dry-run --Werror src/**/*.?pp tests/") }], [clangFormat])).toEqual([]);
  });

  const PAIRS: [string, ReturnType<typeof check> & { fix: { executable: string; args: string[] } }, string][] = [
    ["Go", { ...check("gofmt", "gofmt -l ."), fix: { executable: "go", args: ["fmt", "./..."] } }, "go fmt ./..."],
    ["Python", { ...check("ruff-format", "ruff format --check"), fix: { executable: "ruff", args: ["format"] } }, "ruff format"],
    ["JavaScript", { ...check("prettier", "prettier --check ."), fix: { executable: "prettier", args: ["--write"] } }, "npx prettier --write ."],
    ["TypeScript", { ...check("biome", "biome check"), fix: { executable: "biome", args: ["check", "--write"] } }, "bunx biome check --write ."],
    ["Shell", { ...check("shfmt", "shfmt -d scripts/build.sh scripts/test.sh"), fix: { executable: "shfmt", args: ["-w"] } }, "shfmt -w scripts/*.sh"],
    ["Rust", { ...check("fmt", "cargo fmt --all -- --check"), fix: { executable: "cargo", args: ["fmt"] } }, "cargo fmt"],
    ["C#", { ...check("format", "dotnet format --verify-no-changes"), fix: { executable: "dotnet", args: ["format"] } }, "dotnet format"],
  ];
  for (const [language, gate, write] of PAIRS)
    test(`${language}: the README's write form "${write}" is the check's fixer, not a drift`, () => {
      expect(ciCheckDrift([{ path: "README.md", text: readme(write) }], [gate])).toEqual([]);
    });

  test("a write form with a flag neither the check nor its fixer has still records", () => {
    const ruff = { ...check("ruff-format", "ruff format --check"), fix: { executable: "ruff", args: ["format"] } };
    const drift = ciCheckDrift([{ path: "README.md", text: readme("ruff format --line-length 80") }], [ruff]);
    expect(drift.map((d) => d.missing)).toEqual([["--line-length", "80"]]);
  });
});

// Bench round 84, wrapsmith docs (#2593): the README documented `Invoke-Pester`, `Invoke-ScriptAnalyzer
// -Path . -Recurse`, the analyzer's fixer `Invoke-ScriptAnalyzer -Fix -Path FILE` and the program
// itself, `pwsh bin/wrapsmith.ps1 fill -w 60 < in.txt`; the checks run the cmdlets inside `pwsh
// -Command`. 4 of 4 `ci_check_drift` records false.
describe("ciCheckDrift: an interpreter's inline code and the project's own program (#2593)", () => {
  const readme = (...lines: string[]) => `# Project\n\n\`\`\`powershell\n${lines.join("\n")}\n\`\`\`\n`;
  const PWSH = ["-NoProfile", "-NonInteractive", "-Command"];
  const pester = { id: "pester", executable: "pwsh", args: [...PWSH, PESTER_RUN] };
  const analyzer = {
    id: "psscriptanalyzer",
    executable: "pwsh",
    args: [...PWSH, PSSA_LINT],
    fix: { executable: "pwsh", args: [...PWSH, "Invoke-ScriptAnalyzer", "-Fix", "-Path"] },
  };
  const settingsAnalyzer = {
    ...analyzer,
    args: [...PWSH, PSSA_LINT.replace("Invoke-ScriptAnalyzer ", "Invoke-ScriptAnalyzer -Settings ./PSScriptAnalyzerSettings.psd1 ")],
    fix: { executable: "pwsh", args: [...PWSH, "Invoke-ScriptAnalyzer", "-Settings", "./PSScriptAnalyzerSettings.psd1", "-Fix", "-Path"] },
  };

  test("R84 wrapsmith: the README's cmdlets, the fixer form and the program's example record nothing", () => {
    const text = readme("Invoke-Pester", "Invoke-ScriptAnalyzer -Path . -Recurse", "Invoke-ScriptAnalyzer -Fix -Path FILE", "pwsh bin/wrapsmith.ps1 fill -w 60 < in.txt");
    expect(ciCheckDrift([{ path: "README.md", text }], [pester, analyzer])).toEqual([]);
    expect(ciCheckDrift([{ path: "README.md", text }], [pester, settingsAnalyzer])).toEqual([]);
    // PowerShell's parameters are case-insensitive.
    expect(ciCheckDrift([{ path: "README.md", text: readme("invoke-scriptanalyzer -path . -recurse -enableexit") }], [analyzer])).toEqual([]);
  });

  test("a README cmdlet with a parameter the check does not pass still records", () => {
    const drift = ciCheckDrift([{ path: "README.md", text: readme("Invoke-Pester -Output Detailed", "Invoke-ScriptAnalyzer -Path . -Recurse -Settings CodeFormatting") }], [pester, analyzer]);
    expect(drift.map((d) => [d.check?.id, d.missing])).toEqual([
      ["pester", ["-output", "Detailed"]],
      ["psscriptanalyzer", ["-settings", "CodeFormatting"]],
    ]);
  });

  test("the tool of the inline code, one row per interpreter; a pipeline's later commands are not the tool", () => {
    expect(toolCommand("pwsh", [...PWSH, PSSA_LINT])?.tool).toBe("invoke-scriptanalyzer");
    expect(toolCommand("pwsh", [...PWSH, PESTER_RUN])?.tool).toBe("invoke-pester");
    expect(toolCommand("powershell.exe", ["-NoProfile", "-c", "& ./build.ps1 -Task Test"])).toEqual({ tool: "build", words: ["-task", "Test"] });
    expect(toolCommand("Rscript", ["-e", "testthat::test_local()"])).toEqual({ tool: "testthat::test_local", words: [] });
    expect(toolCommand("bash", ["-c", "shellcheck scripts/a.sh && echo ok"])).toEqual({ tool: "shellcheck", words: ["scripts/a.sh"] });
    expect(toolCommand("sh", ["-c", "eslint --max-warnings 0"])).toEqual({ tool: "eslint", words: ["--max-warnings", "0"] });
    expect(toolCommand("cmd", ["/d", "/c", "eslint", "src"])).toEqual({ tool: "eslint", words: ["src"] });
    expect(toolCommand("python", ["-c", "import pytest; raise SystemExit(pytest.main())"])?.tool).toBe("import");
    expect(toolCommand("node", ["-e", "process.exit(0)"])?.tool).toBe("process.exit(0)");
  });

  const INTERPRETERS: [string, ReturnType<typeof check>, string, string, string[]][] = [
    ["PowerShell (Windows)", check("lint", "powershell -NoProfile -Command Invoke-ScriptAnalyzer -Path . -Recurse"), "Invoke-ScriptAnalyzer -Recurse", "Invoke-ScriptAnalyzer -Recurse -Fix", ["-fix"]],
    ["R", check("testthat", "Rscript -e testthat::test_local()"), 'Rscript -e "testthat::test_local()"', 'Rscript -e "testthat::test_local(stop_on_failure=TRUE)"', ["stop_on_failure=TRUE"]],
    ["Shell (bash -c)", { id: "shellcheck", executable: "bash", args: ["-c", "shellcheck -x scripts/a.sh"] }, "shellcheck scripts/a.sh", "shellcheck -S style scripts/a.sh", ["-S", "style"]],
    ["Shell (sh -c)", { id: "eslint", executable: "sh", args: ["-c", "eslint ."] }, "eslint .", "eslint --max-warnings 0 .", ["--max-warnings", "0"]],
    ["Windows cmd", { id: "eslint", executable: "cmd", args: ["/c", "eslint ."] }, "eslint .", "eslint --fix .", ["--fix"]],
  ];
  for (const [language, gate, same, differs, missing] of INTERPRETERS)
    test(`${language}: the check through the interpreter matches the README's inner command, and a real difference records`, () => {
      expect(ciCheckDrift([{ path: "README.md", text: readme(same) }], [gate])).toEqual([]);
      expect(ciCheckDrift([{ path: "README.md", text: readme(differs) }], [gate]).map((d) => d.missing)).toEqual([missing]);
    });

  test("the project's own program is read as its script: compared with a check that runs it, never with the interpreter's other checks", () => {
    expect(ciCheckDrift([{ path: "README.md", text: readme("pwsh bin/wrapsmith.ps1 fill -w 60") }], [pester])).toEqual([]);
    expect(ciCheckDrift([{ path: "README.md", text: readme("python scripts/report.py --all", "node bin/cli.js --help", "ruby bin/app.rb") }], [check("pytest", "python -m pytest")])).toEqual([]);
    const own = check("lint-script", "python scripts/lint.py --strict");
    expect(ciCheckDrift([{ path: CI, text: workflow("python scripts/lint.py") }], [own])).toEqual([]);
    expect(ciCheckDrift([{ path: CI, text: workflow("python scripts/lint.py --fix-all") }], [own]).map((d) => [d.check?.id, d.missing])).toEqual([["lint-script", ["--fix-all"]]]);
  });
});

// Scenario of bench round 85 shu (shardplan, Java, run ae303a00, #2620): 25 drift records, 22 false.
// The README's untagged blocks held the example timings file, the program's output and its usage
// text, and every line was read as a command whose first word was the tool.
describe("ciCheckDrift: README sample data and program output are no commands (#2620)", () => {
  const fence = (lang: string, ...lines: string[]) => `\`\`\`${lang}\n${lines.join("\n")}\n\`\`\`\n`;
  const README = [
    "# shardplan",
    fence("", "42.5 tests/test_db.py", "3.2 tests/test_cli.py", "18 tests/test_api.py", "27.250 tests/test_parser.py", "0.8 tests/test_utils.py", "9.1 tests/test_auth.py"),
    fence("", "42.500 tests/test_db.py", "shardplan: tests/test_db.py takes 42.500 s, longer than the target 30.000 s"),
    fence("", "Usage:", "  -t, --target 1500ms   target shard time", "  -n 2                  shards", "  0.5s"),
    fence("", "tests/test_db.py"),
  ].join("\n");

  test("the R85 blocks give no command, and so no drift record", () => {
    expect(fileGateCommands("README.md", README)).toEqual([]);
    expect(ciCheckDrift([{ path: "README.md", text: README }], [check("verify", "mvn -B -q verify")])).toEqual([]);
  });

  test("a console block's commands are its prompted lines; its output lines are not", () => {
    const readme = fence("console", "$ gradle test", "BUILD SUCCESSFUL in 3s", "4 actionable tasks: 4 executed", "> gradle check");
    expect(fileGateCommands("README.md", readme)).toEqual(["gradle test", "gradle check"]);
    // An untagged block that prompts its commands reads the same way.
    expect(fileGateCommands("README.md", fence("", "$ cargo test", "test result: ok. 4 passed", "PS> dotnet test"))).toEqual(["cargo test", "dotnet test"]);
  });

  test("an untagged block of commands without a prompt is still read, in every language", () => {
    const commands = ["cargo test", "go test ./...", "pytest", "mvn verify", "dotnet test", "./gradlew build", "./scripts/check.sh --strict", "bun run test"];
    expect(fileGateCommands("README.md", fence("", ...commands))).toEqual(commands);
    expect(looksLikeCommand("src/main.rs --flag")).toBe(false);
  });
});


import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciCheckDrift, ciCheckDriftSummary, fileGateCommands, toolCommand } from "../src/core/workflows/ci-check-drift.js";
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

/** A `cargo` stand-in that passes, so the clippy check runs without a Rust toolchain. */
function cargoShim(): string {
  const bin = mkdtempSync(join(tmpdir(), "baked-cargo-shim-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  const file = join(bin, process.platform === "win32" ? "cargo.cmd" : "cargo");
  writeFileSync(file, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(file, 0o755);
  return file;
}

/** The fixture flow, whose one task also writes the delivered CI workflow. */
class DeliveryExecutor extends FixtureExecutor {
  constructor(
    private workspace: string,
    private ci: string,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      graph.tasks[0]?.writes.push({ path: CI, action: "create" });
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(this.workspace, ".github", "workflows"), { recursive: true });
      writeFileSync(join(this.workspace, CI), this.ci);
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

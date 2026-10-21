import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { buildCheckEnv, exitStatus } from "../src/core/verification/check-runner.js";
import { testsRan } from "../src/core/verification/output-counts.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { testGateFlags, withGateFlags } from "../src/core/workflows/test-gates.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 56, tonemath-update c87b91ee (#1832). The brief added a Cargo feature
// `unicode` and `tests/unicode_tests.rs` behind `#![cfg(feature = "unicode")]`. T004's
// tests-written check ran `cargo test --test unicode_tests` without the feature: "running 0 tests",
// "test result: ok. 0 passed", exit 0, passed twice; no check of the run had the feature, and the
// five tests first ran in the final review's own repro calls.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
// The test preload points HOME at an empty profile, where rustup finds no default toolchain.
process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
process.env.CARGO_HOME ??= join(homedir(), ".cargo");

const check = (id: string, executable: string, args: string[]): Check =>
  ({ id, executable, args, cwd: ".", timeoutMs: 120_000, required: true, scope: "feature", envNames: [], writes: [] }) as Check;
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "baked-gated-tests-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const works = (command: string[]) =>
  Bun.which(command[0] ?? "") !== null &&
  Bun.spawnSync(command, { env: buildCheckEnv(check("probe", command[0] ?? "", [])), cwd: tmpdir(), stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const run = (root: string, c: Check) => {
  const out = Bun.spawnSync([c.executable, ...c.args], { cwd: root, env: buildCheckEnv(c), stdout: "pipe", stderr: "pipe" });
  const output = out.stdout.toString() + out.stderr.toString();
  return { output, status: exitStatus(c, out.exitCode ?? 1, output) };
};

const UNICODE_TESTS = `#![cfg(feature = "unicode")]

#[test]
fn sharp_sign() {
    assert_eq!(tonemath::accidental("sharp"), "\\u{266F}");
}
`;
const TONEMATH = {
  "Cargo.toml": '[package]\nname = "tonemath"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nunicode = []\n',
  ".gitignore": "/target\nCargo.lock\n",
  "src/lib.rs": 'pub fn accidental(name: &str) -> &\'static str {\n    if cfg!(feature = "unicode") && name == "sharp" { "\\u{266F}" } else { "#" }\n}\n',
  "tests/unicode_tests.rs": UNICODE_TESTS,
};

describe("scenario: tonemath-update unicode_tests.rs behind a Cargo feature (#1832)", () => {
  test("the written check runs the file with its feature", () => {
    const root = project(TONEMATH);
    const written = writtenTestsCheck(root, [check("tests", "cargo", ["test"])], [{ path: "tests/unicode_tests.rs", action: "create" }]);
    expect(written).toMatchObject({ id: "tests-written", args: ["test", "--features", "unicode", "--test", "unicode_tests"], requireTests: true });
  });

  test.skipIf(!works(["cargo", "--version"]))("with cargo: the gated file runs its test, and without the feature the check fails", () => {
    const root = project(TONEMATH);
    const written = writtenTestsCheck(root, [check("tests", "cargo", ["test", "--offline"])], [{ path: "tests/unicode_tests.rs", action: "create" }]) as Check;
    const gated = run(root, written);
    expect(gated.status, gated.output).toBe("passed");
    expect(testsRan(gated.output)).toEqual({ tool: "cargo", count: 1 });
    // The check R56 ran: "running 0 tests", exit 0, now failed.
    const r56 = run(root, { ...written, args: ["test", "--offline", "--test", "unicode_tests"] });
    expect(r56.output).toContain("running 0 tests");
    expect(r56.status).toBe("failed");
  }, 300_000);

  test("the R56 output fails a check that must run tests, and passes one that need not", () => {
    const output = "     Running tests/unicode_tests.rs (target/debug/deps/unicode_tests-1f0c)\n\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n";
    expect(exitStatus({ ...check("tests-written", "cargo", ["test"]), requireTests: true }, 0, output)).toBe("failed");
    expect(exitStatus(check("tests", "cargo", ["test"]), 0, output)).toBe("passed");
  });
});

describe("a Go test file behind a build tag (#1832)", () => {
  const files = {
    "go.mod": "module example.com/tones\n\ngo 1.21\n",
    "tones/tones.go": "package tones\n\nfunc Sharp() string { return \"#\" }\n",
    "tones/unicode_test.go": '//go:build unicode\n\npackage tones\n\nimport "testing"\n\nfunc TestSharp(t *testing.T) {\n\tif Sharp() != "#" {\n\t\tt.Fatal(Sharp())\n\t}\n}\n',
  };
  test("the written check runs the package with the tag", () => {
    const written = writtenTestsCheck(project(files), [check("tests", "go", ["test", "-v", "./..."])], [{ path: "tones/unicode_test.go", action: "create" }]);
    expect(written?.args).toEqual(["test", "-tags", "unicode", "-v", "./tones"]);
  });

  test.skipIf(!works(["go", "version"]))("with go: the tagged test runs, and without the tag the check fails", () => {
    const root = project(files);
    const written = writtenTestsCheck(root, [check("tests", "go", ["test", "-v", "./..."])], [{ path: "tones/unicode_test.go", action: "create" }]) as Check;
    const gated = run(root, written);
    expect(gated.status, gated.output).toBe("passed");
    const untagged = run(root, { ...written, args: ["test", "-v", "./tones"] });
    expect(untagged.output).toMatch(/no test files|no tests to run/);
    expect(untagged.status).toBe("failed");
  }, 300_000);
});

describe("gates a test file declares (#1832)", () => {
  test("Rust: a file-level feature, all() of features; not() and any() need none", () => {
    const flags = (text: string) => testGateFlags([{ path: "tests/a.rs", text }]).get("cargo");
    expect(flags(UNICODE_TESTS)).toEqual(["--features", "unicode"]);
    expect(flags('#![cfg(all(feature = "a", feature = "b-c"))]\n')).toEqual(["--features", "a,b-c"]);
    expect(flags('#![cfg(not(feature = "a"))]\n')).toBeUndefined();
    expect(flags('#![cfg(any(feature = "a", feature = "b"))]\n')).toBeUndefined();
    expect(flags('#[cfg(feature = "a")]\nmod inner {}\n')).toBeUndefined();
  });

  test("Go: tags that all must hold; platform tags and other operators need no flag", () => {
    const flags = (text: string) => testGateFlags([{ path: "a/a_test.go", text }]).get("go");
    expect(flags("//go:build integration && unicode\n\npackage a\n")).toEqual(["-tags", "integration,unicode"]);
    expect(flags("//go:build linux\n\npackage a\n")).toBeUndefined();
    expect(flags("//go:build a || b\n\npackage a\n")).toBeUndefined();
    expect(flags("package a\n\n//go:build late\n")).toBeUndefined();
  });

  test("a gate flag the command already gives is extended, since Go keeps only the last -tags", () => {
    expect(withGateFlags(["test", "-tags", "x", "./..."], ["-tags", "unicode"], 1)).toEqual(["test", "-tags", "x,unicode", "./..."]);
    expect(withGateFlags(["test", "-tags=x", "./..."], ["-tags", "unicode"], 1)).toEqual(["test", "-tags=x,unicode", "./..."]);
    expect(withGateFlags(["test", "--test", "a"], ["--features", "unicode"], 1)).toEqual(["test", "--features", "unicode", "--test", "a"]);
    expect(withGateFlags(["test"], undefined, 1)).toEqual(["test"]);
  });
});

// The same rule end to end, with bun: T002 writes a test file whose every test is skipped, its
// tests-written check fails on "0 pass", and the correction makes the test run.
const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Tones", problem: "No sharp sign", outcome: "A sharp sign", inScope: ["Sharp"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "sharp() returns #", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the module", when: "sharp is called", then: "it returns #", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne module.\n## Decisions\nDEC-001: FR-001 returns #.\n## Components\nsrc/tones.ts\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, path: string, dependsOn: string[]): Task => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const TASKS = [task("T001", "src/tones.ts", []), task("T002", "tests/tones.test.ts", ["T001"])];
const SKIPPED = `import { expect, test } from "bun:test";\nimport { sharp } from "../src/tones.ts";\ntest.skipIf(!process.env.UNICODE)("sharp", () => { expect(sharp()).toBe("#"); });\n`;
const RUNS = `import { expect, test } from "bun:test";\nimport { sharp } from "../src/tones.ts";\ntest("sharp", () => { expect(sharp()).toBe("#"); });\n`;
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 20_000, required: true, scope: "feature", envNames: [], writes: [] }] };

class ScriptedExecutor implements AgentExecutor {
  attempts: { id: string; origin: string; prompt: string }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/tones.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: TASKS } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const current = request.task;
        this.attempts.push({ id: current?.id ?? "", origin: current?.origin ?? "", prompt: request.prompt });
        const writes = current?.writes.map((w) => w.path) ?? [];
        if (writes.includes("src/tones.ts")) {
          mkdirSync(join(this.root, "src"), { recursive: true });
          writeFileSync(join(this.root, "src/tones.ts"), 'export const sharp = (): string => "#";\n');
        }
        if (writes.includes("tests/tones.test.ts")) {
          mkdirSync(join(this.root, "tests"), { recursive: true });
          writeFileSync(join(this.root, "tests/tones.test.ts"), current?.origin === "planned" ? SKIPPED : RUNS);
        }
        output = { schemaVersion: 1, taskId: current?.id, outcome: "implemented", summary: "Wrote files", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "The test runs" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: a written test file whose every test is skipped (#1832)", () => {
  test("its tests-written check fails on 0 tests run, and the correction makes the test run", async () => {
    const root = project({});
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Add sharp() and test it", ownerLabel: "test", policy });
    await service.drive(started.runId, new AbortController().signal);
    const waiting = await service.get(started.runId);
    const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(started.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(started.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    const written = service.store.artifacts(started.runId).filter((a) => a.logical_path.startsWith("checks/tests-written/"));
    const results = written.map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as { exitCode: number; output: string });
    // The skipped file exits 0, and the host's note says it ran no test: the task does not pass.
    expect(results[0]).toMatchObject({ exitCode: 0, definition: { requireTests: true } });
    expect(results[0]?.output).toContain("ran no test");
    expect(results.at(-1)?.output).toContain(" 1 pass");
    expect(executor.attempts.filter((a) => a.id !== "T001" && a.origin !== "planned")).toHaveLength(1);
  }, 120_000);
});

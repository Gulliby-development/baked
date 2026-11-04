import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentFailure } from "../src/core/verification/environment-faults.js";
import { runsFormatter } from "../src/core/workflows/format-written.js";
import { detectGates } from "../src/core/workflows/gates.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { SWIFT_TEST_SILENT_EXIT_4 } from "./fixtures/swiftpm-crash-outputs.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 76 (#2418). hintsieve's `swift-test` exited 4 at the checks stage with
// SwiftPM progress lines only (a toolchain crash under parallel builds), and the stage opened
// corrective T004: 440,339 tokens, 13 minutes, an empty diff. The next run of the same tree passed.
// Here the required check fails once that way after the code is correct, then passes.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A check that crashes once, silently, on the first run that sees correct code. */
function crashingOnce(): { policy: RunPolicy; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "baked-silent-check-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "crashed");
  const progress = join(dir, "progress.txt");
  const count = join(dir, "runs");
  writeFileSync(progress, SWIFT_TEST_SILENT_EXIT_4);
  const script = `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(count)}, "x");
const value = fs.existsSync("value.txt") ? fs.readFileSync("value.txt", "utf8") : "";
if (value !== "ready") { console.log("AssertionError: value.txt is not ready"); process.exit(1); }
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, "");
  process.stdout.write(fs.readFileSync(${JSON.stringify(progress)}, "utf8"));
  process.exit(4);
}`;
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [{ ...fixturePolicy.checks[0], id: "swift-test", args: ["-e", script] } as RunPolicy["checks"][number]],
  };
  return { policy, runs: () => (existsSync(count) ? Bun.file(count).size : 0) };
}

async function scenario(policy: RunPolicy, checkId = "swift-test") {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { executor, service } = fixture;
  const corrections: string[] = [];
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") corrections.push(request.task?.id ?? "");
    return original(request);
  };
  const { runId } = await fixture.start();
  await service.drive(runId, new AbortController().signal);
  const waiting = await service.get(runId);
  const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const run = await service.drive(runId, new AbortController().signal);
  const store = service.store;
  return {
    run,
    corrections,
    checks: store.checks(runId).filter((c) => c.check_id === checkId),
    wouldRerun: store.eventsOfType(runId, "decision.would_rerun").flatMap((e) => (e.type === "decision.would_rerun" ? [e.payload] : [])),
    reruns: store.artifacts(runId).filter((a) => a.logical_path.startsWith(`checks/${checkId}/rerun-`)).map((a) => JSON.parse(store.readArtifact(runId, a.id)) as Record<string, unknown>),
  };
}

describe("scenario: hintsieve R76, a required check fails with no failure line (#2418)", () => {
  test("enforced, the host runs it once more, it passes and no corrective opens", async () => {
    const { policy, runs } = crashingOnce();
    const result = await scenario({ ...policy, stopModes: { silent_check_failure: "enforce" } });
    expect(result.corrections).toEqual([]);
    expect(result.run.status).toBe("completed");
    expect(result.checks.map((c) => c.status)).toContain("failed");
    expect(result.reruns).toHaveLength(1);
    expect(result.reruns[0]).toMatchObject({ checkId: "swift-test", stage: "checks", first: { status: "inconclusive", reason: "silent_failure" }, rerun: { status: "passed" } });
    expect(result.wouldRerun).toEqual([]);
    expect(runs()).toBeGreaterThan(1);
  });

  test("in shadow (the default) it records decision.would_rerun and corrects as before", async () => {
    const { policy } = crashingOnce();
    const result = await scenario(policy);
    expect(result.wouldRerun).toHaveLength(1);
    expect(result.wouldRerun[0]).toMatchObject({ reason: "silent_check_failure", mode: "shadow", inputs: { checkId: "swift-test", stage: "checks" } });
    expect(String(result.wouldRerun[0]?.inputs.outputTail)).toContain("HintSieveCoreTests-test-runner");
    expect(result.corrections.length).toBeGreaterThan(0);
    expect(result.reruns).toEqual([]);
  });
});

// Bench round 90 (#2829): windowfit's `fmt` (`cargo fmt --check`) exited 1 with a rustfmt diff, a
// real format difference its fixer repaired, and the checks stage recorded `decision.would_rerun`
// because a diff names no failure word. The Rust output is the captured shape; the others are the
// shapes the tools document. Each check fails once that way after the code is correct.
const FORMATTER_FAILURES = [
  {
    language: "Rust",
    id: "cargo-fmt",
    output:
      "Diff in \\\\?\\C:\\bench\\windowfit\\tests\\estimate.rs:14:\n     let window = fit(&samples, 4);\n-    assert_eq!(window.len(),4);\n+    assert_eq!(window.len(), 4);\n }\n",
  },
  { language: "Lua", id: "stylua", output: "Diff in ./src/init.lua:\n1    |-local x=1\n    1 |+local x = 1\n" },
  { language: "Dart", id: "dart-format", output: "Changed lib/a.dart\nFormatted 3 files (1 changed) in 0.12 seconds.\n" },
  { language: "Go", id: "gofmt", output: "main.go\n" },
] as const;

/** A formatter check with a fixer that prints `output` and exits 1 once on correct code. */
function formatterFailingOnce(id: string, output: string): { policy: RunPolicy; runs: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "baked-silent-format-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, "failed");
  const diff = join(dir, "diff.txt");
  const count = join(dir, "runs");
  writeFileSync(diff, output);
  const script = `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(count)}, "x");
const value = fs.existsSync("value.txt") ? fs.readFileSync("value.txt", "utf8") : "";
if (value !== "ready") { console.log("AssertionError: value.txt is not ready"); process.exit(1); }
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, "");
  process.stdout.write(fs.readFileSync(${JSON.stringify(diff)}, "utf8"));
  process.exit(1);
}`;
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [
      {
        ...fixturePolicy.checks[0],
        id,
        args: ["-e", script],
        fix: { executable: "bun", args: ["-e", "0"] },
      } as RunPolicy["checks"][number],
    ],
  };
  return { policy, runs: () => (existsSync(count) ? Bun.file(count).size : 0) };
}

describe("scenario: windowfit R90, a formatter check fails with a diff or a file list (#2829)", () => {
  for (const { language, id, output } of FORMATTER_FAILURES) {
    test(`${language} (${id}): the output reads as silent, and the check's fixer keeps it from silent_check_failure`, async () => {
      // The output alone names no failure line: only the kind of check tells it from a crash.
      expect(silentFailure(output)).toBe(true);
      const shadow = await scenario(formatterFailingOnce(id, output).policy, id);
      expect(shadow.checks.map((c) => c.status)).toContain("failed");
      expect(shadow.wouldRerun).toEqual([]);
      const enforced = await scenario({ ...formatterFailingOnce(id, output).policy, stopModes: { silent_check_failure: "enforce" } }, id);
      expect(enforced.checks.map((c) => c.status)).toContain("failed");
      expect(enforced.reruns).toEqual([]);
      expect(enforced.wouldRerun).toEqual([]);
    });
  }

  test("each language's detected formatter gate is a formatter without its fixer too", () => {
    const files: Record<string, [string, string]> = {
      "cargo-fmt": ["Cargo.toml", '[package]\nname = "windowfit"\nversion = "0.1.0"\nedition = "2021"\n'],
      stylua: ["stylua.toml", "indent_type = \"Spaces\"\n"],
      "dart-format": ["pubspec.yaml", "name: a\n"],
      gofmt: ["go.mod", "module a\n\ngo 1.22\n"],
    };
    for (const { id } of FORMATTER_FAILURES) {
      const dir = mkdtempSync(join(tmpdir(), "baked-format-gate-"));
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
      const [name, body] = files[id] ?? ["", ""];
      writeFileSync(join(dir, name), body);
      const gate = detectGates(dir).find((s) => s.check.id === id)?.check;
      expect(gate?.fix).toBeDefined();
      const { fix: _, ...bare } = gate ?? fixturePolicy.checks[0];
      expect(runsFormatter(bare)).toBe(true);
    }
    expect(runsFormatter({ executable: "gofmt", args: ["-d", "."] })).toBe(true);
    expect(runsFormatter({ executable: "swift", args: ["test"] })).toBe(false);
    expect(runsFormatter({ executable: "cargo", args: ["test"] })).toBe(false);
    expect(runsFormatter({ executable: "go", args: ["vet", "./..."] })).toBe(false);
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { UNPREPARED_FINDING } from "../src/core/workflows/worktree.js";

// Follow-up of bench round 75 (#2361, #2372). A Dart worktree resolves its packages with
// `dart pub get --offline`; when the machine's pub cache lacks one, the command fails and every
// `dart test` of the worktree fails on the unresolved import. Those failures read like the code's
// and opened correctives for correct code. Here a stand-in dart fails `pub get` the way pub does
// and fails `test` while `.dart_tool/package_config.json` is missing.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-dart-unprepared-"));
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(bin, { recursive: true, force: true });
});
const PUB_OFFLINE = "Because ladle depends on http any which doesn't exist (could not find package http in cache), version solving failed.";
if (!IS_WIN) {
  writeFileSync(
    join(bin, "dart"),
    `#!/bin/sh
if [ "$1" = "pub" ]; then echo "${PUB_OFFLINE}" >&2; exit 69; fi
if [ "$1" = "test" ] && [ ! -f .dart_tool/package_config.json ]; then echo "Error: Couldn't resolve the package 'http' in 'package:http/http.dart'." >&2; exit 1; fi
exit 0
`,
  );
  chmodSync(join(bin, "dart"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Ladle", problem: "No sum", outcome: "A sum", inScope: ["Sum"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The library sums", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "two numbers", when: "summed", then: "it returns their sum", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 sums.\n## Components\nsum.dart\n## Data\nNone\n## Verification\nChecks\n## Risks\nNone for fixture";
const tasks: Task[] = [{ id: "T001", title: "Write sum.dart", description: "Write the sum", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "lib/sum.dart", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }];
const check: Check = { id: "dart-test", executable: "dart", args: ["test"], cwd: ".", timeoutMs: 10_000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };

class SumExecutor implements AgentExecutor {
  corrections: string[] = [];
  constructor(private workspace: string) {}
  async execute(request: ExecutionRequest) {
    const root = request.root ?? this.workspace;
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["lib/sum.dart"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        if (request.task?.origin !== "planned") this.corrections.push(request.task?.id ?? "");
        mkdirSync(join(root, "lib"), { recursive: true });
        writeFileSync(join(root, "lib/sum.dart"), "int sum(int a, int b) => a + b;\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the sum", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Sums" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "baked-dart-unprepared-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n.dart_tool/\n");
  writeFileSync(join(root, "pubspec.yaml"), "name: ladle\nenvironment:\n  sdk: ^3.5.0\ndependencies:\n  http: any\n");
  // The working copy resolved its packages online once; the worktree has no package config.
  mkdirSync(join(root, ".dart_tool"));
  writeFileSync(join(root, ".dart_tool", "package_config.json"), "{}\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  return root;
}
const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };

describe.skipIf(IS_WIN)("scenario: Dart worktree whose packages are not in the pub cache (#2372)", () => {
  test("the dart checks are inconclusive, the run records one environment finding, and no correction opens", async () => {
    const root = workspace();
    const executor = new SumExecutor(root);
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const { runId } = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write the sum", ownerLabel: "test", policy, executionMode: "worktree" });
    await service.drive(runId, new AbortController().signal);
    const waiting = await service.get(runId);
    const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    await service.drive(runId, new AbortController().signal);

    const runs = service.store.checks(runId).filter((c) => c.check_id === "dart-test");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((c) => c.status === "inconclusive" && c.reason === "environment_broken")).toBe(true);
    expect(executor.corrections).toEqual([]);
    expect(service.store.findings(runId).filter((f) => f.body_json.includes("dart-test"))).toEqual([]);

    const recorded = service.store.latestArtifact(runId, UNPREPARED_FINDING);
    if (!recorded) throw new Error("No environment finding");
    const finding = JSON.parse(service.store.readArtifact(runId, recorded.id)) as { problems: { command: string[]; problem: string; output: string | null }[] };
    expect(finding.problems).toHaveLength(1);
    expect(finding.problems[0]?.command).toEqual(["dart", "pub", "get", "--offline"]);
    expect(finding.problems[0]?.problem).toContain("Run `dart pub get` in the project");
    expect(finding.problems[0]?.output).toContain("could not find package http in cache");
    // Recorded once for the run, however many worktrees or copies it makes.
    expect(service.store.artifacts(runId).filter((a) => a.logical_path === UNPREPARED_FINDING)).toHaveLength(1);
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { runDoctor } from "../src/core/workflows/doctor.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 72 (#2273). jvmsig on Windows 11 with a short-path TEMP: every
// `gradle check` failed with the JDK's "Unable to establish loopback connection" before any test
// ran, and `workflow doctor` said "Ready to run". A failed required check of this kind would open
// correctives for code that is correct. Here a stand-in gradle prints that failure for any task.

const IS_WIN = process.platform === "win32";
const bin = mkdtempSync(join(tmpdir(), "baked-fake-gradle-"));
const savedPath = process.env.PATH;
afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(bin, { recursive: true, force: true });
});
// What the R72 machine printed, shortened.
const LOOPBACK = `FAILURE: Build failed with an exception.

* What went wrong:
java.io.IOException: Unable to establish loopback connection
\tat java.base/sun.nio.ch.PipeImpl.<init>(PipeImpl.java:93)
\tat java.base/sun.nio.ch.WEPollSelectorImpl.<init>(WEPollSelectorImpl.java:78)
Caused by: java.net.SocketException: Invalid argument: connect
`;
if (!IS_WIN) {
  writeFileSync(join(bin, "gradle"), `#!/bin/sh\ncat <<'EOF' >&2\n${LOOPBACK}EOF\nexit 1\n`);
  chmodSync(join(bin, "gradle"), 0o755);
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Signatures", problem: "No app", outcome: "An app", inScope: ["App"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The app prints its name", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the app", when: "it runs", then: "it prints its name", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne file.\n## Decisions\nDEC-001: FR-001 prints.\n## Components\nApp.kt\n## Data\nNone\n## Verification\nChecks\n## Risks\nNone for fixture";
const tasks: Task[] = [{ id: "T001", title: "Write App.kt", description: "Write the app", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/main/kotlin/App.kt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }];
const check: Check = { id: "gradle-check", executable: "gradle", args: ["--console=plain", "-q", "check"], cwd: ".", timeoutMs: 10_000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };

class AppExecutor implements AgentExecutor {
  corrections: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/main/kotlin/App.kt"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        if (request.task?.origin !== "planned") this.corrections.push(request.task?.id ?? "");
        mkdirSync(join(this.root, "src/main/kotlin"), { recursive: true });
        writeFileSync(join(this.root, "src/main/kotlin/App.kt"), 'fun main() = println("app")\n');
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote the app", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "Prints" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "baked-gradle-loopback-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "settings.gradle.kts"), 'rootProject.name = "app"\n');
  writeFileSync(join(root, "build.gradle.kts"), 'plugins { kotlin("jvm") version "2.0.21" }\n');
  return root;
}
const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };

describe.skipIf(IS_WIN)("scenario: jvmsig R72, gradle fails on the machine's loopback pipe (#2273)", () => {
  test("the failed check is inconclusive with the machine's fix and opens no correction", async () => {
    const root = workspace();
    const executor = new AppExecutor(root);
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const { runId } = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Write the app", ownerLabel: "test", policy });
    await service.drive(runId, new AbortController().signal);
    const waiting = await service.get(runId);
    const approval = service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const current = await service.drive(runId, new AbortController().signal);
    const runs = service.store.checks(runId).filter((c) => c.check_id === "gradle-check");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((c) => c.status === "inconclusive" && c.reason === "environment_broken")).toBe(true);
    expect(executor.corrections).toEqual([]);
    expect(service.store.findings(runId).filter((f) => f.body_json.includes("gradle-check"))).toEqual([]);
    expect(current.status).not.toBe("completed");
  });

  test("the doctor runs gradle -q help and names the fix", async () => {
    const root = workspace();
    const service = new NativeWorkflowService(root, config, new AppExecutor(root));
    cleanups.push(() => service.close());
    const report = await runDoctor(root, config, {}, {
      providerReady: async () => ({ known: true, ready: true }),
      which: (command) => `/usr/bin/${command}`,
      git: async (args) => (args[0] === "rev-parse" ? { code: 0, stdout: "true\n" } : { code: 0, stdout: "" }),
      probe: async (command, cwd, env) => {
        const child = Bun.spawn([command.executable, ...command.args], { cwd, env, stdout: "pipe", stderr: "pipe" });
        const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
        return { exitCode: await child.exited, output };
      },
    });
    const line = report.checks.find((c) => c.id === "environment");
    expect(line).toMatchObject({ status: "fail", title: "gradle -q help fails on this machine, so gradle-check would fail for every task", subject: "gradle-check" });
    expect(line?.fix).toContain("-Djdk.net.unixdomain.tmpdir=");
    expect(report.ready).toBe(false);
  });
});

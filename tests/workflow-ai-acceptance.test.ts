import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, WorkflowEvent } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { type AcceptanceGateDefinition, walkProblems } from "../src/core/workflows/v2/acceptance.js";
import { recordedSteps, runTestOnce, WalkSession } from "../src/core/workflows/v2/acceptance-gate.js";
import { type Gate, GateSchema, validateGate, type WorkflowV2 } from "../src/core/workflows/v2/definition.js";
import { builtinPresets, instantiatePreset } from "../src/core/workflows/v2/definitions.js";
import { confirmGates, loadGateLibrary, unconfirmedGates } from "../src/core/workflows/v2/library.js";
import { parseRunDefinition } from "../src/core/workflows/v2/runtime.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Fixture", problem: "Missing value", outcome: "Value exists",
  inScope: ["Create value"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "value is ready", method: "automated" }],
  dependencies: [],
};
const valueCheck = {
  id: "check", executable: "bun", args: ["-e", "if ((await Bun.file('value.txt').text()).trim() !== 'ready') process.exit(1)"],
  cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [],
};
const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [valueCheck] };

/** The fixture CLI: a calculator on standard input. The broken one adds one to every sum. */
const calculator = (offset: number, extra = "") => `
import { appendFileSync, mkdirSync } from "node:fs";
mkdirSync("tmp-out", { recursive: true });
${extra}
process.stdout.write("ready>\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    const match = /^add (-?\\d+) (-?\\d+)$/.exec(line);
    if (match) {
      const sum = Number(match[1]) + Number(match[2]) + ${offset};
      appendFileSync("tmp-out/log.txt", line + "\\n");
      process.stdout.write("sum: " + sum + "\\n");
    } else if (line === "quit") process.exit(0);
    else if (line) process.stdout.write("unknown command\\n");
    index = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/** The deterministic test the scripted writer produces; it starts the declared command itself. */
const generatedTest = (variant: "correct" | "always-passes") => variant === "always-passes"
  ? `console.log("nothing to check");\n`
  : `
const child = Bun.spawn([process.execPath, "calc.ts"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
child.stdin.write("add 2 3\\nquit\\n");
child.stdin.end();
const output = await new Response(child.stdout).text();
await child.exited;
let failed = false;
if (!output.includes("ready>")) { console.log("ASSERTION FAILED: A1 the ready prompt is missing"); failed = true; }
if (!output.includes("sum: 5")) { console.log("ASSERTION FAILED: A2 expected sum: 5, got " + JSON.stringify(output)); failed = true; }
process.exit(failed ? 1 : 0);
`;

interface Script {
  /** What the walker cites for E2 instead of the step it recorded. */
  citeE2?: string;
  writer?: "correct" | "always-passes";
}

class AcceptanceExecutor implements AgentExecutor {
  calls: string[] = [];
  constructor(private root: string, private script: Script = {}) {}
  private async tool(request: ExecutionRequest, name: string, input: unknown): Promise<unknown> {
    const tool = request.hostTools?.[name];
    if (!tool) throw new Error(`No host tool ${name}`);
    if (!request.profile.allowedTools.includes(name)) throw new Error(`${name} is not allowed`);
    return tool.execute(tool.inputSchema.parse(input));
  }
  async execute(request: ExecutionRequest) {
    this.calls.push(request.profile.output);
    let output: unknown;
    switch (request.profile.output) {
      case "plan": {
        const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
        output = {
          schemaVersion: 1, markdown,
          taskGraph: {
            schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
            tasks: [{ id: "T001", title: "Create value", description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
          },
        };
        break;
      }
      case "implementation":
        writeFileSync(join(this.root, "value.txt"), "ready\n");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      case "acceptance": {
        // A scripted model: it drives the application and judges what it actually read.
        const started = (await this.tool(request, "app_start", {})) as { output: string; ready: boolean };
        const first = (await this.tool(request, "record_step", {
          action: "Started the calculator", observation: started.output.trim() || "no output", expectationIds: ["E1"],
        })) as { stepId: string };
        await this.tool(request, "terminal_send", { text: "add 2 3" });
        const read = (await this.tool(request, "terminal_read", { waitMs: 5000, until: "sum:" })) as { output: string };
        const second = (await this.tool(request, "record_step", {
          action: "Typed add 2 3", observation: read.output.trim(), expectationIds: ["E2"],
        })) as { stepId: string };
        await this.tool(request, "app_stop", {});
        const sumOk = read.output.includes("sum: 5");
        output = {
          schemaVersion: 1,
          expectations: [
            { expectationId: "E1", verdict: started.output.includes("ready>") ? "pass" : "fail", stepIds: [first.stepId], explanation: "The prompt was shown" },
            { expectationId: "E2", verdict: sumOk ? "pass" : "fail", stepIds: [this.script.citeE2 ?? second.stepId], explanation: sumOk ? "The sum was 5" : `Expected sum: 5, saw ${read.output.trim()}` },
          ],
        };
        break;
      }
      case "acceptance-draft": {
        const testPath = "tests/acceptance/calc-walk.ts";
        await this.tool(request, "write_test", { content: generatedTest(this.script.writer ?? "correct") });
        output = {
          schemaVersion: 1, testPath,
          assertions: [
            { assertionId: "A1", expectationId: "E1", description: "The ready prompt is printed" },
            { assertionId: "A2", expectationId: "E2", description: "add 2 3 prints sum: 5" },
          ],
        };
        break;
      }
      default:
        throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const walkGate = (patch: (gate: AcceptanceGateDefinition) => AcceptanceGateDefinition = (g) => g): AcceptanceGateDefinition =>
  patch({
    schemaVersion: 1, id: "calc-walk", description: "A model adds two numbers in the calculator.", required: false, scope: "feature", timeoutMs: 60000,
    retries: { max: 0, retryOn: [] }, evidence: { kind: "recording", keepOutputLines: 40, artifactPaths: [] },
    type: "ai-acceptance",
    acceptance: {
      scenario: { title: "Adding two numbers", steps: ["Start the calculator.", "Type add 2 3."], expectations: ["The calculator shows its ready prompt.", "add 2 3 prints sum: 5."] },
      start: { executable: "bun", args: ["calc.ts"], cwd: ".", envNames: [], readyWhen: { logIncludes: "ready>" } },
      driver: "terminal",
      capabilities: { spawnApp: true, listenPorts: [], outboundHosts: [], writePaths: ["tmp-out"] },
      promote: { commandGateId: "calc-sum", testPath: "tests/acceptance/calc-walk.ts", framework: "cli-script", stableRuns: 3 },
    },
  });

function setup(script: Script = {}, gate: AcceptanceGateDefinition = walkGate(), offset = 1) {
  const root = mkdtempSync(join(tmpdir(), "baked-ai-acceptance-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "calc.ts"), calculator(offset));
  const executor = new AcceptanceExecutor(root, script);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const writeGate = (definition: Gate) => {
    mkdirSync(join(root, "baked", "gates"), { recursive: true });
    writeFileSync(join(root, "baked", "gates", `${definition.id}.json`), JSON.stringify(definition));
    confirmGates(root, loadGateLibrary(root, policy), [definition.id]);
  };
  const define = (gates: { transition?: string[]; check?: string[] }) => {
    const preset = builtinPresets.get("quick-fix");
    if (!preset) throw new Error("quick-fix preset missing");
    const base = instantiatePreset(preset, policy);
    const definition: WorkflowV2 = {
      ...base, id: "custom-fix", preset: "custom",
      stages: base.stages.map((s) => (s.type === "check" && gates.check ? { ...s, gates: gates.check.map((gateId) => ({ gateId })) } : s)),
      transitions: base.transitions.map((t) => (t.id === "checks-done" ? { ...t, gates: (gates.transition ?? []).map((gateId) => ({ gateId })) } : t)),
    };
    mkdirSync(join(root, "baked", "workflows"), { recursive: true });
    writeFileSync(join(root, "baked", "workflows", "custom-fix.json"), JSON.stringify(definition));
  };
  writeGate(gate);
  define({ transition: [gate.id] });
  const start = () => service.start({ commandId: newId(), featureId: "fixture", workflowId: "custom-fix", prompt: "Create ready value", ownerLabel: "test", policy });
  const pendingApproval = (runId: string) =>
    service.store.requests(runId).find((r) => r.kind === "approval" && r.status === "pending" && !("acceptance" in JSON.parse(r.body_json)));
  const complete = async (runId: string) => {
    for (let round = 0; round < 6; round++) {
      const snapshot = await service.drive(runId, new AbortController().signal);
      const request = pendingApproval(runId);
      if (snapshot.status !== "waiting" || !request) return snapshot;
      await service.decide(runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    }
    return service.get(runId);
  };
  const acceptanceRequest = (runId: string) =>
    service.store.requests(runId).find((r) => r.kind === "approval" && "acceptance" in JSON.parse(r.body_json));
  return { root, executor, service, writeGate, define, start, complete, acceptanceRequest };
}

const events = (service: NativeWorkflowService, runId: string): WorkflowEvent[] => service.store.events(runId, 0, 10000);
const phases = (service: NativeWorkflowService, runId: string) =>
  events(service, runId).flatMap((e) => (e.type === "acceptance.phase" ? [e.payload] : []));
const gateEvents = (service: NativeWorkflowService, runId: string) =>
  events(service, runId).flatMap((e) => (e.type === "gate.finished" ? [e.payload] : []));
const lastError = (service: NativeWorkflowService, runId: string) => {
  const artifact = service.store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
  return artifact ? service.store.readArtifact(runId, artifact.id) : "";
};
const draftOf = (service: NativeWorkflowService, runId: string) => {
  const artifact = service.store.artifacts(runId).filter((a) => a.logical_path.endsWith("/draft.json")).at(-1);
  return JSON.parse(service.store.readArtifact(runId, artifact?.id ?? "")) as {
    draft: { assertions: { assertionId: string; expectationId: string }[] };
    runs: { exitCode: number | null; failed: string[]; violations: string[] }[];
  };
};

describe("AI acceptance gate", () => {
  test("9.5 a broken scenario is found, the test reproduces it, and after the fix it passes without a model", async () => {
    const fixture = setup();
    const { service, root, executor } = fixture;
    const run = await fixture.start();
    // The grant is shown to the person who approves the plan.
    await service.drive(run.runId, new AbortController().signal);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval");
    expect(JSON.parse(approval?.body_json ?? "{}").acceptanceCapabilities).toEqual([
      { gateId: "calc-walk", driver: "terminal", command: ["bun", "calc.ts"], capabilities: walkGate().acceptance.capabilities },
    ]);
    const final = await fixture.complete(run.runId);
    // The walk-through is advisory: its failure is a warning and the run completes.
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");
    expect(gateEvents(service, run.runId).find((g) => g.gateId === "calc-walk")).toMatchObject({ status: "failed", mode: "advisory" });

    // 1. The walk-through reports the failing expectation with the step that shows it.
    const walked = phases(service, run.runId).find((p) => p.phase === "walked");
    expect(walked?.detail).toContain("failed: E2 failed (steps S2)");
    const entry = service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry).toMatchObject({ phase: "awaiting_approval", verdict: "failed", rewrites: 0 });
    const steps = recordedSteps(service.store, run.runId, "calc-walk", entry?.attemptId ?? "");
    expect(steps.map((s) => s.stepId)).toEqual(["S1", "S2"]);
    expect(steps[1]?.frame).toContain("sum: 6");
    expect(service.store.artifacts(run.runId).some((a) => a.logical_path === `acceptance/calc-walk/${entry?.attemptId}/steps/S2.json`)).toBe(true);

    // 2. The generated test fails on the assertion mapped to E2 in every stable run.
    const draft = draftOf(service, run.runId);
    expect(draft.draft.assertions.find((a) => a.expectationId === "E2")?.assertionId).toBe("A2");
    expect(draft.runs).toHaveLength(3);
    for (const testRun of draft.runs) {
      expect(testRun.exitCode).not.toBe(0);
      expect(testRun.failed).toEqual(["A2"]);
      expect(testRun.violations).toEqual([]);
    }
    // Until a person decides, the test is an artifact and not a file of the workspace.
    expect(existsSync(join(root, "tests/acceptance/calc-walk.ts"))).toBe(false);

    // A person accepts: the test and its command gate are written with provenance and confirmed.
    const request = fixture.acceptanceRequest(run.runId);
    if (!request) throw new Error("No acceptance request");
    expect(request.status).toBe("pending");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: final.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    expect(service.store.state(run.runId).acceptance["calc-walk"]?.phase).toBe("promoted");
    const testText = readFileSync(join(root, "tests/acceptance/calc-walk.ts"), "utf8");
    const promoted = GateSchema.parse(JSON.parse(readFileSync(join(root, "baked/gates/calc-sum.json"), "utf8")));
    expect(validateGate(promoted)).toEqual([]);
    if (promoted.type !== "command") throw new Error("not a command gate");
    expect(promoted.command).toMatchObject({ executable: "bun", args: ["tests/acceptance/calc-walk.ts"], writes: ["tmp-out"] });
    expect(promoted.provenance).toMatchObject({ generatedFrom: "calc-walk", testPath: "tests/acceptance/calc-walk.ts", testHash: hashBytes(testText), approvedBy: "human" });
    expect(unconfirmedGates(root, loadGateLibrary(root, policy), ["calc-sum"])).toEqual([]);

    // 3. After the fix the same test passes in every stable run, and no model is called.
    writeFileSync(join(root, "calc.ts"), calculator(0));
    const calls = executor.calls.length;
    const gate = walkGate();
    const parsedPolicy = JSON.parse(service.store.run(run.runId).policy_json) as RunPolicy;
    for (let i = 0; i < gate.acceptance.promote.stableRuns; i++) {
      const result = await runTestOnce(root, gate, parsedPolicy, new AbortController().signal);
      expect(result).toMatchObject({ exitCode: 0, failed: [], violations: [] });
    }
    expect(executor.calls.length).toBe(calls);

    // The promoted gate runs as a required check of a new run, without the acceptance profiles.
    fixture.define({ check: ["check", "calc-sum"] });
    rmSync(join(root, "value.txt"));
    const second = await fixture.start();
    const secondFinal = await fixture.complete(second.runId);
    expect(lastError(service, second.runId)).toBe("");
    expect(secondFinal.status).toBe("completed");
    expect(service.store.checks(second.runId).filter((c) => c.check_id === "calc-sum").map((c) => c.status)).toEqual(["passed"]);
    expect(executor.calls.slice(calls)).toEqual(["plan", "implementation"]);
  }, 120000);

  test("a promoted test whose file changed fails as modified since approval", async () => {
    const fixture = setup({}, walkGate(), 0);
    const { service, root } = fixture;
    const testText = generatedTest("correct");
    mkdirSync(join(root, "tests/acceptance"), { recursive: true });
    writeFileSync(join(root, "tests/acceptance/calc-walk.ts"), testText);
    const promoted: Gate = {
      schemaVersion: 1, id: "calc-sum", description: "Promoted", required: true, scope: "feature", timeoutMs: 60000,
      retries: { max: 0, retryOn: [] }, evidence: { kind: "exit", keepOutputLines: 40, artifactPaths: [] }, type: "command",
      command: { executable: "bun", args: ["tests/acceptance/calc-walk.ts"], cwd: ".", envNames: [], writes: ["tmp-out"] },
      provenance: { generatedFrom: "calc-walk", testPath: "tests/acceptance/calc-walk.ts", testHash: hashBytes(testText), approvedBy: "human", approvedAt: new Date().toISOString() },
    };
    fixture.writeGate(promoted);
    // An agent or a person weakens the test after approval.
    writeFileSync(join(root, "tests/acceptance/calc-walk.ts"), "process.exit(0);\n");
    fixture.define({ transition: ["calc-sum"] });
    const run = await fixture.start();
    const final = await fixture.complete(run.runId);
    expect(final.status).toBe("blocked");
    expect(lastError(service, run.runId)).toContain("Gate calc-sum on checks-done failed: test modified since approval");
    const check = service.store.checks(run.runId).find((c) => c.check_id === "calc-sum");
    expect(check?.status).toBe("failed");
    const evidence = service.store.artifacts(run.runId).find((a) => a.logical_path.startsWith("checks/calc-sum/refused-"));
    expect(JSON.parse(service.store.readArtifact(run.runId, evidence?.id ?? ""))).toMatchObject({ reason: "test_modified", exitCode: null });
  }, 60000);

  test("without spawnApp the walk-through does not run and the tools refuse to start the application", async () => {
    const denied = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, capabilities: { ...g.acceptance.capabilities, spawnApp: false, writePaths: [] } } }));
    const fixture = setup({}, denied);
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    expect(fixture.executor.calls).toEqual(["plan", "implementation"]);
    const entry = fixture.service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry).toMatchObject({ phase: "inconclusive" });
    expect(entry?.reason).toContain("spawnApp is not granted");
    // Nothing is granted, so the approval lists no walk-through capability.
    const approval = fixture.service.store.requests(run.runId).find((r) => r.kind === "approval");
    expect(JSON.parse(approval?.body_json ?? "{}").acceptanceCapabilities).toBeUndefined();
    // The host tool refuses on its own as well.
    const session = new WalkSession(undefined as unknown as WorkflowStore, run.runId, "attempt", denied, fixture.root, new AbortController().signal);
    await expect(session.tools().app_start?.execute({}) ?? Promise.resolve()).rejects.toThrow("spawnApp is not granted");
    expect(session.violations).toEqual(["app_start was refused: spawnApp is not granted"]);
  }, 60000);

  test("an application that writes outside its write paths ends the walk-through as a violation", async () => {
    const fixture = setup();
    writeFileSync(join(fixture.root, "calc.ts"), calculator(0, `import { writeFileSync } from "node:fs"; writeFileSync("stray.txt", "x");`));
    const run = await fixture.start();
    await fixture.complete(run.runId);
    const entry = fixture.service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry?.phase).toBe("inconclusive");
    expect(entry?.reason).toContain("the application changed stray.txt outside the granted write paths");
    // The granted directory is not a violation.
    expect(entry?.reason).not.toContain("tmp-out");
    expect(fixture.executor.calls).not.toContain("acceptance-draft");
  }, 60000);

  test("a cited step must be one this attempt recorded", async () => {
    const fixture = setup({ citeE2: "S9" });
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    const entry = fixture.service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry?.phase).toBe("inconclusive");
    expect(entry?.reason).toContain("Expectation E2 cites step S9, which this attempt did not record");
    expect(fixture.executor.calls).not.toContain("acceptance-draft");
    // Steps of another attempt do not count for this one.
    const other = recordedSteps(fixture.service.store, run.runId, "calc-walk", "another-attempt");
    expect(other).toEqual([]);
    const gate = walkGate();
    expect(walkProblems(gate, {
      schemaVersion: 1,
      expectations: [
        { expectationId: "E1", verdict: "pass", stepIds: [], explanation: "Claimed without evidence" },
        { expectationId: "E2", verdict: "inconclusive", stepIds: [], explanation: "Not observed" },
      ],
    }, new Set(["S1"]))).toEqual(["Expectation E1 cites no recorded step"]);
  }, 60000);

  test("a test that does not reproduce the failure is rewritten at most twice", async () => {
    const fixture = setup({ writer: "always-passes" });
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    const entry = fixture.service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry).toMatchObject({ phase: "unstable", rewrites: 2, verdict: "failed", requestId: null });
    expect(entry?.reason).toContain("passed although the walk-through found a failure");
    expect(fixture.executor.calls.filter((c) => c === "acceptance-draft")).toHaveLength(3);
    expect(fixture.acceptanceRequest(run.runId)).toBeUndefined();
    expect(existsSync(join(fixture.root, "tests/acceptance/calc-walk.ts"))).toBe(false);
  }, 60000);

  test("a rejected test is discarded and nothing is written", async () => {
    const fixture = setup();
    const run = await fixture.start();
    const final = await fixture.complete(run.runId);
    const request = fixture.acceptanceRequest(run.runId);
    if (!request) throw new Error("No acceptance request");
    await fixture.service.decide(run.runId, { commandId: newId(), expectedRevision: final.revision }, { kind: "reject", requestId: request.id, explanation: "The test checks too little" });
    expect(fixture.service.store.state(run.runId).acceptance["calc-walk"]?.phase).toBe("discarded");
    expect(existsSync(join(fixture.root, "baked/gates/calc-sum.json"))).toBe(false);
    expect(existsSync(join(fixture.root, "tests/acceptance/calc-walk.ts"))).toBe(false);
    expect(parseRunDefinition(fixture.service.store.run(run.runId).definition_json).schemaVersion).toBe(2);
  }, 60000);

  test("the gate rules keep metadata out of write and test paths, and the browser driver is skipped", async () => {
    const bad = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, capabilities: { ...g.acceptance.capabilities, writePaths: [".git"] }, promote: { ...g.acceptance.promote, testPath: "baked/gates/x.json" } } }));
    expect(validateGate(bad)).toEqual([
      "calc-walk: write paths must not include the workspace root or workflow metadata",
      "calc-walk: the test path must not be workflow metadata",
    ]);
    const browser = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, driver: "browser" } }));
    const fixture = setup({}, browser);
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    expect(fixture.service.store.state(run.runId).acceptance["calc-walk"]).toMatchObject({ phase: "skipped" });
    expect(gateEvents(fixture.service, run.runId).find((g) => g.gateId === "calc-walk")?.status).toBe("skipped");
    expect(fixture.executor.calls).toEqual(["plan", "implementation"]);
  }, 60000);
});

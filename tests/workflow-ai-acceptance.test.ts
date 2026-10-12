import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { killTree } from "../src/core/platform/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, Spec, WorkflowEvent } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId, type WorkflowStore } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { type AcceptanceGateDefinition, failedAssertions, forbiddenConstructs, walkProblems } from "../src/core/workflows/v2/acceptance.js";
import { isLoopbackAddress, listenerViolations, listeningSockets, parseLsofListeners, parseProcNetTcp, parsePsTable, parseWindowsSockets, processFamily } from "../src/core/workflows/v2/terminal-driver.js";
import { recordedSteps, runTestOnce, WalkSession, type WalkStep } from "../src/core/workflows/v2/acceptance-gate.js";
import { type BrowserLauncher, type BrowserPage, MISSING_PLAYWRIGHT } from "../src/core/workflows/v2/browser-driver.js";
import type { ProxyDecision } from "../src/core/workflows/v2/filter-proxy.js";
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
  /** Walk the web fixture on this port with the browser tools instead of the terminal. */
  browserPort?: number;
  /** Also run declared command 0 with command_run and record a step for it. */
  runCommand?: boolean;
}

/** The fixture web application: a counter page that loads a third-party script. Broken: +2. */
const webApp = (offset: number) => `
const port = Number(process.env.PORT);
const page = (body) => new Response("<html><head><title>Counter</title><script src=\\"http://tracker.example.test/t.js\\"></script></head><body>" + body + "</body></html>", { headers: { "content-type": "text/html" } });
Bun.serve({ port, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return page("<h1>Count: 0</h1><a href=\\"/inc\\">Increment</a>");
  if (path === "/inc") return page("<h1>Count: " + (1 + ${offset}) + "</h1>");
  return new Response("not found", { status: 404 });
} });
console.log("listening on " + port);
`;

/** The browser test the scripted writer produces: it reaches the application through the proxy. */
const generatedBrowserTest = (port: number) => `
const proxy = process.env.BAKED_ACCEPTANCE_PROXY;
const child = Bun.spawn([process.execPath, "web.ts"], { env: { ...process.env, PORT: "${port}" }, stdout: "pipe", stderr: "pipe" });
const get = async (path) => {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch("http://127.0.0.1:${port}" + path, proxy ? { proxy } : {});
      // 502: the proxy could not reach the application yet.
      if (response.status !== 502) return await response.text();
    } catch {}
    await Bun.sleep(50);
  }
  return "";
};
let failed = false;
const home = await get("/");
if (!home.includes("Count: 0")) { console.log("ASSERTION FAILED: A1 the counter does not start at 0"); failed = true; }
const after = await get("/inc");
if (!after.includes("Count: 1")) { console.log("ASSERTION FAILED: A2 expected Count: 1, got " + JSON.stringify(after)); failed = true; }
child.kill();
await child.exited;
process.exit(failed ? 1 : 0);
`;

/** A GET through the proxy over a raw socket; fetch would honour NO_PROXY of the environment. */
async function proxiedGet(proxy: string, url: string): Promise<{ status: number; text: string }> {
  const target = new URL(url);
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(new URL(proxy).port), "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    socket.write(`GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n\r\n`);
  });
  const [head = "", ...body] = raw.split("\r\n\r\n");
  return { status: Number(head.split(" ")[1]), text: body.join("\r\n\r\n") };
}

/**
 * A stand-in for the Playwright page: it fetches documents and their scripts through the proxy
 * the gate configured, so the filtering is real; only rendering is faked.
 */
class FakePage implements BrowserPage {
  private html = "";
  private current = "about:blank";
  constructor(private proxy: string) {}
  private fetch(url: string) {
    return proxiedGet(this.proxy, url);
  }
  async goto(url: string) {
    const document = await this.fetch(url);
    this.current = url;
    this.html = document.text;
    for (const match of this.html.matchAll(/<script src="([^"]+)"/g))
      if (match[1]) await this.fetch(new URL(match[1], url).href).catch(() => undefined);
    return { status: document.status };
  }
  url() {
    return this.current;
  }
  async title() {
    return /<title>(.*?)<\/title>/.exec(this.html)?.[1] ?? "";
  }
  async snapshot() {
    return this.html.replace(/<(script|title)[^>]*>.*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  async click(selector: string) {
    const text = selector.replace(/^text=/, "");
    const href = new RegExp(`<a href="([^"]+)">${text}</a>`).exec(this.html)?.[1];
    if (!href) throw new Error(`No element matches ${selector}`);
    await this.goto(new URL(href, this.current).href);
  }
  async fill() {
    throw new Error("The fixture page has no inputs");
  }
  async press() {
    throw new Error("The fixture page has no inputs");
  }
  async close() {}
}
const fakeLauncher = (missing: string | null = null): BrowserLauncher => ({
  missing: async () => missing,
  launch: async (_workspace, options) => new FakePage(options.proxyServer),
});

class AcceptanceExecutor implements AgentExecutor {
  calls: string[] = [];
  commandResults: unknown[] = [];
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
        if (this.script.browserPort) {
          // A scripted model in the browser: it opens the page, follows the link and judges.
          await this.tool(request, "app_start", {});
          const home = (await this.tool(request, "browser_open", { url: "/" })) as { snapshot: string; refused: string[] };
          const first = (await this.tool(request, "record_step", {
            action: "Opened the counter page", observation: `${home.snapshot} (refused: ${home.refused.join("; ")})`, expectationIds: ["E1"],
          })) as { stepId: string };
          const clicked = (await this.tool(request, "browser_click", { selector: "text=Increment" })) as { snapshot: string };
          const second = (await this.tool(request, "record_step", {
            action: "Clicked Increment", observation: clicked.snapshot, expectationIds: ["E2"],
          })) as { stepId: string };
          await this.tool(request, "app_stop", {});
          const ok = clicked.snapshot.includes("Count: 1");
          output = {
            schemaVersion: 1,
            expectations: [
              { expectationId: "E1", verdict: home.snapshot.includes("Count: 0") ? "pass" : "fail", stepIds: [first.stepId], explanation: "The counter starts at 0" },
              { expectationId: "E2", verdict: ok ? "pass" : "fail", stepIds: [second.stepId], explanation: ok ? "Count: 1" : `Expected Count: 1, saw ${clicked.snapshot}` },
            ],
          };
          break;
        }
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
        if (this.script.runCommand) {
          const result = (await this.tool(request, "command_run", { index: 0 })) as { output: string };
          this.commandResults.push(result);
          await this.tool(request, "record_step", {
            action: "Ran the sum command", observation: result.output.trim(), expectationIds: ["E2"],
          });
        }
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
        await this.tool(request, "write_test", {
          content: this.script.browserPort ? generatedBrowserTest(this.script.browserPort) : generatedTest(this.script.writer ?? "correct"),
        });
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

function setup(script: Script = {}, gate: AcceptanceGateDefinition = walkGate(), offset = 1, browser: BrowserLauncher = fakeLauncher()) {
  const root = mkdtempSync(join(tmpdir(), "baked-ai-acceptance-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "calc.ts"), calculator(offset));
  writeFileSync(join(root, "web.ts"), webApp(offset));
  const executor = new AcceptanceExecutor(root, script);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  // Fake host names of the fixtures resolve to nothing real; the proxy refuses them anyway.
  service.scheduler.browserDriver = { launcher: browser };
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

  test("a terminal walk-through runs its declared commands without a shell and records their output", async () => {
    const gate = walkGate((g) => ({
      ...g,
      acceptance: { ...g.acceptance, commands: [{ executable: "bun", args: ["sum.ts", "2", "3"] }] },
    }));
    expect(validateGate(gate)).toEqual([]);
    expect(validateGate({ ...gate, acceptance: { ...gate.acceptance, driver: "browser" } })).toContain(
      "calc-walk: commands run only with the terminal driver",
    );
    const fixture = setup({ runCommand: true }, gate);
    const { service, root, executor } = fixture;
    writeFileSync(join(root, "sum.ts"), `console.log("total: " + (Number(process.argv[2]) + Number(process.argv[3])) + " $HOME");\n`);
    const run = await fixture.start();
    await fixture.complete(run.runId);
    expect(executor.commandResults).toEqual([
      expect.objectContaining({ index: 0, command: ["bun", "sum.ts", "2", "3"], exit: { exitCode: 0, signal: null }, timedOut: false }),
    ]);
    // No shell: $HOME is printed as typed.
    expect((executor.commandResults[0] as { output: string }).output).toContain("total: 5 $HOME");
    const entry = service.store.state(run.runId).acceptance["calc-walk"];
    const steps = recordedSteps(service.store, run.runId, "calc-walk", entry?.attemptId ?? "");
    expect(steps[2]?.frame).toContain("total: 5");
    expect(steps[2]?.exit).toEqual({ exitCode: 0, signal: null });
  });

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

  test("the gate rules keep metadata out of write and test paths, and a browser walk without Playwright does not run", async () => {
    const bad = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, capabilities: { ...g.acceptance.capabilities, writePaths: [".git"] }, promote: { ...g.acceptance.promote, testPath: "baked/gates/x.json" } } }));
    expect(validateGate(bad)).toEqual([
      "calc-walk: write paths must not include the workspace root or workflow metadata",
      "calc-walk: the test path must not be workflow metadata",
    ]);
    const browser = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, driver: "browser" } }));
    const fixture = setup({}, browser, 1, fakeLauncher(MISSING_PLAYWRIGHT));
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    const entry = fixture.service.store.state(run.runId).acceptance["calc-walk"];
    expect(entry).toMatchObject({ phase: "inconclusive" });
    expect(entry?.reason).toContain("missing dependency: install playwright");
    expect(gateEvents(fixture.service, run.runId).find((g) => g.gateId === "calc-walk")?.status).toBe("inconclusive");
    // No model is called and nothing is downloaded.
    expect(fixture.executor.calls).toEqual(["plan", "implementation"]);
  }, 60000);

  test("a browser walk goes through the filtering proxy, records refusals and promotes a reproducing test", async () => {
    const reserve = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = reserve.port;
    reserve.stop(true);
    const gate = walkGate((g) => ({
      ...g,
      id: "web-walk",
      acceptance: {
        ...g.acceptance,
        scenario: { title: "Incrementing the counter", steps: ["Open the counter.", "Click Increment."], expectations: ["The counter starts at 0.", "After Increment it shows Count: 1."] },
        start: { executable: "bun", args: ["web.ts"], cwd: ".", envNames: [], readyWhen: { url: `http://127.0.0.1:${port}/` } },
        driver: "browser",
        capabilities: { spawnApp: true, listenPorts: [port], outboundHosts: ["cdn.example.test"], writePaths: [] },
        promote: { commandGateId: "web-count", testPath: "tests/acceptance/calc-walk.ts", framework: "playwright", stableRuns: 2 },
      },
    }));
    const fixture = setup({ browserPort: port }, gate);
    const { service } = fixture;
    const run = await fixture.start();
    await service.drive(run.runId, new AbortController().signal);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval");
    expect(JSON.parse(approval?.body_json ?? "{}").acceptanceCapabilities[0]).toMatchObject({ gateId: "web-walk", driver: "browser" });
    const final = await fixture.complete(run.runId);
    expect(lastError(service, run.runId)).toBe("");
    expect(final.status).toBe("completed");

    // The walk found the broken increment, with the step that shows it.
    const entry = service.store.state(run.runId).acceptance["web-walk"];
    expect(entry).toMatchObject({ phase: "awaiting_approval", verdict: "failed" });
    expect(phases(service, run.runId).find((p) => p.phase === "walked")?.detail).toContain("failed: E2 failed (steps S2)");
    const steps: WalkStep[] = recordedSteps(service.store, run.runId, "web-walk", entry?.attemptId ?? "");
    expect(steps.map((s) => [s.stepId, s.url])).toEqual([["S1", `http://127.0.0.1:${port}/`], ["S2", `http://127.0.0.1:${port}/inc`]]);
    expect(steps[0]?.frame).toContain("Count: 0");
    expect(steps[1]?.frame).toContain("Count: 2");
    // The third-party script is refused by the proxy and kept with the step that loaded it.
    expect(steps[0]?.refused?.map((d) => [d.host, d.reason])).toEqual([["tracker.example.test", "tracker.example.test is not in outboundHosts"]]);
    expect(steps[0]?.observation).toContain("refused: GET tracker.example.test:80");
    const walk = service.store.artifacts(run.runId).find((a) => a.logical_path === `acceptance/web-walk/${entry?.attemptId}/walk.json`);
    const network = (JSON.parse(service.store.readArtifact(run.runId, walk?.id ?? "")) as { network: { allowed: string[]; refused: ProxyDecision[] } }).network;
    expect(network.allowed).toEqual([`127.0.0.1:${port}`]);
    expect(network.refused.map((d) => d.host)).toEqual(["tracker.example.test", "tracker.example.test"]);

    // The generated test ran through the proxy in every stable run and failed on A2.
    const draft = draftOf(service, run.runId) as ReturnType<typeof draftOf> & { runs: { refused?: string[] }[] };
    expect(draft.runs).toHaveLength(2);
    for (const testRun of draft.runs) expect(testRun).toMatchObject({ failed: ["A2"], violations: [], refused: [] });
    const request = fixture.acceptanceRequest(run.runId);
    if (!request) throw new Error("No acceptance request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: final.revision }, { kind: "approve", requestId: request.id, digest: request.digest });
    const promoted = GateSchema.parse(JSON.parse(readFileSync(join(fixture.root, "baked/gates/web-count.json"), "utf8")));
    if (promoted.type !== "command") throw new Error("not a command gate");
    expect(promoted.command).toMatchObject({ executable: "bun", args: ["tests/acceptance/calc-walk.ts"] });

    // After the fix the promoted test passes without a model.
    writeFileSync(join(fixture.root, "web.ts"), webApp(0));
    const fixed = await runTestOnce(fixture.root, gate, JSON.parse(service.store.run(run.runId).policy_json) as RunPolicy, new AbortController().signal);
    expect(fixed).toMatchObject({ exitCode: 0, failed: [], violations: [] });
  }, 120000);

  test("browser tools refuse non-web URLs, and a walk without spawnApp or hosts does not run", async () => {
    const browser = walkGate((g) => ({ ...g, acceptance: { ...g.acceptance, driver: "browser", capabilities: { spawnApp: false, listenPorts: [], outboundHosts: [], writePaths: [] } } }));
    const fixture = setup({}, browser);
    const run = await fixture.start();
    expect((await fixture.complete(run.runId)).status).toBe("completed");
    expect(fixture.service.store.state(run.runId).acceptance["calc-walk"]?.reason).toContain("Neither spawnApp nor outboundHosts is granted");
    expect(fixture.executor.calls).toEqual(["plan", "implementation"]);
    const session = new WalkSession(undefined as unknown as WorkflowStore, run.runId, "attempt", browser, fixture.root, new AbortController().signal, { launcher: fakeLauncher() });
    const tools = session.tools();
    expect(Object.keys(tools).sort()).toEqual(["app_start", "app_stop", "browser_click", "browser_key", "browser_open", "browser_snapshot", "browser_type", "record_step"]);
    await expect(tools.browser_open?.execute({ url: "file:///etc/passwd" }) ?? Promise.resolve()).rejects.toThrow("Only http and https URLs can be opened");
    // Without any grant the proxy refuses every host the page asks for.
    const opened = (await tools.browser_open?.execute({ url: "http://example.test/" })) as { status: number; refused: string[] };
    expect(opened.status).toBe(403);
    expect(opened.refused).toEqual(["GET example.test:80: example.test is not in outboundHosts"]);
    expect(session.network()?.refused).toHaveLength(1);
    await session.close();
  }, 60000);

  test("listeners, assertion markers and forbidden test constructs are read by the host", () => {
    const table = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1",
      "   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1",
      "   2: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 333 1",
    ].join("\n");
    const listeners = parseProcNetTcp(table, false);
    expect([...listeners.entries()]).toEqual([["111", { port: 8080, loopback: true }], ["222", { port: 3000, loopback: false }]]);
    expect(listenerViolations([...listeners.values()], [8080, 3000])).toEqual(["the application listens on port 3000 beyond loopback"]);
    expect(listenerViolations([...listeners.values()], [])).toContain("the application listens on port 8080, which is not granted");
    expect(failedAssertions("ok\nASSERTION FAILED: A2 wrong sum\nASSERTION FAILED: A2 again\nASSERTION FAILED: nonsense")).toEqual(["A2"]);
    expect(forbiddenConstructs("await Bun.file('.baked/config.json').text()", "tests/acceptance/x.ts")).toEqual(["it refers to .baked (the run store and configuration)"]);
    expect(forbiddenConstructs(generatedTest("correct"), "tests/acceptance/calc-walk.ts")).toEqual([]);
  });

  test("socket tables of macOS and Windows are read into listeners of the process family", () => {
    expect(["127.0.0.1", "[::1]", "::ffff:127.0.0.1", "localhost"].every(isLoopbackAddress)).toBe(true);
    expect(["*", "0.0.0.0", "::", "[::]", "192.168.1.4"].some(isLoopbackAddress)).toBe(false);
    const lsof = ["p100", "f5", "n127.0.0.1:8080", "f6", "n[::]:3000", "p200", "f3", "n*:5000"].join("\n");
    expect(parseLsofListeners(lsof)).toEqual([
      { pid: 100, listener: { port: 8080, loopback: true } },
      { pid: 100, listener: { port: 3000, loopback: false } },
      { pid: 200, listener: { port: 5000, loopback: false } },
    ]);
    // 101 is a child of 100, 102 a member of its group, 300 unrelated.
    const ps = parsePsTable("  100     1   100\n  101   100   101\n  102     1   100\n  300     1   300\n");
    expect([...processFamily([100], ps)].sort()).toEqual([100, 101, 102]);
    const windows = parseWindowsSockets(
      ["P 10 1 500", "P 11 10 600", "P 12 10 400", "L 11 127.0.0.1 8080", "L 12 0.0.0.0 9000", "L 10 :: 7000"].join("\r\n"),
    );
    // 12 started before 10, so its parent PID was reused: not part of the family.
    const family = processFamily([10], windows.table);
    expect([...family].sort()).toEqual([10, 11]);
    expect(windows.listeners.filter((l) => family.has(l.pid)).map((l) => l.listener)).toEqual([
      { port: 8080, loopback: true },
      { port: 7000, loopback: false },
    ]);
  });

  test("the listening sockets of a process and its descendants are read on this system", async () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-listen-"));
    const grandchild = join(dir, "grandchild.ts");
    writeFileSync(grandchild, 'const s = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("") });\nconsole.log(`wide ${s.port}`);\nsetInterval(() => {}, 1000);\n');
    const parent = join(dir, "parent.ts");
    writeFileSync(parent, `const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });\nconsole.log(\`local \${s.port}\`);\nBun.spawn([process.execPath, ${JSON.stringify(grandchild)}], { stdout: "inherit" });\nsetInterval(() => {}, 1000);\n`);
    const child = spawn(process.execPath, [parent], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    cleanups.push(() => {
      killTree(child.pid ?? 0, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    });
    const ports: Record<string, number> = {};
    let text = "";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ports announced: ${text}`)), 30000);
      child.stdout?.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        for (const [, kind, port] of text.matchAll(/(local|wide) (\d+)/g)) ports[kind as string] = Number(port);
        if (ports.local && ports.wide) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    let found: Awaited<ReturnType<typeof listeningSockets>> = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      found = await listeningSockets([child.pid ?? 0]);
      if (found?.some((l) => l.port === ports.wide) && found.some((l) => l.port === ports.local)) break;
      await Bun.sleep(250);
    }
    expect(found).not.toBeNull();
    expect(found).toContainEqual({ port: ports.local as number, loopback: true });
    expect(found).toContainEqual({ port: ports.wide as number, loopback: false });
    expect(listenerViolations(found ?? [], [ports.local as number])).toEqual([`the application listens on port ${ports.wide} which is not granted`.replace(" which", ", which")]);
  }, 60000);
});

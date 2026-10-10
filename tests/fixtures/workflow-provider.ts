import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import { builtinProfiles } from "../../src/core/agents/profiles/builtin.js";
import { buildSafeEnv } from "../../src/core/spawn.js";
import { hashBytes, hashJson } from "../../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { WorkflowStore } from "../../src/core/workflows/store.js";
import type { RunSnapshot, Spec } from "../../src/core/workflows/schemas.js";
import { WorkerClient } from "../../src/core/workers/rpc.js";

// A developer's provider endpoint or token would bypass the loopback redirect; keep the fixture hermetic.
for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[name];
const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
assert(workspace);
const compiled = process.env.BAKED_WORKFLOW_TEST_DIST === "1";
const preload = resolve(import.meta.dir, "workflow-transport-preload.ts");
const entry = resolve(compiled ? "dist/index.js" : "src/boot.tsx");
const workerDirectory = join(workspace, ".baked", "hydrated-runtime", "workers");
if (compiled) {
  mkdirSync(workerDirectory, { recursive: true });
  for (const name of ["workflow", "io", "intelligence"])
    copyFileSync(resolve(`dist/workers/${name}.worker.js`), join(workerDirectory, `${name}.worker.js`));
}
const workerEntry = compiled ? join(workerDirectory, "workflow.worker.js") : resolve("src/core/workers/workflow.worker.ts");
const policy = { ...defaultWorkflowPolicy, checks: [{ id: "value", executable: process.execPath, args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [] }] };
const config = { ...DEFAULT_CONFIG, repoMap: false, defaultModel: "none", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };
mkdirSync(join(workspace, ".baked"), { recursive: true });
mkdirSync(join(workspace, "baked", "agents"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify(config));
for (const id of ["reviewer", "security-reviewer", "skeptic"])
  writeFileSync(join(workspace, "baked", "agents", `${id}.json`), JSON.stringify({ ...builtinProfiles.find((p) => p.id === id), model: "anthropic/claude-opus-4-6" }));
writeFileSync(join(workspace, "request.txt"), "Create the ready value, validate it, review and repair failures.");
const spec: Spec = { schemaVersion: 1, featureId: "transport", revision: 1, title: "Transport fixture", problem: "Missing value", outcome: "Ready value", inScope: ["value.txt"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Value is ready", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "the task completes", then: "the value is ready", method: "automated" }], dependencies: [] };
const followUpFeature = "transport-model";
const followUpPrompt = "Create ready value";
const markdown = "# Plan\n## Context\nCreate value.\n## Decisions\nDEC-001: Implement FR-001.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nvalue check\n## Risks\nInvalid value";
const models = new Set<string>();
let requests = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  try {
    const body = await request.json() as { model: string; tools: { name: string; input_schema: { properties: Record<string, unknown> } }[]; messages: { content: { type: string; text?: string; name?: string }[] }[] };
    models.add(body.model); requests++;
    const context = body.messages.flatMap((m) => m.content).find((p) => p.type === "text" && p.text?.includes("Project content below"))?.text;
    assert(context, "Workflow context missing from provider request");
    const [documents, attempt] = context.split("\n").slice(-2);
    const data = { ...JSON.parse(documents!), ...JSON.parse(attempt!) } as { request: string; inputHash: string; snapshotHash: string; extra: { task?: { id: string }; evidence?: { id: string }[] } };
    // The model-selection run plans its own feature, so it does not collide with the
    // spec/plan/tasks files the first run published under specs/transport/.
    const featureSpec = data.request === followUpPrompt ? { ...spec, featureId: followUpFeature } : spec;
    const shape = body.tools.find((tool) => tool.name === "submit_result")!.input_schema.properties;
    let output: unknown;
    let name = "submit_result";
    if ("facts" in shape) output = { schemaVersion: 1, summary: "Fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["value.txt"] };
    else if ("problem" in shape) output = featureSpec;
    // Plans are validated against the workspace: once value.txt exists, a task must modify it.
    else if ("taskGraph" in shape) output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: featureSpec.featureId, revision: 1, specHash: hashJson(featureSpec), planHash: hashBytes(markdown), tasks: [{ id: "T001", title: "Create value", description: "Write value", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "value.txt", action: existsSync(join(workspace, "value.txt")) ? "modify" : "create" }], readHints: [], checkIds: ["value"], origin: "planned", findingIds: [], rationale: "FR-001" }] } };
    else if ("inputHash" in shape) output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] };
    else if ("taskId" in shape) {
      const edited = body.messages.some((m) => m.content.some((p) => p.type === "tool_use" && p.name === "edit_file"));
      if (!edited) {
        name = "edit_file";
        output = { path: "value.txt", oldString: data.extra.task?.id === "T001" ? "" : "broken", newString: data.extra.task?.id === "T001" ? "broken" : "ready" };
      } else output = { schemaVersion: 1, taskId: data.extra.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
    } else output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Host command verified the value" }], findings: [] };
    return Response.json({ id: `msg_${requests}`, type: "message", role: "assistant", model: body.model, content: [{ type: "tool_use", id: `tool_${requests}`, name, input: output }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 50 } });
  } catch (error) { console.error("Fixture endpoint:", error); return Response.json({ error: { type: "invalid_request_error", message: String(error) } }, { status: 400 }); }
} });
process.env.BAKED_WORKFLOW_TEST_ENDPOINT = server.url.origin;
process.env.ANTHROPIC_API_KEY = "fixture-key-not-a-secret";
const childEnv = { ...buildSafeEnv(), ANTHROPIC_API_KEY: "fixture-key-not-a-secret", BAKED_WORKFLOW_TEST_ENDPOINT: server.url.origin };
async function cli(argv: string[], expectedExit: number) {
  const child = Bun.spawn([process.execPath, "--preload", preload, entry, "workflow", ...argv], { cwd: workspace, env: childEnv, stdout: "pipe", stderr: "pipe", timeout: 30000 });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== expectedExit) {
    const last = JSON.parse(out.trim().split("\n").at(-1)!);
    if (last.runId) {
      const diagnosticStore = new WorkflowStore(workspace, true);
      for (const artifact of diagnosticStore.artifacts(last.runId).filter((item) => item.kind === "diagnostic")) console.error(diagnosticStore.readArtifact(last.runId, artifact.id));
      diagnosticStore.close();
    }
  }
  assert.equal(code, expectedExit, `${err}\n${out}`);
  return out;
}
class FixtureWorker extends WorkerClient {
  constructor() { const options = { smol: true, preload: [preload] }; super(workerEntry, { workspace, config }, options); }
  command(argv: string[]) { return this.callWithTimeout<RunSnapshot>(30000, "command", crypto.randomUUID(), argv); }
  shutdown() { return this.call("shutdown"); }
}
let worker: FixtureWorker | undefined;
try {
  const events = (await cli(["run", "sdd", "--feature", "transport", "--prompt-file", "request.txt", "--model", "anthropic/claude-sonnet-4-6", "--events"], 3)).trim().split("\n").map((line) => JSON.parse(line));
  assert(events.some((event) => event.type === "run.created"));
  const initial = events.at(-1) as RunSnapshot;
  const store = new WorkflowStore(workspace, true);
  const pending = store.requests(initial.runId).find((r) => r.kind === "approval" && r.status === "pending")!;
  store.close();
  const approved = JSON.parse(await cli(["approve", initial.runId, "--request", pending.id, "--digest", pending.digest, "--expected-revision", String(initial.revision)], 0)) as RunSnapshot;
  const previousCwd = process.cwd();
  worker = new FixtureWorker();
  const finished = await worker.command(["resume", initial.runId, "--expected-revision", String(approved.revision)]);
  assert.equal(finished.status, "completed", JSON.stringify(finished));
  assert.equal(process.cwd(), previousCwd);
  assert.equal(readFileSync(join(workspace, "value.txt"), "utf8"), "ready");
  const checked = new WorkflowStore(workspace, true);
  assert(checked.run(initial.runId).repair_rounds > 0);
  assert(checked.effects(initial.runId).filter((e) => e.kind === "file_patch" && e.status === "applied").length >= 2);
  const initialProfiles = checked.run(initial.runId).profiles_json;
  await assert.rejects(worker.command(["run", "sdd", "--feature", followUpFeature, "--prompt", followUpPrompt]), /Select a model/);
  const selected = await worker.command(["run", "sdd", "--feature", followUpFeature, "--prompt", followUpPrompt, "--model", "anthropic/claude-haiku-4-5"]);
  assert.equal(selected.status, "waiting");
  assert.equal(selected.reason, "approval");
  assert.equal(JSON.parse(checked.run(selected.runId).profiles_json).find((profile: { id: string }) => profile.id === "researcher").model, "anthropic/claude-haiku-4-5");
  assert.equal(checked.run(initial.runId).profiles_json, initialProfiles);
  await assert.rejects(worker.command(["run", "sdd", "--feature", followUpFeature, "--prompt", followUpPrompt]), /Select a model/);
  checked.close();
  assert(models.has("claude-sonnet-4-6") && models.has("claude-opus-4-6") && models.has("claude-haiku-4-5"));
  console.log(JSON.stringify({ providerTransport: "passed", compiled, requests, models: [...models], repaired: true, cachedWorkerModelSelection: "passed", status: finished.status, liveModelCalls: 0 }));
} finally { if (worker) { await worker.shutdown(); worker.dispose(); } server.stop(true); }
process.exit(0);

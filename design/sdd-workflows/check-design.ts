/** Structural design checks. Does not execute product commands or call models. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GateSchema, type Gate, WorkflowV2Schema, type WorkflowV2, upgradeWorkflowV1, validateGate, validateWorkflowV2 } from "./contracts-v2";
import {
  AnalysisSchema, CorrectionSchema, EventSchema, ImplementationSchema, InputManifestSchema, PlanSchema,
  PolicySchema, ProfileSchema, RelativePath, ResearchSchema, ReviewSchema,
  RefutationSchema, RunStatus, SpecSchema, StepStatus, TaskGraphSchema, TaskStatus, WorkflowSchema,
  validateTaskGraph, validateWorkflow, WorkflowConfigSchema,
} from "./contracts";

const root = dirname(fileURLToPath(import.meta.url));
const examples = join(root, "examples");
let checks = 0;
function check(condition: unknown, message: string): asserts condition {
  checks++;
  if (!condition) throw new Error(message);
}
function rejected(action: () => unknown, message: string): void {
  let threw = false;
  try { action(); } catch { threw = true; }
  check(threw, message);
}
function readJson(name: string): unknown { return JSON.parse(readFileSync(join(examples, name), "utf8")); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

const runtimeGuide = readFileSync(join(root, "runtime-guide.md"), "utf8");
const configExample = runtimeGuide.match(/```json\r?\n([\s\S]*?)\r?\n```/)?.[1];
check(configExample, "missing runtime configuration example");
check(WorkflowConfigSchema.safeParse(JSON.parse(configExample).workflows).success, "invalid runtime configuration example");

const spec = SpecSchema.parse(readJson("spec.json"));
const plan = readFileSync(join(examples, "plan.md"), "utf8");
let graph = TaskGraphSchema.parse(readJson("tasks.json"));
if (process.argv.includes("--refresh-example-hashes")) {
  graph = { ...graph, specHash: hash(canonical(spec)), planHash: hash(plan) };
  writeFileSync(join(examples, "tasks.json"), `${JSON.stringify(graph, null, 2)}\n`);
}
const workflow = WorkflowSchema.parse(readJson("workflow.json"));
const policy = PolicySchema.parse(readJson("policy.json"));
const rawProfiles = readJson("profiles.json");
check(Array.isArray(rawProfiles), "profiles must be an array");
const profiles = rawProfiles.map((p: unknown) => ProfileSchema.parse(p));
check(new Set(profiles.map((p) => p.id)).size === profiles.length, "duplicate profile ID");
check(validateTaskGraph(spec, graph).length === 0, "invalid task graph");
check(validateWorkflow(workflow).length === 0, "invalid workflow");
check(graph.specHash === hash(canonical(spec)), "spec hash mismatch");
check(graph.planHash === hash(plan), "plan hash mismatch");
check(PlanSchema.safeParse({ schemaVersion: 1, markdown: plan, taskGraph: graph }).success, "invalid plan envelope");
for (const section of ["Context", "Decisions", "Components", "Data", "Verification", "Risks"]) check(plan.includes(`## ${section}`), `missing ${section}`);
const outputByStage: Record<string, string> = { research: "research", specify: "spec", plan: "plan", analyze: "analysis", review: "review", converge: "convergence" };
for (const stage of workflow.stages) {
  if (stage.profileId) {
    const profile = profiles.find((p) => p.id === stage.profileId);
    check(profile, `unknown profile ${stage.profileId}`);
    check(profile.output === outputByStage[stage.kind], `wrong output for ${stage.id}`);
  }
}
for (const task of graph.tasks) {
  check(profiles.some((p) => p.id === task.profileId && p.output === "implementation"), "task profile mismatch");
  for (const id of task.checkIds) check(policy.checks.some((c) => c.id === id && c.scope === "task"), "unknown task check");
}
check(new Set(policy.checks.map((c) => c.id)).size === policy.checks.length, "duplicate check ID");
for (const id of Object.values(policy.reviewProfiles).filter((id) => id !== null)) check(profiles.some((p) => p.id === id && p.output === "review"), `invalid review profile ${id}`);
check(workflow.stages.find((s) => s.kind === "review")?.profileId === policy.reviewProfiles.correctness, "correctness profile mismatch");
check(profiles.some((p) => p.id === policy.skepticProfileId && p.output === "refutation"), "skeptic profile mismatch");
for (const profile of profiles) {
  check(profile.allowedTools.every((t) => policy.allowedTools.includes(t)), `profile tool not in example policy: ${profile.id}`);
  if (profile.role !== "implementer") check(!profile.allowedTools.some((t) => ["edit_file", "multi_edit", "shell"].includes(t)), `writer tool in read-only profile ${profile.id}`);
}
const firstTask = graph.tasks[0];
check(firstTask, "missing first task");
check(validateTaskGraph(spec, { ...graph, tasks: [{ ...firstTask, dependsOn: [firstTask.id] }] }).some((e) => e.includes("cycle")), "cycle accepted");
check(validateTaskGraph(spec, { ...graph, tasks: [{ ...firstTask, dependsOn: ["T999"] }] }).some((e) => e.includes("unknown dependency")), "unknown dependency accepted");
check(validateTaskGraph(spec, { ...graph, tasks: [{ ...firstTask, criterionIds: ["AC-999"] }] }).some((e) => e.includes("unknown criterion")), "unknown criterion accepted");
check(validateTaskGraph(spec, { ...graph, tasks: [] }).some((e) => e.includes("uncovered")), "coverage gap accepted");
check(validateTaskGraph(spec, { ...graph, tasks: [firstTask, firstTask] }).some((e) => e.includes("duplicate")), "duplicate task accepted");
check(validateWorkflow({ ...workflow, stages: workflow.stages.filter((s) => s.kind !== "approve") }).length > 0, "missing approve accepted");
for (const path of ["../secret", "C:/secret", "/tmp/file", "src\\file", "a/../b", "a//b", "file:stream", "a\0b"]) check(!RelativePath.safeParse(path).success, `unsafe relative path accepted: ${path}`);
check(!SpecSchema.safeParse({ ...spec, execute: "shell" }).success, "unknown spec key accepted");
check(!PolicySchema.safeParse({ ...policy, maxConcurrentWriters: 2 }).success, "v1 multiple writers accepted");
check(ResearchSchema.safeParse({ schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [], constraints: [], suggestedScope: [] }).success, "research result rejected");
check(AnalysisSchema.safeParse({ schemaVersion: 1, inputHash: graph.specHash, verdict: "pass", findings: [] }).success, "analysis result rejected");
check(ImplementationSchema.safeParse({ schemaVersion: 1, taskId: "T001", outcome: "already_satisfied", summary: "Fixture only", evidenceIds: ["e1"], unresolved: [] }).success, "implementation result rejected");
check(ReviewSchema.safeParse({ schemaVersion: 1, snapshotHash: graph.specHash, verdict: "inconclusive", coverage: [], findings: [] }).success, "inconclusive review rejected");
check(!ReviewSchema.safeParse({ schemaVersion: 1, snapshotHash: graph.specHash, verdict: "green", coverage: [], findings: [] }).success, "invalid review verdict accepted");
check(!RefutationSchema.safeParse({ schemaVersion: 1, findingId: "f1", decision: "refuted", evidenceIds: [], explanation: "No proof" }).success, "refutation without evidence accepted");
check(CorrectionSchema.safeParse({ schemaVersion: 1, parentDigest: graph.specHash, parentGraphHash: graph.specHash, rule: "bounded-correction", newGraphHash: graph.specHash, findingIds: ["f1"], taskIds: ["T004"], roundKind: "repair", round: 1 }).success, "correction envelope rejected");
const event = { schemaVersion: 1, eventId: "event-1", runId: "run-1", seq: 1, at: "2026-10-08T12:00:00.000Z", type: "run.created", payload: { featureId: spec.featureId, inputHash: graph.specHash } };
check(EventSchema.safeParse(event).success, "event rejected");
check(!EventSchema.safeParse({ ...event, payload: { command: "unexpected" } }).success, "wrong event payload accepted");
check(InputManifestSchema.safeParse({ schemaVersion: 1, featureId: spec.featureId, workflowHash: hash(canonical(workflow)), policyHash: hash(canonical(policy)), profileHashes: Object.fromEntries(profiles.map((p) => [p.id, hash(canonical(p))])), skillHashes: {}, instructionHashes: [], constitutionHash: null, specHash: graph.specHash, planHash: graph.planHash, rootGraphHash: null, effectiveGraphHash: null, correctionHashes: [], baselineSnapshotId: null, dependencyContracts: [] }).success, "candidate input manifest rejected");
check(validateWorkflow({ ...workflow, stages: workflow.stages.map((s, i) => i === 0 ? { ...s, id: "task-reserved" } : s) }).length > 0, "reserved child stage ID accepted");

const db = new Database(":memory:");
db.exec(readFileSync(join(root, "storage.sql"), "utf8"));
const sha = graph.specHash;
db.run("INSERT INTO features VALUES (?, ?, ?)", ["f1", "specs/f1", 1]);
db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r1','f1','created','{}','[]','{}','{}',?,1,1)", [sha]);
db.run("INSERT INTO runs (id,feature_id,status,definition_json,profiles_json,policy_json,input_manifest_json,input_hash,created_at,updated_at) VALUES ('r2','f1','created','{}','[]','{}','{}',?,1,1)", [sha]);
rejected(() => db.run("UPDATE runs SET status='done' WHERE id='r1'"), "invalid run state accepted by SQL");
db.run("INSERT INTO steps (run_id,id,stage_id,generation,status,input_hash) VALUES ('r1','parent','implement',0,'running',?)", [sha]);
db.run("INSERT INTO steps (run_id,id,stage_id,parent_step_id,generation,status,input_hash) VALUES ('r1','child','task-T001','parent',0,'pending',?)", [sha]);
rejected(() => db.run("INSERT INTO steps (run_id,id,stage_id,parent_step_id,generation,status,input_hash) VALUES ('r2','bad','task-T001','parent',0,'pending',?)", [sha]), "cross-run step parent accepted");
db.run("INSERT INTO artifacts VALUES ('r1','a1','review','review.json',1,?,2,'{}',NULL,1)", [sha]);
rejected(() => db.run("UPDATE artifacts SET inline_content='bad' WHERE id='a1'"), "artifact mutation accepted");
rejected(() => db.run("INSERT INTO artifacts VALUES ('r1','a2','review','other.json',1,?,2,NULL,NULL,1)", [sha]), "missing content accepted");
db.run("INSERT INTO workspace_snapshots VALUES ('r1','s1',?,'{}',NULL,1)", [sha]);
db.run("INSERT INTO evidence VALUES ('r1','e1','review','s1','a1',NULL,'current',1)");
rejected(() => db.run("INSERT INTO evidence VALUES ('r2','bad','review','s1','a1',NULL,'current',1)"), "cross-run evidence accepted");
db.run("INSERT INTO check_results VALUES ('r1','c1','typecheck','e1','passed',0,'exit',1)");
rejected(() => db.run("INSERT INTO check_results VALUES ('r1','c2','typecheck','e1','passed',1,'exit',1)"), "failed check accepted as passed");
rejected(() => db.run("INSERT INTO check_results VALUES ('r1','c3','typecheck','e1','passed',NULL,'unknown',1)"), "unknown check accepted as passed");
db.run("INSERT INTO tasks VALUES ('r1','T001','{}',?,'pending',0,NULL,1)", [sha]);
rejected(() => db.run("INSERT INTO task_dependencies VALUES ('r1','T001','T001')"), "self dependency accepted");
rejected(() => db.run("INSERT INTO task_dependencies VALUES ('r1','T001','T999')"), "dangling dependency accepted");
db.run("INSERT INTO events VALUES ('r1',1,'event-1','run.created',1,'{}')");
rejected(() => db.run("UPDATE events SET type='changed' WHERE id='event-1'"), "event mutation accepted");
rejected(() => db.run("INSERT INTO events VALUES ('r1',1,'event-2','run.created',1,'{}')"), "duplicate seq accepted");
const updated = db.run("UPDATE runs SET revision=revision+1 WHERE id='r1' AND revision=0");
const stale = db.run("UPDATE runs SET revision=revision+1 WHERE id='r1' AND revision=0");
check(updated.changes === 1 && stale.changes === 0, "SQL CAS failed");
for (const [table, statuses] of [["runs", RunStatus.options], ["steps", StepStatus.options], ["tasks", TaskStatus.options]] as const) {
  const row = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name=?").get(table);
  check(row, `missing table ${table}`);
  for (const status of statuses) check(row.sql.includes(`'${status}'`), `${table} missing ${status}`);
}
const fk = db.query("PRAGMA foreign_key_check").all();
check(fk.length === 0, "foreign key consistency failed");
db.close();

// --- Workflow v2 design: gate library, presets, invariants and migration from v1 ---
const v2Root = join(examples, "v2");
const library = new Map<string, Gate>();
for (const name of readdirSync(join(v2Root, "gates"))) {
  const gate = GateSchema.parse(JSON.parse(readFileSync(join(v2Root, "gates", name), "utf8")));
  check(name === gate.id + ".json", "gate file name differs from its ID: " + name);
  check(validateGate(gate).length === 0, "invalid gate " + gate.id + ": " + validateGate(gate).join("; "));
  library.set(gate.id, gate);
}
check(library.size === 9, "unexpected gate library size");
check(["command", "human", "ai-review", "ai-acceptance"].every((type) => [...library.values()].some((g) => g.type === type)), "the library lacks a gate type");
const presets = new Map<string, WorkflowV2>();
for (const name of readdirSync(join(v2Root, "presets"))) {
  const definition = WorkflowV2Schema.parse(JSON.parse(readFileSync(join(v2Root, "presets", name), "utf8")));
  const errors = validateWorkflowV2(definition, library);
  check(errors.length === 0, "invalid preset " + name + ": " + errors.join("; "));
  presets.set(name.replace(/\.json$/, ""), definition);
}
for (const id of ["quick-fix", "standard", "full", "spike", "review-only"]) check(presets.get(id)?.preset === id, "missing preset " + id);
const stageTypes = (id: string): string[] => (presets.get(id)?.stages ?? []).map((st) => st.type);
check(stageTypes("quick-fix").join() === "agent,approval,tasks,check", "quick fix stages differ from plan, approve, implement, checks");
check((presets.get("standard")?.stages ?? []).map((st) => st.id).join() === "research,specify,plan,analyze,approve,implement,checks,review", "standard stages differ");
check(stageTypes("full").includes("reflection") && stageTypes("full").at(-1) === "learn", "full lacks convergence or learn");
check((presets.get("full")?.stages.find((st) => st.type === "review") as { gates: { gateId: string }[] }).gates.some((g) => g.gateId === "security-review"), "full lacks the security review");
for (const id of ["spike", "review-only"]) check((presets.get(id)?.stages ?? []).every((st) => st.effects === "none"), id + " can change files");
for (const [id, definition] of presets) if (definition.stages.some((st) => st.effects === "workspace-write")) check(definition.stages.some((st) => st.type === "approval"), id + " writes without an approval stage");
check(presets.get("quick-fix-auto")?.autoApproval?.allowNewDependencies === false, "auto approval can allow new dependencies");

// The built-in sdd read through the migration function is the sdd-v1-equivalent preset.
const skeleton = (d: WorkflowV2) => JSON.stringify({
  stages: d.stages.map((st) => [st.id, st.type, "profileId" in st ? st.profileId : null, st.produces, st.effects]),
  transitions: d.transitions.map((t) => [t.from, t.to, t.on, t.carries, t.loop?.maxIterations ?? 0]),
});
const upgraded = upgradeWorkflowV1(workflow, policy);
const checkLibrary = new Map(library);
for (const c of policy.checks) checkLibrary.set(c.id, GateSchema.parse({
  schemaVersion: 1, id: c.id, description: "From the v1 policy.", required: c.required, scope: c.scope, timeoutMs: c.timeoutMs,
  retries: { max: 0, retryOn: [] }, evidence: { kind: "exit", keepOutputLines: 40, artifactPaths: [] }, type: "command",
  command: { executable: c.executable, args: c.args, cwd: c.cwd, envNames: c.envNames, writes: c.writes },
}));
check(validateWorkflowV2(upgraded, checkLibrary).length === 0, "upgraded sdd is invalid: " + validateWorkflowV2(upgraded, checkLibrary).join("; "));
check(skeleton(upgraded) === skeleton(presets.get("sdd-v1-equivalent") as WorkflowV2), "the migration does not reproduce the sdd preset");
check(upgraded.stages.map((st) => st.id).join() === workflow.stages.map((st) => st.id).join(), "the migration changed the v1 stage order");
check(upgraded.transitions.filter((t) => t.loop).every((t) => workflow.stages.find((st) => st.id === t.from)?.repairTo === t.to), "the migration changed a repair target");
check(upgraded.transitions.find((t) => t.from === "implement" && t.on === "passed")?.gates.map((g) => g.gateId).join() === "status-tests", "task checks are not bound to the transition after the tasks stage");
check((upgraded.stages.find((st) => st.id === "checks") as { gates: { gateId: string }[] }).gates.map((g) => g.gateId).join() === "typecheck,lint,tests", "feature checks are not the gates of the check stage");

// Negative cases: each unsafe or contradictory edit must be rejected, with a reason.
const standard = presets.get("standard") as WorkflowV2;
const mutate = (base: WorkflowV2, edit: (draft: WorkflowV2) => void): string[] => {
  const draft = structuredClone(base);
  edit(draft);
  const parsed = WorkflowV2Schema.safeParse(draft);
  return parsed.success ? validateWorkflowV2(parsed.data, library) : ["schema: " + parsed.error.issues[0]?.message];
};
const rejects = (errors: string[], part: string, message: string): void => check(errors.some((e) => e.includes(part)), message + "; got: " + (errors.join(" | ") || "no error"));
rejects(mutate(standard, (d) => { const t = d.transitions.find((x) => x.id === "analyze-approve"); if (t) t.to = "implement"; }), "can run without an approval", "a path around the approval was accepted");
rejects(mutate(standard, (d) => { d.stages = d.stages.map((st) => (st.type === "approval" ? { ...st, covers: ["plan"] } : st)); }), "does not write", "an approval of a non-writing stage was accepted");
rejects(mutate(standard, (d) => { for (const t of d.transitions) if (t.id === "checks-repair") delete t.loop; }), "not a bounded loop", "an unbounded loop was accepted");
rejects(mutate(standard, (d) => { const t = d.transitions.find((x) => x.id === "research-specify"); if (t) t.carries = "spec"; }), "carries spec but", "a wrong contract was accepted");
rejects(mutate(standard, (d) => { const st = d.stages.find((x) => x.id === "research"); if (st) st.consumes = ["spec"]; }), "which some path does not produce", "a contract that nobody produced was accepted");
rejects(mutate(standard, (d) => { d.transitions = d.transitions.filter((x) => x.id !== "review-done"); }), "no passed transition", "a stage without a passed transition was accepted");
rejects(mutate(standard, (d) => { d.transitions = d.transitions.filter((x) => x.id !== "plan-analyze"); }), "unreachable", "an unreachable stage was accepted");
rejects(mutate(standard, (d) => { const t = d.transitions.find((x) => x.id === "checks-review"); if (t) t.gates = [{ gateId: "task-tests" }]; }), "only follows a tasks stage", "a task gate after a non-task stage was accepted");
rejects(mutate(standard, (d) => { const st = d.stages.find((x) => x.type === "review"); if (st && st.type === "review") st.gates = [{ gateId: "tests" }]; }), "ai-review gates only", "a review stage with a command gate was accepted");
rejects(mutate(standard, (d) => { const st = d.stages.find((x) => x.type === "check"); if (st && st.type === "check") st.gates = [{ gateId: "correctness-review" }]; }), "command gates only", "a check stage with a review gate was accepted");
rejects(mutate(standard, (d) => { const t = d.transitions.find((x) => x.id === "plan-analyze"); if (t) t.gates = [{ gateId: "no-such-gate" }]; }), "unknown gate", "an unknown gate was accepted");
rejects(mutate(standard, (d) => { d.transitions.push({ id: "extra", from: "research", to: "plan", on: "failed", carries: "research", gates: [] }); }), "cannot end failed", "an impossible outcome was accepted");
rejects(mutate(standard, (d) => { d.transitions.push({ id: "extra", from: "review", to: "done", on: "passed", carries: "review", gates: [] }); }), "two unconditional", "an ambiguous transition was accepted");
rejects(mutate(standard, (d) => { d.stages.push({ id: "task-extra", type: "learn", consumes: [], produces: "report", effects: "none" }); }), "reserved stage ID", "a reserved stage ID was accepted");
rejects(mutate(presets.get("quick-fix-auto") as WorkflowV2, (d) => { d.autoApproval = null; }), "without autoApproval limits", "auto approval without limits was accepted");
rejects(mutate(presets.get("quick-fix-auto") as WorkflowV2, (d) => { (d.autoApproval as unknown as Record<string, unknown>).allowNewDependencies = true; }), "schema", "auto approval of new dependencies was accepted");
rejects(mutate(standard, (d) => { (d as unknown as Record<string, unknown>).hooks = ["run.sh"]; }), "schema", "an unknown field was accepted");
rejects(mutate(standard, (d) => { d.limits.maxStageVisits = 3; }), "lower than the number of stages", "a visit cap below the stage count was accepted");
rejects(mutate(presets.get("review-only") as WorkflowV2, (d) => { d.inputs = ["request"]; }), "consumes diff", "a diff consumer without a diff input was accepted");
const walkthrough = library.get("cli-walkthrough") as Gate;
const withGate = (patch: (g: Record<string, unknown>) => void): string[] => {
  const draft = structuredClone(walkthrough) as unknown as Record<string, unknown>;
  patch(draft);
  const parsed = GateSchema.safeParse(draft);
  return parsed.success ? validateGate(parsed.data) : ["schema: " + parsed.error.issues[0]?.message];
};
rejects(withGate((g) => { g.required = true; }), "advisory until its test is promoted", "a required AI walk-through was accepted");
rejects(withGate((g) => { (g.acceptance as { capabilities: { outboundHosts: string[] } }).capabilities.outboundHosts = ["*.example.com"]; }), "exact", "a wildcard outbound host was accepted");
rejects(withGate((g) => { const c = (g.acceptance as { capabilities: { spawnApp: boolean; listenPorts: number[] } }).capabilities; c.spawnApp = false; c.listenPorts = [4173]; }), "ports need spawnApp", "ports without spawn were accepted");
rejects(withGate((g) => { (g.acceptance as { capabilities: { listenPorts: number[] } }).capabilities.listenPorts = [80]; }), "schema", "a privileged port was accepted");
rejects(withGate((g) => { (g.acceptance as { capabilities: Record<string, unknown> }).capabilities.shell = true; }), "schema", "an unknown capability was accepted");
rejects(withGate((g) => { (g.acceptance as { promote: { commandGateId: string } }).promote.commandGateId = "cli-walkthrough"; }), "own ID", "a self-promoting gate was accepted");
rejects(withGate((g) => { g.retries = { max: 2, retryOn: ["failed"] }; }), "only command gates may retry", "a retried failed model result was accepted");
check(library.get("acceptance-status-json")?.type === "command", "the promoted example gate is not a command gate");

let localLinks = 0;
let skippedAuditLinks = 0;
// .audit/ holds local run evidence and is gitignored; its links resolve only on the machine that produced it.
const auditDir = resolve(root, "../../.audit");
const hasAuditDir = existsSync(auditDir);
check(readFileSync(join(root, "../../CONTRIBUTING.md"), "utf8").includes("(design/sdd-workflows/README.md)"), "missing architecture entry point");
for (const name of ["README.md", "solution-design.md", "implementation-plan.md", "examples/README.md", "runtime-guide.md", "implementation-status.md", "next-implementation.md", "workflow-v2-design.md"]) {
  const path = join(root, name);
  const text = readFileSync(path, "utf8");
  check(!/[\u2013\u2014]/.test(text), `dash style audit: ${name}`);
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (!target || /^(https?:|#)/.test(target)) continue;
    const local = target.split("#")[0];
    if (local && !hasAuditDir && resolve(dirname(path), local).startsWith(auditDir)) {
      skippedAuditLinks++;
      continue;
    }
    check(local && existsSync(resolve(dirname(path), local)), `missing local link: ${name} -> ${target}`);
    localLinks++;
  }
}
console.log(JSON.stringify({ status: "passed", checks, localLinks, skippedAuditLinks, profiles: profiles.length, tasks: graph.tasks.length, scope: "design schemas, examples, SQL constraints and links; no product runtime or LLM execution" }, null, 2));

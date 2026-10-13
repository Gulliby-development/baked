import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import {
  type Gate,
  GateSchema,
  predicateHolds,
  selectTransition,
  type Stage,
  type Transition,
  validateGate,
  validateWorkflowV2,
  type WorkflowV2,
  WorkflowV2Schema,
} from "../src/core/workflows/v2/definition.js";
import {
  builtinPresets,
  instantiatePreset,
  listDefinitions,
  loadDefinition,
} from "../src/core/workflows/v2/definitions.js";
import { checkToGate, gateToCheck, loadGateLibrary } from "../src/core/workflows/v2/library.js";
import { workflowLine } from "../src/core/workflows/v2/line.js";
import { checksOf, frozenGates } from "../src/core/workflows/v2/runtime.js";
import { upgradeWorkflowV1 } from "../src/core/workflows/v2/upgrade.js";

const examples = join(import.meta.dir, "fixtures", "workflow-v2");
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-v2-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const check = (id: string, scope: "task" | "feature") => ({
  id,
  executable: "bun",
  args: ["test"],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope,
  envNames: [],
  writes: [],
});
const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [
    check("typecheck", "feature"),
    check("lint", "feature"),
    check("tests", "feature"),
    check("task-tests", "task"),
  ],
};
function exampleLibrary(): Map<string, Gate> {
  const library = new Map<string, Gate>();
  for (const name of readdirSync(join(examples, "gates"))) {
    const gate = GateSchema.parse(JSON.parse(readFileSync(join(examples, "gates", name), "utf8")));
    library.set(gate.id, gate);
  }
  return library;
}
const examplePreset = (name: string): WorkflowV2 =>
  WorkflowV2Schema.parse(JSON.parse(readFileSync(join(examples, "presets", `${name}.json`), "utf8")));

describe("v2 definitions and presets (V2-01, V2-04)", () => {
  test("every example gate and preset is valid under the runtime validator", () => {
    const library = exampleLibrary();
    expect(library.size).toBe(9);
    for (const gate of library.values()) expect(validateGate(gate)).toEqual([]);
    for (const name of readdirSync(join(examples, "presets")))
      expect(validateWorkflowV2(examplePreset(name.replace(/\.json$/, "")), library)).toEqual([]);
  });

  test("the shipped presets have the planned stages and validate against a project's checks", () => {
    const library = loadGateLibrary(workspace(), policy).gates;
    const types = (id: string) =>
      instantiatePreset(builtinPresets.get(id) as WorkflowV2, policy).stages.map((s) => s.type);
    expect([...builtinPresets.keys()].sort()).toEqual(
      ["fix-ci", "full", "quick", "quick-fix", "review-only", "spike", "standard"].sort(),
    );
    for (const preset of builtinPresets.values())
      expect(validateWorkflowV2(instantiatePreset(preset, policy), library)).toEqual([]);
    expect(types("quick-fix")).toEqual(["agent", "approval", "tasks", "check"]);
    // Fix CI reproduces with the same checks it verifies with.
    expect(types("fix-ci")).toEqual(["check", "agent", "agent", "approval", "tasks", "check"]);
    const fixCi = instantiatePreset(builtinPresets.get("fix-ci") as WorkflowV2, policy);
    const gatesOf = (id: string) =>
      (fixCi.stages.find((s) => s.id === id) as Stage & { gates: { gateId: string }[] }).gates;
    expect(gatesOf("reproduce")).toEqual(gatesOf("verify"));
    expect(types("quick")).toEqual(["agent", "approval", "tasks", "check", "review"]);
    expect(builtinPresets.get("quick")?.publish).toBe(false);
    expect(builtinPresets.get("standard")?.stages.map((s) => s.id)).toEqual([
      "research",
      "specify",
      "plan",
      "analyze",
      "approve",
      "implement",
      "checks",
      "review",
    ]);
    expect(types("full").includes("reflection") && types("full").at(-1) === "learn").toBe(true);
    for (const id of ["spike", "review-only"])
      expect(builtinPresets.get(id)?.stages.every((s) => s.effects === "none")).toBe(true);
  });

  test("a preset uses the project's checks in place of the example gates", () => {
    const instantiated = instantiatePreset(builtinPresets.get("quick-fix") as WorkflowV2, policy);
    const checks = instantiated.stages.find((s) => s.type === "check") as Stage & {
      gates: { gateId: string }[];
    };
    expect(checks.gates.map((g) => g.gateId)).toEqual(["typecheck", "lint", "tests"]);
    expect(
      instantiated.transitions.find((t) => t.from === "implement")?.gates.map((g) => g.gateId),
    ).toEqual(["task-tests"]);
    const bare = instantiatePreset(builtinPresets.get("quick-fix") as WorkflowV2, {
      ...policy,
      checks: [],
    });
    expect(WorkflowV2Schema.safeParse(bare).success).toBe(false);
  });

  test("the built-in sdd read through the migration is the Full preset", () => {
    const skeleton = (d: WorkflowV2) =>
      JSON.stringify({
        stages: d.stages.map((s) => [s.id, s.type, "profileId" in s ? s.profileId : null, s.produces]),
        transitions: d.transitions.map((t) => [t.from, t.to, t.on, t.carries, t.loop?.maxIterations ?? 0]),
      });
    const upgraded = upgradeWorkflowV1(sddWorkflow, policy);
    const library = loadGateLibrary(workspace(), policy).gates;
    expect(validateWorkflowV2(upgraded, library)).toEqual([]);
    expect(skeleton(upgraded)).toBe(
      skeleton(instantiatePreset(builtinPresets.get("full") as WorkflowV2, policy)),
    );
    expect(upgraded.stages.map((s) => s.id)).toEqual(sddWorkflow.stages.map((s) => s.id));
    for (const t of upgraded.transitions.filter((x) => x.loop))
      expect(sddWorkflow.stages.find((s) => s.id === t.from)?.repairTo).toBe(t.to);
    expect(upgraded.transitions.find((t) => t.from === "implement")?.gates).toEqual([
      { gateId: "task-tests" },
    ]);
  });
});

describe("rejected definitions (V2-02)", () => {
  const library = exampleLibrary();
  const standard = examplePreset("standard");
  const mutate = (base: WorkflowV2, edit: (draft: WorkflowV2) => void): string[] => {
    const draft = structuredClone(base);
    edit(draft);
    const parsed = WorkflowV2Schema.safeParse(draft);
    return parsed.success
      ? validateWorkflowV2(parsed.data, library)
      : [`schema: ${parsed.error.issues[0]?.message}`];
  };
  const edge = (d: WorkflowV2, id: string) => d.transitions.find((t) => t.id === id) as Transition;
  const cases: [string, WorkflowV2, (d: WorkflowV2) => void, string][] = [
    ["a path around the approval", standard, (d) => { edge(d, "analyze-approve").to = "implement"; }, "can run without an approval"],
    ["an approval of a non-writing stage", standard, (d) => { d.stages = d.stages.map((s) => (s.type === "approval" ? { ...s, covers: ["plan"] } : s)); }, "does not write"],
    ["an unbounded loop", standard, (d) => { delete edge(d, "checks-repair").loop; }, "not a bounded loop"],
    ["a wrong contract", standard, (d) => { edge(d, "research-specify").carries = "spec"; }, "carries spec but"],
    ["a contract nobody produced", standard, (d) => { (d.stages[0] as Stage).consumes = ["spec"]; }, "which some path does not produce"],
    ["a stage without a passed transition", standard, (d) => { d.transitions = d.transitions.filter((t) => t.id !== "review-done"); }, "no passed transition"],
    ["an unreachable stage", standard, (d) => { d.transitions = d.transitions.filter((t) => t.id !== "plan-analyze"); }, "unreachable"],
    ["a task gate after a non-task stage", standard, (d) => { edge(d, "checks-review").gates = [{ gateId: "task-tests" }]; }, "only follows a tasks stage"],
    ["a review stage with a command gate", standard, (d) => { const s = d.stages.find((x) => x.type === "review"); if (s?.type === "review") s.gates = [{ gateId: "tests" }]; }, "ai-review gates only"],
    ["a check stage with a review gate", standard, (d) => { const s = d.stages.find((x) => x.type === "check"); if (s?.type === "check") s.gates = [{ gateId: "correctness-review" }]; }, "command gates only"],
    ["an unknown gate", standard, (d) => { edge(d, "plan-analyze").gates = [{ gateId: "no-such-gate" }]; }, "unknown gate"],
    ["an impossible outcome", standard, (d) => { d.transitions.push({ id: "extra", from: "research", to: "plan", on: "failed", carries: "research", gates: [] }); }, "cannot end failed"],
    ["an ambiguous transition", standard, (d) => { d.transitions.push({ id: "extra", from: "review", to: "done", on: "passed", carries: "review", gates: [] }); }, "two unconditional"],
    ["a reserved stage ID", standard, (d) => { d.stages.push({ id: "task-extra", type: "learn", consumes: [], produces: "report", effects: "none" }); }, "reserved stage ID"],
    ["auto approval without limits", examplePreset("quick-fix-auto"), (d) => { d.autoApproval = null; }, "without autoApproval limits"],
    ["auto approval of new dependencies", examplePreset("quick-fix-auto"), (d) => { (d.autoApproval as unknown as Record<string, unknown>).allowNewDependencies = true; }, "schema"],
    ["an unknown field", standard, (d) => { (d as unknown as Record<string, unknown>).hooks = ["run.sh"]; }, "schema"],
    ["a visit cap below the stage count", standard, (d) => { d.limits.maxStageVisits = 3; }, "lower than the number of stages"],
    ["a diff consumer without a diff input", examplePreset("review-only"), (d) => { d.inputs = ["request"]; }, "consumes diff"],
    ["an AI review gate on a transition", standard, (d) => { edge(d, "plan-analyze").gates = [{ gateId: "correctness-review" }]; }, "belongs to a review stage"],
    ["a required AI walk-through binding", standard, (d) => { edge(d, "checks-review").gates = [{ gateId: "cli-walkthrough", mode: "required" }]; }, "cannot be required"],
  ];
  for (const [name, base, edit, reason] of cases)
    test(`rejects ${name}`, () => {
      const errors = mutate(base, edit);
      expect(errors.some((e) => e.includes(reason)), errors.join(" | ") || "no error").toBe(true);
    });

  const walkthrough = library.get("cli-walkthrough") as Gate;
  const gateCases: [string, (g: Record<string, unknown>) => void, string][] = [
    ["a required AI walk-through", (g) => { g.required = true; }, "advisory until its test is promoted"],
    ["a wildcard outbound host", (g) => { (g.acceptance as { capabilities: { outboundHosts: string[] } }).capabilities.outboundHosts = ["*.example.com"]; }, "exact"],
    ["ports without spawn", (g) => { const c = (g.acceptance as { capabilities: { spawnApp: boolean; listenPorts: number[] } }).capabilities; c.spawnApp = false; c.listenPorts = [4173]; }, "ports need spawnApp"],
    ["a privileged port", (g) => { (g.acceptance as { capabilities: { listenPorts: number[] } }).capabilities.listenPorts = [80]; }, "schema"],
    ["an unknown capability", (g) => { (g.acceptance as { capabilities: Record<string, unknown> }).capabilities.shell = true; }, "schema"],
    ["a self-promoting gate", (g) => { (g.acceptance as { promote: { commandGateId: string } }).promote.commandGateId = "cli-walkthrough"; }, "own ID"],
    ["a retried model result", (g) => { g.retries = { max: 2, retryOn: ["failed"] }; }, "only command gates may retry"],
  ];
  for (const [name, patch, reason] of gateCases)
    test(`rejects ${name}`, () => {
      const draft = structuredClone(walkthrough) as unknown as Record<string, unknown>;
      patch(draft);
      const parsed = GateSchema.safeParse(draft);
      const errors = parsed.success ? validateGate(parsed.data) : [`schema: ${parsed.error.issues[0]?.message}`];
      expect(errors.some((e) => e.includes(reason)), errors.join(" | ") || "no error").toBe(true);
    });
});

describe("wait stages", () => {
  const library = exampleLibrary();
  const tests = library.get("tests") as Gate;
  const polling: Gate = { ...tests, id: "ci-green", description: "CI is green" } as Gate;
  const writing: Gate = {
    ...polling,
    id: "writes-report",
    command: { ...(polling as Extract<Gate, { type: "command" }>).command, writes: ["report.txt"] },
  } as Gate;
  const gates = new Map([...library, [polling.id, polling], [writing.id, writing]]);
  /** The standard preset with a wait stage after its review. */
  const withWait = (gateIds: string[], edit: (d: WorkflowV2) => void = () => {}): string[] => {
    const draft = structuredClone(examplePreset("standard"));
    draft.stages.push({ id: "wait-ci", type: "wait", consumes: [], produces: "gates", effects: "none", gates: gateIds.map((gateId) => ({ gateId })), intervalSeconds: 30, timeoutMinutes: 60 });
    const done = draft.transitions.find((t) => t.id === "review-done") as Transition;
    done.to = "wait-ci";
    draft.transitions.push({ id: "wait-done", from: "wait-ci", to: "done", on: "passed", carries: "gates", gates: [] });
    draft.limits.maxStageVisits += 1;
    edit(draft);
    const parsed = WorkflowV2Schema.safeParse(draft);
    return parsed.success ? validateWorkflowV2(parsed.data, gates) : [`schema: ${parsed.error.issues[0]?.message}`];
  };

  test("a wait stage polling a command gate is valid; its gates are frozen but are not run checks", () => {
    expect(withWait(["ci-green"])).toEqual([]);
    const draft = structuredClone(examplePreset("standard"));
    draft.stages.push({ id: "wait-ci", type: "wait", consumes: [], produces: "gates", effects: "none", gates: [{ gateId: "ci-green" }], intervalSeconds: 30, timeoutMinutes: 60 });
    expect(frozenGates(draft, gates).map((g) => g.id)).toContain("ci-green");
    expect(checksOf(draft, frozenGates(draft, gates)).map((c) => c.id)).not.toContain("ci-green");
  });
  const cases: [string, string[], (d: WorkflowV2) => void, string][] = [
    ["an AI review gate", ["correctness-review"], () => {}, "a wait stage runs command gates only"],
    ["a task gate", ["task-tests"], () => {}, "runs after each task"],
    ["a gate that writes files", ["writes-report"], () => {}, "write nothing"],
    ["a changes_requested edge", ["ci-green"], (d) => { d.transitions.push({ id: "wait-again", from: "wait-ci", to: "done", on: "changes_requested", carries: "gates", gates: [] }); }, "cannot end changes_requested"],
    ["no gate", [], () => {}, "schema"],
    ["a poll faster than 5 seconds", ["ci-green"], (d) => { const w = d.stages.find((x) => x.type === "wait"); if (w?.type === "wait") w.intervalSeconds = 4; }, "schema"],
    ["a timeout over a day", ["ci-green"], (d) => { const w = d.stages.find((x) => x.type === "wait"); if (w?.type === "wait") w.timeoutMinutes = 1441; }, "schema"],
  ];
  for (const [name, ids, edit, reason] of cases)
    test(`rejects ${name}`, () => {
      const errors = withWait(ids, edit);
      expect(errors.some((e) => e.includes(reason)), errors.join(" | ") || "no error").toBe(true);
    });
});

describe("approval invariant on generated graphs (V2-03)", () => {
  // A small deterministic generator, so a failure names a reproducible seed.
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** An independent search: is there a forward path from the entry to a writer avoiding every covering approval? */
  function bypassExists(d: WorkflowV2): boolean {
    for (const writer of d.stages.filter((s) => s.effects === "workspace-write")) {
      const covering = new Set(
        d.stages.filter((s) => s.type === "approval" && s.covers.includes(writer.id)).map((s) => s.id),
      );
      const queue = [d.entry];
      const seen = new Set<string>();
      while (queue.length) {
        const id = queue.shift() as string;
        if (seen.has(id) || covering.has(id)) continue;
        seen.add(id);
        if (id === writer.id) return true;
        for (const t of d.transitions) if (t.from === id && !t.loop && t.to !== "done") queue.push(t.to);
      }
    }
    return false;
  }
  test("the validator accepts no graph with a path to a writer that avoids its approval", () => {
    let accepted = 0;
    let bypassing = 0;
    for (let seed = 1; seed <= 10000; seed++) {
      const next = random(seed);
      const count = 2 + Math.floor(next() * 5);
      const stages: Stage[] = [];
      for (let i = 0; i < count; i++) {
        const kind = next();
        const id = `s${i}`;
        if (kind < 0.25) stages.push({ id, type: "tasks", consumes: [], produces: "implementation", effects: "workspace-write" });
        else if (kind < 0.5) stages.push({ id, type: "approval", consumes: ["plan"], produces: "decision", effects: "none", decision: "human", covers: ["s0"] });
        else stages.push({ id, type: "agent", profileId: "planner", consumes: [], produces: "plan", effects: "none" });
      }
      const writers = stages.filter((s) => s.type === "tasks").map((s) => s.id);
      for (const s of stages) if (s.type === "approval") s.covers = writers.length ? writers.filter(() => next() < 0.8) : ["s0"];
      for (const s of stages) if (s.type === "approval" && s.covers.length === 0) s.covers = writers.length ? [writers[0] as string] : ["s0"];
      const transitions: Transition[] = [];
      stages.forEach((s, i) => {
        const forward = stages.slice(i + 1);
        const target = forward.length && next() < 0.85 ? (forward[Math.floor(next() * forward.length)] as Stage).id : "done";
        transitions.push({ id: `t${i}`, from: s.id, to: target, on: "passed", carries: s.produces, gates: [] });
      });
      const definition: WorkflowV2 = {
        schemaVersion: 2, id: "generated", version: "1.0.0", description: "Generated", preset: "custom",
        inputs: ["request"], entry: "s0", stages, transitions, limits: { maxStageVisits: 40 }, autoApproval: null,
      };
      const errors = validateWorkflowV2(definition, new Map());
      const bypass = bypassExists(definition);
      if (bypass) {
        bypassing++;
        expect(errors.some((e) => e.includes("without an approval")), `seed ${seed}`).toBe(true);
      }
      if (errors.length === 0) {
        accepted++;
        expect(bypass, `seed ${seed}`).toBe(false);
      }
    }
    // The generator must exercise both sides, or the property says nothing.
    expect(accepted).toBeGreaterThan(100);
    expect(bypassing).toBeGreaterThan(100);
  });
});

describe("gate library", () => {
  test("project gates override user, policy and built-in gates and record what they shadow", () => {
    const root = workspace();
    const user = join(root, "user-gates");
    const project = join(root, "baked", "gates");
    mkdirSync(user, { recursive: true });
    mkdirSync(project, { recursive: true });
    const tests = { ...checkToGate(check("tests", "feature")), description: "User tests." };
    writeFileSync(join(user, "tests.json"), JSON.stringify(tests));
    writeFileSync(join(project, "tests.json"), JSON.stringify({ ...tests, description: "Project tests." }));
    writeFileSync(join(project, "broken.json"), "{");
    writeFileSync(join(project, "renamed.json"), JSON.stringify({ ...tests, id: "other" }));
    const library = loadGateLibrary(root, policy, { user, project });
    const entry = library.entries.get("tests");
    expect(entry?.source).toBe("project");
    expect(entry?.gate.description).toBe("Project tests.");
    expect(entry?.shadows.map((s) => s.source)).toEqual(["policy", "user"]);
    expect(library.entries.get("correctness-review")?.source).toBe("builtin");
    expect(library.gates.has("other")).toBe(false);
    expect(library.problems.length).toBe(2);
  });

  test("a command gate runs as the check it came from, with the binding's mode", () => {
    const original = check("lint", "feature");
    const gate = checkToGate(original);
    expect(gateToCheck(gate)).toEqual(original);
    expect(gateToCheck(gate, { gateId: "lint", mode: "advisory" }).required).toBe(false);
  });

  test("the security review gate follows forceSecurityReview", () => {
    const forced = loadGateLibrary(workspace(), { ...policy, forceSecurityReview: true });
    const gate = forced.gates.get("security-review");
    expect(gate?.type === "ai-review" && gate.review.appliesWhen).toBe("always");
  });
});

describe("definitions on disk", () => {
  test("project files of both schema versions, the built-in sdd and the presets load by ID", () => {
    const root = workspace();
    const directory = join(root, "baked", "workflows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "legacy.json"), JSON.stringify({ ...sddWorkflow, id: "legacy" }));
    writeFileSync(
      join(directory, "mine.json"),
      JSON.stringify({ ...instantiatePreset(builtinPresets.get("quick-fix") as WorkflowV2, policy), id: "mine", preset: "custom" }),
    );
    writeFileSync(join(directory, "bad.json"), JSON.stringify({ schemaVersion: 2, id: "bad" }));
    expect(loadDefinition(root, "legacy", policy).schemaVersion).toBe(1);
    expect(loadDefinition(root, "mine", policy).schemaVersion).toBe(2);
    expect(loadDefinition(root, "sdd", policy).schemaVersion).toBe(1);
    expect(loadDefinition(root, "spike", policy).schemaVersion).toBe(2);
    expect(() => loadDefinition(root, "missing", policy)).toThrow("Unknown workflow");
    const listed = listDefinitions(root, policy);
    expect(listed.map((d) => d.id)).toEqual([
      "sdd", "quick", "quick-fix", "standard", "full", "spike", "review-only", "fix-ci", "bad", "legacy", "mine",
    ]);
    expect(listed.filter((d) => d.problems.length).map((d) => d.id)).toEqual(["bad"]);
    expect(listed.find((d) => d.id === "spike")?.writes).toBe(false);
    expect(listed.find((d) => d.id === "review-only")?.worktreeRefusal).toContain("runs inline");
    expect(listed.find((d) => d.id === "standard")?.worktreeRefusal).toBeNull();
    expect(listed.find((d) => d.id === "bad")?.line).toEqual({ stages: [], loops: [] });
  });

  test("each summary carries the workflow as a line of contracts with its repair loops", () => {
    const root = workspace();
    const standard = listDefinitions(root, policy).find((d) => d.id === "standard");
    expect(standard?.line.stages.map((s) => `${s.id}:${s.type}>${s.produces}`)).toEqual([
      "research:agent>research",
      "specify:agent>spec",
      "plan:agent>plan",
      "analyze:agent>analysis",
      "approve:approval>decision",
      "implement:tasks>implementation",
      "checks:check>gates",
      "review:review>review",
    ]);
    expect(standard?.line.stages.find((s) => s.id === "analyze")?.consumes).toEqual(["spec", "plan"]);
    expect(standard?.line.stages.filter((s) => s.human).map((s) => s.id)).toEqual(["approve"]);
    expect(standard?.line.loops).toEqual([
      { from: "checks", to: "implement", on: "failed", carries: "gates" },
      { from: "review", to: "implement", on: "changes_requested", carries: "review" },
    ]);
    // Schema 1 definitions are drawn through their v2 upgrade.
    expect(listDefinitions(root, policy).find((d) => d.id === "sdd")?.line.stages.length).toBeGreaterThan(0);
  });

  test("the line puts each gate at its station or on the transition it guards, in words", () => {
    const root = workspace();
    const standard = listDefinitions(root, policy).find((d) => d.id === "standard");
    const checks = standard?.line.stages.find((s) => s.id === "checks");
    expect(checks?.gates.filter((g) => g.transition === null).map((g) => `${g.id}:${g.mode}`)).toEqual(
      policy.checks.filter((c) => c.scope === "feature").map((c) => `${c.id}:${c.required ? "required" : "advisory"}`),
    );
    expect(checks?.gates[0]?.does).toStartWith("Runs ");
    const review = standard?.line.stages.find((s) => s.id === "review");
    expect(review?.gates.map((g) => g.type)).toContain("ai-review");
    expect(review?.gates.find((g) => g.id === "correctness-review")?.does).toBe("AI correctness review");
    const definition = instantiatePreset(builtinPresets.get("quick-fix") as WorkflowV2, policy);
    const exit = definition.transitions.find((t) => t.from === "implement");
    if (!exit) throw new Error("quick-fix has no transition from implement");
    const bound = { ...definition, transitions: definition.transitions.map((t) => (t === exit ? { ...t, gates: [...t.gates, { gateId: "missing-gate" }] } : t)) };
    const line = workflowLine(bound, loadGateLibrary(root, policy).gates);
    expect(line.stages.find((s) => s.id === "implement")?.gates.at(-1)).toEqual({
      id: "missing-gate", type: null, mode: "required", does: "Unknown gate: no gate with this ID in the library",
      transition: { id: exit.id, to: exit.to, on: exit.on },
    });
  });
});

describe("transitions", () => {
  test("a condition on the carried contract picks its edge, otherwise the fallback", () => {
    const definition = structuredClone(builtinPresets.get("spike") as WorkflowV2);
    definition.transitions.push({
      id: "report-again",
      from: "report",
      to: "research",
      on: "passed",
      when: { field: "$.recommendation.kind", equals: "research-more" },
      carries: "report",
      gates: [],
      loop: { maxIterations: 1 },
    });
    expect(predicateHolds({ field: "$.verdict", equals: "pass" }, { verdict: "pass" })).toBe(true);
    expect(predicateHolds({ field: "$.a.b", equals: 1 }, { a: null })).toBe(false);
    expect(
      selectTransition(definition, "report", "passed", { recommendation: { kind: "research-more" } })?.id,
    ).toBe("report-again");
    expect(selectTransition(definition, "report", "passed", { recommendation: null })?.id).toBe(
      "report-done",
    );
    expect(selectTransition(definition, "report", "failed", {})).toBeUndefined();
  });
});

describe("definition commands", () => {
  test("define copies a preset as a custom workflow, validate and definitions report it", async () => {
    const { executeDefinitionCommand } = await import("../src/headless/workflow-definitions.js");
    const { parseWorkflowArgs } = await import("../src/headless/workflow-parse.js");
    const root = workspace();
    const run = (argv: string[]) => executeDefinitionCommand(parseWorkflowArgs(argv), root, policy);
    expect(run(["define", "mine", "--from", "quick-fix"]).exitCode).toBe(0);
    const saved = JSON.parse(readFileSync(join(root, "baked", "workflows", "mine.json"), "utf8"));
    expect(saved.preset).toBe("custom");
    expect(() => run(["define", "mine", "--from", "quick-fix"])).toThrow("already exists");
    expect(run(["validate", "mine"]).result).toMatchObject({ id: "mine", schemaVersion: 2, valid: true });
    expect(run(["define", "copy-of-sdd", "--from", "sdd"]).exitCode).toBe(0);
    saved.transitions = saved.transitions.filter((t: { id: string }) => t.id !== "plan-approve");
    writeFileSync(join(root, "broken.json"), JSON.stringify({ ...saved, id: "broken" }));
    const broken = run(["validate", "--file", "broken.json"]);
    expect(broken.exitCode).toBe(1);
    expect((broken.result as { problems: string[] }).problems.join("\n")).toContain("unreachable");
    expect((run(["definitions"]).result as { id: string }[]).map((d) => d.id)).toContain("copy-of-sdd");
    const gates = run(["gates"]).result as { gates: { id: string; source: string }[] };
    expect(gates.gates.find((g) => g.id === "tests")?.source).toBe("policy");
  });
});

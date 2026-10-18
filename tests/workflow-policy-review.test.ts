import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { WorkflowArtifacts } from "../src/core/workflows/artifacts.js";
import { sddWorkflow } from "../src/core/workflows/builtin/sdd.js";
import { assertFrozenInputs } from "../src/core/workflows/context.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { Task } from "../src/core/workflows/types.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "baked-policy-review-"));
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "fixture/model",
    workflows: {
      enabled: true,
      importsEnabled: false,
      defaultWorkflow: "sdd",
      policy: defaultWorkflowPolicy,
    },
  };
  const service = new NativeWorkflowService(root, config);
  return {
    root,
    service,
    close: () => {
      service.leases.release();
      service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const task: Task = {
  id: "T001",
  title: "Create value",
  description: "Create a value file",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: [{ path: "value.txt", action: "create" }],
  readHints: [],
  checkIds: [],
  origin: "planned",
  findingIds: [],
  rationale: "Required behavior",
};

test("create scope rejects existing files for both edit tools", async () => {
  const { root, service, close } = fixture();
  try {
    writeFileSync(join(root, "value.txt"), "before");
    const run = await service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create value",
      ownerLabel: "test",
      policy: defaultWorkflowPolicy,
    });
    const profile = builtinProfiles.find((item) => item.id === "implementer");
    if (!profile) throw new Error("Missing implementer profile");
    service.store.transition(run.runId, "running");
    service.leases.acquire("mutation", run.runId);
    const guard = new WorkflowToolPolicy(
      service.store,
      service.leases,
      run.runId,
      "attempt",
      profile,
      defaultWorkflowPolicy,
      task,
    );
    expect(() =>
      guard.validate("edit_file", {
        path: "value.txt",
        oldString: "before",
        newString: "after",
      }),
    ).toThrow("Create target already exists");
    expect(() =>
      guard.validate("multi_edit", {
        path: "value.txt",
        edits: [{ oldString: "before", newString: "after" }],
      }),
    ).toThrow("Create target already exists");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("before");
    expect(service.store.effects(run.runId)).toHaveLength(0);
  } finally {
    close();
  }
});

test("create scope permits a later edit in the same attempt", async () => {
  const { root, service, close } = fixture();
  try {
    const run = await service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create value",
      ownerLabel: "test",
      policy: defaultWorkflowPolicy,
    });
    const profile = builtinProfiles.find((item) => item.id === "implementer");
    if (!profile) throw new Error("Missing implementer profile");
    service.store.transition(run.runId, "running");
    service.leases.acquire("mutation", run.runId);
    const step = service.store.beginStep(run.runId, "create-value");
    const attempt = service.store.reserve(run.runId, step, profile.model, 10000, defaultWorkflowPolicy);
    const guard = new WorkflowToolPolicy(
      service.store,
      service.leases,
      run.runId,
      attempt,
      profile,
      defaultWorkflowPolicy,
      task,
    );
    await guard.execute("edit_file", { path: "value.txt", oldString: "", newString: "first" }, async () => {
      writeFileSync(join(root, "value.txt"), "first");
      return { success: true };
    });
    expect(guard.validate("multi_edit", { path: "value.txt", edits: [] })).toBe("value.txt");
    await guard.execute("multi_edit", { path: "value.txt", edits: [] }, async () => {
      writeFileSync(join(root, "value.txt"), "second");
      return { success: true };
    });
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("second");
    expect(service.store.effects(run.runId).map((effect) => effect.status)).toEqual([
      "applied",
      "applied",
    ]);
  } finally {
    close();
  }
});

test("revision keeps custom profile and workflow definitions frozen", async () => {
  const { root, service, close } = fixture();
  try {
    const agents = join(root, "baked", "agents");
    const workflows = join(root, "baked", "workflows");
    mkdirSync(agents, { recursive: true });
    mkdirSync(workflows, { recursive: true });
    const profilePath = join(agents, "implementer.json");
    const workflowPath = join(workflows, "sdd.json");
    const profile = builtinProfiles.find((item) => item.id === "implementer");
    if (!profile) throw new Error("Missing implementer profile");
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(workflowPath, JSON.stringify(sddWorkflow));
    const run = await service.start({
      commandId: newId(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create value",
      ownerLabel: "test",
      policy: defaultWorkflowPolicy,
    });
    const spec = {
      schemaVersion: 1 as const,
      featureId: "fixture",
      revision: 1,
      title: "Value",
      problem: "Missing value",
      outcome: "Value exists",
      inScope: ["Create value"],
      outOfScope: [],
      assumptions: [],
      openQuestions: [],
      requirements: [
        { id: "FR-001", text: "Value exists", priority: "must" as const, verification: "automated" as const, sourceRefs: [] },
      ],
      criteria: [
        { id: "AC-001", requirementIds: ["FR-001"], given: "a workspace", when: "task completes", then: "value exists", method: "automated" as const },
      ],
      dependencies: [],
    };
    const plan = "## Context\nValue.\n## Decisions\nDEC-001 FR-001.\n## Components\nvalue.txt\n## Data\nText.\n## Verification\nCheck value.\n## Risks\nNone.";
    const state = service.store.state(run.runId);
    state.spec = spec;
    state.plan = plan;
    state.graph = {
      schemaVersion: 1,
      featureId: "fixture",
      revision: 1,
      specHash: hashJson(spec),
      planHash: hashBytes(plan),
      tasks: [task],
    };
    service.store.saveState(run.runId, state);
    const artifacts = new WorkflowArtifacts(service);
    const candidate = await artifacts.stageRevision(run.runId, {
      commandId: newId(),
      expectedInputHash: service.store.snapshot(run.runId).inputHash,
    });
    await service.revise(
      run.runId,
      { commandId: newId(), expectedRevision: service.store.snapshot(run.runId).revision },
      candidate.candidateHash,
    );
    const revised = service.store.state(run.runId);
    expect(revised.frozenFiles[profilePath]).toBe(hashBytes(readFileSync(profilePath)));
    expect(revised.frozenFiles[workflowPath]).toBe(hashBytes(readFileSync(workflowPath)));
    expect(() => assertFrozenInputs(revised, service.store, run.runId)).not.toThrow();
    writeFileSync(profilePath, `${readFileSync(profilePath, "utf8")} `);
    expect(() => assertFrozenInputs(revised, service.store, run.runId)).toThrow("Accepted input changed");
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(workflowPath, `${readFileSync(workflowPath, "utf8")} `);
    expect(() => assertFrozenInputs(revised, service.store, run.runId)).toThrow("Accepted input changed");
  } finally {
    close();
  }
});

test("CLI run reads prompt-file content and positional workflow ID", async () => {
  const { root, service, close } = fixture();
  try {
    const promptPath = join(root, "request.txt");
    const prompt = "Create the value from this file.\nPreserve the second line.\n";
    writeFileSync(promptPath, prompt);
    const args = parseWorkflowArgs([
      "run",
      "sdd",
      "--feature",
      "fixture",
      "--prompt-file",
      promptPath,
      "--json",
    ]);
    const originalStart = service.start.bind(service);
    let received: Parameters<typeof service.start>[0] | undefined;
    service.start = async (request) => {
      received = request;
      return originalStart(request);
    };
    service.drive = async (runId) => service.get(runId);
    await executeWorkflowCommand(service, args, new AbortController().signal);
    expect(received?.workflowId).toBe("sdd");
    expect(received?.prompt).toBe(prompt);
    expect(() =>
      parseWorkflowArgs(["run", "sdd", "--feature", "fixture", "--prompt", "inline", "--prompt-file", promptPath]),
    ).toThrow("exactly one");
  } finally {
    close();
  }
});

test("a modify target the snapshot cannot see is writable, a tracked one that changed is not", async () => {
  const { root, service, close } = fixture();
  try {
    writeFileSync(join(root, "ignored.md"), "docs");
    writeFileSync(join(root, "tracked.txt"), "one");
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Edit", ownerLabel: "test", policy: defaultWorkflowPolicy });
    const profile = builtinProfiles.find((item) => item.id === "implementer");
    if (!profile) throw new Error("Missing implementer profile");
    service.store.transition(run.runId, "running");
    service.leases.acquire("mutation", run.runId);
    // The snapshot lists tracked.txt only, as it does when ignored.md is git-ignored.
    const state = service.store.state(run.runId);
    state.expectedFiles = { "tracked.txt": hashBytes("one") };
    service.store.saveState(run.runId, state);
    const modify = { ...task, writes: [{ path: "ignored.md", action: "modify" as const }, { path: "tracked.txt", action: "modify" as const }] };
    const guard = new WorkflowToolPolicy(service.store, service.leases, run.runId, "attempt", profile, defaultWorkflowPolicy, modify);
    expect(guard.validate("edit_file", { path: "ignored.md", oldString: "docs", newString: "docs 2" })).toBe("ignored.md");
    expect(guard.validate("edit_file", { path: "tracked.txt", oldString: "one", newString: "two" })).toBe("tracked.txt");
    writeFileSync(join(root, "tracked.txt"), "changed by someone else");
    expect(() => guard.validate("edit_file", { path: "tracked.txt", oldString: "one", newString: "two" })).toThrow("File changed outside this attempt");
  } finally {
    close();
  }
});

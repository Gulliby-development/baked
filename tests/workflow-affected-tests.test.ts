import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import {
  affectedTestCheck,
  affectedTests,
  affectedTestsFor,
  isCompiledTestFile,
  isTestFile,
} from "../src/core/workflows/affected-tests.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { WorkflowScheduler } from "../src/core/workflows/scheduler.js";
import {
  type AgentProfile,
  ProfileSchema,
  type Review,
  type RunPolicy,
} from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { Check, ExecutionRequest, RuntimeState, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const roots: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-affected-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function check(id: string, executable: string, args: string[], extra: Partial<Check> = {}): Check {
  return {
    id,
    executable,
    args,
    cwd: ".",
    timeoutMs: 60000,
    required: true,
    scope: "feature",
    envNames: [],
    writes: [],
    ...extra,
  };
}

describe("isTestFile", () => {
  test("recognizes the test naming conventions of each ecosystem", () => {
    expect(isTestFile("src/store.test.ts")).toBe(true);
    expect(isTestFile("src/store.spec.jsx")).toBe(true);
    expect(isTestFile("src/__tests__/store.ts")).toBe(true);
    expect(isTestFile("tests/test_store.py")).toBe(true);
    expect(isTestFile("pkg/store_test.py")).toBe(true);
    expect(isTestFile("pkg/store_test.go")).toBe(true);
    expect(isTestFile("src/store.ts")).toBe(false);
    expect(isTestFile("pkg/store.go")).toBe(false);
    expect(isTestFile("src/testing.py")).toBe(false);
  });

  test("a Django tests.py and the files of a .NET test project are tests (#1683)", () => {
    expect(isTestFile("polls/tests.py")).toBe(true);
    expect(isTestFile("polls/tests_helpers.py")).toBe(false);
    expect(isCompiledTestFile("App.UnitTests/WhenAdding.cs")).toBe(true);
    expect(isCompiledTestFile("src/App.IntegrationTests/Api/WhenCalling.cs")).toBe(true);
    expect(isCompiledTestFile("App.Tests/CalculatorShould.cs")).toBe(true);
    expect(isCompiledTestFile("App/Calculator.cs")).toBe(false);
    expect(isCompiledTestFile("App.UnitTests/obj/Generated.cs")).toBe(false);
  });
});

describe("affectedTests", () => {
  test("follows TypeScript imports back from the changed file, nearest first", () => {
    const root = workspace({
      "src/store.ts": "export const store = 1;\n",
      "src/api.ts": 'import { store } from "./store.js";\nexport const api = store;\n',
      "src/app.ts": 'import { api } from "./api";\nexport default api;\n',
      "tests/api.test.ts": 'import { api } from "../src/api.js";\n',
      "tests/app.test.ts": 'import app from "../src/app.js";\n',
      "tests/other.test.ts": "export {};\n",
      "src/store.test.ts": "export {};\n",
    });
    expect(affectedTests(root, ["src/store.ts"])).toEqual([
      { path: "src/store.test.ts", hops: 0 },
      { path: "tests/api.test.ts", hops: 2 },
      { path: "tests/app.test.ts", hops: 3 },
    ]);
  });

  test("resolves Python absolute and relative imports", () => {
    const root = workspace({
      "app/__init__.py": "",
      "app/models.py": "X = 1\n",
      "app/service.py": "from .models import X\n",
      "tests/test_service.py": "from app.service import run\n",
      "tests/test_models.py": "import app.models as m\n",
      "tests/test_unrelated.py": "import os\n",
    });
    expect(affectedTests(root, ["app/models.py"]).map((t) => t.path)).toEqual([
      "tests/test_models.py",
      "tests/test_service.py",
    ]);
  });

  test("takes every test file of a Go package", () => {
    const root = workspace({
      "pkg/store/store.go": "package store\n",
      "pkg/store/store_test.go": "package store\n",
      "pkg/store/cache_test.go": "package store\n",
      "pkg/other/other_test.go": "package other\n",
    });
    expect(affectedTests(root, ["pkg/store/store.go"]).map((t) => t.path)).toEqual([
      "pkg/store/cache_test.go",
      "pkg/store/store_test.go",
    ]);
  });

  test("skips dependency folders and returns nothing for a file no test reaches", () => {
    const root = workspace({
      "src/lone.ts": "export {};\n",
      "node_modules/pkg/lone.test.ts": 'import "../../src/lone.js";\n',
    });
    expect(affectedTests(root, ["src/lone.ts"])).toEqual([]);
  });
});

describe("affectedTestCheck", () => {
  const tests = ["tests/api.test.ts", "tests/test_api.py", "pkg/api/api_test.go"];

  test("narrows a bun test check to the affected files, keeping its flags", () => {
    const derived = affectedTestCheck(
      [check("lint", "bun", ["run", "lint"]), check("test", "bun", ["test", "--bail", "tests"])],
      tests,
    );
    expect(derived).toMatchObject({
      id: "test-affected",
      executable: "bun",
      args: ["test", "--bail", "./tests/api.test.ts"],
      required: false,
      scope: "task",
    });
  });

  test("narrows vitest, pytest and go test checks", () => {
    expect(affectedTestCheck([check("t", "npx", ["vitest", "run"])], tests)?.args).toEqual([
      "vitest",
      "run",
      "./tests/api.test.ts",
    ]);
    expect(affectedTestCheck([check("t", "python3", ["-m", "pytest", "-q"])], tests)?.args).toEqual([
      "-m",
      "pytest",
      "-q",
      "./tests/test_api.py",
    ]);
    expect(affectedTestCheck([check("t", "go", ["test", "./..."])], tests)?.args).toEqual([
      "test",
      "./pkg/api",
    ]);
  });

  test("returns null for package scripts, other folders, or no matching tests", () => {
    expect(affectedTestCheck([check("t", "npm", ["test"])], tests)).toBeNull();
    expect(affectedTestCheck([check("t", "bun", ["test"], { cwd: "web" })], tests)).toBeNull();
    expect(affectedTestCheck([check("t", "pytest", [])], ["tests/api.test.ts"])).toBeNull();
    expect(affectedTestCheck([check("t", "bun", ["test"])], [])).toBeNull();
  });

  test("affectedTestsFor maps a task's write paths to tests and the narrowed check", () => {
    const root = workspace({
      "src/store.ts": "export const store = 1;\n",
      "src/store.test.ts": 'import { store } from "./store";\n',
    });
    const { tests: found, check: derived } = affectedTestsFor(
      root,
      [check("test", "bun", ["test"])],
      [{ path: "src/store.ts" }],
    );
    expect(found.map((t) => t.path)).toEqual(["src/store.test.ts"]);
    expect(derived?.args).toEqual(["test", "./src/store.test.ts"]);
  });
});

function step(call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

/** The tool results the scripted model saw, in order. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): unknown[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") seen.push(...last.content);
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

describe("request_check with the affected-tests check", () => {
  test("runs only the tests that reach the task's files and refuses an unknown one", async () => {
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [check("test", "bun", ["test"], { timeoutMs: 30000 })],
    };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    mkdirSync(join(fixture.root, "src"), { recursive: true });
    writeFileSync(join(fixture.root, "src", "value.ts"), "export const value = 1;\n");
    writeFileSync(
      join(fixture.root, "src", "value.test.ts"),
      'import { expect, test } from "bun:test";\nimport { value } from "./value";\ntest("value", () => expect(value).toBe(1));\n',
    );
    writeFileSync(
      join(fixture.root, "src", "broken.test.ts"),
      'import { test } from "bun:test";\ntest("unrelated", () => { throw new Error("unrelated"); });\n',
    );
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = {
      id: "T001",
      title: "Change value",
      description: "Change value",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: profile.id,
      writes: [{ path: "src/value.ts", action: "modify" }],
      readHints: [],
      checkIds: ["test"],
      origin: "planned",
      findingIds: [],
      rationale: "Value",
    };
    const seen = scriptModel([
      step({ name: "request_check", input: { checkId: "test-affected" } }),
      step({ name: "request_check", input: { checkId: "lint-affected" } }),
      () => {
        throw new Error("stop after the checks");
      },
    ]);
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
    const leases = new WorkspaceLeases(store);
    leases.acquire("mutation", run.runId);
    cleanups.push(() => leases.release());
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    const request: ExecutionRequest = {
      runId: run.runId,
      attemptId,
      profile,
      task,
      prompt: "Change the value",
      signal: new AbortController().signal,
      maxSteps: 10,
    };
    await expect(executor.execute(request)).rejects.toThrow("stop after the checks");
    const results = seen.map((r) => JSON.stringify(r));
    expect(results[0]).toContain('"status":"passed"');
    expect(results[1]).toContain("outside the task scope");
  }, 60000);
});

describe("request_check of a whole-unit formatter (#842)", () => {
  async function requestFormatter(origin: Task["origin"]): Promise<string> {
    // The ID names rustfmt, so it is a whole-unit formatter; the command itself passes.
    const policy: RunPolicy = {
      ...fixturePolicy,
      checks: [check("rustfmt", "bun", ["-e", "process.exit(0)"], { timeoutMs: 30000 })],
    };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = {
      id: "T001",
      title: "Add parser",
      description: "Add parser",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: profile.id,
      writes: [{ path: "src/parse.rs", action: "create" }],
      readHints: [],
      checkIds: ["rustfmt"],
      origin,
      findingIds: [],
      rationale: "Parser",
    };
    const seen = scriptModel([
      step({ name: "request_check", input: { checkId: "rustfmt" } }),
      () => {
        throw new Error("stop after the check");
      },
    ]);
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
    const leases = new WorkspaceLeases(store);
    leases.acquire("mutation", run.runId);
    cleanups.push(() => leases.release());
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    await expect(
      executor.execute({
        runId: run.runId,
        attemptId,
        profile,
        task,
        prompt: "Add the parser",
        signal: new AbortController().signal,
        maxSteps: 10,
      }),
    ).rejects.toThrow("stop after the check");
    return JSON.stringify(seen[0]);
  }

  test("a planned task gets it deferred to the checks stage without running it", async () => {
    const result = await requestFormatter("planned");
    expect(result).toContain('"status":"deferred"');
    expect(result).toContain("checks stage");
    expect(result).not.toContain("evidenceId");
  }, 60000);

  test("a corrective task, after integration, runs it", async () => {
    expect(await requestFormatter("repair")).toContain('"status":"passed"');
  }, 60000);
});

describe("the affected-test regression gate", () => {
  type Checked = { status: "passed" | "failed" | "inconclusive"; evidenceId: string; output?: string };
  const plannedTask = (id: string, path: string, extra: Partial<Task> = {}): Task => ({
    id,
    title: id,
    description: id,
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path, action: "modify" }],
    readHints: [],
    checkIds: ["test"],
    origin: "planned",
    findingIds: [],
    rationale: id,
    ...extra,
  });
  const lib = plannedTask("T001", "src/store.ts");
  const testsTask = plannedTask("T002", "tests/store.test.ts", { profileId: "tester" });
  const policy = { checks: [check("test", "bun", ["test"])] } as unknown as RunPolicy;
  const subject = (baseline: Checked) => {
    const ran: Check[] = [];
    const scheduler = Object.create(WorkflowScheduler.prototype) as {
      store: WorkflowStore;
      runTaskCheck: (...args: unknown[]) => Promise<Checked>;
      affectedBaseline(...args: unknown[]): Promise<boolean>;
      gatedChecks(runId: string, state: RuntimeState, policy: RunPolicy, task: Task, root: string): Check[];
      applyTaskCheck(...args: unknown[]): string | undefined;
    };
    scheduler.store = {
      transaction: (fn: () => unknown) => fn(),
      taskStatus: () => undefined,
      latestArtifact: () => undefined,
      // No journaled edits: the format-written checks find no base for an edited file (#1837).
      effects: () => [],
      tasks: () => [lib, testsTask].map((t) => ({ id: t.id, status: "verified", generation: 0 })),
    } as unknown as WorkflowStore;
    scheduler.runTaskCheck = async (_run, _child, ranCheck) => {
      ran.push(ranCheck as Check);
      return baseline;
    };
    const graph = { tasks: [lib, testsTask] };
    const state = {
      graph,
      rootGraph: graph,
      affectedTests: {},
      repairPredecessors: {},
      repairScope: {},
      deferredChecks: {},
      taskGates: {},
    } as unknown as RuntimeState;
    return { scheduler, state, ran };
  };
  const files = {
    "src/store.ts": "export const store = 1;\n",
    "tests/store.test.ts": 'import { store } from "../src/store.js";\n',
  };
  const signal = new AbortController().signal;

  test("records the affected tests and their baseline before the task's first attempt", async () => {
    const root = workspace(files);
    const { scheduler, state, ran } = subject({ status: "passed", evidenceId: "E1" });
    expect(await scheduler.affectedBaseline("run", "step", state, policy, lib, signal, root)).toBe(true);
    expect(ran.map((c) => c.args)).toEqual([["test", "./tests/store.test.ts"]]);
    expect(state.affectedTests.T001).toEqual({
      paths: ["tests/store.test.ts"],
      checkId: "test-affected",
      baseline: "passed",
      evidenceId: "E1",
    });
    // A later attempt keeps the first baseline.
    expect(await scheduler.affectedBaseline("run", "step", state, policy, lib, signal, root)).toBe(false);
    expect(ran).toHaveLength(1);

    const gate = scheduler.gatedChecks("run", state, policy, lib, root).find((c) => c.id === "test-affected");
    expect(gate).toMatchObject({ required: true, args: ["test", "./tests/store.test.ts"] });
    // The task that repairs it inherits the gate.
    state.repairPredecessors.F1 = "T001";
    const repair = plannedTask("T009", "src/store.ts", { origin: "repair", findingIds: ["F1"] });
    expect(scheduler.gatedChecks("run", state, policy, repair, root).map((c) => c.id)).toContain("test-affected");
  });

  test("adds no gate when the affected tests already failed before the task", async () => {
    const root = workspace(files);
    const { scheduler, state } = subject({ status: "failed", evidenceId: "E1" });
    await scheduler.affectedBaseline("run", "step", state, policy, lib, signal, root);
    expect(state.affectedTests.T001?.baseline).toBe("failed");
    expect(scheduler.gatedChecks("run", state, policy, lib, root).map((c) => c.id)).not.toContain("test-affected");
  });

  test("a test outside the task's files that the task broke blocks it for a repair", async () => {
    const root = workspace(files);
    const { scheduler, state } = subject({ status: "passed", evidenceId: "E1" });
    await scheduler.affectedBaseline("run", "step", state, policy, lib, signal, root);
    const gate = scheduler.gatedChecks("run", state, policy, lib, root).find((c) => c.id === "test-affected") as Check;
    const failures: Review["findings"] = [];
    // tests/store.test.ts belongs to a task of another profile: an ordinary check failing only
    // there would stop the run as out of scope.
    scheduler.applyTaskCheck(
      "run",
      state,
      lib,
      gate,
      { status: "failed", evidenceId: "E2", output: "tests/store.test.ts:\n(fail) store > reads" },
      failures,
      [],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.claim).toBe(
      "Task T001 broke existing tests: check test-affected passed before the task and fails after it",
    );
    expect(failures[0]?.evidenceIds).toEqual(["E2"]);
  });
});

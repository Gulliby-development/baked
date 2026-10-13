import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import {
  affectedTestCheck,
  affectedTests,
  affectedTestsFor,
  isTestFile,
} from "../src/core/workflows/affected-tests.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { Check, ExecutionRequest, Task } from "../src/core/workflows/types.js";
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

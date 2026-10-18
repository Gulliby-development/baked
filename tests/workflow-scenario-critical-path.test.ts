import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { criticalPath, criticalPathFeatures, criticalPathProblems } from "../src/core/workflows/initiatives/critical-path.js";
import type { InitiativeFeature, InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 43, intsmith (#1522). The decomposer put five independent modules into
// one arithmetic feature on the chain core -> arithmetic -> basic-commands -> advanced -> entry ->
// documentation; it took 38% of the wall time and the parallel speedup was 1.04x. With the
// critical-path check the decomposer is asked at submission to split it into parts that run side
// by side, or to say why it stays whole.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const feature = (id: string, paths: string[], dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
  id, title: id, boundary: { scope: `The ${id} code`, paths }, contract: `${id} works`, dependsOn, mandatory: true, size: "medium", ...extra,
});
const modules = (names: string[]) => names.flatMap((n) => [`intsmith/${n}.py`, `tests/test_${n}.py`]);
const ARITHMETIC = ["gcd", "primes", "funcs", "residues", "cfrac"];
const split = (arithmetic: InitiativeFeature[]): InitiativePlan => {
  const ids = arithmetic.map((f) => f.id);
  return {
    schemaVersion: 1, title: "intsmith", goals: ["A number theory CLI"], completionCriteria: ["Every command works"],
    features: [
      feature("core", modules(["core", "parse"]), []),
      ...arithmetic,
      feature("basic-commands", modules(["add", "mul"]), ids),
      feature("groups", modules(["group", "order"]), ["core"]),
      feature("advanced-commands", modules(["crt", "dlog"]), ["basic-commands"]),
      feature("entry", ["intsmith/__main__.py", "intsmith/cli.py", "tests/test_cli.py"], ["advanced-commands"], { size: "small" }),
      feature("documentation", ["README.md", "docs/usage.md", "docs/commands.md"], ["entry"], { size: "small" }),
    ],
  };
};
const whole = split([feature("arithmetic", modules(ARITHMETIC), ["core"], { size: "large" })]);
const parted = split([
  feature("arithmetic-a", modules(ARITHMETIC.slice(0, 3)), ["core"]),
  feature("arithmetic-b", modules(ARITHMETIC.slice(3)), ["core"]),
]);
const kept = split([feature("arithmetic", modules(ARITHMETIC), ["core"], { size: "large", serial: "cfrac and residues call gcd and primes" })]);

class Decomposer implements AgentExecutor {
  problems: string[][] = [];
  constructor(private answer: InitiativePlan) {}
  async execute(request: ExecutionRequest) {
    if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
    // Like submit_result: a result with problems is turned back and the decomposer submits again.
    let output: InitiativePlan = whole;
    const problems = request.validate?.(output) ?? [];
    this.problems.push(problems);
    if (problems.length) {
      output = this.answer;
      this.problems.push(request.validate?.(output) ?? []);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [{ id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }] };

async function decompose(answer: InitiativePlan, splitCriticalPath: boolean, runPolicy: RunPolicy = policy) {
  const root = mkdtempSync(join(tmpdir(), "baked-critical-path-"));
  const executor = new Decomposer(answer);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: runPolicy } };
  const workflows = new NativeWorkflowService(root, config, executor);
  const initiatives = new InitiativeService(workflows);
  cleanups.push(() => {
    workflows.close();
    rmSync(root, { recursive: true, force: true });
  });
  await initiatives.start({ commandId: newId(), initiativeId: "intsmith", prompt: "Build intsmith, a number theory CLI", policy: runPolicy, ownerLabel: "test", ...(splitCriticalPath ? { splitCriticalPath: true } : {}) });
  const view = await initiatives.drive("intsmith", new AbortController().signal);
  return { executor, view };
}

describe("scenario: intsmith R43, a feature that dominates the critical path (#1522)", () => {
  test("the decomposer is asked to split it, and the parts run side by side", async () => {
    const { executor, view } = await decompose(parted, true);
    expect(executor.problems[0]).toHaveLength(1);
    expect(executor.problems[0]?.[0]).toStartWith("arithmetic is 36% of the critical path (core -> arithmetic -> basic-commands -> advanced-commands -> entry -> documentation)");
    expect(executor.problems[1]).toEqual([]);
    expect(view.status).toBe("awaiting_approval");
    const ids = view.features.map((f) => f.id);
    expect(ids).toContain("arithmetic-a");
    expect(ids).toContain("arithmetic-b");
    expect(ids).not.toContain("arithmetic");
  }, 60000);

  test("a feature the decomposer keeps whole shows its reason in the split approval", async () => {
    const { executor, view } = await decompose(kept, true);
    expect(executor.problems[1]).toEqual([]);
    expect(view.features.find((f) => f.id === "arithmetic")?.serial).toBe("cfrac and residues call gcd and primes");
  }, 60000);

  test("the run policy turns it on too", async () => {
    const { executor } = await decompose(parted, false, { ...policy, criticalPath: "split" });
    expect(executor.problems[0]).toHaveLength(1);
  }, 60000);

  test("without the setting the decomposer is not asked and the split stays as it was", async () => {
    const { executor, view } = await decompose(parted, false);
    expect(executor.problems).toEqual([[]]);
    expect(view.features.map((f) => f.id)).toContain("arithmetic");
  }, 60000);
});

describe("critical path helpers", () => {
  test("the path follows the chain with the most work", () => {
    expect(criticalPath(whole, [])).toEqual({
      features: ["core", "arithmetic", "basic-commands", "advanced-commands", "entry", "documentation"],
      work: 2 + 5 + 2 + 2 + 1.5 + 1.5,
    });
    // After the split the parts are side by side: only one of them is on the path.
    expect(criticalPath(parted, []).features).toHaveLength(6);
    expect(criticalPathFeatures(parted, "")).toEqual([]);
  });

  test("a feature with too few files for two parts, or a split at the maximum, is not asked about", () => {
    const narrow = split([feature("arithmetic", modules(["gcd", "primes"]), ["core"], { size: "large" })]);
    expect(criticalPathProblems(narrow, "")).toEqual([]);
    const full: InitiativePlan = { ...whole, features: [...whole.features, ...["a", "b", "c", "d", "e"].map((id) => feature(id, [`${id}.py`], []))] };
    expect(full.features).toHaveLength(12);
    expect(criticalPathProblems(full, "")).toEqual([]);
  });

  test("a glob boundary counts the files the request names", () => {
    const globbed = split([feature("arithmetic", ["intsmith/arith/*.py", "tests/arith/*.py"], ["core"])]);
    expect(criticalPathProblems(globbed, "")).toEqual([]);
    const request = `Modules: ${ARITHMETIC.map((n) => `intsmith/arith/${n}.py tests/arith/test_${n}.py`).join(" ")}`;
    expect(criticalPathProblems(globbed, request)).toHaveLength(1);
  });
});

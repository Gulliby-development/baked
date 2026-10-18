import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  CHAIN_SHARE,
  criticalChain,
  criticalPathProblems,
  criticalPathSummary,
} from "../src/core/workflows/initiatives/critical-path.js";
import {
  type InitiativeFeature,
  type InitiativePlan,
  mergeSmallSiblings,
} from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { criticalPathText } from "../src/core/workflows/initiatives/view-model.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 45, grundykit (#1551). The decomposer gave table, period, misere and
// wythoff the same dependency (rules); the host merged the four into table, so solve, which needs
// only table, waited for the other three, and special-front waited for all of table. With
// normal-front depending on play as well, 8 of 9 features ran in series: the largest of them held
// 16% of the path, the share check of one feature never asked, and the speedup was 1.08x.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const feature = (
  id: string,
  paths: string[],
  dependsOn: string[],
  extra: Partial<InitiativeFeature> = {},
): InitiativeFeature => ({
  id,
  title: id,
  boundary: { scope: `The ${id} code`, paths },
  contract: `${id} works`,
  dependsOn,
  mandatory: true,
  size: "medium",
  ...extra,
});
const files = (id: string) => [`grundy/${id}.py`, `grundy/${id}_io.py`, `tests/test_${id}.py`];
const plan = (features: InitiativeFeature[], extra: Partial<InitiativePlan> = {}): InitiativePlan => ({
  schemaVersion: 1,
  title: "grundykit",
  goals: ["A combinatorial game CLI"],
  completionCriteria: ["Every command works"],
  features,
  ...extra,
});

// The decomposer's first split: four small analysis siblings of rules with different dependents.
const layered = plan([
  feature("base", files("base"), []),
  feature("rules", files("rules"), ["base"]),
  feature("table", ["grundy/table.py", "tests/test_table.py"], ["rules"]),
  feature("period", ["grundy/period.py"], ["rules"]),
  feature("misere", ["grundy/misere.py", "tests/test_misere.py"], ["rules"]),
  feature("wythoff", ["grundy/wythoff.py"], ["rules"]),
  feature("solve", files("solve"), ["table"]),
  feature("play", files("play"), ["rules"]),
  feature("special-front", files("special"), ["period", "misere", "wythoff"]),
  feature("normal-front", files("normal"), ["solve", "play"]),
  feature("entry", files("entry"), ["normal-front", "special-front"]),
]);

// A chain of eight features of equal work, as the round ran it, and one feature beside it.
const CHAIN = ["base", "rules", "table", "solve", "play", "normal-front", "entry", "docs"];
const chained = (extra: Partial<InitiativePlan> = {}) =>
  plan(
    [
      ...CHAIN.map((id, index) => feature(id, files(id), index ? [CHAIN[index - 1] ?? ""] : [])),
      feature("notes", files("notes"), ["base"]),
    ],
    extra,
  );
// The answer that drops the edge play does not use: play needs rules, not solve.
const dropped = plan(
  chained().features.map((f) =>
    f.id === "play"
      ? { ...f, dependsOn: ["rules"] }
      : f.id === "normal-front"
        ? { ...f, dependsOn: ["solve", "play"] }
        : f,
  ),
);

class Decomposer implements AgentExecutor {
  problems: string[][] = [];
  constructor(
    private first: InitiativePlan,
    private answer: InitiativePlan,
  ) {}
  async execute(request: ExecutionRequest) {
    if (request.profile.output !== "initiativePlan")
      throw new Error(`Unexpected profile ${request.profile.output}`);
    // Like submit_result: a result with problems is turned back and the decomposer submits again.
    let output = this.first;
    const problems = request.validate?.(output) ?? [];
    this.problems.push(problems);
    if (problems.length) {
      output = this.answer;
      this.problems.push(request.validate?.(output) ?? []);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [
    {
      id: "tests",
      executable: "bun",
      args: ["test"],
      cwd: ".",
      timeoutMs: 10000,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    },
  ],
};

async function decompose(first: InitiativePlan, answer: InitiativePlan, splitCriticalPath: boolean) {
  const root = mkdtempSync(join(tmpdir(), "baked-chain-split-"));
  const executor = new Decomposer(first, answer);
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "fixture/model",
    workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy },
  };
  const workflows = new NativeWorkflowService(root, config, executor);
  const initiatives = new InitiativeService(workflows);
  cleanups.push(() => {
    workflows.close();
    rmSync(root, { recursive: true, force: true });
  });
  await initiatives.start({
    commandId: newId(),
    initiativeId: "grundykit",
    prompt: "Build grundykit, a combinatorial game CLI",
    policy,
    ownerLabel: "test",
    ...(splitCriticalPath ? { splitCriticalPath: true } : {}),
  });
  const view = await initiatives.drive("grundykit", new AbortController().signal);
  return { executor, view };
}

describe("scenario: grundykit R45, siblings merged across dependents (#1551)", () => {
  test("with the critical path split on, siblings merge only with the same dependents", async () => {
    const { view } = await decompose(layered, layered, true);
    expect(view.status).toBe("awaiting_approval");
    const ids = view.features.map((f) => f.id);
    // table keeps its own run; the three parts special-front needs run as one feature beside it.
    expect(ids).toContain("table");
    expect(ids).toContain("period");
    expect(ids).not.toContain("misere");
    expect(ids).not.toContain("wythoff");
    expect(view.features.find((f) => f.id === "solve")?.dependsOn).toEqual(["table"]);
    expect(view.features.find((f) => f.id === "special-front")?.dependsOn).toEqual(["period"]);
  }, 60000);

  test("without the setting the four siblings still merge into one feature, as before", async () => {
    const { view } = await decompose(layered, layered, false);
    const ids = view.features.map((f) => f.id);
    expect(ids).toContain("table");
    expect(ids).not.toContain("period");
    expect(view.features.find((f) => f.id === "solve")?.dependsOn).toEqual(["table"]);
    expect(view.features.find((f) => f.id === "special-front")?.dependsOn).toEqual(["table"]);
  }, 60000);
});

describe("scenario: grundykit R45, a long chain of small shares (#1551)", () => {
  test("the decomposer is asked about the chain and drops the edge its feature does not use", async () => {
    const { executor, view } = await decompose(chained(), dropped, true);
    expect(executor.problems[0]).toHaveLength(1);
    expect(executor.problems[0]?.[0]).toStartWith(
      `The longest dependency chain (${CHAIN.join(" -> ")}) holds 89% of the split's work`,
    );
    expect(executor.problems[1]).toEqual([]);
    expect(view.features.find((f) => f.id === "play")?.dependsOn).toEqual(["rules"]);
    expect(view.criticalPath?.features).toEqual([
      "base",
      "rules",
      "table",
      "solve",
      "normal-front",
      "entry",
      "docs",
    ]);
    expect(criticalPathText(view)).toStartWith(
      "Critical path: base -> rules -> table -> solve -> normal-front -> entry -> docs (7 of 9 features, 78% of the work)",
    );
  }, 60000);

  test("a chain the decomposer keeps shows its reason", async () => {
    const reason = "each layer calls the one before";
    const { executor, view } = await decompose(chained(), chained({ chain: reason }), true);
    expect(executor.problems[1]).toEqual([]);
    expect(view.criticalPath?.chain).toBe(reason);
    expect(criticalPathText(view)).toEndWith(`kept: ${reason}`);
  }, 60000);

  test("without the setting the decomposer is not asked", async () => {
    const { executor } = await decompose(chained(), dropped, false);
    expect(executor.problems).toEqual([[]]);
  }, 60000);
});

describe("chain helpers", () => {
  test("an eight-feature chain of equal work triggers the check; a diamond does not", () => {
    expect(criticalChain(chained(), "")).toEqual({ path: CHAIN, share: 16 / 18 });
    expect(16 / 18).toBeGreaterThanOrEqual(CHAIN_SHARE);
    const diamond = plan([
      feature("a", files("a"), []),
      feature("b", files("b"), ["a"]),
      feature("c", files("c"), ["a"]),
      feature("d", files("d"), ["b", "c"]),
      feature("e", files("e"), ["d"]),
    ]);
    expect(criticalChain(diamond, "")).toBeNull();
    expect(criticalPathProblems(diamond, "")).toEqual([]);
    expect(criticalChain(chained({ chain: "kept" }), "")).toBeNull();
  });

  test("the summary bounds the gain by the path and by the runs at once", () => {
    // 18 units of work, a 16-unit path: two runs at once gain at most 18 / 16.
    expect(criticalPathSummary(chained(), "", 2)?.speedup).toBeCloseTo(18 / 16);
    // A wide split is bounded by the runs: 6 features of 2 units side by side, 2 at once.
    const wide = plan(["a", "b", "c", "d", "e", "f"].map((id) => feature(id, files(id), [])));
    expect(criticalPathSummary(wide, "", 2)?.speedup).toBeCloseTo(2);
    expect(criticalPathSummary(wide, "", 1)?.speedup).toBeCloseTo(1);
  });

  test("a merge keeps siblings with equal dependents together and splits the rest apart", () => {
    const merged = mergeSmallSiblings(layered, { byDependents: true }).merged;
    expect(merged).toEqual([{ featureId: "period", from: ["period", "misere", "wythoff"] }]);
    expect(mergeSmallSiblings(layered).merged).toEqual([
      { featureId: "table", from: ["table", "period", "misere", "wythoff"] },
    ]);
  });
});

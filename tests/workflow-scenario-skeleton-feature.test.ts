import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import {
  foldSkeletonFeatures,
  type InitiativeFeature,
  type InitiativePlan,
} from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { hostFileProblems } from "../src/core/workflows/task-graph.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Bench round 50, selwhy (#1662): the decomposer made the 24 module stubs a feature of their own.
// Its two host-written tasks cost nothing, but the run paid research, specification, planning,
// analysis and review: 298k tokens and 280 s at the head of the critical path. The planner also
// laid the stubs out for gofmt, its plan was refused, and a second generation added a host task.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const STUBS = ["base", "solve", "cli"].map((m) => ({ path: `${m}/${m}.go`, content: `package ${m}\n// filled later\n` }));
const feature = (id: string, paths: string[], dependsOn: string[], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
  id, title: id, boundary: { scope: `The ${id} code`, paths }, contract: `${id} works`, dependsOn, mandatory: true, size: "medium", ...extra,
});
const files = (id: string) => [`${id}/${id}.go`, `${id}/${id}_io.go`, `${id}/${id}_test.go`];
const split = (features: InitiativeFeature[]): InitiativePlan => ({
  schemaVersion: 1, title: "selwhy", goals: ["A selection CLI"], completionCriteria: ["Every command works"], features,
});
const skeleton = feature("skeleton", STUBS.map((s) => s.path), [], { size: "small", skeleton: STUBS });
const selwhy = split([
  skeleton,
  feature("base", files("base"), ["skeleton"]),
  feature("solve", files("solve"), ["skeleton", "base"]),
  feature("cli", files("cli"), ["skeleton", "solve"]),
  feature("docs", ["README.md", "docs/usage.md", "docs/commands.md"], ["cli"], { size: "small" }),
]);

describe("a feature that is only skeleton (#1662)", () => {
  test("is folded into the dependent every other dependent waits for", () => {
    const { plan, merged } = foldSkeletonFeatures(selwhy);
    expect(merged).toEqual([{ featureId: "base", from: ["skeleton", "base"] }]);
    expect(plan.features.map((f) => f.id)).toEqual(["base", "solve", "cli", "docs"]);
    const base = plan.features.find((f) => f.id === "base");
    expect(base?.title).toBe("base");
    expect(base?.skeleton).toEqual(STUBS);
    expect(base?.dependsOn).toEqual([]);
    for (const stub of STUBS) expect(base?.boundary.paths).toContain(stub.path);
    // The other dependents waited for base already: no chain gets longer.
    expect(plan.features.find((f) => f.id === "solve")?.dependsOn).toEqual(["base"]);
    expect(plan.features.find((f) => f.id === "cli")?.dependsOn).toEqual(["base", "solve"]);
  });

  test("stays when its dependents run side by side, or when the split would drop below three", () => {
    const sideBySide = split([
      skeleton,
      feature("base", files("base"), ["skeleton"]),
      feature("solve", files("solve"), ["skeleton"]),
      feature("docs", ["README.md", "docs/a.md", "docs/b.md"], ["base", "solve"]),
    ]);
    expect(foldSkeletonFeatures(sideBySide).merged).toEqual([]);
    const small = split([skeleton, feature("base", files("base"), ["skeleton"]), feature("cli", files("cli"), ["base"])]);
    expect(foldSkeletonFeatures(small).merged).toEqual([]);
    // A feature with work besides its skeleton is not folded.
    const mixed = split([{ ...skeleton, boundary: { ...skeleton.boundary, paths: [...skeleton.boundary.paths, "base/extra.go"] } }, ...selwhy.features.slice(1)]);
    expect(foldSkeletonFeatures(mixed).merged).toEqual([]);
  });

  test("the decomposer's split is folded before approval and the event names the parts", async () => {
    class Decomposer implements AgentExecutor {
      async execute(request: ExecutionRequest) {
        if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
        return { output: selwhy, inputTokens: 20, outputTokens: 30 };
      }
    }
    const root = mkdtempSync(join(tmpdir(), "baked-skeleton-feature-"));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: fixturePolicy } };
    const workflows = new NativeWorkflowService(root, config, new Decomposer());
    const initiatives = new InitiativeService(workflows);
    cleanups.push(() => {
      workflows.close();
      rmSync(root, { recursive: true, force: true });
    });
    await initiatives.start({ commandId: newId(), initiativeId: "selwhy", prompt: "Build selwhy", policy: fixturePolicy, ownerLabel: "test" });
    const view = await initiatives.drive("selwhy", new AbortController().signal);
    expect(view.status).toBe("awaiting_approval");
    expect(view.features.map((f) => f.id)).toEqual(["base", "solve", "cli", "docs"]);
    expect(initiatives.events("selwhy").find((e) => e.type === "split.merged")?.payload).toMatchObject({
      merged: [{ featureId: "base", from: ["skeleton", "base"] }],
    });
  }, 60000);
});

describe("skeleton content the planner laid out for the formatter (#1662)", () => {
  const base = { requirementIds: ["FR-001"], criterionIds: ["AC-001"], profileId: "implementer", readHints: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior", dependsOn: [], checkIds: [] };
  const writer = (content: string): Task => ({ ...base, id: "T001", title: "Write the stubs", description: "Package stubs", writes: [{ path: "base/base.go", action: "create", content }] });
  const files = [{ path: "base/base.go", content: "package base\n// filled later\n\n\n" }];

  test("whitespace a formatter changes is accepted in one host task", () => {
    expect(hostFileProblems({ tasks: [writer("package base\n// filled later\n")] }, files)).toEqual([]);
    expect(hostFileProblems({ tasks: [writer("package base\n\t// filled later\n")] }, files)).toEqual([]);
  });

  test("any other change is still returned to the planner", () => {
    const problems = hostFileProblems({ tasks: [writer("package core\n// filled later\n")] }, files);
    expect(problems[0]).toContain("base/base.go is not written that way. Whitespace may follow the project's formatter");
  });
});

import { afterEach, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { RunPolicy, Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 28, cfgtrace b4427c85 (#1245). Sizing split the planned test tasks into one-file
// parts, and every part kept its group's whole criteria list: each wrote a file that tried to cover
// the group, the parts cost 7.65M tokens (54 percent of the run) and three of them contradicted
// the spec. A part now gets only the criteria the code tasks of its tested file cover, and is told
// which criteria the other parts' files cover.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "Config tracer", problem: "Layered config is opaque", outcome: "Layers are validated and traced",
  inScope: ["Validate and trace layers"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [
    { id: "FR-001", text: "A layer is validated against the schema", priority: "must", verification: "automated", sourceRefs: [] },
    { id: "FR-002", text: "Layers are loaded from every source", priority: "must", verification: "automated", sourceRefs: [] },
  ],
  criteria: [
    { id: "AC-001", requirementIds: ["FR-001"], given: "a layer with an unknown key", when: "it is validated", then: "E201 is reported", method: "automated" },
    { id: "AC-002", requirementIds: ["FR-001"], given: "a layer with a wrong type", when: "it is validated", then: "E202 is reported", method: "automated" },
    { id: "AC-003", requirementIds: ["FR-002"], given: "an environment source", when: "layers load", then: "its values win over files", method: "automated" },
  ],
  dependencies: [],
};
const markdown = "# Plan\n## Context\nSchema and sources.\n## Decisions\nDEC-001: FR-001 in schema, FR-002 in sources.\n## Components\ncfgtrace/schema.py, cfgtrace/sources.py\n## Data\nText\n## Verification\nTests\n## Risks\nNone for fixture";
const task = (id: string, paths: string[], criterionIds: string[], requirementIds: string[], dependsOn: string[] = []): Task => ({
  id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds, criterionIds, dependsOn, profileId: "implementer",
  writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
});

test("each one-file part of a split test task covers only the criteria of its tested module", async () => {
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume", sizing: { maxAttemptTokens: 400_000 } };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const taskGraph: TaskGraph = {
        schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
        tasks: [
          task("T001", ["cfgtrace/schema.py"], ["AC-001", "AC-002"], ["FR-001"]),
          task("T002", ["cfgtrace/sources.py"], ["AC-003"], ["FR-002"]),
          task("T003", ["tests/test_schema.py", "tests/test_sources.py"], ["AC-001", "AC-002", "AC-003"], ["FR-001", "FR-002"], ["T001", "T002"]),
        ],
      };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    return original(request);
  };
  const run = await fixture.start();
  const waiting = await service.drive(run.runId, new AbortController().signal);
  expect(waiting.reason).toBe("approval");
  const graph = service.store.state(run.runId).graph as TaskGraph;
  const parts = graph.tasks.filter((t) => t.writes.some((w) => w.path.startsWith("tests/")));
  expect(parts.map((t) => [t.id, t.writes.map((w) => w.path), t.criterionIds])).toEqual([
    ["T003", ["tests/test_schema.py"], ["AC-001", "AC-002"]],
    ["T004", ["tests/test_sources.py"], ["AC-003"]],
  ]);
  expect(parts[0]?.description).toContain("Cover only AC-001, AC-002 in it; AC-003 are covered by the other parts' files");
  expect(parts[1]?.description).toContain("Cover only AC-003 in it; AC-001, AC-002 are covered by the other parts' files");
});

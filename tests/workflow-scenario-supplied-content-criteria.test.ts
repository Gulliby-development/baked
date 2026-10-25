import { afterEach, describe, expect, test } from "bun:test";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { suppliedContentFindings, suppliedTestFiles } from "../src/core/workflows/supplied-content.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 64, mdtoc-update (#2006, follow-up of #2000). The request gave
// tests/version.test.ts verbatim, and AC-006 named a literal that file does not contain. Only the
// task-end case walk found it, after an implementer session (237,581 tokens) and a second refusal
// (323,183 tokens). The host now walks the criterion against the supplied text at analysis.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEST = "tests/version.test.ts";
const SUPPLIED = `import { expect, test } from "bun:test";
import { version } from "../src/version";

test("prints the version", () => {
  expect(version()).toBe("mdtoc 2.1.0");
});`;
const REQUEST = `Add a --version flag to mdtoc. Create \`${TEST}\` with exactly this content:\n\n\`\`\`ts\n${SUPPLIED}\n\`\`\`\n\nThe flag prints mdtoc 2.1.0.`;

const spec = (then: string): Spec => ({
  ...fixtureSpec,
  criteria: [...fixtureSpec.criteria, { id: "AC-006", requirementIds: ["FR-001"], given: "the built CLI", when: "mdtoc --version runs", then, method: "automated" }],
});
const WRONG = spec("it prints `mdtoc version 2.1.0`");
const RIGHT = spec("it prints `mdtoc 2.1.0`");

const task = (id: string, writes: TaskGraph["tasks"][number]["writes"], criterionIds = ["AC-006"]): TaskGraph["tasks"][number] => ({
  id, title: id, description: id, requirementIds: ["FR-001"], criterionIds, dependsOn: [], profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "x",
});
const graph = (tasks: TaskGraph["tasks"]) => ({ tasks });
const checks = fixturePolicy.checks;

describe("criteria against file content the request supplies verbatim (#2006)", () => {
  test("a criterion literal the supplied test lacks is a finding for the spec author", () => {
    const findings = suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }])]), REQUEST, { checks });
    expect(findings).toEqual([expect.objectContaining({ id: "SUPPLIED-AC-006", kind: "inconsistency", blocking: true, refs: ["spec.json", "AC-006"] })]);
    expect(findings[0]?.description).toContain('"mdtoc version 2.1.0" (task T004 writes only tests/version.test.ts)');
  });

  test("a literal the supplied test holds raises nothing", () => {
    expect(suppliedContentFindings(RIGHT, graph([task("T004", [{ path: TEST, action: "create" }])]), REQUEST, { checks })).toEqual([]);
  });

  test("a block for an existing file is an excerpt unless the prose says it is the whole file", () => {
    const excerpt = REQUEST.replace("with exactly this content:", "and add this test:").replace("Create", "In");
    expect(suppliedTestFiles(excerpt, graph([task("T004", [{ path: TEST, action: "modify" }])])).size).toBe(0);
    expect(suppliedTestFiles(REQUEST, graph([task("T004", [{ path: TEST, action: "modify" }])])).get("T004")).toEqual([{ path: TEST, content: `${SUPPLIED}\n` }]);
  });

  test("a task that also writes a test file the request does not supply is left to the walk", () => {
    expect(suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }, { path: "tests/cli.test.ts", action: "create" }])]), REQUEST, { checks })).toEqual([]);
  });

  test("a sibling that carries the criterion and writes its own test may hold the case", () => {
    const tasks = [task("T004", [{ path: TEST, action: "create" }]), task("T005", [{ path: "tests/cli.test.ts", action: "create" }])];
    expect(suppliedContentFindings(WRONG, graph(tasks), REQUEST, { checks })).toEqual([]);
  });

  test("a request without verbatim files raises nothing", () => {
    expect(suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }])]), "Add a --version flag.", { checks })).toEqual([]);
  });

  test("scenario: the analysis returns the criterion before any implementer session", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: WRONG, inputTokens: 25, outputTokens: 25 };
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: TaskGraph };
        plan.taskGraph.specHash = hashJson(WRONG);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
        plan.taskGraph.tasks = [{ ...(plan.taskGraph.tasks[0] as TaskGraph["tasks"][number]), id: "T001", criterionIds: ["AC-001", "AC-006"], writes: [{ path: "value.txt", action: "create" }, { path: TEST, action: "create" }] }];
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy: fixture.policy });
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    expect(executor.calls).not.toContain("implementation");
    expect(snapshot.reason).not.toBe("approval");
    const asked = service.store.requests(run.runId).filter((r) => r.kind === "clarification");
    expect(asked.map((r) => r.body_json).join("\n")).toContain("Supplied content: AC-006");
  }, 60000);
});

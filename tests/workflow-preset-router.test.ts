import { afterEach, describe, expect, test } from "bun:test";
import { proposeWorkflow } from "../src/core/workflows/preset-router.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

const ALL = ["sdd", "quick", "quick-fix", "standard", "full", "spike", "review-only", "fix-ci"];
const propose = (text: string, available = ALL) => proposeWorkflow(text, available, "sdd");

describe("proposing a workflow from the request", () => {
  test("each kind of request gets its preset and budget", () => {
    expect(propose("Review the changes on this branch for security problems")).toMatchObject({ workflowId: "review-only", kind: "review", confidence: "high" });
    expect(propose("Investigate how we could cache the code graph between sessions")).toMatchObject({ workflowId: "spike", kind: "research" });
    expect(propose("CI is failing on Windows: the lint check is red")).toMatchObject({ workflowId: "fix-ci", kind: "ci-fix" });
    expect(propose("Fix the typo in the README install section")).toMatchObject({ workflowId: "quick", kind: "docs", budget: "quick" });
    expect(propose("Rename the --verbose flag label")).toMatchObject({ workflowId: "quick", kind: "small", budget: "quick" });
    expect(propose("Redesign the plugin architecture across the codebase")).toMatchObject({ workflowId: "sdd", kind: "large", budget: "extended" });
    expect(propose("Add an export button to the usage screen")).toMatchObject({ workflowId: "sdd", kind: "default", confidence: "low", signals: [] });
  });
  test("a change request is never sent to a read-only preset", () => {
    expect(propose("Review the diff and fix what you find").workflowId).not.toBe("review-only");
    expect(propose("Research the options and implement the fastest one").workflowId).not.toBe("spike");
    // A docs page that names code is not docs-only.
    expect(propose("Document the new API endpoint in the docs").kind).not.toBe("docs");
  });
  test("a preset that cannot start here falls back to the project default", () => {
    const proposal = proposeWorkflow("Fix the typo in the README", ["sdd", "custom"], "custom");
    expect(proposal).toMatchObject({ workflowId: "custom", kind: "docs", confidence: "medium", budget: "quick" });
    expect(proposal.reason).toContain("quick cannot start here");
  });
});

describe("--auto-preset and propose", () => {
  const fixture = () => {
    const f = workflowFixture();
    disposals.push(f.dispose);
    return f;
  };
  const cli = (f: ReturnType<typeof workflowFixture>, argv: string[]) =>
    executeWorkflowCommand(f.service, parseWorkflowArgs(argv), new AbortController().signal);

  test("propose prints the proposal for a request", async () => {
    const f = fixture();
    const proposal = await cli(f, ["propose", "Investigate", "why", "startup", "is", "slow"]);
    expect(proposal).toMatchObject({ kind: "research" });
    expect(() => parseWorkflowArgs(["propose"])).toThrow("Describe the request");
  });
  test("a run records the proposal and the workflow that ran, and the report says so", async () => {
    const f = fixture();
    const kept = (await cli(f, ["run", "--feature", "fixture", "--prompt", "Create ready value", "--auto-preset"])) as RunSnapshot;
    const choice = f.service.store.state(kept.runId).presetChoice;
    expect(choice).toMatchObject({ proposed: "sdd", chosen: "sdd", overridden: false, kind: "default" });
    expect(runReport(f.service.store, kept.runId)).toContain("Workflow proposed from the request: `sdd`");
    const overridden = (await cli(f, ["run", "quick", "--feature", "other", "--prompt", "Create ready value", "--auto-preset"])) as RunSnapshot;
    expect(f.service.store.state(overridden.runId).presetChoice).toMatchObject({ proposed: "sdd", chosen: "quick", overridden: true });
    const plain = (await cli(f, ["run", "--feature", "third", "--prompt", "Create ready value"])) as RunSnapshot;
    expect(f.service.store.state(plain.runId).presetChoice).toBeNull();
  });
});

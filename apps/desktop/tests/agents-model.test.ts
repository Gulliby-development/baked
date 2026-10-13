import { describe, expect, test } from "bun:test";
import type { ProjectAgent } from "../src/renderer/client/agents.js";
import {
  choiceProblem,
  freeId,
  isWorkflowId,
  origins,
  placement,
  planSummary,
  removable,
  resultLine,
  suggested,
} from "../src/renderer/screens/setup/agents-model.js";

const agent = (name: string, stage: ProjectAgent["stage"], extra: Partial<ProjectAgent> = {}) =>
  ({
    key: `.claude/agents/${name}.md`,
    name,
    source: "claude",
    sourceLabel: "Claude Code",
    path: `.claude/agents/${name}.md`,
    description: "",
    instructions: "",
    tools: [],
    model: null,
    stage,
    orchestrator: false,
    removable: true,
    content: "",
    hash: "0".repeat(64),
    ...extra,
  }) satisfies ProjectAgent;

const agents = [
  agent("architect", "plan"),
  agent("builder", "implement"),
  agent("auditor", "review"),
  agent("checker", "review"),
  agent("boss", "skip", { orchestrator: true, sourceLabel: "Roo Code", removable: false }),
];

describe("agents model", () => {
  test("places agents on stations and leaves the unused aside", () => {
    const { byStage, unused } = placement(agents, suggested(agents));
    expect(byStage.review.map((a) => a.name)).toEqual(["auditor", "checker"]);
    expect(unused.map((a) => a.name)).toEqual(["boss"]);
    expect(planSummary(agents, suggested(agents))).toBe(
      "Plan ← architect · Implement ← builder · Review ← auditor · Review ← checker",
    );
  });

  test("one agent per station except Review, and at least one agent", () => {
    expect(choiceProblem(agents, suggested(agents))).toBeNull();
    const twoPlans = { ...suggested(agents), [agents[1]?.key ?? ""]: "plan" as const };
    expect(choiceProblem(agents, twoPlans)).toBe(
      "Plan takes one agent; architect and builder are both on it.",
    );
    const none = Object.fromEntries(agents.map((a) => [a.key, "skip" as const]));
    expect(choiceProblem(agents, none)).toBe("Put at least one agent on a station.");
  });

  test("names, IDs and files", () => {
    expect(origins(agents)).toBe("Claude Code and Roo Code");
    expect(freeId(["agents", "agents-2"])).toBe("agents-3");
    expect(isWorkflowId("my-agents")).toBe(true);
    expect(isWorkflowId("-x")).toBe(false);
    expect(removable(agents, suggested(agents)).map((a) => a.name)).toEqual([
      "architect",
      "builder",
      "auditor",
      "checker",
    ]);
    expect(
      resultLine({
        workflowId: "agents",
        path: "",
        from: "standard",
        profiles: [{ id: "a", path: "", stage: "plan", agent: "a" }],
        gates: [],
        removed: ["a"],
        kept: [],
        notes: [],
        problems: [],
      }),
    ).toBe("Workflow agents now runs 1 agent as its steps and removed 1 agent file.");
  });
});

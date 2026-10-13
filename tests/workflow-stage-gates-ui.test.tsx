import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { gatesStage, StageGates } from "../src/components/workflow/StageGates.js";
import { type RunGate, runGates, type WorkflowLine } from "../src/core/workflows/v2/line.js";
import type { StageView } from "../src/core/workflows/view.js";

const stages: StageView[] = [
  { id: "plan", kind: "plan", status: "completed", generation: 0 },
  { id: "implement", kind: "task-graph", status: "completed", generation: 0 },
  { id: "checks", kind: "checks", status: "running", generation: 1 },
  { id: "review", kind: "review", status: "pending", generation: 0 },
];
const line: WorkflowLine = {
  stages: stages.map((s) => ({
    id: s.id,
    type: s.id === "checks" ? "check" : s.id === "review" ? "review" : "agent",
    consumes: [],
    produces: s.id,
    human: false,
    gates:
      s.id === "checks"
        ? [
            { id: "tests", type: "command", mode: "required", does: "Runs bun test", transition: null },
            { id: "lint", type: "command", mode: "advisory", does: "Runs bun run lint", transition: null },
            { id: "e2e", type: "command", mode: "required", does: "Runs bun run e2e", transition: null },
            {
              id: "smoke",
              type: "command",
              mode: "required",
              does: "Runs bun run smoke",
              transition: { id: "checks-failed", to: "implement", on: "failed" },
            },
          ]
        : [],
  })),
  loops: [],
};
const gates = runGates(
  line,
  { tests: { status: "passed", mode: "required", attempts: 2, flaky: true } },
  [
    { check_id: "tests", status: "failed" },
    { check_id: "lint", status: "failed" },
  ],
);

async function frame(width: number, height: number, current: string | null = "checks"): Promise<string> {
  let view!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    view = await testRender(<StageGates stages={stages} current={current} gates={gates} width={width} />, {
      width,
      height,
    });
  });
  try {
    for (let i = 0; i < 2; i++)
      await act(async () => {
        await view.flush();
        await view.renderOnce();
      });
    return view.captureCharFrame();
  } finally {
    act(() => view.renderer.destroy());
  }
}

describe("gates on the run's stage row", () => {
  test("a gate's own result wins over the check of the same ID; checks fill in the rest", () => {
    const byId = new Map((gates.checks ?? []).map((g: RunGate) => [g.id, g.last]));
    expect(byId.get("tests")).toEqual({ status: "passed", mode: "required", attempts: 2, flaky: true });
    expect(byId.get("lint")?.status).toBe("failed");
    expect(byId.get("e2e")).toBeNull();
  });

  test("the current stage's gates are listed; with no current stage, the last stage that has gates", () => {
    expect(gatesStage(stages, "checks", gates)?.id).toBe("checks");
    expect(gatesStage(stages, "plan", gates)).toBeNull();
    expect(gatesStage(stages, null, gates)?.id).toBe("checks");
  });

  test("120x40 lists each gate with blocks or advises, what it does, where it stands and its last result", async () => {
    const text = await frame(120, 40);
    expect(text).toContain("Gates of Checks");
    expect(text).toContain("~ tests · blocks · passed after 2 attempts, flaky");
    expect(text).toContain("Runs bun test, at this stage");
    expect(text).toContain("! lint · advises · failed");
    expect(text).toContain("· e2e · blocks · not run yet");
    expect(text).toContain("Runs bun run smoke, when it fails, before going back to Implement");
  });

  for (const [width, height] of [
    [80, 24],
    [50, 20],
  ] as const)
    test(`${width}x${height} keeps every gate on its own cut line`, async () => {
      const text = await frame(width, height);
      const rows = text.split("\n");
      expect(rows.every((row) => row.trimEnd().length <= width)).toBe(true);
      for (const id of ["tests", "lint", "e2e", "smoke"])
        expect(rows.some((row) => row.includes(` ${id} · `))).toBe(true);
    });

  test("a stage without gates shows nothing", async () => {
    expect((await frame(80, 10, "plan")).trim()).toBe("");
  });
});

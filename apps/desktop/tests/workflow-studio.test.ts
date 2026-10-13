import { describe, expect, test } from "bun:test";
import type { DefinitionSummary, WorkflowLine } from "../src/renderer/client/start.ts";
import type { EditorView, StageView } from "../src/renderer/client/workflow-editor.ts";
import { handoff } from "../src/renderer/screens/runs/line-model.ts";
import {
  boardSize,
  cardFacts,
  defaultLayout,
  edgeNear,
  edgePath,
  familyOf,
  frameAt,
  graphEdges,
  lineFromView,
  linkFor,
  magnet,
  matches,
  mergeLayout,
  miniLine,
  NODE_H,
  NODE_W,
  narrate,
  nodeAt,
  scenariosFor,
  snap,
  stepAt,
  walkStations,
  walkthrough,
} from "../src/renderer/screens/setup/workflow-studio-model.ts";

const stage = (
  id: string,
  type: WorkflowLine["stages"][number]["type"],
  produces: string,
  consumes: string[] = [],
): WorkflowLine["stages"][number] => ({
  id,
  type,
  produces,
  consumes,
  human: type === "approval",
  gates: [],
});

const QUICK: WorkflowLine = {
  stages: [
    stage("plan", "agent", "plan"),
    stage("approve", "approval", "decision", ["plan"]),
    stage("implement", "tasks", "implementation", ["plan", "decision"]),
    stage("checks", "check", "gates", ["implementation"]),
    {
      ...stage("review", "review", "review", ["implementation", "gates"]),
      gates: [
        {
          id: "correctness-review",
          type: "ai-review",
          mode: "required",
          does: "AI correctness review",
          transition: null,
        },
      ],
    },
  ],
  loops: [
    { from: "checks", to: "implement", on: "failed", carries: "gates" },
    { from: "review", to: "implement", on: "changes_requested", carries: "review" },
  ],
};

const summary = (over: Partial<DefinitionSummary>): DefinitionSummary => ({
  id: "quick",
  source: "builtin",
  preset: "quick",
  description: "A small task.",
  stages: QUICK.stages.map((s) => s.id),
  line: QUICK,
  writes: true,
  problems: [],
  execution: null,
  worktreeRefusal: null,
  ...over,
});

describe("workflow gallery", () => {
  test("a definition's family follows what it writes and its stations", () => {
    expect(familyOf(summary({}))).toBe("quick");
    expect(familyOf(summary({ id: "spike", writes: false }))).toBe("read");
    const repair: WorkflowLine = { stages: [stage("reproduce", "check", "gates"), ...QUICK.stages], loops: [] };
    expect(familyOf(summary({ line: repair, stages: repair.stages.map((s) => s.id) }))).toBe("repair");
    const full: WorkflowLine = {
      stages: [...QUICK.stages, stage("research", "agent", "research"), stage("learn", "learn", "report")],
      loops: [],
    };
    expect(familyOf(summary({ line: full, stages: full.stages.map((s) => s.id) }))).toBe("full");
  });

  test("a card lists stations, gates, loops and whether files change", () => {
    expect(cardFacts(summary({}))).toEqual([
      "5 stations",
      "1 gate",
      "2 repair loops",
      "changes files",
    ]);
    expect(cardFacts(summary({ writes: false, execution: "worktree" })).slice(-2)).toEqual([
      "read only",
      "worktrees",
    ]);
  });

  test("search matches the ID, the description and stage names", () => {
    expect(matches(summary({}), "QUI")).toBe(true);
    expect(matches(summary({}), "small")).toBe(true);
    expect(matches(summary({}), "implement")).toBe(true);
    expect(matches(summary({}), "converge")).toBe(false);
    expect(matches(summary({}), "  ")).toBe(true);
  });

  test("the mini line places stations side by side with loops under them", () => {
    const mini = miniLine(QUICK);
    expect(mini.stations.map((s) => s.x)).toEqual([0, 28, 56, 84, 112]);
    expect(mini.width).toBe(134);
    expect(mini.loops).toHaveLength(2);
    expect(mini.loops[0]?.d).toBe("M 95 22 C 95 30, 67 30, 67 22");
    expect(mini.loops[0]?.title).toBe("checks failed: back to implement");
  });
});

describe("workflow walkthrough", () => {
  test("the scenarios a line can play need a loop that takes them", () => {
    expect(scenariosFor(QUICK)).toEqual(["happy", "failed", "changes"]);
    expect(scenariosFor({ stages: QUICK.stages.slice(0, 2), loops: [] })).toEqual(["happy"]);
  });

  test("everything passes: each station works once, then the finish", () => {
    const walk = walkthrough(QUICK, "happy");
    expect(walk.events.map((e) => `${e.kind}:${walk.stations[e.at]?.id}`)).toEqual([
      "work:plan",
      "work:approve",
      "work:implement",
      "work:checks",
      "work:review",
      "work:done",
    ]);
    const end = frameAt(walk, walk.events.length - 1);
    expect(end.states.every((s) => s === "done")).toBe(true);
  });

  test("a failed check sends the work back once along its loop", () => {
    const walk = walkthrough(QUICK, "failed");
    expect(walk.events.map((e) => `${e.kind}:${walk.stations[e.at]?.id}`)).toEqual([
      "work:plan",
      "work:approve",
      "work:implement",
      "work:checks",
      "fail:checks",
      "back:implement",
      "work:checks",
      "work:review",
      "work:done",
    ]);
    const failed = frameAt(walk, 4);
    expect(failed.states.slice(0, 4)).toEqual(["done", "done", "done", "failed"]);
    const back = frameAt(walk, 5);
    expect(back.states.slice(0, 5)).toEqual(["done", "done", "current", "pending", "pending"]);
    expect(back.rounds[2]).toBe(2);
    expect(narrate(walk, back.event).title).toBe("Back at implement with the gates");
    expect(stepAt(walk, 3)).toBe(3);
  });

  test("frames become conveyor stations: an approval waits, gates take their result", () => {
    const walk = walkthrough(QUICK, "changes");
    const atApproval = walkStations(walk, frameAt(walk, 1));
    expect(atApproval[1]?.state).toBe("waiting");
    const review = walk.events.findIndex((e) => e.kind === "fail");
    const stations = walkStations(walk, frameAt(walk, review));
    expect(stations[4]?.state).toBe("failed");
    expect(stations[4]?.gates[0]?.last?.status).toBe("failed");
    expect(stations.at(-1)).toMatchObject({ id: "done", type: "finish", produces: null });
    // The conveyor carries the review back along the loop when implement restarts.
    const restarted = walkStations(walk, frameAt(walk, review + 1));
    expect(handoff(stations, restarted, walk.loops)).toEqual({
      kind: "repair",
      from: 4,
      to: 2,
      contract: "review",
    });
  });

  test("narration names the contracts a station takes and makes", () => {
    const walk = walkthrough(QUICK, "happy");
    expect(narrate(walk, { kind: "work", at: 1 }).text).toBe(
      "The line waits for you to approve the plan. Nothing is written to your files before that.",
    );
    expect(narrate(walk, { kind: "work", at: 0 }).text).toContain("works from your goal");
    expect(narrate(walk, { kind: "work", at: 5 }).title).toBe("Done");
  });
});

const target = (
  id: string,
  to: string,
  on: "passed" | "failed" | "changes_requested",
  loop: number | null = null,
) => ({
  target: { kind: "transition" as const, id },
  name: id,
  transition: { to, on, loop },
  bindings: [],
  options: [{ gateId: "lint", summary: "command", disabled: null }],
});

const view = (): EditorView => {
  const stages: StageView[] = [
    { id: "plan", type: "agent", produces: "plan", fields: [], targets: [target("plan-approve", "implement", "passed")], transitionChoices: { to: ["implement", "checks", "done"], on: ["passed"], loop: [null] } },
    { id: "implement", type: "tasks", produces: "implementation", fields: [], targets: [target("implement-checks", "checks", "passed")], transitionChoices: { to: ["plan", "checks", "done"], on: ["passed"], loop: [null] } },
    {
      id: "checks",
      type: "check",
      produces: "gates",
      fields: [],
      targets: [
        { target: { kind: "stage", stageId: "checks" }, name: "stage checks", transition: null, bindings: [], options: [] },
        target("checks-done", "done", "passed"),
        target("checks-implement", "implement", "failed", 3),
      ],
      transitionChoices: { to: ["plan", "implement", "done"], on: ["passed", "failed"], loop: [null, 3, 5] },
    },
  ];
  return {
    id: "mini-custom",
    from: "mini",
    copy: true,
    definition: { id: "mini-custom", stages: [], transitions: [] },
    readOnly: null,
    dirty: true,
    stages,
    problems: [],
    estimate: "",
  };
};

describe("workflow graph", () => {
  test("the default layout fills rows of four and ends with the finish", () => {
    const layout = defaultLayout(["a", "b", "c", "d", "e"]);
    expect(layout.a).toEqual({ x: 40, y: 60 });
    expect(layout.d).toEqual({ x: 640, y: 60 });
    expect(layout.e).toEqual({ x: 40, y: 260 });
    expect(layout.done).toEqual({ x: 240, y: 260 });
    expect(defaultLayout(["a", "b", "c", "d"]).done).toEqual({ x: 40, y: 260 });
    expect(defaultLayout(["a", "b"]).done).toEqual({ x: 440, y: 60 });
    expect(boardSize(layout)).toEqual({ width: 860, height: 520 });
  });

  test("a saved layout keeps known stations and places new ones", () => {
    const merged = mergeLayout(["a", "b"], { a: { x: 400, y: 400 }, gone: { x: 1, y: 1 } });
    expect(merged).toEqual({ a: { x: 400, y: 400 }, b: { x: 240, y: 60 }, done: { x: 440, y: 60 } });
  });

  test("a dragged station pulls into line with another and snaps to the grid", () => {
    const layout = { a: { x: 40, y: 60 }, b: { x: 240, y: 60 } };
    const pulled = magnet("b", { x: 250, y: 70 }, layout);
    expect(pulled).toEqual({ point: { x: 250, y: 60 }, guideX: null, guideY: 60 + NODE_H / 2 });
    expect(magnet("b", { x: 48, y: 300 }, layout).guideX).toBe(40 + NODE_W / 2);
    expect(snap({ x: 249, y: 71 })).toEqual({ x: 240, y: 80 });
    expect(snap({ x: -12, y: 3 })).toEqual({ x: 0, y: 0 });
  });

  test("hit tests find the topmost station and the nearest arrow", () => {
    const layout = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } };
    expect(nodeAt(layout, { x: 120, y: 10 }, ["a", "b"])).toBe("b");
    expect(nodeAt(layout, { x: 50, y: 10 }, ["a", "b"])).toBe("a");
    expect(nodeAt(layout, { x: 500, y: 500 }, ["a", "b"])).toBeNull();
    const edges = graphEdges(view(), defaultLayout(["plan", "implement", "checks"]));
    const first = edges[0];
    if (!first) throw new Error("expected an edge");
    expect(edgeNear(edges, first.mid)?.id).toBe("plan-approve");
    expect(edgeNear(edges, { x: -500, y: -500 })).toBeNull();
  });

  test("edges curve forward, down to a later row, or loop under the line", () => {
    expect(edgePath({ x: 0, y: 0 }, { x: 200, y: 0 }, false, 0).d).toBe(
      "M 160 32 C 190 32, 168 32, 198 32",
    );
    expect(edgePath({ x: 200, y: 0 }, { x: 0, y: 200 }, false, 0).d).toBe(
      "M 280 64 C 280 131, 80 131, 80 198",
    );
    const loop = edgePath({ x: 200, y: 0 }, { x: 0, y: 0 }, true, 1);
    expect(loop.d).toBe("M 294 64 C 294 136, 66 136, 66 66");
    const edges = graphEdges(view(), defaultLayout(["plan", "implement", "checks"]));
    expect(edges.map((e) => [e.id, e.back])).toEqual([
      ["plan-approve", false],
      ["implement-checks", false],
      ["checks-done", false],
      ["checks-implement", true],
    ]);
  });

  test("a drawn link becomes the transition the editor would accept", () => {
    const v = view();
    const [plan, , checks] = v.stages as [StageView, StageView, StageView];
    expect(linkFor(plan, "checks", v)).toEqual({
      ok: false,
      reason: "plan already has a transition on passed. Remove it first.",
    });
    expect(linkFor({ ...plan, targets: [] }, "checks", v)).toEqual({
      ok: true,
      on: "passed",
      loop: null,
    });
    const open = { ...checks, targets: checks.targets.filter((t) => t.transition?.on !== "failed") };
    expect(linkFor(open, "plan", v)).toEqual({ ok: true, on: "failed", loop: 3 });
    expect(linkFor(checks, "plan", v)).toEqual({
      ok: false,
      reason: "checks already has a transition on failed. Remove it first.",
    });
    expect(linkFor(plan, "plan", v)).toEqual({ ok: false, reason: "plan cannot lead to plan." });
    const implement = v.stages[1] as StageView;
    expect(linkFor(implement, "plan", v)).toEqual({
      ok: false,
      reason:
        "implement only passes, so it cannot send work back. Loops start at checks, reviews and convergence.",
    });
  });

  test("the walkthrough plays the working copy from the editor view", () => {
    const line = lineFromView(view(), QUICK);
    expect(line.stages.map((s) => s.id)).toEqual(["plan", "implement", "checks"]);
    expect(line.stages[1]?.consumes).toEqual(["plan", "decision"]);
    expect(line.loops).toEqual([{ from: "checks", to: "implement", on: "failed", carries: "gates" }]);
  });
});

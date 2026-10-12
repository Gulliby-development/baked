import { describe, expect, test } from "bun:test";
import type { WorkflowLine } from "../src/renderer/client/start.ts";
import {
  describe as describeStation,
  FINISH,
  focusStation,
  handoff,
  lineOf,
  loopText,
  type Station,
  sectionsOf,
  stageIcon,
  stageIconOf,
  stations,
} from "../src/renderer/screens/runs/line-model.ts";
import type { PipelineStage, PipelineState } from "../src/renderer/screens/runs/model.ts";

const IDS = ["plan", "approve", "implement", "checks", "review"];
const LINE: WorkflowLine = {
  stages: [
    { id: "plan", type: "agent", consumes: ["request"], produces: "plan", human: false },
    { id: "approve", type: "approval", consumes: ["plan"], produces: "decision", human: true },
    { id: "implement", type: "tasks", consumes: ["plan", "decision"], produces: "implementation", human: false },
    { id: "checks", type: "check", consumes: ["implementation"], produces: "gates", human: false },
    { id: "review", type: "review", consumes: ["plan", "implementation", "gates"], produces: "review", human: false },
  ],
  loops: [
    { from: "checks", to: "implement", on: "failed", carries: "gates" },
    { from: "review", to: "implement", on: "changes_requested", carries: "review" },
  ],
};

function pipe(states: PipelineState[]): PipelineStage[] {
  return IDS.map((id, i) => ({ id, label: id, state: states[i] ?? "pending" }));
}

describe("workflow line", () => {
  test("stations follow the pipeline and end in a finish station", () => {
    const list = stations(pipe(["done", "done", "current"]), LINE, new Map([["implement", 1]]), "running");
    expect(list.map((s) => s.id)).toEqual([...IDS, FINISH]);
    expect(list[2]).toMatchObject({ type: "tasks", produces: "implementation", round: 2 });
    expect(list[1]?.human).toBe(true);
    expect(list.at(-1)).toMatchObject({ type: "finish", consumes: ["review"], state: "pending" });
    expect(stations(pipe([]), LINE, new Map(), "completed").at(-1)?.state).toBe("done");
  });

  test("a backend without the line gets roles guessed from stage IDs", () => {
    const guessed = lineOf(["research", "approve", "implement", "verify", "review"], undefined);
    expect(guessed.stages.map((s) => s.type)).toEqual(["agent", "approval", "tasks", "check", "review"]);
    expect(guessed.loops).toEqual([]);
    expect(lineOf(IDS, LINE)).toBe(LINE);
  });

  test("the focus is the station that needs the user, then the working one", () => {
    const at = (states: PipelineState[], run = "running") =>
      focusStation(stations(pipe(states), LINE, new Map(), run));
    expect(at(["done", "waiting"])).toBe("approve");
    expect(at(["done", "done", "current"])).toBe("implement");
    expect(at(["done", "done", "done", "failed"], "failed")).toBe("checks");
    expect(at(["done", "done", "done", "done", "done"], "completed")).toBe(FINISH);
    expect(at([])).toBe("plan");
  });

  test("each station opens the sections about what it makes", () => {
    const list = stations(pipe([]), LINE, new Map(), "running");
    const of = (id: string) => sectionsOf(list.find((s) => s.id === id) as Station);
    expect(of("plan")).toEqual(["plan"]);
    expect(of("approve")[0]).toBe("decision");
    expect(of("implement")).toEqual(["tasks", "changes"]);
    expect(of("checks")).toEqual(["checks", "criteria"]);
    expect(of("review")[0]).toBe("findings");
    expect(of(FINISH)).toEqual(["overview", "report", "criteria"]);
  });

  test("descriptions name the contracts and where a loop sends the work", () => {
    const list = stations(pipe([]), LINE, new Map(), "running");
    const checks = list.find((s) => s.id === "checks") as Station;
    expect(describeStation(checks, LINE.loops)).toBe(
      "Runs the project's checks on the result. When it fails, its gates contract goes back to Implement.",
    );
    expect(describeStation(list[1] as Station, LINE.loops)).toContain("approve the plan");
    const loop = LINE.loops[0];
    if (!loop) throw new Error("expected a loop");
    expect(loopText(loop, "Checks")).toBe("Checks failed: back with gates");
  });

  test("a finished stage hands its contract forward; a loop carries one back", () => {
    const before = stations(pipe(["done", "done", "current"]), LINE, new Map(), "running");
    const after = stations(pipe(["done", "done", "done", "current"]), LINE, new Map(), "running");
    expect(handoff(before, after, LINE.loops)).toEqual({
      kind: "forward",
      from: 2,
      to: 3,
      contract: "implementation",
    });
    const failed = stations(pipe(["done", "done", "done", "current"]), LINE, new Map(), "running");
    const repair = stations(pipe(["done", "done", "current", "failed"]), LINE, new Map(), "running");
    expect(handoff(failed, repair, LINE.loops)).toEqual({
      kind: "repair",
      from: 3,
      to: 2,
      contract: "gates",
    });
    expect(handoff(after, after, LINE.loops)).toBeNull();
  });
});

describe("stage icons", () => {
  test("each station of the line gets the icon of its role", () => {
    const pending = IDS.map((id) => ({ id, label: id, state: "pending" as PipelineState }));
    const list = stations(pending, LINE, new Map(), "running");
    expect(list.map(stageIcon)).toEqual([
      "plan",
      "attention",
      "implement",
      "checks",
      "review",
      "accept",
    ]);
  });

  test("a stage guessed from its ID alone", () => {
    expect(stageIconOf("research")).toBe("research");
    expect(stageIconOf("spec")).toBe("spec");
    expect(stageIconOf("implement")).toBe("implement");
    expect(stageIconOf("verify")).toBe("checks");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { type WorkflowListEntry, WorkflowsPopup } from "../src/components/workflow/WorkflowsView.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { type DefinitionSummary, listDefinitions } from "../src/core/workflows/v2/definitions.js";
import {
  familyOf,
  FINISH,
  frameAt,
  lineText,
  narrate,
  scenariosFor,
  stepAt,
  walkthrough,
} from "../src/core/workflows/v2/walkthrough.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function builtins(): Map<string, DefinitionSummary> {
  const workspace = mkdtempSync(join(tmpdir(), "baked-walkthrough-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  return new Map(listDefinitions(workspace, PolicySchema.parse(defaultWorkflowPolicy)).map((d) => [d.id, d]));
}

describe("workflow walkthrough model", () => {
  test("families and the one-row line of the built-in workflows", () => {
    const all = builtins();
    const get = (id: string) => all.get(id) as DefinitionSummary;
    expect(familyOf(get("sdd"))).toBe("full");
    expect(familyOf(get("quick-fix"))).toBe("quick");
    expect(familyOf(get("standard"))).toBe("spec");
    expect(familyOf(get("fix-ci"))).toBe("repair");
    expect(familyOf(get("spike"))).toBe("read");
    expect(lineText(get("quick"))).toBe("plan → approve → implement → checks ⟲ → review ⟲");
    expect(lineText({ line: { stages: [], loops: [] }, stages: ["a", "b"] })).toBe("a → b");
    expect(scenariosFor(get("quick").line)).toEqual(["happy", "failed", "changes"]);
    expect(scenariosFor(get("quick-fix").line)).toEqual(["happy", "failed"]);
    expect(scenariosFor(get("spike").line)).toEqual(["happy"]);
  });

  test("a failing check sends the work back once and the line then finishes", () => {
    const line = (builtins().get("quick-fix") as DefinitionSummary).line;
    const happy = walkthrough(line, "happy");
    expect(happy.stations.map((s) => s.id)).toEqual(["plan", "approve", "implement", "checks", FINISH]);
    expect(happy.events.every((e) => e.kind === "work")).toBe(true);
    const failed = walkthrough(line, "failed");
    const loop = line.loops.find((l) => l.on === "failed");
    expect(loop?.from).toBe("checks");
    const kinds = failed.events.map((e) => `${e.kind}:${failed.stations[e.at]?.id}`);
    expect(kinds.slice(3, 6)).toEqual(["work:checks", "fail:checks", `back:${loop?.to}`]);
    expect(kinds.at(-1)).toBe(`work:${FINISH}`);
    const failing = frameAt(failed, 4);
    expect(failing.states[3]).toBe("failed");
    expect(narrate(failed, failing.event).title).toBe("checks failed");
    const back = frameAt(failed, 5);
    expect(narrate(failed, back.event).title).toContain(`Back at ${loop?.to}`);
    const end = frameAt(failed, failed.events.length - 1);
    expect(end.states.every((s) => s === "done")).toBe(true);
    const at = failed.stations.findIndex((s) => s.id === loop?.to);
    expect(end.rounds[at]).toBe(2);
    expect(stepAt(failed, 3)).toBe(3);
    expect(narrate(failed, frameAt(failed, 1).event).text).toContain("waits for you to approve");
  });
});

type View = Awaited<ReturnType<typeof testRender>>;

function entries(): WorkflowListEntry[] {
  return [...builtins().values()]
    .filter((d) => ["quick", "quick-fix", "spike"].includes(d.id))
    .map((d) => ({ id: d.id, description: d.description, stages: d.stages, line: d.line, writes: d.writes, problems: d.problems }))
    .concat([{ id: "broken", stages: [], writes: true, problems: ["Unknown gate lint"] }]);
}

async function frame(view: View): Promise<string> {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await view.flush();
      await view.renderOnce();
    });
  return view.captureCharFrame();
}
const press = async (view: View, key: () => void) => {
  await act(async () => {
    key();
    await Bun.sleep(30);
  });
};

for (const [width, height] of [
  [120, 40],
  [80, 24],
] as const) {
  test(`workflows screen at ${width}x${height}: list, step-through, scenario, edit and back`, async () => {
    const edits: string[] = [];
    let backs = 0;
    let view!: View;
    await act(async () => {
      view = await testRender(
        <WorkflowsPopup
          definitions={entries()}
          width={width}
          height={Math.min(40, height)}
          onBack={() => {
            backs++;
          }}
          onEdit={(id) => edits.push(id)}
        />,
        { width, height },
      );
    });
    let text = await frame(view);
    expect(text).toContain("quick");
    expect(text).toContain("plan → approve");
    expect(text).toContain("✗ Unknown gate lint");
    expect(text).toContain("Read only");

    // The list is in listing order: quick, quick-fix, spike, broken. Step through quick-fix.
    await press(view, () => view.mockInput.pressArrow("down"));
    await press(view, () => view.mockInput.pressEnter());
    text = await frame(view);
    expect(text).toContain("quick-fix: Everything passes");
    expect(text).toContain("● plan");
    expect(text).toContain("Step 1 of");

    await press(view, () => view.mockInput.pressKey("s"));
    for (let i = 0; i < 4; i++) await press(view, () => view.mockInput.pressArrow("right"));
    text = await frame(view);
    expect(text).toContain("A check fails once");
    expect(text).toContain("✗ checks");
    expect(text).toContain("checks failed");

    await press(view, () => view.mockInput.pressKey("e"));
    expect(edits).toEqual(["quick-fix"]);
    await press(view, () => view.mockInput.pressEscape());
    await Bun.sleep(120);
    text = await frame(view);
    expect(text).toContain("Workflows a run can start from");
    await press(view, () => view.mockInput.pressEscape());
    await Bun.sleep(120);
    expect(backs).toBe(1);
  });
}

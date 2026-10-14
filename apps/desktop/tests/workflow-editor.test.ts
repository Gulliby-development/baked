import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { workflowEditor } = await import("../src/renderer/client/workflow-editor.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const { outcomeLabel, problemsFor, targetKey } = await import(
  "../src/renderer/screens/setup/workflow-editor-logic.ts"
);
delete scope.window;

describe("workflow editor client", () => {
  test("opens a preset read only, duplicates it, edits and saves the copy", async () => {
    expect(await workflowEditor.offered("baked")).toEqual({ editor: true, remove: true });
    const { view: preset } = await workflowEditor.open("baked", "quick");
    expect(preset.readOnly).not.toBeNull();
    const refused = await workflowEditor.edit("baked", preset, {
      op: "removeTransition",
      id: "plan-approve",
    });
    expect(refused.error).toBe(preset.readOnly ?? "");

    const { view: copy } = await workflowEditor.edit("baked", preset, { op: "duplicate" });
    expect([copy.id, copy.copy, copy.readOnly, copy.dirty]).toEqual([
      "quick-custom",
      true,
      null,
      true,
    ]);
    const checks = { kind: "stage", stageId: "checks" } as const;
    const { view: toggled } = await workflowEditor.edit("baked", copy, {
      op: "toggleMode",
      target: checks,
      index: 0,
    });
    const binding = toggled.stages
      .find((s) => s.id === "checks")
      ?.targets.find((t) => t.target.kind === "stage")?.bindings[0];
    expect([binding?.gateId, binding?.mode, binding?.override]).toEqual([
      "typecheck",
      "advisory",
      true,
    ]);

    const review = await workflowEditor.review("baked", toggled);
    expect(review.kind).toBe("review");
    const outcome = await workflowEditor.save("baked", toggled);
    expect(outcome.saved).toBe(true);
    expect(outcome.view.dirty).toBe(false);
    expect((await workflowEditor.review("baked", outcome.view)).kind).toBe("unchanged");
  });

  test("deletes a saved project workflow and refuses a built-in one (#1101)", async () => {
    const { view: preset } = await workflowEditor.open("baked", "spike");
    const { view: copy } = await workflowEditor.edit("baked", preset, { op: "duplicate" });
    const outcome = await workflowEditor.save("baked", copy);
    if (!outcome.saved) throw new Error("not saved");
    expect(await workflowEditor.remove("baked", outcome.view.id)).toEqual({
      id: outcome.view.id,
      path: `baked/workflows/${outcome.view.id}.json`,
      restores: null,
    });
    await expect(workflowEditor.open("baked", outcome.view.id)).rejects.toThrow("Unknown workflow");
    await expect(workflowEditor.remove("baked", "spike")).rejects.toThrow("built-in");
  });

  test("an auto approval needs the typed hash prefix", async () => {
    const { view: preset } = await workflowEditor.open("baked", "quick");
    const { view: copy } = await workflowEditor.edit("baked", preset, { op: "duplicate" });
    const { view: auto } = await workflowEditor.edit("baked", copy, {
      op: "changeField",
      stageId: "approve",
      key: "decision",
      delta: 1,
    });
    const unconfirmed = await workflowEditor.save("baked", auto);
    expect(unconfirmed.saved).toBe(false);
    if (unconfirmed.saved || unconfirmed.review.kind !== "review") throw new Error("no review");
    expect(unconfirmed.confirmationNeeded).toBe(true);
    const prefix = unconfirmed.review.autoApproval?.prefix ?? "";
    expect((await workflowEditor.save("baked", auto, prefix)).saved).toBe(true);
  });

  test("a refused edit names the reason and keeps the copy", async () => {
    const { view: preset } = await workflowEditor.open("baked", "quick");
    const { view: copy } = await workflowEditor.edit("baked", preset, { op: "duplicate" });
    const refused = await workflowEditor.edit("baked", copy, {
      op: "addGate",
      target: { kind: "stage", stageId: "checks" },
      gateId: "correctness-review",
    });
    expect(refused.error).toContain("command gates only");
    expect(refused.view.definition).toEqual(copy.definition);
  });

  test("adds a wait stage after a stage, changes its interval and removes it", async () => {
    const { view: preset } = await workflowEditor.open("baked", "quick");
    const { view: copy } = await workflowEditor.edit("baked", preset, { op: "duplicate" });
    const { view: added } = await workflowEditor.edit("baked", copy, {
      op: "addWaitStage",
      after: "review",
    });
    const wait = added.stages.find((s) => s.type === "wait");
    expect(wait?.fields.map((f) => `${f.key}=${f.value}`)).toEqual(["interval=30s", "timeout=30 min"]);
    expect(added.problems.flatMap((g) => g.messages)).toContain("needs at least one gate");
    const { view: faster } = await workflowEditor.edit("baked", added, {
      op: "changeField",
      stageId: "wait",
      key: "interval",
      delta: 1,
    });
    expect(faster.stages.find((s) => s.id === "wait")?.fields[0]?.value).toBe("60s");
    const { view: removed } = await workflowEditor.edit("baked", faster, {
      op: "removeWaitStage",
      stageId: "wait",
    });
    expect(removed.definition).toEqual(copy.definition);
  });
});

describe("workflow editor screen logic", () => {
  test("routes, keys, outcomes and problems", () => {
    expect(parseRoute(projectHref("baked", "workflows", "quick").slice(1))).toMatchObject({
      section: "workflows",
    });
    expect(targetKey({ kind: "stage", stageId: "checks" })).toBe("stage:checks");
    expect(targetKey({ kind: "transition", id: "a-b" })).toBe("transition:a-b");
    expect(outcomeLabel("changes_requested")).toBe("changes requested");
    const stage = {
      id: "review",
      type: "review" as const,
      produces: "review",
      fields: [],
      targets: [
        {
          target: { kind: "transition" as const, id: "review-done" },
          name: "review-done",
          transition: null,
          bindings: [],
          options: [],
        },
      ],
      transitionChoices: { to: [], on: [], loop: [] },
    };
    expect(
      problemsFor(
        [
          { owner: "stage review", messages: ["needs at least one gate"] },
          { owner: "transition review-done", messages: ["loops forever"] },
          { owner: "transition other", messages: ["ignored"] },
          { owner: "definition", messages: ["ignored too"] },
        ],
        stage,
      ),
    ).toEqual(["needs at least one gate", "review-done: loops forever"]);
  });
});

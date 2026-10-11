import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { type RoutingApi, RoutingPopup, type RoutingScope } from "../src/components/workflow/RoutingView.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type ModelRouting, mergeModelRouting } from "../src/core/llm/model-routing.js";
import { explainRoute } from "../src/core/workflows/routing.js";

type View = Awaited<ReturnType<typeof testRender>>;
const SIZES = [
  [120, 40],
  [80, 24],
  [50, 20],
] as const;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Both configuration layers in memory; routes resolve through the real `workflow route` code. */
function harness() {
  const workspace = mkdtempSync(join(tmpdir(), "baked-routing-ui-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const layers: Record<RoutingScope, ModelRouting | undefined> = { global: undefined, project: undefined };
  const state = { saves: 0, backs: 0 };
  const api: RoutingApi = {
    load: () => ({ global: layers.global, project: layers.project, workflows: ["sdd", "quick"] }),
    explain: (workflowId, model) =>
      explainRoute(
        workspace,
        { ...DEFAULT_CONFIG, modelRouting: mergeModelRouting(layers.global, layers.project) },
        { workflowId, model: model ?? undefined },
      ),
    save: (scope, routing) => {
      layers[scope] = routing;
      state.saves++;
    },
  };
  return { api, layers, state };
}

async function mount(api: RoutingApi, size: { width: number; height: number }, onBack: () => void): Promise<View> {
  let view!: View;
  await act(async () => {
    view = await testRender(
      <RoutingPopup api={api} model="run/model" width={Math.min(120, size.width)} height={Math.min(40, size.height)} onBack={onBack} />,
      size,
    );
  });
  return view;
}
/** Renders, checks that the popup lies inside the terminal, and returns the frame. */
async function frame(view: View, width: number, height: number, name: string): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  const popup = view.renderer.root.findDescendantById("baked-popup");
  expect(popup, name).toBeTruthy();
  if (popup) {
    expect(popup.x >= 0 && popup.y >= 0, `${name}: origin`).toBe(true);
    expect(popup.x + popup.width <= width && popup.y + popup.height <= height, `${name}: inside ${width}x${height}`).toBe(true);
  }
  // The list is windowed to the popup body, so nothing scrolls out of view.
  const body = view.renderer.root.findDescendantById("baked-popup-body") as unknown as {
    content: { height: number };
    viewport: { height: number };
  } | null;
  if (body) expect(body.content.height <= body.viewport.height, `${name}: fits without scrolling`).toBe(true);
  const text = view.captureCharFrame();
  expect(text, name).toContain("Workflow");
  expect(text.toLowerCase(), `${name}: exit hint`).toContain("esc");
  return text;
}
const press = async (view: View, key: string, times = 1) => {
  for (let i = 0; i < times; i++)
    await act(async () => {
      if (key === "up" || key === "down" || key === "left" || key === "right") view.mockInput.pressArrow(key);
      else if (key === "return") view.mockInput.pressEnter();
      else if (key === "tab") view.mockInput.pressTab();
      else if (key === "escape") {
        view.mockInput.pressEscape();
        await Bun.sleep(120);
      }
      else view.mockInput.pressKey(key);
    });
};
/** Ctrl+S saves the route form from any field. */
const save = async (view: View) => {
  await act(async () => {
    view.mockInput.pressKey("s", { ctrl: true });
  });
};
const type = async (view: View, text: string) => {
  await act(async () => { await view.mockInput.typeText(text); });
};

for (const [width, height] of SIZES) {
  test(`routing screen at ${width}x${height}: classes, roles, validation, scopes, stages and review mode`, async () => {
    const { api, layers, state } = harness();
    const view = await mount(api, { width, height }, () => { state.backs++; });
    const size = `${width}x${height}`;

    let text = await frame(view, width, height, `${size} browse`);
    expect(text).toContain("Classes");
    expect(text).toContain("$active");
    expect(text).toContain("[global]");
    expect(text).toContain("Resolves to run/model");

    // A new class with an effort, written to the global layer.
    await press(view, "down", 4);
    text = await frame(view, width, height, `${size} new class row`);
    expect(text).toContain("+ new class");
    await press(view, "return");
    await type(view, "deep");
    await press(view, "tab");
    await type(view, "x/big");
    await press(view, "tab");
    await press(view, "right", 2);
    text = await frame(view, width, height, `${size} class form`);
    expect(text).toContain("‹ low ›");
    await press(view, "return");
    expect(layers.global).toEqual({ classes: { deep: { model: "x/big", effort: "low" } } });

    // A role routed to an undefined class is refused, then routed to the new class.
    await press(view, "down", 2);
    text = await frame(view, width, height, `${size} researcher`);
    expect(text).toContain("roles.researcher");
    await press(view, "return");
    await type(view, "$nope");
    await save(view);
    text = await frame(view, width, height, `${size} refused`);
    expect(text).toContain("which no class");
    expect(layers.global?.roles).toBeUndefined();
    await press(view, "escape");
    await press(view, "return");
    await type(view, "$deep");
    await save(view);
    expect(layers.global?.roles).toEqual({ researcher: "$deep" });
    text = await frame(view, width, height, `${size} routed role`);
    expect(text).toContain("Resolves to x/big · low");

    // A class still in use cannot be cleared.
    await press(view, "up", 2);
    await press(view, "d");
    text = await frame(view, width, height, `${size} clear refused`);
    expect(text).toContain("Not cleared");
    expect(layers.global?.classes?.deep).toBeDefined();

    // The project scope shows the global route as inherited and writes its own layer.
    await press(view, "tab");
    await press(view, "down", 2);
    text = await frame(view, width, height, `${size} project scope`);
    expect(text).toContain("[project]");
    expect(text).toContain("global: $deep");

    // Walk down to the first stage of sdd and route it in the project layer.
    for (let i = 0; i < 30 && !text.includes("workflows.sdd.stages."); i++) {
      await press(view, "down");
      text = await frame(view, width, height, `${size} to stages`);
    }
    expect(text).toContain("workflows.sdd.stages.");
    await press(view, "return");
    await type(view, "a/stage");
    await save(view);
    const stages = layers.project?.workflows?.sdd?.stages ?? {};
    expect(Object.values(stages)).toEqual(["a/stage"]);
    text = await frame(view, width, height, `${size} stage routed`);
    expect(text).toContain("Resolves to a/stage");

    // W switches the workflow; the stages listed follow it.
    await press(view, "w");
    text = await frame(view, width, height, `${size} quick`);
    expect(text).toContain("quick");

    // Independent review cycles in the selected scope.
    await press(view, "up");
    for (let i = 0; i < 60 && !text.includes("Effective:"); i++) {
      await press(view, "up");
      text = await frame(view, width, height, `${size} to review`);
    }
    await press(view, "right");
    expect(layers.project?.independentReview).toBe("off");
    const saves = state.saves;

    await press(view, "escape");
    expect(state.backs).toBe(1);
    expect(state.saves).toBe(saves);
    view.renderer.destroy();
  });
}

for (const [width, height] of SIZES) {
  test(`routing form at ${width}x${height}: models and fallback models come from the model list`, async () => {
    const { api, layers } = harness();
    let asked = 0;
    api.models = async () => {
      asked++;
      return {
        providers: [
          { id: "alpha", name: "Alpha", configured: true, models: [
            { id: "alpha/one", name: "One", contextWindow: 200_000 },
            { id: "alpha/two", name: "Two" },
          ] },
          { id: "beta", name: "Beta", configured: false, models: [] },
        ],
      };
    };
    const view = await mount(api, { width, height }, () => {});
    const size = `${width}x${height}`;

    // The researcher role: Enter on the Model field opens the list, with model names on top.
    for (let i = 0; i < 20; i++) {
      const text = await frame(view, width, height, `${size} to researcher`);
      if (text.includes("roles.researcher")) break;
      await press(view, "down");
    }
    await press(view, "return");
    await press(view, "return");
    let text = await frame(view, width, height, `${size} list`);
    expect(text).toContain("$active");
    expect(text).toContain("alpha/one");
    if (height >= 24) expect(text).toContain("no key or login");
    expect(asked).toBe(1);

    // Typing filters; Enter puts the choice in the field, and the form saves it.
    await type(view, "two");
    text = await frame(view, width, height, `${size} filtered`);
    expect(text).toContain("alpha/two");
    expect(text).not.toContain("alpha/one");
    await press(view, "return");
    text = await frame(view, width, height, `${size} picked`);
    expect(text).toContain("alpha/two");
    await save(view);
    expect(layers.global?.roles).toEqual({ researcher: "alpha/two" });

    // Fallback models are added one at a time from the list, which offers no model names.
    await press(view, "return");
    await press(view, "down", 2);
    await press(view, "return");
    text = await frame(view, width, height, `${size} fallback list`);
    expect(text).not.toContain("$active");
    await type(view, "one");
    await press(view, "return");
    // A model the list does not show is used as typed.
    await press(view, "return");
    await type(view, "gamma/x");
    text = await frame(view, width, height, `${size} typed`);
    expect(text).toContain("as typed");
    await press(view, "return");
    await save(view);
    expect(layers.global?.roles).toEqual({
      researcher: { model: "alpha/two", fallback: ["alpha/one", "gamma/x"] },
    });

    // Esc leaves the list without changing the field.
    await press(view, "return");
    await press(view, "return");
    await press(view, "escape");
    text = await frame(view, width, height, `${size} back to form`);
    expect(text).toContain("Fallback");
    expect(asked).toBe(1);
    view.renderer.destroy();
  });
}

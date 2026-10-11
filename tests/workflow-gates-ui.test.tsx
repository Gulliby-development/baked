import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { type GatesApi, GatesView } from "../src/components/workflow/GatesView.js";
import type { GateRunResult, GateSuggestion } from "../src/core/workflows/gates.js";
import type { Check } from "../src/core/workflows/types.js";

type View = Awaited<ReturnType<typeof testRender>>;
const gate = (patch: Partial<Check>): Check => ({
  id: "tests", executable: "bun", args: ["run", "test"], cwd: ".", timeoutMs: 600000,
  required: true, scope: "feature", envNames: [], writes: [], ...patch,
});
// Escape is held back briefly so it can be told apart from an escape sequence.
async function esc(view: View): Promise<void> {
  await act(async () => { view.mockInput.pressEscape(); await Bun.sleep(120); });
}
async function settle(view: View): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  return view.captureCharFrame();
}
function harness(initial: Check[], suggestions: GateSuggestion[] = []) {
  const state = { saved: [...initial], runs: [] as Check[], notes: [] as string[], backs: 0, release: null as null | ((r: GateRunResult) => void), aborted: false };
  const api: GatesApi = {
    load: () => state.saved,
    save: async (checks) => { state.saved = checks; },
    suggest: (configured) => suggestions.filter((s) => !configured.some((c) => c.id === s.check.id)),
    run: (check, signal) => {
      state.runs.push(check);
      return new Promise<GateRunResult>((resolve) => {
        state.release = resolve;
        signal.addEventListener("abort", () => { state.aborted = true; resolve({ status: "cancelled", exitCode: null, durationMs: 5, outputTail: "", truncated: false }); });
      });
    },
  };
  return { state, api };
}
async function mount(api: GatesApi, state: ReturnType<typeof harness>["state"], size = { width: 100, height: 34 }, canRun = true) {
  let view!: View;
  await act(async () => {
    view = await testRender(
      <GatesView active workspace={process.cwd()} api={api} canRun={canRun} width={size.width - 6} onBack={() => { state.backs++; }} notify={(_k, m) => { state.notes.push(m); }} />,
      size,
    );
  });
  return view;
}

test("gates list, add, edit and remove persist through the api", async () => {
  const { state, api } = harness([gate({})]);
  const view = await mount(api, state);
  try {
    let frame = await settle(view);
    expect(frame).toContain("bun run test");
    expect(frame).toContain("required · feature · 600s");

    await act(async () => view.mockInput.pressKey("n"));
    frame = await settle(view);
    expect(frame).toContain("New gate");
    // An incomplete draft is explained, not saved.
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    frame = await settle(view);
    expect(frame).toContain("ID: letters, digits");
    expect(state.saved).toHaveLength(1);

    await act(async () => { await view.mockInput.typeText("lint"); });
    await act(async () => view.mockInput.pressTab());
    await act(async () => { await view.mockInput.typeText("bun run lint --max-warnings 0"); });
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    frame = await settle(view);
    expect(state.saved.map((c) => c.id)).toEqual(["tests", "lint"]);
    expect(state.saved[1]).toMatchObject({ executable: "bun", args: ["run", "lint", "--max-warnings", "0"], timeoutMs: 120000, required: true });
    expect(frame).toContain("lint");
    expect(state.notes.at(-1)).toBe("Gate lint added");

    // Edit the selected gate (the new one) and make it advisory.
    await act(async () => view.mockInput.pressKey("e"));
    frame = await settle(view);
    expect(frame).toContain("Edit gate lint");
    for (let i = 0; i < 3; i++) await act(async () => view.mockInput.pressTab());
    await act(async () => view.mockInput.pressArrow("right"));
    frame = await settle(view);
    expect(frame).toContain("advisory");
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    await settle(view);
    expect(state.saved[1]?.required).toBe(false);

    // Duplicate IDs are refused at save time.
    await act(async () => view.mockInput.pressKey("n"));
    await act(async () => { await view.mockInput.typeText("tests"); });
    await act(async () => view.mockInput.pressTab());
    await act(async () => { await view.mockInput.typeText("bun test"); });
    await act(async () => view.mockInput.pressKey("s", { ctrl: true }));
    frame = await settle(view);
    expect(frame).toContain("Duplicate check ID tests");
    expect(state.saved).toHaveLength(2);
    await esc(view);

    await act(async () => view.mockInput.pressKey("d"));
    frame = await settle(view);
    expect(frame).toContain("Remove gate lint?");
    await act(async () => view.mockInput.pressKey("n"));
    expect(state.saved).toHaveLength(2);
    await act(async () => view.mockInput.pressKey("d"));
    await act(async () => view.mockInput.pressKey("y"));
    await settle(view);
    expect(state.saved.map((c) => c.id)).toEqual(["tests"]);
  } finally { await act(async () => view.renderer.destroy()); }
});

test("run now shows progress, then the exit code, duration and the output tail", async () => {
  const { state, api } = harness([gate({})]);
  const view = await mount(api, state);
  try {
    await act(async () => view.mockInput.pressKey("r"));
    let frame = await settle(view);
    expect(frame).toContain("Running tests");
    expect(state.runs.map((c) => c.id)).toEqual(["tests"]);
    await act(async () => view.mockInput.pressKey("d"));
    expect(await settle(view)).not.toContain("Remove gate", );
    state.release?.({ status: "failed", exitCode: 2, durationMs: 1500, outputTail: "first\nexpect(received).toBe(expected)", truncated: false });
    frame = await settle(view);
    expect(frame).toContain("tests: failed · exit 2 · 2s");
    expect(frame).toContain("expect(received).toBe(expected)");
    expect(frame).toContain("last: failed");
  } finally { await act(async () => view.renderer.destroy()); }
});

test("Esc stops a running gate instead of leaving the window", async () => {
  const { state, api } = harness([gate({})]);
  const view = await mount(api, state);
  try {
    await act(async () => view.mockInput.pressKey("r"));
    await settle(view);
    await esc(view);
    const frame = await settle(view);
    expect(state.aborted).toBe(true);
    expect(state.backs).toBe(0);
    expect(frame).toContain("tests: stopped");
    await esc(view);
    expect(state.backs).toBe(1);
  } finally { await act(async () => view.renderer.destroy()); }
});

test("running is refused with an explanation while workflows are off", async () => {
  const { state, api } = harness([gate({})]);
  const view = await mount(api, state, { width: 100, height: 34 }, false);
  try {
    await act(async () => view.mockInput.pressKey("r"));
    const frame = await settle(view);
    expect(state.runs).toHaveLength(0);
    expect(state.notes.at(-1)).toContain("Enable workflows first");
    expect(frame).toContain("Workflows are turned off");
  } finally { await act(async () => view.renderer.destroy()); }
});

test("detected gates are listed with their source and added only after confirmation", async () => {
  const found: GateSuggestion[] = [
    { check: gate({ id: "pytest", executable: "python3", args: ["-m", "pytest", "-q"] }), source: "pytest.ini", reason: "python -m pytest -q", preselected: true },
    { check: gate({ id: "build", args: ["run", "build"], required: false }), source: 'package.json script "build"', reason: "bun run build", preselected: false },
  ];
  const { state, api } = harness([], found);
  const view = await mount(api, state);
  try {
    expect(await settle(view)).toContain("No gates yet");
    await act(async () => view.mockInput.pressKey("s"));
    let frame = await settle(view);
    expect(frame).toContain("[x] pytest");
    expect(frame).toContain("[ ] build");
    expect(frame).toContain("pytest.ini");
    expect(state.saved).toHaveLength(0);
    await act(async () => view.mockInput.pressArrow("down"));
    await act(async () => view.mockInput.pressKey(" "));
    frame = await settle(view);
    expect(frame).toContain("[x] build");
    await act(async () => view.mockInput.pressEnter());
    await settle(view);
    expect(state.saved.map((c) => c.id)).toEqual(["pytest", "build"]);
    expect(state.notes.at(-1)).toBe("2 gates added");
    // Everything detected is now configured, so there is nothing more to offer.
    await act(async () => view.mockInput.pressKey("s"));
    await settle(view);
    expect(state.notes.at(-1)).toContain("Nothing new detected");
  } finally { await act(async () => view.renderer.destroy()); }
});

test("the window stays readable on a narrow terminal", async () => {
  const { state, api } = harness([gate({}), gate({ id: "lint", args: ["run", "lint"] })]);
  const view = await mount(api, state, { width: 50, height: 20 });
  try {
    const frame = await settle(view);
    expect(frame).toContain("tests");
    expect(frame).toContain("lint");
    await act(async () => view.mockInput.pressKey("n"));
    expect(await settle(view)).toContain("New gate");
  } finally { await act(async () => view.renderer.destroy()); }
});

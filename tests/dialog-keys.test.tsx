import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { DialogHost } from "../src/components/ui/DialogHost.js";
import { openSelect } from "../src/components/ui/dialogs/DialogSelect.js";
import { promptText } from "../src/components/ui/dialogs/PromptDialog.js";
import { RunList } from "../src/components/workflow/RunList.js";
import { openProjectPicker } from "../src/core/commands/projects.js";
import { addKnownProject } from "../src/core/projects/known.js";
import { fitLabel } from "../src/core/projects/switcher.js";
import type { RunSummary } from "../src/core/workflows/view.js";
import { useKeyboard } from "../src/hooks/useTerminalEvents.js";
import { useDialogStore } from "../src/stores/dialog.js";

type View = Awaited<ReturnType<typeof testRender>>;

afterEach(() => {
  while (useDialogStore.getState().stack.length) useDialogStore.getState().pop();
});

async function settle(view: View): Promise<string> {
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await view.flush();
      await view.renderOnce();
    });
  return view.captureCharFrame();
}

test("an open dialog takes every key; the screen beneath gets none until it closes", async () => {
  const beneath: string[] = [];
  function Screen() {
    useKeyboard((evt) => {
      beneath.push(evt.name);
    });
    return <text>screen</text>;
  }
  let view!: View;
  await act(async () => {
    view = await testRender(
      <box>
        <Screen />
        <DialogHost />
      </box>,
      { width: 100, height: 30 },
    );
  });
  try {
    await act(async () => view.mockInput.pressKey("x"));
    expect(beneath).toEqual(["x"]);

    let answer: Promise<string | null> | undefined;
    await act(async () => {
      answer = promptText({ title: "Open folder", placeholder: "~/code/other-project" });
    });
    await settle(view);
    await act(async () => {
      await view.mockInput.typeText("second proj");
    });
    expect(await settle(view)).toContain("second proj");
    expect(beneath).toEqual(["x"]);

    await act(async () => view.mockInput.pressEnter());
    expect(await answer).toBe("second proj");
    await act(async () => view.mockInput.pressKey("r"));
    expect(beneath).toEqual(["x", "r"]);
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("a run row with a long reason keeps its whole token figure", async () => {
  const run = (id: string, reason: string, status: string) =>
    ({
      snapshot: { runId: id, featureId: id, status, reason, tokenUsage: 45_000, estimatedCostUsd: null },
      title: null,
      stage: { index: 0, total: 0, id: null },
      tasks: { done: 0, total: 0 },
      pendingKind: null,
      budget: { maxTokens: 800_000 },
      createdAt: 0,
      updatedAt: Date.now(),
    }) as unknown as RunSummary;
  let view!: View;
  await act(async () => {
    view = await testRender(
      <RunList
        runs={[
          run("add-a-remove-id-command-3", "instructions or configuration changed since approval", "blocked"),
          run("short", "stopped", "failed"),
        ]}
        cursor={0}
        width={100}
      />,
      { width: 140, height: 10 },
    );
  });
  try {
    const lines = (await settle(view)).split("\n");
    const long = lines.find((l) => l.includes("add-a-remove-id-command-3")) ?? "";
    expect(long).toContain("… · 45k/800k");
    expect(lines.find((l) => l.includes("short"))).toContain("stopped · 45k/800k");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

test("the project picker counts projects in words and shows a row's counters whole", async () => {
  const folder = mkdtempSync(join(tmpdir(), "baked-picker-"));
  let view!: View;
  await act(async () => {
    view = await testRender(<DialogHost />, { width: 140, height: 30 });
  });
  try {
    addKnownProject(folder);
    await act(async () => {
      void openProjectPicker({ cwd: folder, notify: () => {}, switchProject: () => {} });
    });
    expect(await settle(view)).toContain("1 project · fuzzy filter");
    await act(async () => useDialogStore.getState().pop());

    await act(async () => {
      void openSelect({
        title: "Projects",
        options: [
          {
            value: "checks",
            label: fitLabel("baked-checks", "C:\\Project\\baked-checks\\second proj", 32),
            meta: "1 session · 4 active · 3 waiting",
            status: "warning" as const,
          },
        ],
      });
    });
    const row = (await settle(view)).split("\n").find((l) => l.includes("baked-checks")) ?? "";
    expect(row).toContain("1 session · 4 active · 3 waiting");
    expect(row).toContain("baked-checks");
  } finally {
    await act(async () => view.renderer.destroy());
    rmSync(folder, { recursive: true, force: true });
  }
});

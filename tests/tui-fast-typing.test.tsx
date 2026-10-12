import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { MemoryBrowser } from "../src/components/modals/MemoryBrowser.js";
import { type InitiativesApi, InitiativesPopup } from "../src/components/workflow/InitiativesView.js";
import type { ContextManager } from "../src/core/context/manager.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { stopWorkflowSessions } from "../src/hooks/useWorkflow.js";
import { removeTempDir } from "./helpers/temp-dir.js";

type View = Awaited<ReturnType<typeof testRender>>;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function settle(view: View, rounds = 3): Promise<string> {
  for (let i = 0; i < rounds; i++)
    await act(async () => {
      await Bun.sleep(5);
      await view.flush();
      await view.renderOnce();
    });
  return view.captureCharFrame();
}

async function waitFor(view: View, text: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const frame = await settle(view, 1);
    if (frame.includes(text) || Date.now() > deadline) return frame;
    await Bun.sleep(20);
  }
}

/** Every key arrives before the field renders again, as with a paste or a fast typist. */
async function burst(view: View, text: string): Promise<void> {
  await act(async () => {
    for (const ch of text) view.mockInput.pressKey(ch);
  });
}

const TEXT = "Keep LF line endings everywhere";
const REQUEST = "Add due dates to todos and sort by them";
const EDITED = "Use CRLF only in the batch files";

test("the run memory note field keeps every key of a burst", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-fast-typing-"));
  dirs.push(cwd);
  const globalDir = join(cwd, "global");
  mkdirSync(globalDir, { recursive: true });
  const memory = new MemoryManager(cwd, globalDir);
  const contextManager = {
    getMemoryManager: () => memory,
    getEmbedderResolution: () => null,
  } as unknown as ContextManager;

  let view!: View;
  await act(async () => {
    view = await testRender(
      <MemoryBrowser visible contextManager={contextManager} cwd={cwd} onClose={() => {}} onSystemMessage={() => {}} />,
      { width: 120, height: 34 },
    );
  });
  try {
    await settle(view);
    await act(async () => view.mockInput.pressTab());
    await act(async () => view.mockInput.pressTab());
    expect(await waitFor(view, "^N adds a note")).toContain("^N adds a note");
    await act(async () => view.mockInput.pressKey("n", { ctrl: true }));
    await settle(view);
    await burst(view, TEXT);
    expect(await settle(view)).toContain(TEXT);
    await act(async () => view.mockInput.pressEnter());
    let frame = await waitFor(view, "Note added");
    expect(frame).toContain("Note added");

    // Enter on the note opens the edit field, which takes a burst the same way.
    await act(async () => view.mockInput.pressEnter());
    await act(async () => view.mockInput.pressKey("u", { ctrl: true }));
    await burst(view, EDITED);
    expect(await settle(view)).toContain(EDITED);
    await act(async () => view.mockInput.pressEnter());
    frame = await waitFor(view, "Saved;");
    expect(frame).toContain("Saved; new runs read it");
    expect(frame).toContain(EDITED);
  } finally {
    act(() => view.renderer.destroy());
    memory.close();
    // The run memory tab starts a workflow worker in cwd; Windows keeps the directory busy until it stops.
    await stopWorkflowSessions();
  }
});

test("keys typed right after N opens the initiative form reach its request field", async () => {
  const api: InitiativesApi = {
    load: async () => ({ initiatives: [], driving: [], errors: {} }),
    act: async () => {
      throw new Error("unused");
    },
    start: async () => {
      throw new Error("unused");
    },
    info: async () => ({ workflows: ["sdd"], defaultWorkflow: "sdd" }),
  };
  let view!: View;
  await act(async () => {
    view = await testRender(
      <InitiativesPopup
        api={api}
        width={100}
        height={40}
        selectedId={null}
        model="fixture/model"
        onSelect={() => {}}
        onBack={() => {}}
        onOpenRun={() => {}}
      />,
      { width: 100, height: 40 },
    );
  });
  try {
    expect(await waitFor(view, "No initiatives yet")).toContain("No initiatives yet");
    // N and the request arrive before the form renders.
    await burst(view, `n${REQUEST}`);
    const frame = await settle(view);
    expect(frame).toContain(REQUEST);
    expect(frame).toContain("add-due-dates-to-todos");
  } finally {
    await act(async () => view.renderer.destroy());
  }
});

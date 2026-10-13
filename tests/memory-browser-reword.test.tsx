import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { MemoryBrowser } from "../src/components/modals/MemoryBrowser.js";
import type { ContextManager } from "../src/core/context/manager.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { removeTempDir } from "./helpers/temp-dir.js";

type View = Awaited<ReturnType<typeof testRender>>;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function settle(view: View): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  return view.captureCharFrame();
}

test("Ctrl+E on the Chat tab rewords a memory's summary and keeps its details", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "baked-memory-ui-"));
  dirs.push(cwd);
  const globalDir = join(cwd, "global");
  mkdirSync(globalDir, { recursive: true });
  const memory = new MemoryManager(cwd, globalDir);
  const { id } = memory.write("project", {
    category: "pref",
    summary: "Use tabs",
    details: "Indent with tabs in this repo",
    topics: ["style"],
    source: "user",
  }).record;
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
    let frame = await settle(view);
    expect(frame).toContain("Use tabs");
    expect(frame).toContain("reword");

    await act(async () => view.mockInput.pressKey("e", { ctrl: true }));
    await act(async () => view.mockInput.pressKey("u", { ctrl: true }));
    await act(async () => { await view.mockInput.typeText("Use two spaces"); });
    frame = await settle(view);
    expect(frame).toContain("Use two spaces");
    await act(async () => view.mockInput.pressEnter());
    frame = await settle(view);
    expect(frame).toContain("Reworded");

    const record = memory.read("project", id);
    expect(record?.summary).toBe("Use two spaces");
    expect(record?.details).toBe("Indent with tabs in this repo");
    expect(record?.category).toBe("pref");
  } finally {
    act(() => view.renderer.destroy());
    memory.close();
  }
});

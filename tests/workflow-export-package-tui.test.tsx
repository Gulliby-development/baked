import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { exportChoice, exportPackage, exportPromptText } from "../src/components/workflow/export-package.js";
import { runActions } from "../src/components/workflow/format.js";
import { type InitiativesApi, InitiativesPopup } from "../src/components/workflow/InitiativesView.js";
import { formatWorkflowResult } from "../src/core/commands/workflow.js";
import type { InitiativeView } from "../src/core/workflows/initiatives/service.js";
import type { WrittenSddPackage } from "../src/core/workflows/sdd-export/package.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";
import { featureView, initiativeView } from "./helpers/initiative-views.js";

const written: WrittenSddPackage = {
  path: "/work/.baked/exports/run-1-export.zip",
  zip: true,
  files: ["AGENTS.md", "graph.json", "graph.md", "manifest.json"],
  manifest: {
    formatVersion: 1,
    kind: "run",
    id: "run-1",
    title: "Value",
    gitHead: null,
    status: "completed",
    features: [{ id: "value", title: "Value", status: "completed", runId: "run-1", accepted: true, dependsOn: [], dir: "specs/value" }],
    files: {},
  },
};

test("the run screen offers E to export only once the plan is approved (#2207)", () => {
  const base = { runId: "run-1", featureId: "value", status: "completed", reason: "none", pendingRequestIds: [] } as unknown as RunSnapshot;
  expect(runActions({ ...base, approvalDigest: null }).map((a) => a.action)).not.toContain("export-package");
  const approved = runActions({ ...base, approvalDigest: "a".repeat(64) });
  expect(approved.find((a) => a.action === "export-package")).toEqual({ key: "E", label: "export package", action: "export-package" });
  // E is no other run action's key.
  expect(approved.filter((a) => a.key === "E")).toHaveLength(1);
});

test("the export prompt maps F, Z and N and writes through the worker command", async () => {
  expect(exportPromptText("run-1")).toContain(".baked/exports/run-1-export");
  expect([exportChoice("f"), exportChoice("z"), exportChoice("n"), exportChoice("escape"), exportChoice("x")]).toEqual(["folder", "zip", "cancel", "cancel", null]);
  const calls: string[][] = [];
  const message = await exportPackage({ command: async (argv) => { calls.push(argv); return written; } }, "run-1", "zip");
  expect(calls).toEqual([["export-package", "run-1", "--zip"]]);
  expect(message).toBe("Exported run run-1 as an SDD package (1 of 1 feature accepted, 4 files) to /work/.baked/exports/run-1-export.zip");
  // The typed /workflow export-package prints the same line.
  expect(formatWorkflowResult(written)).toBe(message);
});

test("Ctrl+E on an approved initiative asks folder or zip and shows where the package went", async () => {
  const view: InitiativeView = initiativeView({ initiativeId: "search", title: "Search", features: [featureView("index", { state: "accepted", runId: "run-index", runStatus: "completed" })] });
  const exported: [string, string][] = [];
  const api: InitiativesApi = {
    load: async () => ({ initiatives: [view], driving: [], errors: {} }),
    act: async () => view,
    exportPackage: async (id, choice) => {
      exported.push([id, choice]);
      return `Exported initiative ${id} to .baked/exports/${id}-export`;
    },
  };
  let ui!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    ui = await testRender(<InitiativesPopup api={api} width={120} height={40} selectedId="search" onSelect={() => {}} onBack={() => {}} onOpenRun={() => {}} />, { width: 120, height: 40 });
  });
  const frame = async () => {
    for (let i = 0; i < 3; i++) await act(async () => { await ui.flush(); await ui.renderOnce(); });
    return ui.captureCharFrame().replace(/[│┃█▀▄]/g, " ").replace(/\s+/g, " ");
  };
  try {
    expect(await frame()).toContain("[Ctrl+E] export package");
    await act(async () => { ui.mockInput.pressKey("e", { ctrl: true }); });
    expect(await frame()).toContain("F writes a folder, Z one zip archive");
    await act(async () => { ui.mockInput.pressKey("z"); });
    await act(async () => { await Bun.sleep(20); });
    expect(exported).toEqual([["search", "zip"]]);
    expect(await frame()).toContain("Exported initiative search");
  } finally {
    await act(async () => ui.renderer.destroy());
  }
});

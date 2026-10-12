import { mock } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { ContextManager } from "../../src/core/context/manager";
import type { ProviderModelInfo } from "../../src/core/llm/models";

const noop = () => {};
const workspace = mkdtempSync(join(tmpdir(), "baked-ui-catalog-"));
mkdirSync(join(workspace, ".git"));
const { setCwd } = await import("../../src/core/cwd.js");
setCwd(workspace, { changeProcess: false });
process.on("exit", () => rmSync(workspace, { recursive: true, force: true }));
const modelState = {
  providerData: { openai: { loading: false, items: [{ id: "baked-test", name: "Baked test model", contextWindow: 128000 } as ProviderModelInfo] } },
  availability: new Map([["openai", true]]),
};
mock.module("../../src/hooks/useAllProviderModels", () => ({ useAllProviderModels: () => modelState }));
const history = await import("../../src/core/history/index");
mock.module("../../src/core/history/index", () => ({ ...history, getFrecencyDB: () => ({ byKeys: () => new Map(), bump: noop }) }));
let installs = 0;
const skills = [{ id: "bread", skillId: "bread", name: "bread", source: "baked/skills", installs: 1000 }];
mock.module("../../src/core/skills/manager", () => ({
  listPopularSkills: async () => skills,
  searchSkills: async (query: string) => skills.filter((skill) => skill.name.includes(query)),
  listInstalledSkills: () => [{ name: "bread", scope: "project", path: "test/bread", description: "Bread skill" }],
  installSkill: async () => { installs++; return { installed: true, name: "bread" }; },
  loadSkill: () => "Skill instructions",
  removeInstalledSkill: noop,
}));
const context = { getActiveSkills: () => ["bread"], addSkill: noop, removeSkill: noop } as unknown as ContextManager;
const { LlmSelector } = await import("../../src/components/modals/LlmSelector");
const { SkillSearch } = await import("../../src/components/settings/SkillSearch");
const { ProviderSettings } = await import("../../src/components/settings/ProviderSettings");
const { FirstRunWizard } = await import("../../src/components/modals/wizard/index");
const { HelpPopup } = await import("../../src/components/modals/HelpPopup");
const { InfoPopup } = await import("../../src/components/modals/InfoPopup");
const { RouterSettings } = await import("../../src/components/settings/RouterSettings");
const { MCPSettings } = await import("../../src/components/settings/MCPSettings");
const { DEFAULT_CONFIG } = await import("../../src/config/index");
const { STEPS } = await import("../../src/components/modals/wizard/data");

const captureDir = process.env.BAKED_UI_CAPTURE_DIR;
if (captureDir) mkdirSync(captureDir, { recursive: true });
let frames = 0;
async function settle(view: Awaited<ReturnType<typeof testRender>>) {
  for (let i = 0; i < 3; i++) await act(async () => { await view.renderOnce(); });
}
async function snapshot(view: Awaited<ReturnType<typeof testRender>>, name: string, width: number, height: number) {
  await settle(view);
  const frame = view.captureCharFrame();
  const popup = view.renderer.root.findDescendantById("baked-popup");
  assert(popup, name);
  assert(popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= width && popup.y + popup.height <= height, `${name}: bounds`);
  assert(/esc/i.test(frame), `${name}: missing exit hint`);
  assert(frame.includes("┛"), `${name}: missing bottom border`);
  if (captureDir) writeFileSync(join(captureDir, `${width}-${height}-${name}.txt`), frame);
  frames++;
  return frame;
}
async function screen(name: string, node: ReactNode, width: number, height: number, visit?: (view: Awaited<ReturnType<typeof testRender>>) => Promise<void>) {
  let view!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => { view = await testRender(node, { width, height }); });
  try {
    await snapshot(view, name, width, height);
    await visit?.(view);
  } finally { await act(async () => view.renderer.destroy()); }
}

for (const [width, height] of [[120, 40], [80, 24], [50, 20]]) {
  await screen("models", <LlmSelector visible activeModel="openai/baked-test" onClose={noop} onSelect={noop} />, width!, height!, async (view) => {
    await act(async () => view.mockInput.pressKey("/"));
    await act(async () => view.mockInput.typeText("baked-test"));
    const frame = await snapshot(view, "models-search", width!, height!);
    assert(frame.includes("Baked test model"), "model search result must be visible");
  });
  await screen("skills", <SkillSearch visible contextManager={context} onClose={noop} onSystemMessage={noop} />, width!, height!, async (view) => {
    await act(async () => view.mockInput.pressEnter());
    const destination = await snapshot(view, "skills-destination", width!, height!);
    assert(destination.includes("Project") && destination.includes("Global"), "installation destinations must be visible");
    await act(async () => view.mockInput.pressEscape());
    // Browsing must preserve the active skill without invoking installation.
    await act(async () => view.mockInput.pressTab());
    assert((await snapshot(view, "skills-installed", width!, height!)).includes("bread"));
    await act(async () => view.mockInput.pressTab());
    assert((await snapshot(view, "skills-active", width!, height!)).includes("bread"));
  });
  await screen("providers", <ProviderSettings visible globalConfig={DEFAULT_CONFIG} projectConfig={null} onUpdate={noop} onClose={noop} />, width!, height!, async (view) => {
    for(let tab = 1; tab < 9; tab++) {
      await act(async () => view.mockInput.pressTab());
      await snapshot(view, `providers-${tab}`, width!, height!);
    }
  });
  await screen("router", <RouterSettings visible router={undefined} defaultModel="openai/baked-test" modelFallback={undefined} activeModel="openai/baked-test" scope="project" onScopeChange={noop} onPickSlot={noop} onClearSlot={noop} onPickerChange={noop} onAddFallback={noop} onClearFallbacks={noop} onClose={noop} />, width!, height!);
  await screen("mcp", <MCPSettings visible mcpManager={null} globalServers={[]} projectServers={[]} onSave={noop} onClose={noop} />, width!, height!, async (view) => {
    await act(async () => view.mockInput.pressKey("a", { ctrl: true }));
    await snapshot(view, "mcp-add", width!, height!);
    for (let field = 0; field < 3; field++) await act(async () => view.mockInput.pressTab());
    assert((await snapshot(view, "mcp-environment", width!, height!)).includes("Environment"), "focused MCP field must remain visible");
  });
  await screen("help", <HelpPopup visible onClose={noop} />, width!, height!);
  await screen("info", <InfoPopup visible config={{ title: "Project status", lines: [{ type: "entry", label: "Version", desc: "0.0.1" }] }} onClose={noop} />, width!, height!);
  await screen("wizard", <FirstRunWizard visible hasModel activeModel="openai/baked-test" onSelectModel={noop} onClose={noop} />, width!, height!, async (view) => {
    for(let step = 1; step < STEPS.length; step++) {
      await act(async () => view.mockInput.pressArrow("right"));
      await snapshot(view, `wizard-${STEPS[step]}`, width!, height!);
    }
  });
}
assert.equal(installs, 0, "viewing the catalogs must never install anything");
console.log(JSON.stringify({ frames }));
process.exit(0);

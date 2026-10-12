import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { act, type ReactNode, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import { PremiumPopup } from "../src/components/ui/PremiumPopup";
import { Search } from "../src/components/ui/Search";
import { VirtualList } from "../src/components/ui/VirtualList";
import { TabBar } from "../src/components/layout/TabBar";
import { CommandPalette } from "../src/components/modals/CommandPalette";
import { TabNamePopup } from "../src/components/modals/TabNamePopup";
import { ConfirmDialog } from "../src/components/ui/dialogs/ConfirmDialog";
import { fitPopupHeight, fitPopupWidth, wrapKeyHints } from "../src/components/ui/popup-geometry";

async function withView(node: ReactNode, width: number, height: number, check: (view: Awaited<ReturnType<typeof testRender>>) => Promise<void> | void) {
  const view = await testRender(node, { width, height });
  try {
    await settle(view);
    await check(view);
  } finally {
    await act(async () => { view.renderer.destroy(); });
  }
}

async function repaint(view: Awaited<ReturnType<typeof testRender>>, action: () => void | Promise<void>) {
  await act(async () => { await action(); });
  await settle(view);
}

async function settle(view: Awaited<ReturnType<typeof testRender>>) {
  for (let frame = 0; frame < 3; frame++) {
    await act(async () => { await view.flush(); await view.renderOnce(); });
  }
}

function bounds(view: Awaited<ReturnType<typeof testRender>>, width: number, height: number) {
  const popup = view.renderer.root.findDescendantById("baked-popup");
  expect(popup).toBeDefined();
  expect(popup!.x).toBeGreaterThanOrEqual(0);
  expect(popup!.y).toBeGreaterThanOrEqual(0);
  expect(popup!.x + popup!.width).toBeLessThanOrEqual(width);
  expect(popup!.y + popup!.height).toBeLessThanOrEqual(height);
}

const noop = () => {};

describe("Baked terminal UI", () => {
  test("resize keeps the active section visible in compact navigation", async () => {
    await withView(<PremiumPopup visible width={110} height={30} title="Settings"
      tabs={Array.from({ length: 10 }, (_, i) => ({ id: String(i), label: `Section ${i}` }))}
      activeTab="9" footerHints={[{ key: "Esc", label: "close" }]}><text>Selected section</text></PremiumPopup>, 120, 40, async (view) => {
      await repaint(view, () => view.resize(50, 20));
      bounds(view, 50, 20);
      expect(view.captureCharFrame()).toContain("Section 9");
      const active = view.renderer.root.findDescendantById("popup-tab-9")!;
      expect(active.x).toBeGreaterThanOrEqual(0);
      expect(active.x + active.width).toBeLessThanOrEqual(50);
    });
  });

  test("long content scrolls by keyboard while the footer remains visible", async () => {
    await withView(<PremiumPopup visible width={50} height={18} title="Details"
      footerHints={[{ key: "Esc", label: "close" }]}>
      {Array.from({ length: 30 }, (_, i) => <text key={i} height={1} flexShrink={0}>Detail {i}</text>)}
    </PremiumPopup>, 50, 20, async (view) => {
      expect(view.captureCharFrame()).toContain("scroll");
      for (let page = 0; page < 4; page++) {
        await repaint(view, () => view.mockInput.pressKeys(["\x1b[6;2~"]));
      }
      expect(view.captureCharFrame()).toContain("Detail 29");
      expect(view.captureCharFrame()).toContain("[Esc] close");
    });
  });

  for (const [width, height] of [[120, 40], [80, 24], [50, 20]]) {
    test(`windows retain borders and exit hints at ${width}x${height}`, async () => {
      for (const node of [
        <CommandPalette visible onClose={noop} onExecute={noop} />,
        <TabNamePopup visible placeholder="Feature work" onClose={noop} onSubmit={noop} />,
        <ConfirmDialog width={70} title="Delete session" message="Remove this saved session?" danger onClose={noop} />,
      ]) {
        await withView(node, width!, height!, (view) => {
          bounds(view, width!, height!);
          const frame = view.captureCharFrame();
          expect(frame).toContain("Esc");
          expect(frame).toContain("┗");
          expect(frame).toContain("┛");
        });
      }
    });
  }

  test("command search keeps selection usable and executes the filtered command", async () => {
    let executed = "";
    await withView(<CommandPalette visible onClose={noop} onExecute={(command) => { executed = command; }} />, 50, 20, async (view) => {
      await repaint(view, () => view.mockInput.typeText("/router"));
      expect(view.captureCharFrame()).toContain("/router");
      await repaint(view, () => view.mockInput.pressEnter());
      expect(executed).toBe("/router");
    });
  });

  test("tab name accepts typing and submit", async () => {
    let name = "";
    await withView(<TabNamePopup visible placeholder="New tab" onClose={noop} onSubmit={(value) => { name = value; }} />, 50, 20, async (view) => {
      await repaint(view, () => view.mockInput.typeText("Bread"));
      expect(view.captureCharFrame()).toContain("Bread");
      await repaint(view, () => view.mockInput.pressEnter());
      expect(name).toBe("Bread");
    });
  });

  test("compact navigation supports mouse selection without allowing disabled tabs", async () => {
    function Fixture() {
      const [tab, setTab] = useState("models");
      return <PremiumPopup visible width={100} height={20} title="Settings" activeTab={tab} onTabChange={setTab}
        tabs={[{ id: "models", label: "Models" }, { id: "skills", label: "Skills" }, { id: "locked", label: "Locked", disabled: true }]}
        footerHints={[{ key: "Esc", label: "close" }]}><text>Current: {tab}</text></PremiumPopup>;
    }
    await withView(<Fixture />, 60, 24, async (view) => {
      const skills = view.renderer.root.findDescendantById("popup-tab-skills")!;
      await repaint(view, () => view.mockMouse.click(skills.x + 1, skills.y));
      expect(view.captureCharFrame()).toContain("Current: skills");
      const locked = view.renderer.root.findDescendantById("popup-tab-locked")!;
      await repaint(view, () => view.mockMouse.click(locked.x + 1, locked.y));
      expect(view.captureCharFrame()).toContain("Current: skills");
    });
  });

  test("workspace tabs remain visible and clickable with five long labels", async () => {
    let selected = "";
    await withView(<TabBar tabs={Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: "A very long feature branch name" }))}
      activeTabId="0" onSwitch={(id) => { selected = id; }} getMode={() => "default"} getModelLabel={() => "long/model-name"}
      getActivity={() => ({ isLoading: false, isCompacting: false, hasUnread: false, hasError: false, needsAttention: false, editedFileCount: 0 })} />, 50, 20, async (view) => {
      const last = view.renderer.root.findDescendantById("workspace-tab-4")!;
      expect(last.x + last.width).toBeLessThanOrEqual(50);
      await repaint(view, () => view.mockMouse.click(last.x + 1, last.y));
      expect(selected).toBe("4");
    });
  });

  test("multi-line lists scroll in cells to keep the selected row visible", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    await withView(<VirtualList items={items} selectedIndex={19} width={40} maxRows={3} rowHeight={2}
      renderItem={(item) => <box height={2}><text>Item {item}</text></box>} />, 50, 20, (view) => {
      expect(view.captureCharFrame()).toContain("Item 19");
    });
  });

  test("search shows the end of a long query and preserves the result count", async () => {
    await withView(<box width={30}><Search focused value={"long ".repeat(30) + "tail"} count="2/10" /></box>, 40, 10, (view) => {
      expect(view.captureCharFrame()).toContain("tail");
      expect(view.captureCharFrame()).toContain("2/10");
    });
  });

  test("geometry and keyboard hints fit compact terminals", () => {
    expect(fitPopupWidth(140, 50)).toBe(50);
    expect(fitPopupHeight(40, 20)).toBe(18);
    for (const line of wrapKeyHints([{ key: "Enter", label: "install" }, { key: "Esc", label: "cancel" }, { key: "Tab", label: "next" }], 32)) {
      expect(Bun.stringWidth(line.map((hint) => `[${hint.key}] ${hint.label}`).join(" · "))).toBeLessThanOrEqual(32);
    }
  });
});

// Keep catalog service mocks isolated from other application tests.
test("catalogs, settings and onboarding render across terminal sizes", () => {
  const result = spawnSync(process.execPath, ["tests/fixtures/ui-catalog-screens.tsx"], { cwd: process.cwd(), encoding: "utf8", timeout: 30000 });
  expect(result.stderr).not.toContain("AssertionError");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"frames":');
}, 35000);

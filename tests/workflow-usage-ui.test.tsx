import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { type UsageLoader, UsagePopup, usageTotalsLine } from "../src/components/workflow/UsageView.js";
import type { UsageDimension, UsageSummary } from "../src/core/workflows/usage.js";
import { workflowUsageLoader } from "../src/hooks/useWorkflow.js";

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

const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function summary(days: number, groupBy: UsageDimension): UsageSummary {
  const keys: Record<UsageDimension, [string, string]> = {
    model: ["openai/gpt-5", "(host)"],
    stage: ["implement", "review"],
    day: ["2026-10-11", "2026-10-12"],
  };
  const [first, second] = keys[groupBy];
  return {
    ...totals,
    days,
    since: 0,
    groupBy: [groupBy],
    filters: {},
    runs: 3,
    attempts: 7,
    tokens: 1_500_000,
    totalTokens: 1_500_000,
    costUsd: 4.25,
    unpricedTokens: 20_000,
    groups: [
      { ...totals, key: first, keys: { [groupBy]: first }, runs: 3, attempts: 5, tokens: 1_480_000, costUsd: 4.25, unpricedTokens: 0 },
      { ...totals, key: second, keys: { [groupBy]: second }, runs: 1, attempts: 2, tokens: 20_000, costUsd: 0, unpricedTokens: 20_000 },
    ],
  };
}

async function mount(load: UsageLoader, size: { width: number; height: number }, onBack: () => void): Promise<View> {
  let view!: View;
  await act(async () => {
    view = await testRender(
      <UsagePopup load={load} width={Math.min(120, size.width)} height={Math.min(40, size.height)} onBack={onBack} />,
      size,
    );
  });
  return view;
}

async function frame(view: View, width: number, height: number, name: string): Promise<string> {
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  const popup = view.renderer.root.findDescendantById("baked-popup");
  expect(popup, name).toBeTruthy();
  if (popup) expect(popup.x + popup.width <= width && popup.y + popup.height <= height, `${name}: inside`).toBe(true);
  return view.captureCharFrame();
}

const press = async (view: View, key: "left" | "right" | "tab" | "escape") => {
  await act(async () => {
    if (key === "tab") view.mockInput.pressTab();
    else if (key === "escape") {
      view.mockInput.pressEscape();
      await Bun.sleep(120);
    } else view.mockInput.pressArrow(key);
  });
};

test("the totals line names runs, attempts, tokens, cost and unpriced tokens", () => {
  expect(usageTotalsLine(summary(7, "model"))).toBe("3 runs · 7 attempts · 1.5M tokens · $4.25 · 20k unpriced");
});

for (const [width, height] of SIZES) {
  test(`usage screen at ${width}x${height}: periods, groups and back`, async () => {
    const calls: string[] = [];
    let backs = 0;
    const view = await mount(
      (days, groupBy) => {
        calls.push(`${days}:${groupBy}`);
        return summary(days, groupBy);
      },
      { width, height },
      () => {
        backs++;
      },
    );
    let text = await frame(view, width, height, "model");
    expect(text).toContain("openai/gpt-5");
    expect(text).toContain("1.5M tokens");
    expect(text.toLowerCase()).toContain("esc");

    await press(view, "right");
    await press(view, "tab");
    text = await frame(view, width, height, "stage");
    expect(text).toContain("implement");
    expect(calls).toContain("30:stage");

    await press(view, "tab");
    await press(view, "left");
    await press(view, "left");
    text = await frame(view, width, height, "day");
    expect(text).toContain("2026-10-12");
    expect(calls.at(-1)).toBe("90:day");

    await press(view, "escape");
    expect(backs).toBe(1);
  });
}

test("a project without a run database has no usage", () => {
  const workspace = mkdtempSync(join(tmpdir(), "baked-usage-ui-"));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  const result = workflowUsageLoader(workspace)(7, "model");
  expect(result).toMatchObject({ runs: 0, attempts: 0, tokens: 0, groups: [] });
});

test("E on the usage screen exports the shown period and grouping as Markdown", async () => {
  const exported: UsageSummary[] = [];
  let view!: View;
  await act(async () => {
    view = await testRender(
      <UsagePopup
        load={summary}
        width={100}
        height={30}
        onBack={() => undefined}
        onExport={(shown) => {
          exported.push(shown);
          return "/project/baked-usage-30d.md";
        }}
      />,
      { width: 100, height: 30 },
    );
  });
  await press(view, "right");
  await act(async () => {
    view.mockInput.pressKey("e");
  });
  const text = await frame(view, 100, 30, "exported");
  expect(exported.map((s) => [s.days, s.groupBy])).toEqual([[30, ["model"]]]);
  expect(text).toContain("Markdown written to /project/baked-usage-30d.md");
});

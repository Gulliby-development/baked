import { afterEach, describe, expect, test } from "bun:test";
import { desktopRecoveryText } from "../apps/desktop/src/renderer/client/remedies.js";
import { splitPreviewText, suggestedExtension } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { tuiRecoveryText } from "../src/components/workflow/remedies.js";
import { startApiServer } from "../src/core/api/server.js";
import type { InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { splitPreviewLine } from "../src/core/workflows/initiatives/split-preview.js";
import { splitExtension } from "../src/core/workflows/initiatives/token-pool.js";
import { executeInitiativeCommand, parseInitiativeArgs } from "../src/headless/workflow-initiative.js";
import { historyFixture, plannedForecastScenario } from "./helpers/initiative-planned-forecast.js";

// Bench round 82 (#2525). tinyflate extended to the 19.6M the split approval's budget preview named,
// what its $25 cap paid for (19,660,470 tokens), and its approval message then said "Consider
// extending to 29607139 tokens, including margin", with a remedy of 29,607,139: 50 percent above
// what the unchanged cap pays for. slotprompt's 14.2M pool covered its 12.5M of high estimates,
// and the preview still said to extend to the cap's 23.5M. A split approval names one amount: the
// high end with margin, held to what the cap pays for, and none when the pool covers the high end.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function awaiting(features: number, histories: number, maxTotalTokens: number, capUsd: number) {
  const history = await historyFixture(histories, { taskShare: 0.4 });
  cleanups.push(() => history.dispose());
  const result = await plannedForecastScenario(features, histories, [history.root], {
    skeleton: false,
    maxTotalTokens,
    capUsd,
    approve: false,
  });
  cleanups.push(() => result.fixture.dispose());
  return result;
}

/** Every token amount the split approval names, on every surface: preview, message, remedy, TUI, desktop, API, headless. */
async function amounts(result: Awaited<ReturnType<typeof awaiting>>) {
  const { initiatives, fixture } = result;
  const view = initiatives.view("values");
  expect(view.status).toBe("awaiting_approval");
  const server = await startApiServer({ service: fixture.service, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
  });
  const response = await fetch(`${server.url}/v1/initiatives/values`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  const served = (await response.json()) as InitiativeView;
  const shown = (await executeInitiativeCommand(
    initiatives,
    parseInitiativeArgs(["show", "values"]),
    new AbortController().signal,
  )) as InitiativeView;
  const texts = [
    view.next.message,
    view.budget.preview?.notice ?? "",
    tuiRecoveryText(view.next.message, view.next.recovery),
    desktopRecoveryText(served.next.message, served.next.recovery),
    splitPreviewText(served) ?? "",
    shown.next.message,
  ];
  const named = new Set<number>();
  for (const text of texts)
    for (const match of text.matchAll(/--tokens (\d+)|extending to (\d+) tokens/g))
      named.add(Number(match[1] ?? match[2]));
  for (const remedy of [...(view.next.recovery?.remedies ?? []), ...(served.next.recovery?.remedies ?? [])])
    if (remedy.action === "extend" && remedy.suggestedTokens !== undefined) named.add(remedy.suggestedTokens);
  if (view.budget.preview?.suggestedTokens != null) named.add(view.budget.preview.suggestedTokens);
  const extension = suggestedExtension(served);
  if (extension?.tokens !== undefined) named.add(extension.tokens);
  return { view, served, texts, named: [...named] };
}

describe("scenario: a split approval names one extension amount (#2525)", () => {
  test("a pool above the sum of the high estimates gives no extend text anywhere, though the cap pays for more (slotprompt)", async () => {
    // Five features with 5.5M of highs and 4.1M expected; the 20.0M pool covers them, the $30 cap
    // pays for 25.6M at $1.17 per million.
    const result = await awaiting(5, 1, 20_000_000, 30);
    const { view, texts, named } = await amounts(result);
    const preview = view.budget.preview!;
    expect(preview.sumHigh).toBeLessThan(preview.limitTokens);
    expect(preview.capTokens).toBeGreaterThan(preview.limitTokens);
    expect(preview).toMatchObject({ suggestedTokens: null, notice: null });
    expect(named).toEqual([]);
    for (const text of texts) expect(text).not.toMatch(/[Ee]xtend/);
    expect(view.next.message).toBe("Approve the split (plan revision 1) or edit it.");
    expect(view.next.recovery).toBeUndefined();
    expect(splitPreviewLine(preview)).not.toContain("Extend");
  }, 120000);

  test("a pool between the expected and the high estimates gives one amount, the same in the preview, the message and the remedy, inside what the cap pays for", async () => {
    // Three features: 11.5M expected, 15.3M high, 19.1M with margin; the $25 cap pays for 21.4M.
    const result = await awaiting(3, 5, 12_000_000, 25);
    const { view, served, named } = await amounts(result);
    const preview = view.budget.preview!;
    expect(preview.sumExpected).toBeLessThan(12_000_000);
    expect(preview.sumHigh).toBeGreaterThan(12_000_000);
    expect(named).toEqual([19_145_290]);
    expect(preview.suggestedTokens).toBe(19_145_290);
    expect(preview.suggestedTokens!).toBeLessThanOrEqual(preview.capTokens!);
    expect(view.next.message).toContain(`Use baked workflow initiative extend values --tokens 19145290 --expected-revision ${view.revision}.`);
    expect(view.next.message).not.toContain("including margin");
    expect(view.next.recovery?.remedies).toEqual([
      { action: "extend", initiativeId: "values", suggestedTokens: 19_145_290 },
    ]);
    expect(served.next.recovery).toEqual(view.next.recovery);
    expect(splitPreviewLine(preview)).toEndWith(" Extend to 19.1M before approving.");
  }, 120000);

  test("a pool at what the cap pays for, below the high end, names no amount above the cap's tokens (tinyflate)", async () => {
    // The $15 cap pays for 12.8M tokens; the pool is already 12.8M, the high end 15.3M and with
    // margin 19.1M. Main named 19,145,290 "including margin", above what the cap pays for.
    const result = await awaiting(3, 5, 12_800_000, 15);
    const { view, named } = await amounts(result);
    const preview = view.budget.preview!;
    expect(preview.capTokens).toBeGreaterThanOrEqual(12_800_000);
    expect(preview.capTokens).toBeLessThan(12_900_000);
    expect(preview.sumHigh).toBeGreaterThan(12_800_000);
    for (const amount of named) expect(amount).toBeLessThanOrEqual(preview.capTokens!);
    expect(named).toEqual([]);
    expect(view.next.message).toContain("no more than the shared pool: a larger pool would go unpaid at that price");
    expect(view.next.message).not.toContain("including margin");
  }, 120000);

  test("R82 tinyflate's numbers: at most what the $25 cap pays for, and nothing once the pool is that", () => {
    const capTokens = 19_660_470;
    const withMargin = 29_607_139;
    const highTokens = 24_000_000;
    // Before the extend: one amount, the cap's tokens rounded down, at most 19.66M.
    const before = splitExtension({ limitTokens: 12_000_000, highTokens, withMargin, capTokens });
    expect(before).toEqual({ tokens: 19_600_000, byDollars: true });
    expect(before!.tokens).toBeLessThanOrEqual(capTokens);
    // After extending to that amount: no second amount.
    expect(splitExtension({ limitTokens: 19_600_000, highTokens, withMargin, capTokens })).toBeNull();
  });
});

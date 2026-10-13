import { describe, expect, test } from "bun:test";
import { SETTING_PAGES, SETTINGS } from "../../../src/core/settings/schema.ts";
import type { SettingsView } from "../src/renderer/client/settings.ts";
import {
  dependencyNote,
  displayNumber,
  isActive,
  libraryDocsDraft,
  libraryDocsSummary,
  lockedReason,
  numberDraft,
  pageSections,
  parseLibraryDocs,
  parseNumber,
  scopeValue,
  setInScope,
} from "../src/renderer/screens/setup/chat-settings-logic.ts";

const setting = (id: string) => {
  const found = SETTINGS.find((s) => s.id === id);
  if (!found) throw new Error(`No setting ${id}`);
  return found;
};

function view(values: Record<string, unknown>): SettingsView {
  return {
    pages: [...SETTING_PAGES],
    settings: [...SETTINGS],
    values: Object.fromEntries(
      SETTINGS.map((s) => [s.id, { id: s.id, value: s.id in values ? values[s.id] : s.default, source: "default" as const }]),
    ),
    catalogs: { tools: [] },
  };
}

describe("chat settings pages", () => {
  test("a page groups its settings by section in schema order", () => {
    const sections = pageSections(view({}), "provider-options");
    expect(sections.map((s) => s.title)).toEqual(["Claude", "OpenAI", "GitHub", "All providers"]);
    expect(sections[0]?.settings[0]?.id).toBe("thinking.mode");
  });

  test("settings saved only globally are locked in the project scope", () => {
    expect(lockedReason(setting("toolTimeout"), "project")).toBe("Saved for all projects only");
    expect(lockedReason(setting("toolTimeout"), "global")).toBeNull();
    expect(lockedReason(setting("performance.effort"), "project")).toBeNull();
  });

  test("a dependent setting is inactive until its condition holds", () => {
    const budget = setting("thinking.budgetTokens");
    expect(isActive(budget, view({}).values)).toBe(false);
    expect(isActive(budget, view({ "thinking.mode": "enabled" }).values)).toBe(true);
    expect(dependencyNote(budget, view({}))).toBe("Used when Thinking is Fixed budget");
    expect(dependencyNote(setting("watchdogTimeouts.chunkMs"), view({}))).toBe("Used when Watchdog is on");
  });

  test("numbers show and parse in their display unit", () => {
    const chunk = setting("watchdogTimeouts.chunkMs");
    expect(displayNumber(chunk, 120_000)).toBe("120 s");
    expect(parseNumber(chunk, "90")).toEqual({ value: 90_000 });
    expect(parseNumber(chunk, "5")).toEqual({ error: "Between 30 s and 600 s" });
    const threshold = setting("compaction.triggerThreshold");
    expect(displayNumber(threshold, 0.7)).toBe("70%");
    expect(numberDraft(threshold, 0.7)).toBe("70");
    expect(parseNumber(threshold, "85")).toEqual({ value: 0.85 });
    const budget = setting("repoMapTokenBudget");
    expect(displayNumber(budget, null)).toBe("auto");
    expect(parseNumber(budget, "")).toEqual({ value: null });
    expect(parseNumber(setting("taskRouter.maxConcurrentAgents"), "2.5")).toEqual({ error: "Enter a whole number" });
  });

  test("a scope's own value wins over the value in use when editing", () => {
    const value = { id: "modelFallback", value: { a: ["b"] }, source: "global" as const, global: { a: ["b"] } };
    expect(setInScope(value, "global")).toBe(true);
    expect(setInScope(value, "project")).toBe(false);
    expect(scopeValue(value, "project", {})).toEqual({ a: ["b"] });
    expect(scopeValue<Record<string, number>>({ ...value, project: {} }, "project", { x: 1 })).toEqual({});
  });
});

describe("library docs source", () => {
  test("a draft round-trips a directory and an MCP tool with its arguments", () => {
    const dir = { dir: "docs/libs", maxChars: 4000 };
    expect(parseLibraryDocs(libraryDocsDraft(dir))).toEqual({ value: dir });
    const mcp = { mcp: { server: "context7", tool: "get-docs", args: { library: "{name}@{version}" } } };
    const draft = libraryDocsDraft(mcp);
    expect(draft).toMatchObject({ kind: "mcp", args: "library={name}@{version}" });
    expect(parseLibraryDocs(draft)).toEqual({ value: mcp });
    expect(libraryDocsSummary(mcp)).toBe("MCP context7 / get-docs");
    expect(libraryDocsSummary(null)).toBe("not set");
  });

  test("none saves null; missing fields, bad arguments and an out-of-range cap are refused", () => {
    const empty = libraryDocsDraft(null);
    expect(parseLibraryDocs(empty)).toEqual({ value: null });
    expect(parseLibraryDocs({ ...empty, kind: "dir" })).toEqual({ error: "Name the directory." });
    expect(parseLibraryDocs({ ...empty, kind: "mcp", server: "context7" })).toHaveProperty("error");
    expect(parseLibraryDocs({ ...empty, kind: "mcp", server: "s", tool: "t", args: "novalue" })).toHaveProperty("error");
    expect(parseLibraryDocs({ ...empty, kind: "dir", dir: "d", maxChars: "100" })).toHaveProperty("error");
  });
});

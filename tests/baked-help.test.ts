import { describe, expect, test } from "bun:test";
import { DOC_READ_LIMIT, findDocPage, readDoc, searchDocs } from "../src/core/help/docs.js";
import { createBakedHelpTool } from "../src/core/tools/baked-help.js";

type Result = { success: boolean; output: string };
const run = async (args: Record<string, unknown>): Promise<Result> => {
  const help = createBakedHelpTool();
  const input = help.inputSchema as { parse: (v: unknown) => unknown };
  const execute = help.execute as (a: unknown, o: unknown) => Promise<Result>;
  return execute(input.parse(args), { toolCallId: "t", messages: [] });
};

describe("baked_help", () => {
  test("search finds the workflow model routing docs", () => {
    const hits = searchDocs("pick a model for review workflow routing");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.path.startsWith("workflows/") || h.path === "commands.md")).toBe(true);
  });

  test("search ranks the page about a topic first", () => {
    expect(searchDocs("run memory")[0]?.heading.toLowerCase()).toContain("memory");
  });

  test("pages resolve by path, docs/ prefix, missing extension or title", () => {
    expect(findDocPage("workflows/quick.md")?.path).toBe("workflows/quick.md");
    expect(findDocPage("docs/configuration.md")?.path).toBe("configuration.md");
    expect(findDocPage("providers")?.path).toBe("providers.md");
    expect(findDocPage("workflows")?.path).toBe("workflows/README.md");
    expect(findDocPage("nope")).toBeNull();
  });

  test("read returns one section with its subsections", () => {
    const page = findDocPage("commands.md");
    const section = page?.sections.find((s) => s.level === 2);
    if (!page || !section) throw new Error("commands.md has no sections");
    const result = readDoc("commands.md", section.anchor);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain(`## ${section.heading}`);
      expect(result.text.length).toBeLessThan(page.text.length + 100);
    }
    const viaHash = readDoc(`commands.md#${section.anchor}`);
    expect(viaHash.ok && viaHash.text).toBe(result.ok && result.text);
  });

  test("long pages are cut with an outline to read further", () => {
    const result = readDoc("workflows/runtime.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text.length).toBeLessThan(DOC_READ_LIMIT + 8_000);
      expect(result.text).toContain("Read a narrower section");
    }
  });

  test("unknown pages and sections list what exists", () => {
    const page = readDoc("missing.md");
    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.error).toContain("configuration.md");
    const section = readDoc("configuration.md", "no-such-heading");
    expect(section.ok).toBe(false);
  });

  test("the tool lists, searches and reads", async () => {
    expect((await run({ action: "list" })).output).toContain("getting-started.md");
    const search = await run({ action: "search", query: "headless" });
    expect(search.success).toBe(true);
    expect(search.output).toContain("headless.md#");
    expect((await run({ action: "read", page: "privacy.md" })).output).toStartWith("[privacy.md]");
    expect((await run({ action: "search", query: null })).success).toBe(false);
    expect((await run({ action: "read" })).success).toBe(false);
  });
});

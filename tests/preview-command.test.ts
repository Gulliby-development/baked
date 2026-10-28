import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandPickerConfig } from "../src/components/modals/CommandPicker.js";
import type { InfoPopupConfig } from "../src/components/modals/InfoPopup.js";
import type { ArtifactStore } from "../src/core/artifacts/store.js";
import { handlePreview, type PreviewDeps } from "../src/core/commands/preview.js";
import type { CommandContext } from "../src/core/commands/types.js";
import type { SessionManager } from "../src/core/sessions/manager.js";
import { type PreviewCliDeps, runPreviewCli } from "../src/headless/preview.js";
import type { ChatMessage, ToolCall } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-preview-cmd-"));
  dirs.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\n\nBake the **bread**.\n\n- one\n- two\n");
  writeFileSync(join(root, "page.html"), "<h1>Page</h1>");
  return root;
}

const call = (id: string, name: string, args: Record<string, unknown>, output = "ok"): ToolCall => ({
  id,
  name,
  args,
  result: { success: true, output },
});

const transcript: ChatMessage[] = [
  {
    id: "a1",
    role: "assistant",
    content: "",
    timestamp: 1,
    toolCalls: [
      call("c1", "write_file", { path: "docs/plan.md" }),
      call("c2", "write_file", { path: "src/main.ts" }),
      call("c3", "artifact", {}, 'Saved artifact menu v1 "Menu"'),
      call("c4", "edit_file", { path: "./page.html", oldString: "a" }),
    ],
  },
];

function tui(cwd: string, messages: ChatMessage[] = transcript) {
  const popups: InfoPopupConfig[] = [];
  const pickers: CommandPickerConfig[] = [];
  const notes: string[] = [];
  const opened: string[] = [];
  const ctx = {
    cwd,
    chat: {
      messages,
      setMessages: (update: (prev: ChatMessage[]) => ChatMessage[]) =>
        notes.push(...update([]).map((m) => m.content)),
    },
    openInfoPopup: (popup: InfoPopupConfig) => popups.push(popup),
    openCommandPicker: (picker: CommandPickerConfig) => pickers.push(picker),
  } as unknown as CommandContext;
  const deps: PreviewDeps = {
    open: (path) => opened.push(path) > 0,
    store: () => ({ pagePath: (id: string) => `/artifacts/${id}/v1.html` }) as ArtifactStore,
    columns: () => 120,
  };
  return { ctx, deps, popups, pickers, notes, opened };
}

describe("/preview in the TUI (#2299)", () => {
  test("lists the chat's documents and artifacts, the latest change first", () => {
    const t = tui(project());
    handlePreview("/preview", t.ctx, t.deps);
    expect(t.pickers).toHaveLength(1);
    expect(t.pickers[0]?.options.map((o) => o.value)).toEqual([
      "file:page.html",
      "artifact:menu",
      "file:docs/plan.md",
    ]);
  });

  test("picking Markdown opens a popup drawn like assistant text", () => {
    const t = tui(project());
    handlePreview("/preview", t.ctx, t.deps);
    t.pickers[0]?.onSelect("file:docs/plan.md");
    expect(t.popups).toHaveLength(1);
    expect(t.popups[0]?.title).toBe("docs/plan.md");
    const labels = t.popups[0]?.lines.map((l) => l.label) ?? [];
    // Markdown markers are gone, as in the chat.
    expect(labels).toContain("Bake the bread.");
    expect(labels.some((l) => l?.includes("**"))).toBe(false);
    expect(labels.some((l) => l?.includes("one"))).toBe(true);
  });

  test("picking HTML or an artifact opens it in the browser", () => {
    const root = project();
    const t = tui(root);
    handlePreview("/preview", t.ctx, t.deps);
    t.pickers[0]?.onSelect("file:page.html");
    t.pickers[0]?.onSelect("artifact:menu");
    expect(t.opened).toHaveLength(2);
    expect(t.opened[0]?.endsWith("page.html")).toBe(true);
    expect(t.opened[1]).toBe("/artifacts/menu/v1.html");
    expect(t.popups).toHaveLength(0);
  });

  test("/preview PATH previews any project document and refuses one outside", () => {
    const root = project();
    const t = tui(root, []);
    handlePreview("/preview docs/plan.md", t.ctx, t.deps);
    expect(t.popups).toHaveLength(1);
    handlePreview("/preview ../secret.md", t.ctx, t.deps);
    handlePreview("/preview src/main.ts", t.ctx, t.deps);
    expect(t.notes.at(-2)).toContain("outside the project");
    expect(t.notes.at(-1)).toContain("not a Markdown or HTML file");
  });

  test("a chat without documents says how to preview a path", () => {
    const t = tui(project(), []);
    handlePreview("/preview", t.ctx, t.deps);
    expect(t.pickers).toHaveLength(0);
    expect(t.notes[0]).toContain("/preview PATH");
  });
});

function cli(cwd: string, messages: ChatMessage[] = transcript) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const sessions = {
    listSessions: () => [{ id: "s-latest" }, { id: "s-old" }],
    findByPrefix: (prefix: string) => (["s-latest", "s-old"].find((id) => id.startsWith(prefix)) ?? null),
    loadSession: (id: string) => ({
      meta: { activeTabId: "t", tabs: [{ id: "t" }] },
      tabMessages: new Map([["t", id === "s-latest" ? messages : []]]),
    }),
  } as unknown as SessionManager;
  const deps: PreviewCliDeps = {
    cwd: () => cwd,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    open: (path) => opened.push(path) > 0,
    sessions: () => sessions,
    store: () => ({ pagePath: (id: string) => `/artifacts/${id}/v1.html` }) as ArtifactStore,
  };
  return { deps, out, err, opened };
}

describe("baked preview (#2299)", () => {
  test("prints Markdown and opens HTML in the browser", async () => {
    const c = cli(project());
    expect(await runPreviewCli(["docs/plan.md"], c.deps)).toBe(0);
    expect(c.out.join("")).toContain("Bake the **bread**.");
    expect(await runPreviewCli(["page.html"], c.deps)).toBe(0);
    expect(c.opened).toHaveLength(1);
    expect(await runPreviewCli(["page.html", "--print"], c.deps)).toBe(0);
    expect(c.out.at(-1)).toContain("<h1>Page</h1>");
    expect(c.opened).toHaveLength(1);
  });

  test("--json answers like GET /v1/files/preview", async () => {
    const c = cli(project());
    expect(await runPreviewCli(["docs/plan.md", "--json"], c.deps)).toBe(0);
    const doc = JSON.parse(c.out.join(""));
    expect(doc).toMatchObject({ path: "docs/plan.md", kind: "markdown" });
  });

  test("refuses a path outside the project, another kind and a missing file", async () => {
    const c = cli(project());
    expect(await runPreviewCli(["../outside.md"], c.deps)).toBe(2);
    expect(await runPreviewCli(["src/main.ts"], c.deps)).toBe(2);
    expect(await runPreviewCli(["docs/missing.md"], c.deps)).toBe(2);
    expect(c.err.join("")).toContain("outside the project");
    expect(c.opened).toHaveLength(0);
  });

  test("list prints the latest session's documents, the latest change first", async () => {
    const c = cli(project());
    expect(await runPreviewCli(["list"], c.deps)).toBe(0);
    const lines = c.out.join("").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("page.html");
    expect(lines[1]).toContain("artifact menu");
    expect(lines[1]).toContain("/artifacts/menu/v1.html");
    expect(lines[2]).toContain("docs/plan.md");
    expect(await runPreviewCli(["list", "--session", "s-old"], c.deps)).toBe(0);
    expect(c.out.at(-1)).toContain("wrote no Markdown or HTML document");
    expect(await runPreviewCli(["list", "--session", "nope"], c.deps)).toBe(2);
  });

  test("bad arguments exit 2", async () => {
    const c = cli(project());
    expect(await runPreviewCli([], c.deps)).toBe(2);
    expect(await runPreviewCli(["docs/plan.md", "--open"], c.deps)).toBe(2);
    expect(await runPreviewCli(["--help"], c.deps)).toBe(0);
  });
});

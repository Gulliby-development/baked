import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ArtifactStore } from "../src/core/artifacts/store.js";
import {
  applyKitToPage,
  buildKitGuidance,
  detectProjectStyle,
  KIT_CSS,
  KIT_PALETTE,
  pageIsUnstyled,
} from "../src/core/kit/index.js";
import { buildSystemPrompt } from "../src/core/prompts/builder.js";
import { createArtifactTool } from "../src/core/tools/artifact.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "baked-kit-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("kit stylesheet", () => {
  test("uses the desktop palette in both themes", () => {
    const css = readFileSync("apps/desktop/src/renderer/styles/tokens.css", "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(selector);
      const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
      return Object.fromEntries(
        [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]?.trim()]),
      );
    };
    const desktop = [block(':root[data-theme="light"]'), block(':root[data-theme="dark"]')];
    const source: Record<keyof typeof KIT_PALETTE, string | [string, string]> = {
      bg: "bg",
      surface: "bg-panel",
      sunken: "bg-sunken",
      line: "line",
      edge: ["ink", "line-strong"],
      ink: "ink",
      text: "text",
      "text-2": "text-2",
      muted: "text-3",
      accent: "accent",
      "accent-fill": "fill-accent",
      "on-fill": "on-fill",
      code: "bg-code",
      ok: "ok",
      warn: "warn",
      err: "err",
      "fill-ok": "fill-ok",
      "fill-warn": "fill-warn",
      "fill-err": "fill-err",
    };
    for (const [name, values] of Object.entries(KIT_PALETTE))
      values.forEach((value, side) => {
        const from = source[name as keyof typeof KIT_PALETTE];
        const token = typeof from === "string" ? from : from[side];
        expect(`${name}: ${value}`).toBe(`${name}: ${desktop[side]?.[token ?? ""]}`);
      });
  });

  test("stays small enough to sit in the agent's context", () => {
    expect(KIT_CSS.length).toBeLessThan(8000);
    expect(KIT_CSS).toContain("prefers-color-scheme:dark");
    expect(KIT_CSS).toContain(":root[data-theme=dark]");
  });
});

describe("project style detection", () => {
  test("an empty project or unstyled web files get the kit", () => {
    expect(detectProjectStyle(project({ "README.md": "# App", "AGENTS.md": "Use Bun." })).state).toBe(
      "unstyled",
    );
    expect(detectProjectStyle(project({ "index.html": "<h1>Hi</h1>", "app.js": "" })).state).toBe(
      "unstyled",
    );
  });

  test("any style of the project's own keeps the kit out", () => {
    const styled = (files: Record<string, string>, instructions = "") =>
      detectProjectStyle(project(files), instructions);
    expect(styled({ "src/app.css": "body{}" })).toMatchObject({ state: "styled", reason: "the project has src/app.css" });
    expect(styled({ "index.html": "<style>h1{}</style>" }).state).toBe("styled");
    expect(styled({ "index.html": '<link rel="stylesheet" href="x.css">' }).state).toBe("styled");
    expect(styled({ "package.json": JSON.stringify({ dependencies: { tailwindcss: "4" } }) })).toMatchObject({
      reason: "package.json depends on tailwindcss",
    });
    expect(styled({ "components.json": "{}", "index.html": "" }).state).toBe("styled");
    expect(styled({ "index.html": "" }, "Project instructions:\nUse our design system.").state).toBe("styled");
  });

  test("build output and dependencies do not count, the kit file is recognised", () => {
    expect(
      detectProjectStyle(project({ "index.html": "", "node_modules/x/y.css": "", "dist/a.css": "" })).state,
    ).toBe("unstyled");
    expect(detectProjectStyle(project({ "index.html": '<link rel="stylesheet" href="baked-kit.css">', "baked-kit.css": KIT_CSS }))).toEqual({
      state: "kit",
      path: "baked-kit.css",
    });
  });

  test("code without a web front end is left alone", () => {
    expect(detectProjectStyle(project({ "main.go": "package main", "go.mod": "" })).state).toBe("not-web");
  });
});

describe("guidance", () => {
  const unstyled = { state: "unstyled", reason: "the project is empty" } as const;

  test("auto offers the kit with its stylesheet only to unstyled projects", () => {
    const text = buildKitGuidance("auto", unstyled);
    expect(text).toContain("the project is empty");
    expect(text).toContain(KIT_CSS);
    expect(text).toContain('<meta name="generator" content="BAKED">');
    expect(text).toContain("The user's request comes first");
    expect(text).not.toMatch(/claude|openai|codex|gpt/i);
    expect(buildKitGuidance("auto", { state: "styled", reason: "x" })).toBe("");
    expect(buildKitGuidance("auto", { state: "not-web" })).toBe("");
    expect(buildKitGuidance("off", unstyled)).toBe("");
  });

  test("a kit project gets a short reminder, always mode gets the kit everywhere", () => {
    const kit = buildKitGuidance("auto", { state: "kit", path: "public/baked-kit.css" });
    expect(kit).toContain("public/baked-kit.css");
    expect(kit).not.toContain(KIT_CSS);
    expect(buildKitGuidance("always", { state: "styled", reason: "x" })).toContain(KIT_CSS);
  });

  test("the system prompt carries it after the project instructions", () => {
    const prompt = buildSystemPrompt({
      modelId: "anthropic/claude-sonnet-4-6",
      hasRepoMap: false,
      hasSymbols: false,
      bakeMode: "default",
      projectInstructions: "Project instructions:\nX",
      designGuidance: "Design (BAKED kit): Y",
    });
    expect(prompt.indexOf("Design (BAKED kit)")).toBeGreaterThan(prompt.indexOf("Project instructions"));
  });
});

describe("artifact pages", () => {
  test("an unstyled page gets the kit and the mark once", () => {
    const page = "<!doctype html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>";
    expect(pageIsUnstyled(page)).toBe(true);
    const styled = applyKitToPage(page);
    expect(styled).toContain(KIT_CSS);
    expect(styled.indexOf("bk-made")).toBeLessThan(styled.indexOf("</body>"));
    expect(pageIsUnstyled(styled)).toBe(false);
    expect(applyKitToPage(styled)).toBe(styled);
    const fragment = applyKitToPage("<h1>Hi</h1>");
    expect(fragment).toStartWith("<!doctype html>");
    expect(fragment).toContain('<meta name="viewport"');
  });

  test("the artifact tool styles unstyled pages unless told not to", async () => {
    const root = project();
    const store = new ArtifactStore(join(root, "artifacts"));
    const tool = createArtifactTool({ cwd: root, store });
    const run = (args: Record<string, unknown>) =>
      (tool.execute as (a: unknown, o: unknown) => Promise<string>)(args, { toolCallId: "t", messages: [] });
    expect(await run({ action: "save", html: "<h1>Plain</h1>", title: "Plain" })).toContain("styled with the BAKED kit");
    expect(store.read("plain")).toContain("Made with <b>BAKED</b>");
    await run({ action: "save", html: "<h1>Raw</h1>", title: "Raw", kit: false });
    expect(store.read("raw")).toBe("<h1>Raw</h1>");
    const own = "<style>h1{color:red}</style><h1>Own</h1>";
    await run({ action: "save", html: own, title: "Own" });
    expect(store.read("own")).toBe(own);
  });
});

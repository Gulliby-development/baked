import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import {
  PREVIEW_KINDS,
  PREVIEW_MAX_BYTES,
  PreviewError,
  previewKind,
  readPreview,
} from "../src/core/files/preview.js";
import { fileSymlinksAvailable } from "./helpers/symlinks.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-preview-"));
  dirs.push(root);
  return root;
}

function code(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof PreviewError) return error.code;
    throw error;
  }
  return "ok";
}

describe("file preview (#2298)", () => {
  test("knows Markdown and HTML by extension, case-insensitively", () => {
    expect(previewKind("docs/README.md")).toBe("markdown");
    expect(previewKind("a/B.MARKDOWN")).toBe("markdown");
    expect(previewKind("site/index.HTM")).toBe("html");
    expect(previewKind("report.html")).toBe("html");
    expect(previewKind("src/app.ts")).toBeNull();
    expect(previewKind("Makefile")).toBeNull();
    expect(new Set(Object.values(PREVIEW_KINDS))).toEqual(new Set(["markdown", "html"]));
  });

  test("reads a project document with its kind, size and relative path", () => {
    const root = project();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs", "plan.md"), "# Plan\n");
    const doc = readPreview(root, "docs/plan.md");
    expect(doc).toMatchObject({ path: "docs/plan.md", kind: "markdown", text: "# Plan\n", bytes: 7 });
    expect(Number.isNaN(Date.parse(doc.modifiedAt))).toBe(false);
    expect(readPreview(root, join(root, "docs", "plan.md")).path).toBe("docs/plan.md");
  });

  test("refuses other kinds, missing and large files, and paths that leave the project", () => {
    const root = project();
    const outside = project();
    writeFileSync(join(root, "app.ts"), "x");
    writeFileSync(join(outside, "secret.md"), "secret");
    writeFileSync(join(root, "big.html"), "x".repeat(PREVIEW_MAX_BYTES + 1));
    expect(code(() => readPreview(root, "app.ts"))).toBe("INVALID");
    expect(code(() => readPreview(root, "missing.md"))).toBe("NOT_FOUND");
    expect(code(() => readPreview(root, "big.html"))).toBe("TOO_LARGE");
    expect(code(() => readPreview(root, "../secret.md"))).toBe("INVALID");
    expect(code(() => readPreview(root, join(outside, "secret.md")))).toBe("INVALID");
  });

  test("a project reached through a linked folder, as macOS's /var is /private/var, finds missing files missing", () => {
    const real = project();
    const links = project();
    const alias = join(links, "alias");
    symlinkSync(real, alias, "junction");
    mkdirSync(join(real, "docs"));
    writeFileSync(join(real, "docs", "plan.md"), "# Plan\n");
    expect(readPreview(alias, "docs/plan.md").path).toBe("docs/plan.md");
    expect(code(() => readPreview(alias, "missing.md"))).toBe("NOT_FOUND");
    expect(code(() => readPreview(alias, "new/folder/missing.md"))).toBe("NOT_FOUND");
    expect(code(() => readPreview(alias, "../outside.md"))).toBe("INVALID");
  });

  test.if(fileSymlinksAvailable)("refuses links that leave the project or hide another kind", () => {
    const root = project();
    const outside = project();
    writeFileSync(join(outside, "secret.md"), "secret");
    writeFileSync(join(root, "env.txt"), "TOKEN=1");
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"), "file");
    symlinkSync(join(root, "env.txt"), join(root, "env.md"), "file");
    expect(code(() => readPreview(root, "link.md"))).toBe("INVALID");
    expect(code(() => readPreview(root, "env.md"))).toBe("INVALID");
  });

  test("the API previews and opens project documents", async () => {
    const fixture = workflowFixture();
    const root = fixture.service.workspace;
    writeFileSync(join(root, "notes.md"), "# Notes\n");
    writeFileSync(join(root, "page.html"), "<h1>Hi</h1>");
    const opened: string[] = [];
    const server = await startApiServer({
      service: fixture.service,
      openFile: (path) => {
        opened.push(path);
        return true;
      },
    });
    try {
      const call = (path: string, init: RequestInit = {}) =>
        fetch(`${server.url}${path}`, {
          ...init,
          headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        });
      const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
      expect(health.capabilities).toContain("file-preview");
      const md = await call("/v1/files/preview?path=notes.md");
      expect(md.status).toBe(200);
      expect(await md.json()).toMatchObject({ path: "notes.md", kind: "markdown", text: "# Notes\n" });
      expect(((await (await call("/v1/files/preview?path=page.html")).json()) as { kind: string }).kind).toBe("html");
      expect((await call("/v1/files/preview?path=missing.md")).status).toBe(404);
      expect((await call("/v1/files/preview?path=../x.md")).status).toBe(400);
      expect((await call("/v1/files/preview")).status).toBe(400);
      const open = await call("/v1/files/open", { method: "POST", body: JSON.stringify({ path: "page.html" }) });
      expect(((await open.json()) as { opened: boolean }).opened).toBe(true);
      expect(opened).toHaveLength(1);
      expect(opened[0]?.endsWith("page.html")).toBe(true);
      expect((await call("/v1/files/open", { method: "POST", body: JSON.stringify({ path: "a.ts" }) })).status).toBe(400);
    } finally {
      await server.stop();
      await fixture.dispose();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { ProjectMemoryView } from "../src/core/workflows/project-memory.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("project memory over the local API", () => {
  test("lists, adds, edits and forgets notes; refuses bad requests", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(homeDir);
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" } });
    const post = (body: unknown) => call("/v1/workflow/memory", { method: "POST", body: JSON.stringify(body) });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("run-memory");
    const empty = (await (await call("/v1/workflow/memory")).json()) as ProjectMemoryView;
    expect(empty).toEqual({ enabled: true, entries: [], hidden: [], rendered: null });

    const added = (await (await post({ action: "add", text: "Prefer small modules" })).json()) as ProjectMemoryView & { id: string };
    expect(added.entries).toEqual([{ id: added.id, kind: "note", text: "Prefer small modules", hidden: false, sent: true }]);
    expect(added.rendered).toContain("- Prefer small modules");
    const edited = (await (await post({ action: "edit", id: added.id, text: "Prefer short modules" })).json()) as ProjectMemoryView;
    expect(edited.entries[0]?.text).toBe("Prefer short modules");
    expect((await post({ action: "restore", id: added.id })).status).toBe(400);
    expect((await post({ action: "forget", id: "a-0123456789" })).status).toBe(404);
    expect((await post({ action: "add" })).status).toBe(400);
    expect((await call("/v1/workflow/memory", { method: "DELETE" })).status).toBe(405);
    const forgotten = (await (await post({ action: "forget", id: added.id })).json()) as ProjectMemoryView;
    expect(forgotten.entries).toEqual([]);
  });
});

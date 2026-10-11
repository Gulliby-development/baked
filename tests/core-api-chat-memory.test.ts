import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { ChatMemoryView, CleanupCandidate } from "../src/core/memory/browse.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve() {
  const fixture = workflowFixture();
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
  const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
  const seed = new MemoryManager(fixture.service.workspace, configDir);
  cleanups.push(async () => {
    seed.close();
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
    await removeTempDir(homeDir);
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, { ...init, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" } });
  const send = async <T>(method: string, path: string, body: unknown): Promise<T> => {
    const res = await call(path, { method, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return { call, send, seed, configDir, workspace: fixture.service.workspace };
}

describe("chat memory over the local API", () => {
  test("lists, pins, edits, hides, restores and purges memories", async () => {
    const { call, send, seed } = await serve();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("chat-memory");

    const empty = (await (await call("/v1/memory")).json()) as ChatMemoryView;
    expect(empty.entries).toEqual([]);
    expect(empty.settings).toEqual({ writeScope: "project", readScope: "all", settingsScope: "project" });

    const project = seed.write("project", { summary: "Use bun, never npm", details: "", category: "pref", source: "user" }).record;
    const global = seed.write("global", { summary: "Short commit subjects", details: "under 60 chars", category: "pref", source: "agent" }).record;
    const listed = (await (await call("/v1/memory")).json()) as ChatMemoryView;
    expect(listed.entries.map((e) => [e.scope, e.summary]).sort()).toEqual([
      ["global", "Short commit subjects"],
      ["project", "Use bun, never npm"],
    ]);

    const pinned = await send<ChatMemoryView>("POST", "/v1/memory", { action: "pin", scope: "project", id: project.id });
    expect(pinned.entries.find((e) => e.id === project.id)?.pinned).toBe(true);
    const edited = await send<ChatMemoryView>("POST", "/v1/memory", {
      action: "edit",
      scope: "project",
      id: project.id,
      summary: "Use bun for everything",
      category: "decision",
    });
    expect(edited.entries.find((e) => e.id === project.id)).toMatchObject({ summary: "Use bun for everything", category: "decision", pinned: true });

    const hidden = await send<ChatMemoryView>("POST", "/v1/memory", { action: "hide", scope: "global", id: global.id });
    expect(hidden.entries.map((e) => e.id)).toEqual([project.id]);
    expect(hidden.hidden.map((e) => e.id)).toEqual([global.id]);
    const restored = await send<ChatMemoryView>("POST", "/v1/memory", { action: "restore", scope: "global", id: global.id });
    expect(restored.hidden).toEqual([]);

    // The wrong scope does not find a memory; bad bodies and methods are refused.
    expect((await call("/v1/memory", { method: "POST", body: JSON.stringify({ action: "pin", scope: "global", id: project.id }) })).status).toBe(404);
    expect((await call("/v1/memory", { method: "POST", body: JSON.stringify({ action: "edit", scope: "project", id: project.id, summary: " " }) })).status).toBe(400);
    expect((await call("/v1/memory", { method: "DELETE" })).status).toBe(405);

    const purged = await send<ChatMemoryView & { cleared: number }>("POST", "/v1/memory", { action: "purge", scope: "project" });
    expect(purged.cleared).toBe(1);
    expect(purged.entries.map((e) => e.scope)).toEqual(["global"]);
  });

  test("changes the scope settings and keeps them on disk", async () => {
    const { call, send, configDir, workspace } = await serve();
    const changed = await send<ChatMemoryView>("PUT", "/v1/memory/settings", { writeScope: "none", readScope: "project" });
    expect(changed.settings).toEqual({ writeScope: "none", readScope: "project", settingsScope: "project" });
    const moved = await send<ChatMemoryView>("PUT", "/v1/memory/settings", { settingsScope: "global" });
    expect(moved.settings).toEqual({ writeScope: "none", readScope: "project", settingsScope: "global" });
    const reread = new MemoryManager(workspace, configDir);
    expect(reread.scopeConfig).toEqual({ writeScope: "none", readScope: "project" });
    expect(reread.settingsScope).toBe("global");
    reread.close();
    expect((await call("/v1/memory/settings", { method: "PUT", body: JSON.stringify({}) })).status).toBe(400);
    expect((await call("/v1/memory/settings", { method: "PUT", body: JSON.stringify({ writeScope: "all" }) })).status).toBe(400);
  });

  test("suggests memories whose files are gone and applies a cleanup", async () => {
    const { call, send, seed } = await serve();
    const dead = seed.write("project", { summary: "Parser lives in old.ts", details: "", category: "context", source: "agent" }).record;
    seed.addFileRef("project", dead.id, "src/old.ts", null);
    const keep = seed.write("project", { summary: "Tests use bun:test", details: "", category: "pref", source: "user" }).record;

    const { candidates } = (await (await call("/v1/memory/cleanup")).json()) as { candidates: CleanupCandidate[] };
    expect(candidates.find((c) => c.id === dead.id)).toMatchObject({ kind: "dead", scope: "project", detail: "src/old.ts" });

    const applied = await send<ChatMemoryView & { applied: { hidden: number; pinned: number } }>("POST", "/v1/memory/cleanup", {
      actions: [
        { scope: "project", id: dead.id, action: "hide" },
        { scope: "project", id: keep.id, action: "pin" },
      ],
    });
    expect(applied.applied).toEqual({ hidden: 1, pinned: 1 });
    expect(applied.entries.map((e) => [e.id, e.pinned])).toEqual([[keep.id, true]]);
  });
});

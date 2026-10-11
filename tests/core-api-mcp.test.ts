import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { applyMCPChange, MCPChangeError, mcpServerViews } from "../src/core/mcp/config.js";
import { disposeMCPManager } from "../src/core/mcp/index.js";
import type { MCPServerConfig } from "../src/types/index.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const stub: MCPServerConfig = {
  name: "stub",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures", "mcp-stub-server.ts")],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MCP config changes", () => {
  const layers = {
    global: [{ name: "docs", transport: "http" as const, url: "https://mcp.example.com/mcp" }],
    project: [{ name: "db", command: "uvx", args: ["mcp-db"] }],
  };

  test("add, edit, move, toggle and remove touch only the scopes they change", () => {
    expect(applyMCPChange(layers, { action: "add", scope: "project", server: stub })).toEqual({
      project: [...layers.project, stub],
    });
    const moved = applyMCPChange(layers, {
      action: "edit",
      scope: "project",
      name: "db",
      server: { name: "db", command: "uvx", args: ["mcp-db", "--ro"] },
      toScope: "global",
    });
    expect(moved.project).toEqual([]);
    expect(moved.global?.[1]).toEqual({ name: "db", command: "uvx", args: ["mcp-db", "--ro"] });
    const off = applyMCPChange(layers, { action: "set-disabled", scope: "global", name: "docs", disabled: true });
    expect(off).toEqual({ global: [{ ...layers.global[0], disabled: true }] });
    expect(applyMCPChange(layers, { action: "remove", scope: "global", name: "docs" })).toEqual({ global: [] });
  });

  test("an edit keeps a disabled server disabled and drops fields its transport does not use", () => {
    const off = { global: [], project: [{ name: "db", command: "uvx", disabled: true }] };
    const edited = applyMCPChange(off, {
      action: "edit",
      scope: "project",
      name: "db",
      server: { name: "db", transport: "http", url: "https://db.example.com/mcp", command: "uvx" },
    });
    expect(edited.project).toEqual([
      { name: "db", transport: "http", url: "https://db.example.com/mcp", disabled: true },
    ]);
  });

  test("duplicates, unknown servers and incomplete servers are refused", () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof MCPChangeError ? error.code : "other";
      }
      return null;
    };
    expect(code(() => applyMCPChange(layers, { action: "add", scope: "project", server: { name: "db", command: "x" } }))).toBe("CONFLICT");
    expect(code(() => applyMCPChange(layers, { action: "remove", scope: "project", name: "docs" }))).toBe("NOT_FOUND");
    expect(code(() => applyMCPChange(layers, { action: "add", scope: "project", server: { name: "x" } }))).toBe("INVALID");
    expect(code(() => applyMCPChange(layers, { action: "add", scope: "project", server: { name: "x", transport: "sse", url: "ftp://a" } }))).toBe("INVALID");
    expect(code(() => applyMCPChange(layers, { action: "add", scope: "project", server: { name: "a b", command: "x" } }))).toBe("INVALID");
  });

  test("a project server replaces a global one with the same name", () => {
    const views = mcpServerViews(
      { global: [{ name: "db", command: "global-db" }, { name: "docs", command: "d" }], project: [{ name: "db", command: "project-db" }] },
      {},
    );
    expect(views.map((v) => [v.name, v.scope, v.overridesGlobal, v.status])).toEqual([
      ["db", "project", true, "idle"],
      ["docs", "global", false, "idle"],
    ]);
  });
});

async function setup() {
  const fixture = workflowFixture();
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const server = await startApiServer({ service: fixture.service, configDir, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await disposeMCPManager();
    await fixture.dispose();
    await removeTempDir(configDir);
  });
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { fixture, configDir, call };
}

type View = { servers: { name: string; scope: string; status: string; tools: { name: string }[] }[]; started: boolean };

describe("local API MCP servers", () => {
  test("health lists the mcp capability", async () => {
    const { call } = await setup();
    expect((await call("/v1/health")).body.capabilities).toContain("mcp");
  });

  test("servers are added, toggled, edited and removed in the config files", async () => {
    const { call, configDir, fixture } = await setup();
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ theme: { name: "x" }, mcpServers: [{ name: "docs", transport: "http", url: "https://mcp.example.com/mcp" }] }));

    const added = await call("/v1/mcp", "POST", { scope: "project", server: { name: "db", command: "uvx", args: ["mcp-db"] } });
    expect(added.status).toBe(200);
    expect((added.body as unknown as View).servers.map((s) => [s.name, s.scope, s.status])).toEqual([
      ["db", "project", "idle"],
      ["docs", "global", "idle"],
    ]);
    const projectFile = join(fixture.root, ".baked", "config.json");
    expect(JSON.parse(readFileSync(projectFile, "utf8")).mcpServers).toEqual([{ name: "db", command: "uvx", args: ["mcp-db"] }]);

    expect((await call("/v1/mcp", "POST", { scope: "project", server: { name: "db", command: "x" } })).status).toBe(409);
    expect((await call("/v1/mcp", "POST", { scope: "project", server: { name: "web", transport: "http" } })).status).toBe(400);

    const off = await call("/v1/mcp/docs", "PATCH", { scope: "global", disabled: true });
    expect((off.body as unknown as View).servers.find((s) => s.name === "docs")?.status).toBe("disabled");
    const global = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(global.theme).toEqual({ name: "x" });
    expect(global.mcpServers[0].disabled).toBe(true);

    const renamed = await call("/v1/mcp/db", "PATCH", { scope: "project", server: { name: "database", command: "uvx" } });
    expect((renamed.body as unknown as View).servers.map((s) => s.name)).toEqual(["database", "docs"]);

    expect((await call("/v1/mcp/missing?scope=project", "DELETE")).status).toBe(404);
    const removed = await call("/v1/mcp/database?scope=project", "DELETE");
    expect((removed.body as unknown as View).servers.map((s) => s.name)).toEqual(["docs"]);
    expect(JSON.parse(readFileSync(projectFile, "utf8")).mcpServers).toBeUndefined();
  });

  test("reconnect connects a server and lists its tools; ping answers once it is connected", async () => {
    const { call } = await setup();
    expect((await call("/v1/mcp/stub/ping", "POST", {})).status).toBe(404);
    await call("/v1/mcp", "POST", { scope: "project", server: stub });
    expect((await call("/v1/mcp/stub/ping", "POST", {})).status).toBe(409);

    const connected = await call("/v1/mcp/stub/reconnect", "POST", {});
    expect(connected.status).toBe(200);
    const view = connected.body as unknown as View;
    expect(view.started).toBe(true);
    expect(view.servers[0]?.status).toBe("ready");
    expect(view.servers[0]?.tools.map((t) => t.name).sort()).toEqual(["echo", "stamp"]);

    const ping = await call("/v1/mcp/stub/ping", "POST", {});
    expect(ping.status).toBe(200);
    expect(typeof ping.body.ms).toBe("number");

    // Disabling a connected server disconnects it.
    const off = await call("/v1/mcp/stub", "PATCH", { scope: "project", disabled: true });
    expect((off.body as unknown as View).servers[0]?.status).toBe("disabled");
    expect((await call("/v1/mcp/stub/reconnect", "POST", {})).status).toBe(409);
  }, 30_000);
});

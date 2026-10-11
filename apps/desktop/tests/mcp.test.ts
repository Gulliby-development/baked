import { describe, expect, test } from "bun:test";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { mcp } = await import("../src/renderer/client/mcp.ts");
const { parseRoute, projectHref } = await import("../src/renderer/router.ts");
const { draftFrom, draftProblem, draftServer, EMPTY_DRAFT, joinArgs, splitArgs } = await import(
  "../src/renderer/screens/setup/mcp-logic.ts"
);
delete scope.window;

describe("MCP client", () => {
  test("lists, adds, toggles, edits, reconnects and removes servers", async () => {
    const listed = await mcp.list("baked");
    expect(listed.servers.map((s) => [s.name, s.scope])).toContainEqual(["github", "global"]);

    const added = await mcp.add("baked", "project", { name: "files", command: "npx", args: ["-y", "fs-mcp"] });
    expect(added.servers.find((s) => s.name === "files")?.status).toBe("ready");
    await expect(mcp.add("baked", "project", { name: "files", command: "x" })).rejects.toBeInstanceOf(ApiError);

    const off = await mcp.setDisabled("baked", "project", "files", true);
    expect(off.servers.find((s) => s.name === "files")?.status).toBe("disabled");
    await expect(mcp.reconnect("baked", "files")).rejects.toBeInstanceOf(ApiError);

    const moved = await mcp.edit("baked", "project", "files", { name: "files", command: "npx" }, "global");
    const files = moved.servers.find((s) => s.name === "files");
    expect([files?.scope, files?.status]).toEqual(["global", "disabled"]);

    const removed = await mcp.remove("baked", "global", "files");
    expect(removed.servers.some((s) => s.name === "files")).toBe(false);
  });

  test("has its own project section", () => {
    expect(parseRoute(projectHref("baked", "mcp"))).toEqual({ name: "project", key: "baked", section: "mcp", id: null });
  });
});

describe("MCP form", () => {
  test("arguments keep quoted spaces both ways", () => {
    expect(splitArgs(`-y "@scope/pkg" 'a b' c`)).toEqual(["-y", "@scope/pkg", "a b", "c"]);
    expect(splitArgs(joinArgs(["--path", "C:\\My Files", ""]))).toEqual(["--path", "C:\\My Files", ""]);
  });

  test("a draft turns into the config entry it came from", () => {
    const config = {
      name: "docs",
      transport: "http" as const,
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer x=y" },
      env: { A: "1" },
      timeout: 45_000,
    };
    expect(draftServer(draftFrom(config, "global"))).toEqual(config);
  });

  test("problems name the field to fix", () => {
    expect(draftProblem(EMPTY_DRAFT)).toContain("Name");
    expect(draftProblem({ ...EMPTY_DRAFT, name: "db" })).toContain("command");
    expect(draftProblem({ ...EMPTY_DRAFT, name: "db", transport: "sse", url: "ftp://x" })).toContain("URL");
    expect(draftProblem({ ...EMPTY_DRAFT, name: "db", command: "uvx", env: "TOKEN" })).toContain("KEY=value");
    expect(draftProblem({ ...EMPTY_DRAFT, name: "db", command: "uvx", timeout: "0" })).toContain("Timeout");
    expect(draftProblem({ ...EMPTY_DRAFT, name: "db", command: "uvx" })).toBeNull();
  });
});

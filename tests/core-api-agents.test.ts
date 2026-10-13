import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(agents: Record<string, string> = {}) {
  const fixture = workflowFixture();
  for (const [path, text] of Object.entries(agents)) {
    mkdirSync(join(fixture.root, path, ".."), { recursive: true });
    writeFileSync(join(fixture.root, path), text);
  }
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const server = await startApiServer({ service: fixture.service, configDir, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
  return { fixture, call };
}

type Listed = {
  agents: { key: string; name: string; stage: string; hash: string; sourceLabel: string }[];
  bases: string[];
  stages: string[];
};

describe("local API project agents", () => {
  test("health lists the capability; a project without agents lists none and no bases", async () => {
    const { call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("project-agents");
    const list = (await (await call("/v1/agents")).json()) as Listed;
    expect(list.agents).toEqual([]);
    expect(list.bases).toEqual([]);
  });

  test("lists, edits, converts and removes agents", async () => {
    const { fixture, call } = await setup({
      ".claude/agents/reviewer-x.md": "---\ndescription: Reviews for security\n---\nCheck secrets.",
      ".claude/agents/builder.md": "---\ndescription: Builds UI\n---\nUse hooks.",
    });
    const list = (await (await call("/v1/agents")).json()) as Listed;
    expect(list.agents.map((a) => [a.name, a.stage, a.sourceLabel])).toEqual([
      ["builder", "implement", "Claude Code"],
      ["reviewer-x", "review", "Claude Code"],
    ]);
    expect(list.bases[0]).toBe("standard");
    expect(list.stages).toContain("skip");

    const builder = list.agents[0];
    const stale = await call("/v1/agents", {
      method: "PUT",
      body: JSON.stringify({ key: builder?.key, content: "x", expectedHash: "0".repeat(64) }),
    });
    expect(stale.status).toBe(409);
    const edited = await call("/v1/agents", {
      method: "PUT",
      body: JSON.stringify({
        key: builder?.key,
        content: "---\ndescription: Builds UI\n---\nUse hooks and tests.",
        expectedHash: builder?.hash,
      }),
    });
    expect(edited.status).toBe(200);

    const converted = await call("/v1/agents/convert", {
      method: "POST",
      body: JSON.stringify({
        workflowId: "team",
        agents: list.agents.map((a) => ({ key: a.key, stage: a.stage })),
        removeOriginals: true,
      }),
    });
    expect(converted.status).toBe(200);
    const result = (await converted.json()) as { removed: string[]; profiles: { id: string }[] };
    expect(result.profiles.map((p) => p.id)).toEqual(["builder"]);
    expect(result.removed).toHaveLength(2);
    expect(existsSync(join(fixture.root, "baked/workflows/team.json"))).toBe(true);
    expect(((await (await call("/v1/agents")).json()) as Listed).agents).toEqual([]);

    const again = await call("/v1/agents/convert", {
      method: "POST",
      body: JSON.stringify({ workflowId: "team", agents: [{ key: "x.md", stage: "plan" }] }),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  test("removes one agent file and answers 404 for an unknown one", async () => {
    const { call } = await setup({ ".github/agents/plan.agent.md": "Plan things." });
    const ok = await call(`/v1/agents?key=${encodeURIComponent(".github/agents/plan.agent.md")}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    const missing = await call("/v1/agents?key=nope.md", { method: "DELETE" });
    expect(missing.status).toBe(404);
  });
});

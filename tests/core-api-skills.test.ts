import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { SkillCatalog } from "../src/core/skills/manager.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const CATALOG = [{ id: "acme/skills/pdf", skillId: "pdf", name: "pdf", installs: 1200, source: "acme/skills" }];

async function setup(fail?: string) {
  const fixture = workflowFixture();
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
  const queries: string[] = [];
  const skillCatalog: SkillCatalog = {
    search: async (query) => {
      queries.push(query);
      if (fail) throw new Error(fail);
      return CATALOG;
    },
    install: async (_source, skillId, global, options = {}) => {
      if (skillId === "broken") return { installed: false, error: "No SKILL.md found after install." };
      const root = global ? (options.home ?? homeDir) : (options.cwd ?? fixture.root);
      mkdirSync(join(root, ".agents", "skills", skillId), { recursive: true });
      writeFileSync(join(root, ".agents", "skills", skillId, "SKILL.md"), "---\ndescription: Read PDFs\n---\nSteps");
      return { installed: true, name: skillId };
    },
  };
  const server = await startApiServer({ service: fixture.service, configDir, homeDir, skillCatalog, log: () => {} });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
    await removeTempDir(homeDir);
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
    });
  return { fixture, homeDir, call, queries };
}

type Skill = { id: string; scope: string; path: string; description?: string };

describe("local API skills", () => {
  test("health lists the skills-install capability", async () => {
    const { call } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("skills-install");
  });

  test("the catalog searches skills.sh, and an empty query asks for popular skills", async () => {
    const { call, queries } = await setup();
    const found = (await (await call("/v1/skills/catalog?q=pdf")).json()) as { skills: unknown[] };
    expect(found.skills).toEqual(CATALOG);
    await call("/v1/skills/catalog");
    expect(queries).toEqual(["pdf", ""]);
  });

  test("an unreachable catalog answers 502", async () => {
    const { call } = await setup("offline");
    const response = await call("/v1/skills/catalog?q=pdf");
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("CATALOG_UNAVAILABLE");
  });

  test("a skill installs into the project or globally, can be read and removed", async () => {
    const { call, fixture, homeDir } = await setup();
    const project = await call("/v1/skills", {
      method: "POST",
      body: JSON.stringify({ source: "acme/skills", skillId: "pdf", scope: "project" }),
    });
    expect(project.status).toBe(200);
    const installed = (await project.json()) as { skill: Skill; skills: Skill[] };
    expect(installed.skill).toEqual(expect.objectContaining({ id: "pdf", scope: "project", description: "Read PDFs" }));
    expect(existsSync(join(fixture.root, ".agents", "skills", "pdf", "SKILL.md"))).toBe(true);

    await call("/v1/skills", { method: "POST", body: JSON.stringify({ source: "acme/skills", skillId: "lint", scope: "global" }) });
    expect(existsSync(join(homeDir, ".agents", "skills", "lint", "SKILL.md"))).toBe(true);

    const read = (await (await call("/v1/skills/project/pdf")).json()) as Skill & { content: string };
    expect(read.content).toContain("Steps");
    expect((await call("/v1/skills/global/pdf")).status).toBe(404);

    const removed = await call("/v1/skills/project/pdf", { method: "DELETE" });
    expect(((await removed.json()) as { skills: Skill[] }).skills.map((s) => [s.id, s.scope])).toEqual([["lint", "global"]]);
    expect(existsSync(join(fixture.root, ".agents", "skills", "pdf"))).toBe(false);
    expect(existsSync(join(fixture.root, ".agents", "skills"))).toBe(true);
  });

  test("a failed install answers 422 and bad input 400", async () => {
    const { call } = await setup();
    const failed = await call("/v1/skills", {
      method: "POST",
      body: JSON.stringify({ source: "acme/skills", skillId: "broken", scope: "project" }),
    });
    expect(failed.status).toBe(422);
    expect(((await failed.json()) as { error: { message: string } }).error.message).toContain("SKILL.md");
    const bad = await call("/v1/skills", {
      method: "POST",
      body: JSON.stringify({ source: "--evil", skillId: "pdf", scope: "project" }),
    });
    expect(bad.status).toBe(400);
  });

  test("a SKILL.md lying directly in a skills folder is not removed with the folder", async () => {
    const { call, fixture } = await setup();
    mkdirSync(join(fixture.root, ".claude", "skills"), { recursive: true });
    writeFileSync(join(fixture.root, ".claude", "skills", "SKILL.md"), "Loose");
    const response = await call("/v1/skills/project/skills", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(existsSync(join(fixture.root, ".claude", "skills", "SKILL.md"))).toBe(true);
  });
});

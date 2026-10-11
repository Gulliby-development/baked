import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { RoutingOverview } from "../src/core/workflows/routing-edit.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = workflowFixture();
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-routing-"));
  const homeDir = mkdtempSync(join(tmpdir(), "baked-api-routing-home-"));
  const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, homeDir, log: () => {} });
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
  const patch = (body: unknown) => call("/v1/workflow/routing", { method: "PATCH", body: JSON.stringify(body) });
  const get = async (query = "") => (await (await call(`/v1/workflow/routing${query}`)).json()) as RoutingOverview;
  const readFile = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return { fixture, configDir, call, patch, get, readFile };
}

describe("local API model routing", () => {
  test("health lists routing, and the overview lists every editable route", async () => {
    const { call, get } = await setup();
    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("routing");
    const view = await get("?model=fixture/model");
    expect(view.workflows).toContain("sdd");
    expect(view.workflowId).toBe("sdd");
    expect(view.runModel).toBe("fixture/model");
    expect(view.classes.map((row) => row.label).slice(0, 4)).toEqual(["$active", "$fast", "$coding", "$review"]);
    expect(view.classes[0]?.resolved?.model).toBe("fixture/model");
    expect(view.roles.map((row) => row.path)).toContain("roles.reviewer");
    expect(view.stages.length).toBeGreaterThan(0);
    expect(view.stages[0]?.target).toEqual({ kind: "stage", workflowId: "sdd", stageId: view.stages[0]?.label ?? "" });
    expect(view.independentReview).toEqual({ global: null, project: null, effective: "off" });
    expect(view.error).toBeNull();
  });

  test("routes are written to the chosen layer and resolve for new runs", async () => {
    const { patch, configDir, fixture, readFile } = await setup();
    const saved = await patch({
      scope: "global",
      model: "fixture/model",
      target: { kind: "class", name: "deep" },
      route: { model: "fixture/deep", effort: "high", fallback: ["fixture/backup"] },
      create: true,
    });
    expect(saved.status).toBe(200);
    expect(readFile(join(configDir, "config.json")).modelRouting).toEqual({
      classes: { deep: { model: "fixture/deep", effort: "high", fallback: ["fixture/backup"] } },
    });

    const role = await patch({
      scope: "project",
      model: "fixture/model",
      target: { kind: "role", role: "reviewer" },
      route: { model: "$deep" },
    });
    expect(role.status).toBe(200);
    const view = (await role.json()) as RoutingOverview;
    const reviewer = view.roles.find((row) => row.path === "roles.reviewer");
    expect(reviewer?.project).toBe("$deep");
    expect(reviewer?.global).toBeNull();
    expect(reviewer?.resolved).toMatchObject({ model: "fixture/deep", effort: "high", fallback: ["fixture/backup"] });
    expect(readFile(join(fixture.root, ".baked", "config.json")).modelRouting).toEqual({ roles: { reviewer: "$deep" } });
    expect(fixture.service.config.modelRouting?.roles?.reviewer).toBe("$deep");

    const stageId = view.stages[0]?.label ?? "";
    const stage = await patch({
      scope: "project",
      target: { kind: "stage", workflowId: "sdd", stageId },
      route: { model: "fixture/stage" },
    });
    expect(stage.status).toBe(200);
    expect(readFile(join(fixture.root, ".baked", "config.json")).modelRouting).toEqual({
      roles: { reviewer: "$deep" },
      workflows: { sdd: { stages: { [stageId]: "fixture/stage" } } },
    });

    const review = await patch({ scope: "project", independentReview: "require" });
    expect(((await review.json()) as RoutingOverview).independentReview.effective).toBe("require");
  });

  test("changes a run start would refuse are not written", async () => {
    const { patch, configDir, readFile } = await setup();
    const refused = async (body: unknown) => {
      const response = await patch(body);
      expect(response.status).toBe(422);
      const answer = (await response.json()) as { error: { code: string }; problems: string[] };
      expect(answer.error.code).toBe("ROUTING_REFUSED");
      return answer.problems;
    };
    expect(await refused({ scope: "global", target: { kind: "role", role: "reviewer" }, route: { model: "$deep" } })).toEqual([
      "roles.reviewer uses $deep, which no class defines",
    ]);
    expect(await refused({ scope: "global", target: { kind: "class", name: "deep" }, route: { model: "$fast" } })).toEqual([
      "A class names a model, not another class",
    ]);
    expect(
      await refused({ scope: "global", target: { kind: "role", role: "planner" }, route: { model: "a/b", fallback: ["$fast", "a/b"] } }),
    ).toEqual(["Fallbacks name models, not classes", "A fallback repeats the primary model"]);
    expect(await refused({ scope: "global", target: { kind: "class", name: "fast" }, route: { model: "a/b" }, create: true })).toEqual([
      "Class $fast already exists; select it to edit",
    ]);

    // Removing a class a role still uses is refused.
    expect((await patch({ scope: "global", target: { kind: "class", name: "deep" }, route: { model: "a/deep" } })).status).toBe(200);
    expect((await patch({ scope: "project", target: { kind: "role", role: "reviewer" }, route: { model: "$deep" } })).status).toBe(200);
    expect(await refused({ scope: "global", target: { kind: "class", name: "deep" }, route: null })).toEqual([
      "roles.reviewer uses $deep, which no class defines",
    ]);
    expect(readFile(join(configDir, "config.json")).modelRouting).toEqual({ classes: { deep: "a/deep" } });
  });

  test("clearing the last route removes the section", async () => {
    const { patch, configDir, readFile } = await setup();
    await patch({ scope: "global", target: { kind: "role", role: "planner" }, route: { model: "a/b" } });
    expect((await patch({ scope: "global", target: { kind: "role", role: "planner" }, route: null })).status).toBe(200);
    expect(readFile(join(configDir, "config.json"))).toEqual({});
    expect((await patch({ scope: "team", independentReview: "warn" })).status).toBe(400);
  });
});

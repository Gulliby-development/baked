import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import type { InstallResult, PackageListEntry, PackagePlan, RemoveResult } from "../src/core/packages/packages.js";
import { readConfirmations } from "../src/core/workflows/v2/library.js";
import { writePackage } from "./helpers/package-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("packages over the local API", () => {
  test("inspects, installs an approved plan, lists and removes", async () => {
    const fixture = workflowFixture();
    const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
    const server = await startApiServer({ service: fixture.service, pollMs: 20, configDir, log: () => {} });
    const dir = writePackage();
    cleanups.push(async () => {
      await server.stop();
      await fixture.dispose();
      await removeTempDir(configDir);
      await removeTempDir(dir);
    });
    const workspace = fixture.service.workspace;
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      });
    const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

    const health = (await (await call("/v1/health")).json()) as { capabilities: string[] };
    expect(health.capabilities).toContain("packages");
    expect(await (await call("/v1/packages")).json()).toEqual({ packages: [] });

    const inspected = await post("/v1/packages/inspect", { path: dir });
    expect(inspected.status).toBe(200);
    const plan = (await inspected.json()) as PackagePlan;
    expect(plan.problems).toEqual([]);
    expect(plan.files.length).toBeGreaterThan(0);
    // Inspecting writes nothing.
    expect(existsSync(join(workspace, "baked", "packages.json"))).toBe(false);

    // The install needs the hash of the plan the person saw.
    expect((await post("/v1/packages/install", { path: dir })).status).toBe(400);
    const wrong = await post("/v1/packages/install", { path: dir, planHash: "0".repeat(64) });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("STALE_PLAN");
    expect(existsSync(join(workspace, "baked", "agents"))).toBe(false);

    const installed = await post("/v1/packages/install", { path: dir, planHash: plan.planHash, commandId: "install-1" });
    expect(installed.status).toBe(201);
    const result = (await installed.json()) as InstallResult;
    expect(result.written.length).toBe(plan.files.length);
    expect(result.gatesToConfirm.length).toBeGreaterThan(0);
    expect(readConfirmations(workspace)).toEqual({});
    // A retry with the same command ID answers the first result.
    const retry = await post("/v1/packages/install", { path: dir, planHash: plan.planHash, commandId: "install-1" });
    expect(((await retry.json()) as InstallResult).written).toEqual(result.written);

    const listed = (await (await call("/v1/packages")).json()) as { packages: PackageListEntry[] };
    expect(listed.packages.map((p) => [p.name, p.version])).toEqual([["acme-review", "1.0.0"]]);

    writeFileSync(join(workspace, "baked", "gates", "lint.json"), "{}\n");
    const removed = await call("/v1/packages/acme-review", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as RemoveResult).kept).toEqual(["baked/gates/lint.json"]);
    expect((await call("/v1/packages/acme-review", { method: "DELETE" })).status).toBe(404);

    expect((await post("/v1/packages/inspect", { path: join(dir, "missing") })).status).toBe(404);
    expect((await post("/v1/packages/inspect", { path: dir, extra: 1 })).status).toBe(400);
    expect((await call("/v1/packages", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("/v1/packages/inspect")).status).toBe(405);
  });
});

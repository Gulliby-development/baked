import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { hashJson } from "../src/core/specs/hash.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeStore } from "../src/core/workflows/initiatives/store.js";
import { unzipFiles } from "../src/core/workflows/sdd-export/zip.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve() {
  const fixture = workflowFixture();
  const server = await startApiServer({ service: fixture.service, pollMs: 20, log: () => {} });
  cleanups.push(fixture.dispose, () => server.stop());
  const request = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...fixture, request };
}

test("the run and initiative package endpoints write, download and refuse like the CLI (#2207)", async () => {
  const { service, root, start, approve, request } = await serve();
  const run = await start();
  await service.drive(run.runId, new AbortController().signal);

  // Nothing accepted yet: 409, and an unknown run 404.
  const early = await request("POST", `/v1/workflow/runs/${run.runId}/package`, {});
  expect(early.status).toBe(409);
  expect(((await early.json()) as { error: { code: string } }).error.code).toBe("NOT_ACCEPTED");
  expect((await request("POST", "/v1/workflow/runs/missing/package", {})).status).toBe(404);

  await approve(run.runId);
  await service.drive(run.runId, new AbortController().signal);
  const written = await request("POST", `/v1/workflow/runs/${run.runId}/package`, {});
  expect(written.status).toBe(200);
  const body = (await written.json()) as { path: string; zip: boolean; files: string[]; manifest: { kind: string } };
  expect(body.zip).toBe(false);
  expect(body.manifest.kind).toBe("run");
  expect(body.path).toBe(join(root, ".baked", "exports", `${run.runId}-export`));
  expect(existsSync(join(body.path, "specs", "fixture", "spec.md"))).toBe(true);
  // The same path again is refused; a path outside the workspace too.
  expect((await request("POST", `/v1/workflow/runs/${run.runId}/package`, {})).status).toBe(409);
  expect((await request("POST", `/v1/workflow/runs/${run.runId}/package`, { out: "../outside" })).status).toBe(400);
  const zipped = (await (await request("POST", `/v1/workflow/runs/${run.runId}/package`, { zip: true, out: "handoff/run.zip" })).json()) as { path: string };
  expect(zipped.path).toBe(join(root, "handoff", "run.zip"));

  // The download is the same tree, written nowhere.
  const download = await request("GET", `/v1/workflow/runs/${run.runId}/package`);
  expect(download.headers.get("content-type")).toBe("application/zip");
  expect(download.headers.get("content-disposition")).toContain(`${run.runId}-export.zip`);
  const files = unzipFiles(new Uint8Array(await download.arrayBuffer()), { maxFiles: 100, maxBytes: 1 << 24 });
  expect(Object.keys(files).sort()).toEqual(body.files);

  const initiatives = new InitiativeStore(service.store);
  const plan: InitiativePlan = {
    schemaVersion: 1,
    title: "Value",
    goals: ["Ship the value"],
    completionCriteria: ["Value is ready"],
    features: [{ id: "fixture", title: "Value", boundary: { scope: "Writes the value", paths: ["value.txt"] }, contract: "value.txt holds ready", dependsOn: [], mandatory: true }],
  };
  initiatives.create({ id: "value-init", title: "Value", prompt: "Make a value", status: "awaiting_approval", settings: { workflowId: "sdd", basePolicy: fixturePolicy, budget: null, featureAutoApproval: null, model: null, ownerLabel: "test" } as never, decomposeRunId: null });
  const revision = initiatives.addRevision("value-init", plan, { maxTotalTokens: 100000, maxAgentCalls: 50, maxActiveMs: 600000 }, hashJson(plan), "decomposer", null);
  expect((await request("POST", "/v1/initiatives/value-init/package", {})).status).toBe(409);
  initiatives.approve("value-init", revision, hashJson(plan));
  initiatives.link("value-init", "fixture", run.runId, revision, hashJson(plan.features[0]), "start");
  const initiative = (await (await request("POST", "/v1/initiatives/value-init/package", { zip: true })).json()) as { path: string; files: string[] };
  expect(initiative.path).toBe(join(root, ".baked", "exports", "value-init-export.zip"));
  expect(initiative.files).toContain("initiative.md");
  // An ID of the other kind is unknown on each path.
  expect((await request("GET", `/v1/initiatives/${run.runId}/package`)).status).toBe(404);
  expect((await request("GET", "/v1/workflow/runs/value-init/package")).status).toBe(404);
});

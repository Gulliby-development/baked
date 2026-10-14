import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { copilotConfigDir } from "../src/core/llm/detected-logins.js";
import { recordProjectOpen } from "../src/core/projects/known.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy, RunSnapshot } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const gateReply = {
  kind: "command",
  id: "api-check",
  description: "The CLI prints 56.",
  command: { executable: "bun", args: ["cli.ts"] },
};

async function setup(policy?: RunPolicy) {
  const fixture = workflowFixture({ policy });
  const configDir = mkdtempSync(join(tmpdir(), "baked-api-config-"));
  const homeDir = mkdtempSync(join(tmpdir(), "baked-api-home-"));
  const server = await startApiServer({
    service: fixture.service,
    pollMs: 20,
    configDir,
    homeDir,
    log: () => {},
    gateDraftModel: async () => JSON.stringify(gateReply),
  });
  cleanups.push(async () => {
    await server.stop();
    await fixture.dispose();
    await removeTempDir(configDir);
    await removeTempDir(homeDir);
  });
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${server.token}`, ...(init.headers as Record<string, string>) },
    });
  const send = (method: string, path: string, body: unknown) =>
    call(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const post = (path: string, body: unknown = {}) => send("POST", path, body);
  const get = async <T>(path: string) => (await (await call(path)).json()) as T;
  return { fixture, configDir, homeDir, server, call, send, post, get };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

const errorCode = async (response: Response) => ((await response.json()) as { error: { code: string } }).error.code;

describe("local API setup and workflow additions", () => {
  test("run maintenance exports, redacts, previews gc and imports a candidate", async () => {
    const { fixture, post, get } = await setup();
    const run = (await (await post("/v1/workflow/runs", { commandId: newId(), feature: "fixture", prompt: "Create ready value" })).json()) as RunSnapshot;
    const waiting = await until(
      () => get<RunSnapshot & { requests: { id: string; kind: string; status: string; digest: string }[] }>(`/v1/workflow/runs/${run.runId}`),
      (s) => s.status === "waiting",
    );
    const request = waiting.requests.find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    const approved = (await (await post(`/v1/workflow/runs/${run.runId}/approve`, {
      commandId: newId(),
      expectedRevision: waiting.revision,
      requestId: request.id,
      digest: request.digest,
    })).json()) as RunSnapshot;
    await post(`/v1/workflow/runs/${run.runId}/resume`, { commandId: newId(), expectedRevision: approved.revision });
    await until(() => get<RunSnapshot>(`/v1/workflow/runs/${run.runId}`), (s) => ["completed", "failed", "blocked"].includes(s.status));

    const exported = await post(`/v1/workflow/runs/${run.runId}/export`);
    expect(exported.status).toBe(200);
    const { path } = (await exported.json()) as { path: string; manifestHash: string };
    expect(path).toContain(join(".baked", "exports", run.runId));
    expect(JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")).snapshot.runId).toBe(run.runId);
    const outside = await post(`/v1/workflow/runs/${run.runId}/export`, { destination: join(tmpdir(), `baked-export-${newId()}`) });
    expect(outside.status).toBe(403);

    const spec = (await get<{ id: string; kind: string }[]>(`/v1/workflow/runs/${run.runId}/artifacts`)).find((a) => a.kind === "spec");
    if (!spec) throw new Error("No spec artifact");
    expect((await post(`/v1/workflow/runs/${run.runId}/redact`, { artifactId: spec.id, reason: " " })).status).toBe(400);
    const redacted = await post(`/v1/workflow/runs/${run.runId}/redact`, { artifactId: spec.id, reason: "Remove a pasted key" });
    expect(await redacted.json()).toEqual({ redacted: true });
    expect(fixture.service.store.latestArtifact(run.runId, `redactions/${spec.id}.json`)).toBeTruthy();

    const preview = await post("/v1/workflow/gc", { before: new Date().toISOString(), dryRun: true });
    expect(await preview.json()).toEqual({ runIds: [], bytes: 0 });
    expect((await post("/v1/workflow/gc", { before: "soon" })).status).toBe(400);

    mkdirSync(join(fixture.root, "specs", "feature"), { recursive: true });
    writeFileSync(join(fixture.root, "specs", "feature", "spec.md"), "# Feature\n\nUsers can export runs.\n");
    const imported = await post("/v1/workflow/import", { source: "spec-kit", path: "specs/feature", featureId: "imported" });
    expect(imported.status).toBe(200);
    const candidate = (await imported.json()) as { candidateHash: string; warnings: string[] };
    expect(candidate.candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(candidate.warnings.join(" ")).toContain("draft");
    expect((await post("/v1/workflow/import", { source: "spec-kit", path: "missing", featureId: "imported" })).status).toBe(400);
    const health = await get<{ capabilities: string[] }>("/v1/health");
    expect(health.capabilities).toContain("run-maintenance");
  });

  test("health lists the setup and initiative capabilities", async () => {
    const { get } = await setup();
    const health = await get<{ capabilities: string[] }>("/v1/health");
    expect(health.capabilities).toEqual(expect.arrayContaining(["setup", "initiatives", "sessions"]));
  });

  test("a completed run reports progress and cross-run usage, and can be forked", async () => {
    const { post, get, call } = await setup();
    const run = (await (await post("/v1/workflow/runs", { commandId: newId(), feature: "fixture", prompt: "Create ready value" })).json()) as RunSnapshot;
    const waiting = await until(
      () => get<RunSnapshot & { requests: { id: string; kind: string; status: string; digest: string }[] }>(`/v1/workflow/runs/${run.runId}`),
      (s) => s.status === "waiting",
    );
    const request = waiting.requests.find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    const approved = (await (await post(`/v1/workflow/runs/${run.runId}/approve`, {
      commandId: newId(),
      expectedRevision: waiting.revision,
      requestId: request.id,
      digest: request.digest,
    })).json()) as RunSnapshot;
    await post(`/v1/workflow/runs/${run.runId}/resume`, { commandId: newId(), expectedRevision: approved.revision });
    const done = await until(() => get<RunSnapshot>(`/v1/workflow/runs/${run.runId}`), (s) => ["completed", "failed", "blocked"].includes(s.status));
    expect(done.status).toBe("completed");

    expect((await call(`/v1/workflow/runs/${run.runId}/progress`)).status).toBe(200);

    const byStage = await get<{ runs: number; attempts: number; totalTokens: number; groups: { key: string; tokens: number; runs: number }[] }>(
      "/v1/usage?days=1&groupBy=stage",
    );
    expect(byStage.runs).toBe(1);
    expect(byStage.attempts).toBeGreaterThan(0);
    expect(byStage.groups.map((g) => g.key)).toContain("plan");
    expect(byStage.groups.reduce((sum, g) => sum + g.tokens, 0)).toBe(byStage.totalTokens);
    const byDay = await get<{ groups: { key: string }[] }>("/v1/usage?groupBy=day");
    expect(byDay.groups.map((g) => g.key)).toEqual([new Date().toISOString().slice(0, 10)]);
    expect((await call("/v1/usage?groupBy=week")).status).toBe(400);
    expect((await call("/v1/usage?groupBy=stage,stage")).status).toBe(400);
    expect((await call("/v1/usage?groupBy=stage,model,day")).status).toBe(400);

    type Group = { key: string; keys: Record<string, string>; tokens: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedTokens: number };
    const pairs = await get<{ tokens: number; costUsd: number; unpricedTokens: number; groups: Group[] }>("/v1/usage?groupBy=stage,model");
    const plan = pairs.groups.find((g) => g.keys.stage === "plan");
    expect(plan?.key).toBe(`plan / ${plan?.keys.model}`);
    expect(pairs.groups.reduce((sum, g) => sum + g.tokens, 0)).toBe(pairs.tokens);
    for (const group of pairs.groups) {
      expect(group.inputTokens + group.outputTokens).toBeGreaterThanOrEqual(0);
      expect(group.costUsd).toBeGreaterThanOrEqual(0);
    }
    const planOnly = await get<{ filters: { stage?: string }; groups: Group[] }>("/v1/usage?stage=plan&groupBy=model");
    expect(planOnly.filters).toEqual({ stage: "plan" });
    expect(planOnly.groups.reduce((sum, g) => sum + g.tokens, 0)).toBe(plan?.tokens ?? -1);
    const host = await get<{ groups: Group[] }>("/v1/usage?model=(host)&groupBy=stage");
    expect(host.groups.every((g) => g.costUsd === 0 && g.unpricedTokens === 0)).toBe(true);
    const shared = await get<{ markdown: string }>("/v1/usage?groupBy=stage,model&format=md");
    expect(shared.markdown).toContain("| Stage | Model |");
    expect(shared.markdown).toContain("| plan |");
    expect((await call("/v1/usage?format=html")).status).toBe(400);
    const runShared = await get<{ markdown: string }>(`/v1/workflow/runs/${run.runId}/usage?format=md`);
    expect(runShared.markdown).toContain(`# BAKED usage of run ${run.runId}`);
    expect((await call(`/v1/workflow/runs/${run.runId}/usage?format=csv`)).status).toBe(400);

    const forked = await post(`/v1/workflow/runs/${run.runId}/fork`, { commandId: newId(), expectedRevision: done.revision });
    expect(forked.status).toBe(200);
    expect(((await forked.json()) as RunSnapshot).runId).not.toBe(run.runId);
  }, 60000);

  test("new run mutations validate their bodies and reach the run", async () => {
    const { post, call } = await setup();
    const run = (await (await post("/v1/workflow/runs", { commandId: newId(), feature: "fixture", prompt: "Create ready value" })).json()) as RunSnapshot;
    expect((await post(`/v1/workflow/runs/${run.runId}/evidence`, { commandId: newId(), expectedRevision: 0, requestId: "r1" })).status).toBe(400);
    const missing = await post(`/v1/workflow/runs/${run.runId}/evidence`, {
      commandId: newId(),
      expectedRevision: 0,
      requestId: "r1",
      evidence: "Watched it",
      accepted: true,
    });
    expect(missing.status).toBe(404);
    expect((await post(`/v1/workflow/runs/${run.runId}/recover`, { commandId: newId(), expectedRevision: 0, requestId: "r", effectId: "e", resolution: "guess", evidence: "x" })).status).toBe(400);
    expect((await post(`/v1/workflow/runs/${run.runId}/continue`, { commandId: newId(), expectedRevision: 0 })).status).toBe(400);
    expect((await post(`/v1/workflow/runs/${run.runId}/deliver/execute`, {})).status).toBe(400);
    expect((await post(`/v1/workflow/runs/${run.runId}/unknown`, {})).status).toBe(404);
    expect((await call(`/v1/workflow/runs/${run.runId}/deliver`)).status).toBe(405);
    // A follow-up adds to the followed run's branch, so a new branch name contradicts it.
    expect((await post(`/v1/workflow/runs/${run.runId}/deliver`, { followUp: "other-run", branch: "x" })).status).toBe(400);
  }, 60000);

  test("gates and routes are listed; confirming needs ids or all", async () => {
    const { get, post } = await setup();
    const gates = await get<{ gates: unknown[]; problems: unknown[] }>("/v1/workflow/gates");
    expect(Array.isArray(gates.gates)).toBe(true);
    expect(Array.isArray(gates.problems)).toBe(true);
    expect((await post("/v1/workflow/gates/confirm", {})).status).toBe(400);
    expect((await post("/v1/workflow/gates/confirm", { ids: ["a"], all: true })).status).toBe(400);
    const route = await get<{ workflowId: string; stages: unknown[] }>("/v1/workflow/route?model=openai/gpt-test");
    expect(route.workflowId).toBe("sdd");
  });

  test("a gate is drafted from a sentence, saved once and shown in words", async () => {
    const { get, post, call } = await setup();
    const drafted = await post("/v1/workflow/gates/draft", { text: "the CLI prints 56" });
    expect(drafted.status).toBe(200);
    const draft = (await drafted.json()) as { gate: { id: string }; problems: string[]; capabilities: string[] };
    expect(draft.gate.id).toBe("api-check");
    expect(draft.problems).toEqual([]);
    expect(draft.capabilities[0]).toContain("Runs bun cli.ts");
    expect((await post("/v1/workflow/gates/draft", {})).status).toBe(400);
    const saved = await post("/v1/workflow/gates", { gate: draft.gate });
    expect(saved.status).toBe(201);
    expect(await saved.json()).toEqual({ id: "api-check", path: "baked/gates/api-check.json", script: null });
    expect((await post("/v1/workflow/gates", { gate: draft.gate })).status).toBe(422);
    const shown = await get<{ id: string; confirmed: boolean; mode: string }>("/v1/workflow/gates/api-check");
    expect(shown).toMatchObject({ id: "api-check", confirmed: true, mode: "required" });
    expect((await call("/v1/workflow/gates/nope")).status).toBe(404);
    expect((await call("/v1/workflow/gates/confirm")).status).toBe(405);
    const places = await get<{ workflowId: string; places: { key: string; disabled: string | null }[] }>(
      "/v1/workflow/gates/api-check/places?workflow=quick-fix",
    );
    expect(places.workflowId).toBe("quick-fix");
    const at = places.places.find((p) => p.disabled === null)?.key;
    expect(at).toBeDefined();
    const bound = await post("/v1/workflow/gates/api-check/bind", { workflow: "quick-fix", at });
    expect(bound.status).toBe(200);
    expect(await bound.json()).toEqual({ workflowId: "quick-fix-custom", path: "baked/workflows/quick-fix-custom.json", copiedFrom: "quick-fix" });
    expect((await post("/v1/workflow/gates/api-check/bind", { at: "nowhere" })).status).toBe(400);
    expect((await call("/v1/workflow/gates/api-check/bind")).status).toBe(405);
  });

  test("without checks a gate is offered only the empty check stage, and the places say why", async () => {
    const { fixture, get, post } = await setup({ ...defaultWorkflowPolicy, checks: [] });
    type Places = { needsChecks: string | null; places: { key: string; disabled: string | null; bound: boolean }[] };
    const human = (await (await post("/v1/workflow/gates/draft", { text: "QA signs off the release", kind: "human" })).json()) as { gate: { id: string } };
    expect((await post("/v1/workflow/gates", { gate: human.gate })).status).toBe(201);
    const forHuman = await get<Places>(`/v1/workflow/gates/${human.gate.id}/places?workflow=sdd`);
    expect(forHuman.needsChecks).toContain("has no checks yet");
    expect(forHuman.needsChecks).not.toContain("or put this gate");
    expect(forHuman.places.filter((p) => p.disabled === null && !p.bound)).toEqual([]);
    expect(forHuman.places.some((p) => p.disabled?.includes("has no checks yet"))).toBe(true);

    const command = (await (await post("/v1/workflow/gates/draft", { text: "the CLI prints 56" })).json()) as { gate: { id: string } };
    expect((await post("/v1/workflow/gates", { gate: command.gate })).status).toBe(201);
    const forCommand = await get<Places>("/v1/workflow/gates/api-check/places?workflow=sdd");
    expect(forCommand.needsChecks).toContain("or put this gate");
    const open = forCommand.places.filter((p) => p.disabled === null && !p.bound).map((p) => p.key);
    expect(open.length).toBe(1);
    expect(open[0]).toStartWith("stage:");
    // Every place offered is one bind accepts: the gate becomes the stage's first check.
    expect((await post("/v1/workflow/gates/api-check/bind", { workflow: "sdd", at: open[0] })).status).toBe(200);
    expect(readFileSync(join(fixture.root, "baked", "workflows", "sdd-custom.json"), "utf8")).toContain("api-check");
    const after = await get<Places>(`/v1/workflow/gates/${human.gate.id}/places?workflow=sdd-custom`);
    expect(after.needsChecks).toBeNull();
    expect(after.places.some((p) => p.disabled === null)).toBe(true);
  });

  test("initiatives are listed, validated and not found by unknown id", async () => {
    const { get, post, call } = await setup();
    expect(await get("/v1/initiatives")).toEqual({ initiatives: [] });
    expect((await post("/v1/initiatives", { commandId: newId(), initiativeId: "big", prompt: "x", budget: { tokens: 1 } })).status).toBe(400);
    expect((await call("/v1/initiatives/missing")).status).toBe(404);
    expect((await post("/v1/initiatives/missing/pause", { commandId: newId(), expectedRevision: 0 })).status).toBe(404);
    expect((await post("/v1/initiatives/missing/explode", {})).status).toBe(404);
    expect((await call("/v1/initiatives/missing/events", { headers: { Accept: "application/json" } })).status).toBe(404);
    expect((await post("/v1/initiatives/missing/reroute", { commandId: newId(), expectedRevision: 0, model: "spare/model" })).status).toBe(404);
  });

  test("an initiative switches to another model over the API", async () => {
    const { post } = await setup();
    const feature = (id: string) => ({
      id,
      title: `Feature ${id}`,
      boundary: { scope: id, paths: [`${id}.txt`] },
      contract: `${id}.txt exists`,
      dependsOn: [],
      mandatory: true,
    });
    const plan = { schemaVersion: 1, title: "Values", goals: ["Values"], completionCriteria: ["Done"], features: ["a", "b", "c"].map(feature) };
    const started = (await (await post("/v1/initiatives", { commandId: newId(), initiativeId: "big", prompt: "Add values", plan })).json()) as {
      revision: number;
      status: string;
    };
    expect(started.status).toBe("awaiting_approval");
    expect((await post("/v1/initiatives/big/reroute", { commandId: newId(), expectedRevision: started.revision })).status).toBe(400);
    const response = await post("/v1/initiatives/big/reroute", { commandId: newId(), expectedRevision: started.revision, model: "spare/model" });
    expect(response.status).toBe(200);
    const view = (await response.json()) as { model: string | null; planRevision: number };
    expect(view.model).toBe("spare/model");
    expect(view.planRevision).toBe(2);
  });

  test("known projects can be pinned, unpinned and forgotten", async () => {
    const { post, configDir } = await setup();
    const folder = mkdtempSync(join(tmpdir(), "baked-api-known-"));
    cleanups.push(() => removeTempDir(folder));
    recordProjectOpen(folder, { configDir });
    type Listed = { projects: { path: string; pinned: boolean }[] };
    const pinned = (await (await post("/v1/projects/pin", { path: folder })).json()) as Listed;
    expect(pinned.projects.find((p) => p.path.endsWith(folder.split("/").at(-1) ?? ""))?.pinned).toBe(true);
    const unpinned = (await (await post("/v1/projects/unpin", { path: folder })).json()) as Listed;
    expect(unpinned.projects.every((p) => !p.pinned)).toBe(true);
    const forgotten = (await (await post("/v1/projects/forget", { path: folder })).json()) as Listed;
    expect(forgotten.projects).toEqual([]);
    expect((await post("/v1/projects/forget", { path: folder })).status).toBe(404);
    expect((await post("/v1/projects/pin", { path: "relative/dir" })).status).toBe(400);
  });

  test("a known project can be renamed and an empty name restores the default", async () => {
    const { get, post, configDir } = await setup();
    const health = await get<{ capabilities: string[] }>("/v1/health");
    expect(health.capabilities).toContain("project-rename");
    const folder = mkdtempSync(join(tmpdir(), "baked-api-rename-"));
    cleanups.push(() => removeTempDir(folder));
    recordProjectOpen(folder, { configDir });
    type Listed = { projects: { path: string; name: string }[] };
    const base = basename(folder);
    const renamed = (await (await post("/v1/projects/rename", { path: folder, name: "  Shop  " })).json()) as Listed;
    expect(renamed.projects.find((p) => p.path.endsWith(base))?.name).toBe("Shop");
    const restored = (await (await post("/v1/projects/rename", { path: folder, name: "" })).json()) as Listed;
    expect(restored.projects.find((p) => p.path.endsWith(base))?.name).toBe(base);
    expect((await post("/v1/projects/rename", { path: folder })).status).toBe(400);
    expect((await post("/v1/projects/rename", { path: folder, name: "x".repeat(121) })).status).toBe(400);
    expect((await post("/v1/projects/rename", { path: "relative/dir", name: "a" })).status).toBe(400);
    const unknown = mkdtempSync(join(tmpdir(), "baked-api-unknown-"));
    cleanups.push(() => removeTempDir(unknown));
    expect((await post("/v1/projects/rename", { path: unknown, name: "a" })).status).toBe(404);
  });

  test("instruction files are read and written only with the hash that was read", async () => {
    const { get, send, fixture } = await setup();
    writeFileSync(join(fixture.root, "baked.md"), "# Rules\nUse Bun.\n");
    type File = { path: string; scope: string; hash: string; content: string; bytes: number };
    const listed = await get<{ files: File[] }>("/v1/projects/current/instructions");
    const file = listed.files.find((f) => f.path === "baked.md" && f.scope === "project");
    expect(file).toMatchObject({ content: "# Rules\nUse Bun.\n", bytes: 17 });
    if (!file) throw new Error("No instruction file");
    const written = await send("PUT", "/v1/projects/current/instructions", { path: "baked.md", content: "# Rules\nUse Bun 1.4.\n", expectedHash: file.hash });
    expect(written.status).toBe(200);
    expect(readFileSync(join(fixture.root, "baked.md"), "utf8")).toBe("# Rules\nUse Bun 1.4.\n");
    const stale = await send("PUT", "/v1/projects/current/instructions", { path: "baked.md", content: "x", expectedHash: file.hash });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("INPUT_CHANGED");
    const other = await send("PUT", "/v1/projects/current/instructions", { path: "src/index.ts", content: "x", expectedHash: file.hash });
    expect(other.status).toBe(404);
  });

  test("instruction sources switch on and off, and a new file can be created", async () => {
    const { get, send, fixture } = await setup();
    writeFileSync(join(fixture.root, "CLAUDE.md"), "Claude rules\n");
    type File = { path: string; enabled: boolean; order: number | null; hash: string; sourceLabel: string };
    type Source = { id: string; enabled: boolean };
    type List = { files: File[]; sources: Source[]; sourcesScope: string; promptBytes: number };
    const before = await get<List>("/v1/projects/current/instructions");
    expect(before.files.find((f) => f.path === "CLAUDE.md")).toMatchObject({ enabled: false, order: null, sourceLabel: "CLAUDE.md" });
    expect(before.sources.find((s) => s.id === "claude")?.enabled).toBe(false);
    expect(before.sourcesScope).toBe("project");

    const on = (await (await send("PUT", "/v1/projects/current/instructions/sources", { source: "claude", enabled: true })).json()) as List;
    expect(on.files.find((f) => f.path === "CLAUDE.md")?.enabled).toBe(true);
    expect(on.sources.find((s) => s.id === "claude")?.enabled).toBe(true);
    expect(on.promptBytes).toBeGreaterThan(before.promptBytes);
    const saved = JSON.parse(readFileSync(join(fixture.root, ".baked", "config.json"), "utf8")) as { instructionFiles: string[] };
    expect(saved.instructionFiles).toContain("claude");
    expect((await send("PUT", "/v1/projects/current/instructions/sources", { source: "nope", enabled: true })).status).toBe(404);

    const created = await send("PUT", "/v1/projects/current/instructions", { path: "AGENTS.md", content: "# Agents\n", expectedHash: null });
    expect(created.status).toBe(200);
    expect((await created.json()) as File).toMatchObject({ path: "AGENTS.md", enabled: false, affectedRuns: [] });
    const again = await send("PUT", "/v1/projects/current/instructions", { path: "AGENTS.md", content: "x", expectedHash: null });
    expect(await errorCode(again)).toBe("INPUT_CHANGED");
    const unknown = await send("PUT", "/v1/projects/current/instructions", { path: "notes.md", content: "x", expectedHash: null });
    expect(unknown.status).toBe(404);
  });

  test("the agent context preview renders the instructions agents read", async () => {
    const { get, send, fixture } = await setup();
    writeFileSync(join(fixture.root, "baked.md"), "# Rules\nUse Bun.\n");
    type Preview = { instructions: { text: string; bytes: number }; workingSet: { text: string; bytes: number } | null; bytes: number };
    const preview = await get<Preview>("/v1/projects/current/context");
    expect(preview.instructions.text).toContain("Use Bun.");
    expect(preview.instructions.bytes).toBe(Buffer.byteLength(preview.instructions.text));
    expect(preview.bytes).toBe(preview.instructions.bytes + (preview.workingSet?.bytes ?? 0));
    const list = await get<{ promptBytes: number }>("/v1/projects/current/instructions");
    expect(preview.instructions.bytes).toBe(list.promptBytes);
    expect((await send("PUT", "/v1/projects/current/context", {})).status).toBe(405);
  });

  test("config changes are written to the chosen file and reach the running server", async () => {
    const { get, send, configDir, fixture } = await setup();
    type Config = { global: Record<string, unknown>; project: Record<string, unknown>; effective: Record<string, unknown>; paths: { global: string; project: string } };
    const before = await get<Config>("/v1/config");
    expect(before.paths.global).toBe(join(configDir, "config.json"));
    expect(before.project).toEqual({});

    const global = await send("PATCH", "/v1/config", { scope: "global", set: { defaultModel: "openai/gpt-test", webSearch: false } });
    expect(global.status).toBe(200);
    expect(JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"))).toEqual({ defaultModel: "openai/gpt-test", webSearch: false });

    const project = (await (await send("PATCH", "/v1/config", { scope: "project", set: { defaultModel: "anthropic/claude-test" } })).json()) as Config;
    expect(project.project).toEqual({ defaultModel: "anthropic/claude-test" });
    expect(project.effective.defaultModel).toBe("anthropic/claude-test");
    expect(fixture.service.config.defaultModel).toBe("anthropic/claude-test");

    const removed = (await (await send("PATCH", "/v1/config", { scope: "project", remove: ["defaultModel"] })).json()) as Config;
    expect(removed.effective.defaultModel).toBe("openai/gpt-test");
    expect((await send("PATCH", "/v1/config", { scope: "project" })).status).toBe(400);
    expect((await send("PATCH", "/v1/config", { scope: "team", set: { a: 1 } })).status).toBe(400);
  });

  test("providers are listed; keys are refused for unknown providers", async () => {
    const { get, send, call } = await setup();
    const { providers } = await get<{ providers: { id: string; configured: boolean; acceptsKey: boolean }[] }>("/v1/providers");
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.some((p) => p.acceptsKey)).toBe(true);
    expect((await send("PUT", "/v1/providers/nope/key", { key: "x" })).status).toBe(404);
    expect((await call("/v1/providers/openai/key")).status).toBe(405);
  });

  test("a Copilot IDE login is reported as a detected source", async () => {
    const { get } = await setup();
    const dir = copilotConfigDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "apps.json"), JSON.stringify({ "github.com:app": { oauth_token: "gho_ide" } }));
    try {
      type Row = { id: string; configured: boolean; source: string | null; detectedFrom?: string };
      const { providers } = await get<{ providers: Row[] }>("/v1/providers");
      expect(providers.find((p) => p.id === "copilot")).toMatchObject({
        configured: true,
        source: "detected",
        detectedFrom: "Copilot IDE login",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checks are listed, saved to the project, suggested and run on demand", async () => {
    const { get, send, post, fixture } = await setup();
    type Check = { id: string; executable: string; lastResult?: { status: string; checkId: string; at: number } };
    const listed = await get<{ checks: Check[]; workflowsEnabled: boolean }>("/v1/workflow/checks");
    expect(listed.checks.map((c) => c.id)).toEqual(["check"]);
    expect(listed.workflowsEnabled).toBe(true);

    const run = await post("/v1/workflow/checks/check/run");
    expect(run.status).toBe(200);
    expect(await run.json()).toMatchObject({ checkId: "check", status: "failed", exitCode: 1 });
    writeFileSync(join(fixture.root, "value.txt"), "ready");
    expect(await (await post("/v1/workflow/checks/check/run")).json()).toMatchObject({ status: "passed" });
    const after = await get<{ checks: Check[] }>("/v1/workflow/checks");
    expect(after.checks[0]?.lastResult).toMatchObject({ checkId: "check", status: "passed" });
    expect((await post("/v1/workflow/checks/missing/run")).status).toBe(404);
    expect((await post("/v1/workflow/checks/check/run", { extra: 1 })).status).toBe(400);

    writeFileSync(join(fixture.root, "package.json"), JSON.stringify({ scripts: { test: "bun test", lint: "biome check" } }));
    const { suggestions } = await get<{ suggestions: { check: { id: string }; source: string; preselected: boolean }[] }>(
      "/v1/workflow/checks/suggestions",
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((suggestion) => suggestion.source.length > 0)).toBe(true);

    const second = { id: "typecheck", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
    const saved = await send("PUT", "/v1/workflow/checks", { checks: [...listed.checks.map(({ lastResult: _, ...c }) => c), second] });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { checks: Check[] }).checks.map((c) => c.id)).toEqual(["check", "typecheck"]);
    const stored = JSON.parse(readFileSync(join(fixture.root, ".baked", "config.json"), "utf8")) as { workflows: { policy: { checks: Check[] } } };
    expect(stored.workflows.policy.checks.map((c) => c.id)).toEqual(["check", "typecheck"]);
    expect(fixture.service.config.workflows?.policy.checks.map((c) => c.id)).toEqual(["check", "typecheck"]);
    expect((await send("PUT", "/v1/workflow/checks", { checks: [second, second] })).status).toBe(400);
    expect((await send("PUT", "/v1/workflow/checks", { checks: [{ id: "x" }] })).status).toBe(400);
  }, 60000);

  test("a check saved in a project without a workflows block is a gate at once", async () => {
    const { get, send, fixture } = await setup();
    rmSync(join(fixture.root, ".baked", "config.json"), { force: true });
    fixture.service.config.workflows = undefined;
    const check = { id: "version", executable: "bun", args: ["--version"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
    expect((await send("PUT", "/v1/workflow/checks", { checks: [check] })).status).toBe(200);
    expect(fixture.service.config.workflows?.policy.checks.map((c) => c.id)).toEqual(["version"]);
    const { gates } = await get<{ gates: { id: string; source: string }[] }>("/v1/workflow/gates");
    expect(gates).toContainEqual(expect.objectContaining({ id: "version", source: "policy" }));
  });

  test("custom commands and installed skills are listed from the project and the home folder", async () => {
    const { get, fixture, homeDir } = await setup();
    mkdirSync(join(fixture.root, ".baked", "commands"), { recursive: true });
    writeFileSync(join(fixture.root, ".baked", "commands", "fix-ci.md"), "---\ndescription: Fix the CI\n---\nFix it.");
    mkdirSync(join(homeDir, ".baked", "commands"), { recursive: true });
    writeFileSync(join(homeDir, ".baked", "commands", "standup.md"), "Write a standup.");
    mkdirSync(join(fixture.root, ".claude", "skills", "review"), { recursive: true });
    writeFileSync(join(fixture.root, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: \"Review a diff\"\n---\nSteps");
    mkdirSync(join(homeDir, ".baked", "skills", "notes"), { recursive: true });
    writeFileSync(join(homeDir, ".baked", "skills", "notes", "SKILL.md"), "No front matter");

    const { commands } = await get<{ commands: { name: string; scope: string; description: string }[] }>("/v1/commands");
    expect(commands.map((c) => [c.name, c.scope])).toEqual([
      ["/fix-ci", "project"],
      ["/standup", "global"],
    ]);
    expect(commands[0]?.description).toBe("Fix the CI");
    const { skills } = await get<{ skills: { id: string; scope: string; description?: string }[] }>("/v1/skills");
    expect(skills).toEqual([
      expect.objectContaining({ id: "notes", scope: "global" }),
      expect.objectContaining({ id: "review", scope: "project", description: "Review a diff" }),
    ]);
    expect(skills[0]?.description).toBeUndefined();
  });

  // #1106: skills a package put in baked/skills show with the package that installed them.
  test("skills installed by a package are listed with their package and cannot be removed alone", async () => {
    const { get, call, fixture } = await setup();
    mkdirSync(join(fixture.root, "baked", "skills", "review-notes"), { recursive: true });
    writeFileSync(
      join(fixture.root, "baked", "skills", "review-notes", "SKILL.md"),
      "---\nname: review-notes\ndescription: The review checklist\n---\nCheck the diff.",
    );
    const files = ["baked/skills/review-notes/SKILL.md", "baked/skills/gone/SKILL.md"].map((path) => ({ path, sha256: "a".repeat(64) }));
    writeFileSync(
      join(fixture.root, "baked", "packages.json"),
      JSON.stringify({ schemaVersion: 1, packages: [{ name: "acme-review", version: "1.0.0", installedAt: "2026-10-14T00:00:00Z", files }] }),
    );
    const { skills } = await get<{ skills: { id: string; scope: string; package?: string; description?: string }[] }>("/v1/skills");
    expect(skills).toEqual([
      expect.objectContaining({ id: "review-notes", scope: "package", package: "acme-review", description: "The review checklist" }),
    ]);
    const item = await get<{ content: string; package: string }>("/v1/skills/package/review-notes");
    expect(item).toMatchObject({ package: "acme-review", content: expect.stringContaining("Check the diff.") });
    const removed = await call("/v1/skills/package/review-notes", { method: "DELETE" });
    expect(removed.status).toBe(409);
    expect(((await removed.json()) as { error: { message: string } }).error.message).toContain("remove the package");
    expect((await call("/v1/skills/package/gone")).status).toBe(404);
  });

  // #1102: Settings > Global commands creates, edits and removes commands in ~/.baked/commands.
  test("global commands are created, edited, renamed and removed in the home folder", async () => {
    const { get, send, post, call, homeDir } = await setup();
    const dir = join(homeDir, ".baked", "commands");
    const created = await post("/v1/commands", {
      scope: "global",
      name: "frontend:component",
      description: "Add a component",
      argumentHint: "<name>",
      body: "Create the component $1.",
    });
    expect(created.status).toBe(201);
    expect(readFileSync(join(dir, "frontend", "component.md"), "utf8")).toBe(
      "---\ndescription: Add a component\nargument-hint: <name>\n---\nCreate the component $1.\n",
    );
    type Listed = { commands: { name: string; scope: string; description: string; argumentHint?: string }[] };
    expect((await get<Listed>("/v1/commands")).commands).toEqual([
      expect.objectContaining({ name: "/frontend:component", scope: "global", description: "Add a component", argumentHint: "<name>" }),
    ]);
    const draft = await get<{ name: string; description: string; argumentHint: string; body: string }>(
      "/v1/commands/global/frontend:component",
    );
    expect(draft).toMatchObject({ name: "/frontend:component", description: "Add a component", argumentHint: "<name>", body: "Create the component $1." });

    // An empty, invalid or taken name is refused.
    expect((await post("/v1/commands", { scope: "global", name: " ", body: "x" })).status).toBe(400);
    expect((await post("/v1/commands", { scope: "global", name: "Fix CI", body: "x" })).status).toBe(400);
    expect((await post("/v1/commands", { scope: "global", name: "/frontend:component", body: "x" })).status).toBe(409);
    expect((await post("/v1/commands", { scope: "global", name: "empty", body: "  " })).status).toBe(400);

    // A rename moves the file and removes the folder it leaves empty.
    const renamed = await send("PUT", "/v1/commands/global/frontend:component", { name: "component", body: "Create $1." });
    expect(renamed.status).toBe(200);
    expect((await get<Listed>("/v1/commands")).commands.map((c) => [c.name, c.description])).toEqual([["/component", "Create $1."]]);
    expect(readFileSync(join(dir, "component.md"), "utf8")).toBe("Create $1.\n");
    expect(() => readFileSync(join(dir, "frontend", "component.md"))).toThrow();
    await post("/v1/commands", { scope: "global", name: "standup", body: "Write a standup." });
    expect((await send("PUT", "/v1/commands/global/standup", { name: "component", body: "x" })).status).toBe(409);
    expect((await send("PUT", "/v1/commands/global/missing", { name: "missing", body: "x" })).status).toBe(404);

    expect((await call("/v1/commands/global/component", { method: "DELETE" })).status).toBe(200);
    expect((await call("/v1/commands/global/component", { method: "DELETE" })).status).toBe(404);
    expect((await get<Listed>("/v1/commands")).commands.map((c) => c.name)).toEqual(["/standup"]);
    expect((await get<{ capabilities: string[] }>("/v1/health")).capabilities).toContain("commands-edit");
  });

  test("a waiting run adopts changed instructions through a candidate and a revision", async () => {
    const { post, get, send, fixture } = await setup();
    writeFileSync(join(fixture.root, "baked.md"), "# Rules\n");
    const run = (await (await post("/v1/workflow/runs", { commandId: newId(), feature: "fixture", prompt: "Create ready value" })).json()) as RunSnapshot;
    const waiting = await until(() => get<RunSnapshot>(`/v1/workflow/runs/${run.runId}`), (s) => s.status === "waiting");

    type File = { path: string; scope: string; hash: string };
    const file = (await get<{ files: File[] }>("/v1/projects/current/instructions")).files.find((f) => f.path === "baked.md");
    if (!file) throw new Error("No instruction file");
    const written = (await (
      await send("PUT", "/v1/projects/current/instructions", { path: "baked.md", content: "# Rules\nUse Bun.\n", expectedHash: file.hash })
    ).json()) as { affectedRuns: string[] };
    expect(written.affectedRuns).toEqual([run.runId]);

    const candidate = await post(`/v1/workflow/runs/${run.runId}/candidate`, { commandId: newId() });
    expect(candidate.status).toBe(200);
    const { candidateHash } = (await candidate.json()) as { candidateHash: string };
    expect(candidateHash).toMatch(/^[0-9a-f]{64}$/);
    const revised = await post(`/v1/workflow/runs/${run.runId}/revise`, {
      commandId: newId(),
      expectedRevision: waiting.revision,
      candidate: candidateHash,
    });
    expect(revised.status).toBe(200);
    expect((await post(`/v1/workflow/runs/${run.runId}/revise`, { commandId: newId(), expectedRevision: 0, candidate: "nope" })).status).toBe(400);
    expect((await post(`/v1/workflow/runs/${run.runId}/candidate`, { commandId: newId(), workflow: "x" })).status).toBe(400);
  }, 60000);
});

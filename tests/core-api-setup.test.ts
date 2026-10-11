import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startApiServer } from "../src/core/api/server.js";
import { recordProjectOpen } from "../src/core/projects/known.js";
import type { RunSnapshot } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
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

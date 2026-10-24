import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { FirstByteHistory } from "../src/core/llm/first-byte-history.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { dataDir } from "../src/core/platform/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { awakeClock } from "./helpers/awake-clock.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58, wheeltags (#1880). A fresh workspace has no recorded calls, so its first specify
// calls on Codex waited the 10 minute ceiling each (33 minutes before the first block), while the
// spec calls of the round's other six workspaces answered in 4 to 126 s.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SHARED = () => join(dataDir(), "first-byte-history.json");
const answer = (stage: string, firstByteMs: number) => ({ provider: "codex", stage, firstByteMs, durationMs: firstByteMs });

/** A Codex model whose call never answers, as the stalled specify calls of R58. */
const silent: LanguageModelV2 = {
  specificationVersion: "v2",
  provider: "codex",
  modelId: "gpt-test",
  supportedUrls: {},
  doGenerate: () => new Promise(() => {}),
  doStream: (options) =>
    new Promise((_, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
    }),
};

async function firstSpecCall(policy: RunPolicy) {
  const adapter = getProvider("codex");
  if (!adapter) throw new Error("Codex provider missing");
  const original = adapter.createModel;
  adapter.createModel = () => silent;
  cleanups.push(() => {
    adapter.createModel = original;
  });
  let specified = false;
  const fixture = workflowFixture({
    policy,
    executor: (root) =>
      new (class SilentSpecExecutor extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output !== "spec" || specified) return super.execute(request);
          specified = true;
          const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
            ...fixture.config,
            repoMap: false,
          });
          try {
            return await native.execute({ ...request, profile: { ...request.profile, model: "codex/gpt-test" } });
          } finally {
            native.dispose();
          }
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  const clock = awakeClock();
  try {
    const run = await fixture.start();
    let finished = false;
    const driving = fixture.service.drive(run.runId, new AbortController().signal).finally(() => {
      finished = true;
    });
    for (let ticks = 0; ticks < 3_600 && !finished; ticks++) {
      clock.advance(1000);
      await Bun.sleep(1);
    }
    await driving;
    return firstCall(fixture, run.runId);
  } finally {
    clock.restore();
  }
}

function firstCall(fixture: ReturnType<typeof workflowFixture>, runId: string) {
  const run = { runId };
  const store = fixture.service.store;
  const failed = store
    .attempts(run.runId)
    .filter((a) => a.model_id !== null && store.rootStage(run.runId, a.step_id) === "specify")
    .sort((a, b) => a.started_at - b.started_at)[0];
  const usage = store.latestArtifact(run.runId, `attempts/${failed?.id}/usage.json`);
  return (JSON.parse(store.readArtifact(run.runId, usage?.id ?? "")) as { calls: { limitMs?: number; durationMs: number; effort?: string }[] }).calls[0];
}

describe("scenario: a fresh workspace's first specify call (#1880)", () => {
  test("with the shared history on, the deadline comes from other workspaces' spec answers", async () => {
    rmSync(SHARED(), { force: true });
    const off = await firstSpecCall(fixturePolicy);
    // No answers anywhere: the 10 minute ceiling, and nothing written to the shared file.
    expect(off?.limitMs).toBeUndefined();
    expect(off?.durationMs).toBeGreaterThanOrEqual(600_000);
    expect(() => readFileSync(SHARED())).toThrow();

    const key = `codex/gpt-test|spec|${off?.effort ?? ""}`;
    writeFileSync(SHARED(), JSON.stringify({ schemaVersion: 1, shapes: { [key]: [66_000, 90_000, 126_000] } }));
    const on = await firstSpecCall({ ...fixturePolicy, sharedFirstByteHistory: "on" });
    // Twice the 95th percentile of 66, 90 and 126 s.
    expect(on?.limitMs).toBe(252_000);
    expect(on?.durationMs).toBeLessThan(300_000);
  }, 60_000);
});

describe("shared first-response history", () => {
  test("completes a shape the workspace has too few answers for, and keeps the workspace's own first", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-first-byte-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "first-byte-history.json");
    const machine = new FirstByteHistory(file);
    for (const ms of [60_000, 70_000, 80_000]) machine.record("codex/m", answer("spec", ms), true);
    // A call without an answer, and a call with sharing off, are not shared.
    machine.record("codex/m", { ...answer("spec", 0), firstByteMs: null }, true);
    machine.record("codex/m", answer("plan", 5_000));

    const fresh = new FirstByteHistory(file);
    expect(fresh.healthy("codex/m", "spec").map((sample) => sample.ms)).toEqual([]);
    expect(fresh.healthy("codex/m", "spec", undefined, true).map((sample) => sample.ms)).toEqual([60_000, 70_000, 80_000]);
    expect(fresh.healthy("codex/m", "plan", undefined, true).map((sample) => sample.ms)).toEqual([]);
    fresh.record("codex/m", answer("spec", 20_000));
    expect(fresh.healthy("codex/m", "spec", undefined, true).map((sample) => sample.ms)).toEqual([60_000, 70_000, 80_000, 20_000]);
    for (const ms of [21_000, 22_000]) fresh.record("codex/m", answer("spec", ms));
    // Three answers of its own: the workspace's deadline is its own again.
    expect(fresh.healthy("codex/m", "spec", undefined, true).map((sample) => sample.ms)).toEqual([20_000, 21_000, 22_000]);
    // A second process's answers are kept when the first writes again.
    new FirstByteHistory(file).record("codex/m", answer("spec", 90_000), true);
    machine.record("codex/m", answer("spec", 95_000), true);
    expect(new FirstByteHistory(file).healthy("codex/m", "spec", undefined, true).map((sample) => sample.ms)).toEqual([60_000, 70_000, 80_000, 90_000, 95_000]);
  });

  test("an unreadable shared file is no history", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-first-byte-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "first-byte-history.json");
    writeFileSync(file, "{not json");
    expect(new FirstByteHistory(file).healthy("codex/m", "spec", undefined, true).map((sample) => sample.ms)).toEqual([]);
  });
});

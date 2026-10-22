import { afterEach, describe, expect, test } from "bun:test";
import { ROUTING_ARTIFACT, type RoutingRecord } from "../src/core/llm/model-routing.js";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import { buildCodexNativeRequest } from "../src/core/llm/providers/codex/native.js";
import { canonical } from "../src/core/specs/hash.js";
import { withCodexRecovery } from "../src/core/workflows/agent-executor.js";
import { providerCircuitOpen } from "../src/core/workflows/retry.js";
import { isStall, nextRung } from "../src/core/workflows/stall-ladder.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 58 (wheeltags base, #1877): a specify call on Codex native stalled on its follow-up
// call in 10 attempts over 97 minutes, with 3 resumes and a reroute to another Codex model, while
// `codex exec` finished the same stage in one 126 s call. The host had one reaction to a stall:
// the same call on the same transport, until the circuit stopped the run for a person.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const stall = (model: string) =>
  new ProviderUnreachableError(model, "No model response within 190 seconds");

interface Seen {
  model: string;
  freshSession: boolean;
  transport: string | null;
  effort: string | null;
}

/** A run whose implementation calls go to `fail` first; its route is Codex, then Claude Code. */
async function ladderRun(fail: (request: ExecutionRequest, seen: Seen[]) => Error | null) {
  const seen: Seen[] = [];
  const fixture = workflowFixture({
    executor: (root) =>
      new (class extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output === "implementation") {
            seen.push({
              model: request.profile.model,
              freshSession: request.freshSession === true,
              transport: request.transport ?? null,
              effort: request.effort ?? null,
            });
            const error = fail(request, seen);
            if (error) throw error;
          }
          return super.execute(request);
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  fixture.service.providerProbe = async () => ({});
  fixture.service.providerDelay = async () => {};
  const run = await fixture.start();
  const { store } = fixture.service;
  const artifact = store.latestArtifact(run.runId, ROUTING_ARTIFACT);
  if (!artifact) throw new Error("Routing record missing");
  const routing = JSON.parse(store.readArtifact(run.runId, artifact.id)) as RoutingRecord;
  routing.stages.implement = {
    model: "codex/gpt-6-astra",
    effort: "medium",
    fallback: ["codex/gpt-6.1-sol", "claude-code/claude-opus-4-7"],
    source: "scenario",
  };
  store.artifact(run.runId, "routing", ROUTING_ARTIFACT, canonical(routing));
  const signal = new AbortController().signal;
  await fixture.service.drive(run.runId, signal);
  await fixture.approve(run.runId);
  const snapshot = await fixture.service.drive(run.runId, signal);
  const recoveries = () =>
    store
      .events(run.runId, 0, 10_000)
      .flatMap((event) => (event.type === "attempt.recovery" ? [event.payload] : []));
  return { fixture, run, snapshot, seen, recoveries, signal };
}

describe("scenario: wheeltags R58, a stalled call walks the recovery ladder (#1877)", () => {
  test("a call that stalls only on the native transport completes on the exec rung without a person", async () => {
    const { snapshot, seen, recoveries } = await ladderRun((request) =>
      request.transport === "exec" ? null : stall(request.profile.model),
    );
    expect(snapshot).toMatchObject({ status: "completed", reason: "none" });
    expect(seen.slice(0, 3)).toEqual([
      { model: "codex/gpt-6-astra", freshSession: false, transport: null, effort: "medium" },
      { model: "codex/gpt-6-astra", freshSession: true, transport: null, effort: "medium" },
      { model: "codex/gpt-6-astra", freshSession: true, transport: "exec", effort: "medium" },
    ]);
    expect(recoveries().map((r) => r.rung)).toEqual(["fresh-session", "other-transport"]);
    expect(recoveries()[1]).toMatchObject({ modelId: "codex/gpt-6-astra", transport: "exec" });
  }, 30_000);

  test("a call that stalls on every rung stops once with the rungs it tried, and a resume starts a new ladder", async () => {
    let stalling = true;
    const { fixture, run, snapshot, seen, recoveries, signal } = await ladderRun((request) =>
      stalling ? stall(request.profile.model) : null,
    );
    expect(snapshot).toMatchObject({ status: "blocked", reason: "no_progress" });
    expect(recoveries().map((r) => r.rung)).toEqual([
      "fresh-session",
      "other-transport",
      "lower-effort",
      "next-model",
    ]);
    // The next model prefers another provider: a second Codex model stalled the same way in R58.
    expect(seen.map((s) => s.model)).toEqual([
      ...Array(4).fill("codex/gpt-6-astra"),
      "claude-code/claude-opus-4-7",
    ]);
    expect(seen[3]).toMatchObject({ transport: "exec", effort: "low" });
    expect(seen[4]).toMatchObject({ transport: null, freshSession: false, effort: "medium" });
    const { store } = fixture.service;
    expect(providerCircuitOpen(store, run.runId)).toBe(true);
    const advice = store
      .artifacts(run.runId)
      .filter((a) => a.kind === "diagnostic")
      .map((a) => store.readArtifact(run.runId, a.id))
      .join("\n");
    expect(advice).toContain("recovery ladder");
    expect(advice).toContain("codex exec transport on codex/gpt-6-astra");
    expect(advice).toContain("next model of the route on claude-code/claude-opus-4-7");
    // Without the ladder each stall was a provider wait, and the third opened the circuit.
    expect(advice).not.toContain("returned no tokens");

    stalling = false;
    await fixture.resume(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(done).toMatchObject({ status: "completed", reason: "none" });
    expect(seen[5]).toEqual({
      model: "codex/gpt-6-astra",
      freshSession: false,
      transport: null,
      effort: "medium",
    });
  }, 30_000);

  test("a driver that stops mid-ladder continues on its rung, not from the first", async () => {
    const { snapshot, seen, recoveries } = await ladderRun((request, calls) => {
      if (calls.length === 1) return stall(request.profile.model);
      // The fresh-session attempt loses the connection: the run waits for the provider, then
      // resumes in a new call of the stage.
      if (calls.length === 2) return new ProviderUnreachableError(request.profile.model, "ECONNREFUSED");
      return request.transport === "exec" ? null : stall(request.profile.model);
    });
    expect(snapshot).toMatchObject({ status: "completed", reason: "none" });
    expect(seen.slice(0, 4).map((s) => [s.freshSession, s.transport])).toEqual([
      [false, null],
      [true, null],
      [true, null],
      [true, "exec"],
    ]);
    expect(recoveries().map((r) => r.rung)).toEqual(["fresh-session", "other-transport"]);
  }, 30_000);

  test("a route with no rung to try keeps the provider wait", async () => {
    let stalled = false;
    const fixture = workflowFixture({
      executor: (root) =>
        new (class extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output === "implementation" && !stalled) {
              stalled = true;
              throw stall(request.profile.model);
            }
            return super.execute(request);
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    fixture.service.providerProbe = async () => ({});
    fixture.service.providerDelay = async () => {};
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(done).toMatchObject({ status: "completed", reason: "none" });
    const events = fixture.service.store.events(run.runId, 0, 10_000);
    expect(events.some((e) => e.type === "attempt.recovery")).toBe(false);
    expect(events.some((e) => e.type === "run.state_changed" && e.payload.reason === "provider")).toBe(true);
  }, 30_000);
});

describe("recovery ladder rungs", () => {
  const call = {
    model: "codex/a",
    models: ["codex/a", "codex/b", "openai/c"],
    fallbackIndex: 0,
    effort: "high" as const,
  };

  test("each rung keeps what the rungs before it changed", () => {
    const fresh = nextRung(undefined, call);
    expect(fresh).toEqual({ rung: "fresh-session", freshSession: true, effort: "high", fallbackIndex: 0 });
    const exec = nextRung(fresh ?? undefined, call);
    expect(exec).toEqual({ rung: "other-transport", freshSession: true, transport: "exec", effort: "high", fallbackIndex: 0 });
    const lower = nextRung(exec ?? undefined, { ...call, effort: "high" });
    expect(lower).toMatchObject({ rung: "lower-effort", transport: "exec", effort: "medium" });
    expect(nextRung(lower ?? undefined, call)).toEqual({ rung: "next-model", fallbackIndex: 2 });
    expect(nextRung({ rung: "next-model", fallbackIndex: 2 }, call)).toBeNull();
  });

  test("a rung that changes nothing for the call is skipped", () => {
    // Not Codex native: no session or transport to change, no effort to lower, no other model.
    expect(nextRung(undefined, { model: "openai/c", models: ["openai/c"], fallbackIndex: 0, effort: undefined })).toBeNull();
    expect(nextRung(undefined, { model: "openai/c", models: ["openai/c"], fallbackIndex: 0, effort: "low" })).toBeNull();
    expect(nextRung(undefined, { model: "openai/c", models: ["openai/c", "openai/d"], fallbackIndex: 0, effort: undefined })).toEqual({ rung: "next-model", fallbackIndex: 1 });
    const previous = process.env.BAKED_CODEX_TRANSPORT;
    process.env.BAKED_CODEX_TRANSPORT = "exec";
    try {
      expect(nextRung(undefined, { ...call, models: ["codex/a"] })).toMatchObject({ rung: "lower-effort" });
    } finally {
      if (previous === undefined) delete process.env.BAKED_CODEX_TRANSPORT;
      else process.env.BAKED_CODEX_TRANSPORT = previous;
    }
  });

  test("only a call the provider never answered is a stall", () => {
    expect(isStall(stall("codex/a"))).toBe(true);
    expect(isStall(new ProviderUnreachableError("codex/a", "Provider stream ended without a response finish"))).toBe(true);
    expect(isStall(new ProviderUnreachableError("codex/a", "ECONNREFUSED"))).toBe(false);
    expect(isStall(new Error("No model response within 190 seconds"))).toBe(false);
  });

  test("the session and transport rungs reach the Codex adapter as provider options", () => {
    const options = withCodexRecovery({ codex: { effort: "low" } }, { freshSession: true, transport: "exec" });
    expect(options).toEqual({ codex: { effort: "low", freshThread: true, transport: "exec" } });
    const request = buildCodexNativeRequest("gpt-6-astra", {
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      providerOptions: options,
    } as never);
    expect(request.freshThread).toBe(true);
    expect(buildCodexNativeRequest("gpt-6-astra", { prompt: [] } as never).freshThread).toBeUndefined();
  });
});

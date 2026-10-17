import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import {
  fingerprintRequest,
  type Recording,
  runRecording,
  withModelCalls,
} from "../src/core/workflows/model-recording.js";
import { reasonText } from "../src/core/workflows/reasons.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-recording-"));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

function step(call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: [
      { type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Routes `openai/*` to a scripted model and counts the calls that reach it. */
function scriptModel(script: LanguageModelV3GenerateResult[]): { calls: number } {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { calls: 0 };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const next = script[seen.calls++];
      if (!next) throw new Error("the provider was called past its script");
      return next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

const research = {
  schemaVersion: 1,
  summary: "A fixture workspace",
  facts: [],
  unknowns: [],
  constraints: [],
  suggestedScope: ["value.txt"],
};

/** One research attempt of a fresh run under `policy`, through the native executor. */
async function researchAttempt(policy: RunPolicy, prompt = "Research the fixture") {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === "research");
  if (!researcher) throw new Error("research profile missing");
  const profile: AgentProfile = { ...researcher, model: "openai/fixture-model" };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
  });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId,
    attemptId,
    profile,
    prompt,
    signal: new AbortController().signal,
    maxSteps: 10,
  };
  return { store, runId: run.runId, execute: () => executor.execute(request) };
}

/** Records one research attempt: an unknown tool call, then the submission. */
async function recordAttempt(): Promise<{ path: string; recording: Recording }> {
  scriptModel([step({ name: "no_such_tool", input: {} }), step({ name: "submit_result", input: research })]);
  const recorded = await researchAttempt(withModelCalls(fixturePolicy, { record: true }));
  const response = await recorded.execute();
  expect(response.output).toMatchObject({ summary: "A fixture workspace" });
  const recording = runRecording(recorded.store, recorded.runId);
  const path = join(scratch(), "recording.json");
  writeFileSync(path, JSON.stringify(recording));
  return { path, recording };
}

describe("request fingerprints", () => {
  const request = (text: string) =>
    ({ prompt: [{ role: "user", content: [{ type: "text", text }] }], tools: [] }) as never;

  test("ignore host IDs and times, and change with the text", () => {
    const a = fingerprintRequest(request("evidence 0b7e7a52-9c3e-4f43-9a0e-6f8f1c2d3e4f at 2026-10-13T12:00:00.000Z"));
    const b = fingerprintRequest(request("evidence 5d1c0a4e-1111-4222-8333-944455556666 at 2026-10-14T08:30:12Z"));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(fingerprintRequest(request("other text")).fingerprint).not.toBe(a.fingerprint);
  });
});

describe("record and replay of model calls (#856)", () => {
  test("a recording run stores each model call with its key, attempt and call number", async () => {
    const { recording } = await recordAttempt();
    expect(recording.calls.map((c) => [c.key, c.attempt, c.call])).toEqual([
      ["researcher/run", 0, 0],
      ["researcher/run", 0, 1],
    ]);
    expect(recording.calls[1]?.response.content).toMatchObject([{ type: "tool-call", toolName: "submit_result" }]);
  });

  test("calls stored in the same millisecond keep their order", async () => {
    // Artifacts that tied on `created_at` were listed by their random ID, so a replay's export
    // could list the second call first (seen on macOS CI).
    setSystemTime(new Date("2026-10-17T21:00:00.000Z"));
    cleanups.push(() => {
      setSystemTime();
    });
    for (let i = 0; i < 4; i++) {
      const { recording } = await recordAttempt();
      expect(recording.calls.map((c) => c.call)).toEqual([0, 1]);
    }
  });

  test("a replay answers from the recording without calling the provider, and records again", async () => {
    const { path, recording } = await recordAttempt();
    const provider = scriptModel([]);
    const replayed = await researchAttempt(withModelCalls(fixturePolicy, { replay: path }));
    const response = await replayed.execute();
    expect(provider.calls).toBe(0);
    expect(response.output).toMatchObject({ summary: "A fixture workspace" });
    expect(runRecording(replayed.store, replayed.runId).calls.map((c) => c.fingerprint)).toEqual(
      recording.calls.map((c) => c.fingerprint),
    );
  });

  test("a replay stops at the first request the recording does not have", async () => {
    const { path } = await recordAttempt();
    const provider = scriptModel([]);
    const replayed = await researchAttempt(withModelCalls(fixturePolicy, { replay: path }), "Research another thing");
    const failure = await replayed.execute().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WorkflowFault);
    const fault = failure as WorkflowFault;
    expect(fault.message).toContain("Replay diverged from the recording at researcher/run attempt 0 call 0");
    expect(fault.message).toContain("Research another thing");
    expect(fault.details.reason).toBe("replay_diverged");
    expect(provider.calls).toBe(0);
    expect(reasonText("replay_diverged")).toContain("recording");
  });

  test("the start refuses a missing recording, and a policy without either flag is unchanged", () => {
    expect(() => withModelCalls(fixturePolicy, { replay: join(scratch(), "missing.json") })).toThrow(
      "Cannot read the recording",
    );
    expect(withModelCalls(fixturePolicy, {})).toBe(fixturePolicy);
  });

  test("a run that recorded nothing has no recording to export", async () => {
    const run = await researchAttempt(fixturePolicy);
    expect(() => runRecording(run.store, run.runId)).toThrow("recorded no model calls");
  });
});

import { z } from "zod";
import { afterEach, describe, expect, test } from "bun:test";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import { AttemptStepController, type AttemptUsageRecord } from "../src/core/workflows/step-budget.js";
import { mergeToolBackends, runUsage, toolBackendLine } from "../src/core/workflows/usage.js";
import type { AgentExecutor, ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** One provider step: a tool call (or plain text) with the usage the provider reports. */
function step(input: number, output: number, call?: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: call
      ? [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }]
      : [{ type: "text", text: "thinking" }],
    finishReason: { unified: call ? "tool-calls" : "stop", raw: undefined },
    usage: {
      inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: output, text: output, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Route `openai/*` to a scripted model; every script entry is one step, a function throws. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>): void {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
}

async function nativeAttempt(policy = fixturePolicy, role: "research" | "implementation" = "research", task?: Task) {
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const researcher = profiles.find((p) => p.output === role);
  if (!researcher) throw new Error(`${role} profile missing`);
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
    prompt: "Research the fixture",
    signal: new AbortController().signal,
    maxSteps: 10,
    ...(task ? { task } : {}),
  };
  const usageRecord = (): AttemptUsageRecord | undefined => {
    const row = store.latestArtifact(run.runId, `attempts/${attemptId}/usage.json`);
    return row ? (JSON.parse(store.readArtifact(run.runId, row.id)) as AttemptUsageRecord) : undefined;
  };
  return { fixture, store, run, attemptId, executor, request, usageRecord };
}

describe("attempt usage of a failing native attempt", () => {
  test("a loop that throws after model steps keeps their tokens and writes usage.json", async () => {
    scriptModel([
      step(1000, 100, { name: "unknown_tool", input: {} }),
      step(1500, 200, { name: "unknown_tool", input: {} }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(2800);
    const usage = usageRecord();
    expect(usage?.stopReason).toBe("error");
    expect(usage?.totalTokens).toBe(2800);
    expect(usage?.steps.map((s) => [s.inputTokens, s.outputTokens])).toEqual([
      [1000, 100],
      [1500, 200],
    ]);
  });

  test("a budget refusal between steps keeps the spend of the steps that ran", async () => {
    // The first step fits; after it the cap (the 40,000 left of 50,000) is still above two such
    // steps, but the run limit refuses the next one once another attempt takes 25,000 more.
    const policy = { ...fixturePolicy, maxTotalTokens: 50_000 };
    scriptModel([
      step(12_000, 500, { name: "unknown_tool", input: {} }),
      step(12_000, 500, { name: "unknown_tool", input: {} }),
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    const otherAttempt = store.reserve(run.runId, other, "openai/fixture-model", 10_000, policy);
    const original = store.recordAttemptUsage.bind(store);
    store.recordAttemptUsage = (runId, id, used) => {
      original(runId, id, used);
      if (id === attemptId && used > 0) store.expandReservation(run.runId, otherAttempt, 25_000, policy);
    };
    cleanups.push(() => {
      store.recordAttemptUsage = original;
    });
    await expect(executor.execute(request)).rejects.toThrow("Next model step exceeds remaining token budget");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(12_500);
    expect(usageRecord()).toMatchObject({ stopReason: "error", totalTokens: 12_500 });
    store.transaction(() =>
      store.finishAttempt(run.runId, attemptId, "failed", store.recordedUsage(run.runId, attemptId)),
    );
    expect(store.attempts(run.runId).find((a) => a.id === attemptId)).toMatchObject({ used_tokens: 12_500, usage_complete: 1 });
  });

  test("a sized run at its ceiling blocks before an attempt its budget cannot cover (#747)", async () => {
    // 50,000 left of a 60,000 ceiling, below the default attempt cap: no model step runs.
    const policy = { ...fixturePolicy, maxTotalTokens: 60_000, sizing: { maxRunTokens: 60_000 } };
    scriptModel([step(12_000, 500, { name: "unknown_tool", input: {} })]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 10_000, policy);
    await expect(executor.execute(request)).rejects.toThrow("The next attempt needs more tokens than the run budget has left");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(0);
  });

  test("an attempt that fails before any model step records zero tokens", async () => {
    scriptModel([
      () => {
        throw new Error("connection refused");
      },
    ]);
    const { store, run, attemptId, executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("connection refused");
    expect(store.recordedUsage(run.runId, attemptId)).toBe(0);
    expect(usageRecord()?.steps).toEqual([]);
  });

  test("the attempt cap shrinks to the remaining run budget so the agent finalizes in time", async () => {
    // 30,000 of the 60,000-token run are held by another attempt, below the default attempt cap
    // of 250,000: the attempt starts with the remaining 30,000 instead of being refused.
    const policy = { ...fixturePolicy, maxTotalTokens: 60_000 };
    const result = {
      schemaVersion: 1,
      summary: "Fixture researched",
      facts: [],
      unknowns: [],
      constraints: [],
      suggestedScope: [],
    };
    scriptModel([
      step(10_000, 100, { name: "unknown_tool", input: {} }),
      step(10_200, 100, { name: "submit_result", input: result }),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 30_000, policy);
    await expect(executor.execute(request)).resolves.toMatchObject({ output: result });
    const usage = usageRecord();
    expect(usage?.maxTokens).toBe(30_000);
    // After the first step two more would pass the cap, so the second was the submit-only step.
    expect(usage).toMatchObject({ finalizedBy: "tokens", stopReason: "submitted", totalTokens: 20_400 });
  });
});

describe("an attempt at its token cap", () => {
  test("that ends without submitting stops with the attempt_cap reason and its numbers (#935)", async () => {
    // 70,000 of the 100,000-token run are held elsewhere, so the attempt's cap is the 30,000 left:
    // after the first step comes the finalizing step, which reaches the cap with text instead of
    // a result.
    const policy = { ...fixturePolicy, maxTotalTokens: 100_000 };
    scriptModel([
      step(9_900, 100, { name: "unknown_tool", input: {} }),
      step(19_900, 100),
    ]);
    const { store, run, executor, request, usageRecord } = await nativeAttempt(policy);
    const other = store.beginStep(run.runId, "other");
    store.reserve(run.runId, other, "openai/fixture-model", 70_000, policy);
    const error = await executor.execute(request).then(
      () => null,
      (e: unknown) => e,
    );
    expect(usageRecord()).toMatchObject({ stopReason: "tokens", maxTokens: 30_000, totalTokens: 30_000 });
    expect(error).toMatchObject({
      code: "BUDGET_EXHAUSTED",
      details: { reason: "attempt_cap", cap: 30_000 },
    });
    expect(String(error)).toContain("used 30000 tokens without submitting a result (attempt cap 30000)");
  });
});

describe("attempts whose provider reports no tokens", () => {
  const result = {
    schemaVersion: 1,
    summary: "Fixture researched",
    facts: [],
    unknowns: [],
    constraints: [],
    suggestedScope: [],
  };

  test("a submit step that reports zero tokens leaves the attempt's usage unknown", async () => {
    // Codex reports a response's usage only after its tool call is answered, so an attempt that
    // ends at its only call (the submit) sees zero input and zero output tokens.
    scriptModel([step(0, 0, { name: "submit_result", input: result })]);
    const { executor, request } = await nativeAttempt();
    await expect(executor.execute(request)).resolves.toMatchObject({
      output: result,
      usageComplete: false,
    });
  });

  test("an attempt with reported tokens stays complete", async () => {
    scriptModel([
      step(0, 0, { name: "unknown_tool", input: {} }),
      step(5_000, 100, { name: "submit_result", input: result }),
    ]);
    const { executor, request } = await nativeAttempt();
    const response = await executor.execute(request);
    expect(response).toMatchObject({ inputTokens: 5_000, outputTokens: 100 });
    expect(response.usageComplete).toBeUndefined();
  });
});

describe("repair probes", () => {
  test("each run_probe call is journaled with the attempt", async () => {
    scriptModel([
      step(1000, 50, { name: "run_probe", input: { executable: "bun", args: ["-e", "console.log('probe-ok')"] } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const repair: Task = {
      id: "T900",
      title: "Repair",
      description: "Repair the failing check",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: [{ path: "value.txt", action: "modify" }],
      readHints: [],
      checkIds: ["check"],
      origin: "repair",
      findingIds: [],
      rationale: "check failed",
    };
    const { store, run, attemptId, executor, request } = await nativeAttempt(fixturePolicy, "implementation", repair);
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    const row = store.latestArtifact(run.runId, `attempts/${attemptId}/probe-1.json`);
    expect(row?.kind).toBe("probe");
    const probe = JSON.parse(store.readArtifact(run.runId, row?.id ?? "")) as Record<string, unknown>;
    expect(probe).toMatchObject({ taskId: "T900", executable: "bun", status: "ran", exitCode: 0 });
    expect(String(probe.output)).toContain("probe-ok");
    const tools = store
      .events(run.runId)
      .filter((e) => e.type === "tool.finished")
      .map((e) => e.payload as { tool: string; status: string });
    expect(tools).toContainEqual(expect.objectContaining({ tool: "run_probe", status: "ok" }));
  });
});

describe("host tools", () => {
  // R10: a reviewer's run_repro calls were missing from the journal, so review cost had no owner.
  test("a host tool call is journaled with its attempt and result size", async () => {
    scriptModel([
      step(1000, 50, { name: "run_repro", input: { value: 1 } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt();
    const answer = { status: "reproduced", output: "actual" };
    await expect(
      executor.execute({
        ...request,
        profile: { ...request.profile, allowedTools: [...request.profile.allowedTools, "run_repro"] },
        hostTools: {
          run_repro: {
            description: "Run a repro",
            inputSchema: z.object({ value: z.number() }),
            execute: async () => answer,
          },
        },
      }),
    ).rejects.toThrow("provider unavailable");
    const events = store.events(run.runId).filter((e) => e.type === "tool.started" || e.type === "tool.finished");
    expect(events.map((e) => [e.type, (e.payload as { tool: string }).tool])).toEqual([
      ["tool.started", "run_repro"],
      ["tool.finished", "run_repro"],
    ]);
    expect(events[1]?.payload).toMatchObject({
      attemptId,
      status: "ok",
      resultBytes: Buffer.byteLength(JSON.stringify(answer)),
    });
  });
});

describe("a failed tool call", () => {
  // R13, mdrefs T010: an apply_fix call failed after 8 ms and the journal did not say why.
  test("is journaled with its error message", async () => {
    scriptModel([
      step(1000, 50, { name: "run_repro", input: { value: 1 } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, executor, request } = await nativeAttempt();
    await expect(
      executor.execute({
        ...request,
        profile: { ...request.profile, allowedTools: [...request.profile.allowedTools, "run_repro"] },
        hostTools: {
          run_repro: {
            description: "Run a repro",
            inputSchema: z.object({ value: z.number() }),
            execute: async () => {
              throw new Error("the repro command is missing");
            },
          },
        },
      }),
    ).rejects.toThrow("provider unavailable");
    const finished = store.events(run.runId).find((e) => e.type === "tool.finished");
    expect(finished?.payload).toMatchObject({ tool: "run_repro", status: "error", error: "the repro command is missing" });
  });
});

describe("documentation probes", () => {
  const planned = (path: string): Task => ({
    id: "T004",
    title: "Write the README",
    description: "Document the CLI",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path, action: "modify" }],
    readHints: [],
    checkIds: ["check"],
    origin: "planned",
    findingIds: [],
    rationale: "docs",
  });
  const probeOnce = async (path: string) => {
    scriptModel([
      step(1000, 50, { name: "run_probe", input: { executable: "bun", args: ["-e", "console.log('usage: app <dir>/')"] } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(fixturePolicy, "implementation", planned(path));
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    return store.latestArtifact(run.runId, `attempts/${attemptId}/probe-1.json`);
  };

  // R09 propdrift 90c09da7: README examples were written from the spec and disagreed with the CLI.
  test("a planned task that writes a README can run the program to capture its output", async () => {
    expect((await probeOnce("README.md"))?.kind).toBe("probe");
  });

  test("a planned task that writes only code has no probe", async () => {
    expect(await probeOnce("value.txt")).toBeNull();
  });
});

describe("task-end check", () => {
  const implemented = (summary: string) => ({
    schemaVersion: 1,
    taskId: "T004",
    outcome: "implemented",
    summary,
    evidenceIds: [],
    unresolved: [],
  });
  const codeTask: Task = {
    id: "T004",
    title: "Parse input",
    description: "Parse the input",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    dependsOn: [],
    profileId: "implementer",
    writes: [{ path: "value.txt", action: "modify" }],
    readHints: [],
    checkIds: ["check"],
    origin: "planned",
    findingIds: [],
    rationale: "parse",
  };

  test("its errors go back once, and the next submission is accepted without running it again", async () => {
    scriptModel([
      step(1000, 50, { name: "submit_result", input: implemented("first") }),
      step(1000, 50, { name: "submit_result", input: implemented("fixed") }),
    ]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    let runs = 0;
    const response = await executor.execute({
      ...request,
      taskEndCheck: async () => {
        runs++;
        return ["typecheck: src/app.ts: error TS2322: Type 'number' is not assignable to type 'string'."];
      },
    });
    expect(runs).toBe(1);
    expect(response.output).toMatchObject({ summary: "fixed" });
  });

  test("a blocked result after applied edits goes back once with the written files (#846)", async () => {
    const blocked = {
      ...implemented("Unable to edit value.txt: blocked by read-only sandbox settings. No changes were made."),
      outcome: "blocked",
      unresolved: ["value.txt"],
    };
    scriptModel([
      step(1000, 50, { name: "submit_result", input: blocked }),
      step(1000, 50, { name: "submit_result", input: implemented("value.txt is parsed") }),
    ]);
    const { store, run, attemptId, executor, request } = await nativeAttempt(
      fixturePolicy,
      "implementation",
      codeTask,
    );
    store.transaction(() => {
      const id = store.prepareEffect(run.runId, attemptId, "file_patch", { path: "value.txt", tool: "edit_file" }, null, null);
      store.finishFileEffect(run.runId, id, "a".repeat(64));
    });
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "implemented", summary: "value.txt is parsed" });
  });

  test("a blocked result without applied edits is accepted as it is", async () => {
    const blocked = { ...implemented("The spec is missing a format."), outcome: "blocked", unresolved: ["format"] };
    scriptModel([step(1000, 50, { name: "submit_result", input: blocked })]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "blocked" });
  });

  test("a clean check accepts the first submission", async () => {
    scriptModel([step(1000, 50, { name: "submit_result", input: implemented("first") })]);
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", codeTask);
    const response = await executor.execute({ ...request, taskEndCheck: async () => [] });
    expect(response.output).toMatchObject({ summary: "first" });
  });
});

describe("model calls of an ended attempt (#863)", () => {
  test("the signal of every model call fires when the attempt ends, after its last step", async () => {
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    const signals: AbortSignal[] = [];
    const submit = {
      schemaVersion: 1,
      taskId: "T004",
      outcome: "implemented",
      summary: "done",
      evidenceIds: [],
      unresolved: [],
    };
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (options.abortSignal) signals.push(options.abortSignal);
        return step(1000, 50, { name: "submit_result", input: submit });
      },
    });
    provider.createModel = () => model as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const task: Task = {
      id: "T004",
      title: "Parse input",
      description: "Parse the input",
      requirementIds: ["FR-001"],
      criterionIds: ["AC-001"],
      dependsOn: [],
      profileId: "implementer",
      writes: [{ path: "value.txt", action: "modify" }],
      readHints: [],
      checkIds: ["check"],
      origin: "planned",
      findingIds: [],
      rationale: "parse",
    };
    const { executor, request } = await nativeAttempt(fixturePolicy, "implementation", task);
    // A provider that keeps a thread open at the submit call (Codex app-server) releases it on
    // this signal; the attempt's own signal never fires on a normal end.
    const response = await executor.execute(request);
    expect(response.output).toMatchObject({ outcome: "implemented" });
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(request.signal.aborted).toBe(false);
  });
});

describe("code intelligence backends in attempt usage", () => {
  test("each tool call is counted under the backend that answered it", async () => {
    scriptModel([
      step(1000, 50, { name: "bake_find", input: { query: "value" } }),
      step(1000, 50, { name: "bake_find", input: { query: "fixture" } }),
      () => {
        throw new Error("provider unavailable");
      },
    ]);
    const { executor, request, usageRecord } = await nativeAttempt();
    await expect(executor.execute(request)).rejects.toThrow("provider unavailable");
    // Without a repo map bake_find lists files itself.
    expect(usageRecord()?.toolBackends).toEqual([
      { tool: "bake_find", backend: "file-list", server: null, calls: 2 },
    ]);
  });

  test("counts of the same tool, backend and server add up across attempts", () => {
    const merged = mergeToolBackends([
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 2 },
      { tool: "navigate", backend: "tree-sitter", server: null, calls: 1 },
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 3 },
    ]);
    expect(merged).toEqual([
      { tool: "navigate", backend: "lsp", server: "rust-analyzer", calls: 5 },
      { tool: "navigate", backend: "tree-sitter", server: null, calls: 1 },
    ]);
    expect(toolBackendLine(merged)).toBe("navigate lsp (rust-analyzer) 5, navigate tree-sitter 1");
    expect(toolBackendLine([])).toBeNull();
  });
});

describe("scheduler accounting of failed attempts", () => {
  test("a failed attempt is charged the usage its executor recorded and releases its reservation", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service } = fixture;
    const failing: AgentExecutor = {
      async execute(request) {
        service.store.recordAttemptUsage(request.runId, request.attemptId, 4321);
        throw new Error("model rejected the request");
      },
    };
    (service as unknown as { scheduler: { executor: AgentExecutor } }).scheduler.executor = failing;
    const run = await fixture.start();
    await fixture.resume(run.runId);
    await service.drive(run.runId, new AbortController().signal).catch(() => {});
    const attempts = service.store.attempts(run.runId).filter((a) => a.model_id !== null);
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts)
      expect(attempt).toMatchObject({ status: "failed", used_tokens: 4321, usage_complete: 1 });
    expect(service.store.run(run.runId).token_usage).toBe(4321 * attempts.length);
    expect(runUsage(service.store, run.runId).totalTokens).toBe(4321 * attempts.length);
  });
});

describe("next-step reservation", () => {
  const controller = () =>
    new AttemptStepController({
      maxSteps: 20,
      maxTokens: 250_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 1000,
      maxOutputTokens: 32_000,
    });
  const usage = (inputTokens: number, outputTokens: number) => ({
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    toolCalls: [{}],
  });

  test("grows from the reported input tokens instead of a fixed share of the bytes", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(300_000) }];
    budget.prepare({ stepNumber: 0, steps: [], messages });
    const done = [usage(90_000, 1000)];
    const longer = [...messages, { role: "user" as const, content: "y".repeat(3000) }];
    // Spend 91,000 + next input 90,000 + about 1,000 new + output estimate max(4096, 2*1000).
    const reserve = budget.reservation(done, longer);
    expect(reserve).toBeGreaterThan(91_000 + 90_000 + 4096);
    expect(reserve).toBeLessThan(91_000 + 90_000 + 1100 + 4096);
    // The former estimate charged half the bytes plus the whole output cap and a fixed slack.
    const former = 91_000 + Math.ceil(Buffer.byteLength(JSON.stringify(longer)) / 2) + 32_000 + 8192;
    expect(former - reserve).toBeGreaterThan(80_000);
  });

  test("before any usage it counts the messages at three bytes per token, and caps the output", () => {
    const budget = controller();
    const messages = [{ role: "user" as const, content: "x".repeat(30_000) }];
    const bytes = Buffer.byteLength(JSON.stringify(messages));
    expect(budget.reservation([], messages)).toBe(Math.ceil(bytes / 3) + 8192 + 4096);
    budget.prepare({ stepNumber: 0, steps: [], messages });
    expect(budget.reservation([usage(10_000, 30_000)], messages)).toBe(40_000 + 10_000 + 32_000);
  });

  test("records a failure as the stop reason", () => {
    const record = controller().record([usage(10, 1)], false, { profileId: "p", taskId: null }, "aborted");
    expect(record.stopReason).toBe("aborted");
    expect(record.totalTokens).toBe(11);
  });
});

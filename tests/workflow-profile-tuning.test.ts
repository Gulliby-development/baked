import { afterEach, describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { ProfileRegistry } from "../src/core/agents/profiles/registry.js";
import { ProfileSchema } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { AttemptStepController } from "../src/core/workflows/step-budget.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const implementer = builtinProfiles.find((profile) => profile.id === "implementer");
if (!implementer) throw new Error("No built-in implementer profile");

/** A workspace whose `baked/agents/implementer.json` replaces the built-in implementer. */
function workspaceWith(profile: unknown, root?: string): string {
  const workspace = root ?? mkdtempSync(join(tmpdir(), "baked-profile-tuning-"));
  if (!root) cleanups.push(() => removeTempDir(workspace));
  const agents = join(workspace, "baked", "agents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "implementer.json"), JSON.stringify(profile));
  return workspace;
}

describe("profile effort and compaction fields", () => {
  test("are optional, and the built-in profiles set neither", () => {
    for (const profile of builtinProfiles) {
      expect(profile.effort).toBeUndefined();
      expect(profile.compaction).toBeUndefined();
    }
    const tuned = { ...implementer, effort: "low", compaction: { keepRecent: 1, startAtShare: 0.25 } };
    expect(ProfileSchema.parse(tuned)).toEqual(tuned);
  });

  test("reject an unknown effort, both compaction starts, and unknown keys", () => {
    expect(ProfileSchema.safeParse({ ...implementer, effort: "extreme" }).success).toBe(false);
    const both = { compaction: { startAtTokens: 50_000, startAtShare: 0.5 } };
    expect(ProfileSchema.safeParse({ ...implementer, ...both }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...implementer, compaction: { keepRecent: 0 } }).success).toBe(false);
    expect(ProfileSchema.safeParse({ ...implementer, compaction: { after: 1 } }).success).toBe(false);
  });

  test("a profile's effort becomes its route's effort unless routing sets one", () => {
    const workspace = workspaceWith({ ...implementer, effort: "low" });
    const none = join(workspace, "none");
    const plain = new ProfileRegistry(workspace, { active: "openai/x" }, none);
    expect(plain.list().find((entry) => entry.profile.id === "implementer")?.route.effort).toBe("low");
    expect(plain.list().find((entry) => entry.profile.id === "reviewer")?.route.effort).toBeUndefined();
    const routed = new ProfileRegistry(
      workspace,
      { active: "openai/x", routing: { roles: { implementer: { model: "openai/x", effort: "high" } } } },
      none,
    );
    expect(routed.list().find((entry) => entry.profile.id === "implementer")?.route.effort).toBe("high");
  });
});

describe("profile compaction in an attempt", () => {
  const BIG = "x".repeat(4000);
  function history(reads: number): ModelMessage[] {
    const messages: ModelMessage[] = [{ role: "user", content: "task" }];
    for (let i = 0; i < reads; i++) {
      const id = `c${String(i)}`;
      messages.push({
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { files: [{ path: `f${String(i)}.ts` }] } }],
      });
      messages.push({
        role: "tool",
        content: [{ type: "tool-result", toolCallId: id, toolName: "read", output: { type: "json", value: { result: BIG } } }],
      });
    }
    return messages;
  }
  const compacted = (messages: ModelMessage[] | undefined) =>
    (messages ?? []).filter((m) => m.role === "tool" && JSON.stringify(m.content).includes('"compacted":true')).length;
  const step = (tokens: number) => ({ usage: { inputTokens: tokens, outputTokens: 0, totalTokens: tokens }, toolCalls: [{}] });
  const controller = (compaction?: ConstructorParameters<typeof AttemptStepController>[0]["compaction"]) =>
    new AttemptStepController({
      maxSteps: 40,
      maxTokens: 100_000,
      submitTools: ["submit_result"],
      fallbackStepTokens: 100,
      ...(compaction ? { compaction } : {}),
    });

  test("without settings, all but the last three tool results compact from the first step", () => {
    expect(compacted(controller().prepare({ stepNumber: 1, steps: [step(1000)], messages: history(6) }).messages)).toBe(3);
  });

  test("keepRecent sets how many tool results stay verbatim", () => {
    const prepared = controller({ keepRecent: 1 }).prepare({ stepNumber: 1, steps: [step(1000)], messages: history(6) });
    expect(compacted(prepared.messages)).toBe(5);
  });

  test("compaction starts at the token threshold and then stays on", () => {
    const attempt = controller({ startAtTokens: 20_000 });
    expect(attempt.prepare({ stepNumber: 1, steps: [step(10_000)], messages: history(6) })).toEqual({});
    const started = attempt.prepare({ stepNumber: 2, steps: [step(10_000), step(12_000)], messages: history(6) });
    expect(compacted(started.messages)).toBe(3);
    // A later step under the threshold (the cap only counts up) still compacts.
    expect(compacted(attempt.prepare({ stepNumber: 3, steps: [step(1)], messages: history(6) }).messages)).toBe(3);
  });

  test("startAtShare is a share of the attempt's token cap", () => {
    const attempt = controller({ startAtShare: 0.5 });
    expect(attempt.prepare({ stepNumber: 1, steps: [step(20_000)], messages: history(6) })).toEqual({});
    expect(compacted(attempt.prepare({ stepNumber: 2, steps: [step(20_000), step(30_000)], messages: history(6) }).messages)).toBe(3);
  });
});

describe("profile effort in a run", () => {
  class EffortExecutor extends FixtureExecutor {
    efforts: Record<string, (string | undefined)[]> = {};
    override async execute(request: ExecutionRequest) {
      (this.efforts[request.profile.output] ??= []).push(request.effort);
      return super.execute(request);
    }
  }

  async function implementerEffort(routing?: Record<string, unknown>): Promise<(string | undefined)[]> {
    const fixture = workflowFixture({ executor: (root) => new EffortExecutor(root) });
    cleanups.push(fixture.dispose);
    workspaceWith({ ...implementer, effort: "low" }, fixture.root);
    const service = routing
      ? new NativeWorkflowService(fixture.root, { ...fixture.config, modelRouting: routing }, fixture.executor)
      : fixture.service;
    if (service !== fixture.service) cleanups.push(() => service.close());
    const run = await service.start({
      commandId: crypto.randomUUID(),
      featureId: "fixture",
      workflowId: "sdd",
      prompt: "Create ready value",
      ownerLabel: "test",
      policy: fixture.policy,
    });
    const signal = new AbortController().signal;
    await service.drive(run.runId, signal);
    const state = await service.get(run.runId);
    const request = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!request) throw new Error("No pending approval");
    await service.decide(
      run.runId,
      { commandId: crypto.randomUUID(), expectedRevision: state.revision },
      { kind: "approve", requestId: request.id, digest: request.digest },
    );
    await service.drive(run.runId, signal);
    expect(fixture.executor.efforts.plan).toEqual([undefined]);
    return fixture.executor.efforts.implementation ?? [];
  }

  test("an implementer attempt gets the profile's effort", async () => {
    expect(await implementerEffort()).toEqual(["low"]);
  });

  test("a stage route without effort keeps the profile's; one with effort wins", async () => {
    expect(await implementerEffort({ workflows: { sdd: { stages: { implement: "fixture/other" } } } })).toEqual(["low"]);
    const routed = { workflows: { sdd: { stages: { implement: { model: "fixture/other", effort: "high" } } } } };
    expect(await implementerEffort(routed)).toEqual(["high"]);
  });
});

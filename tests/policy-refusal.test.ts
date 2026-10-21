import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV2 } from "@ai-sdk/provider";
import { AbnormalFinishError } from "../src/core/agents/stream-options.js";
import { POLICY_REFUSALS, policyRefusal } from "../src/core/llm/policy-refusal.js";
import { getAllProviders, getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { accountRefusal } from "../src/core/workflows/retry.js";
import { runReport } from "../src/core/workflows/run-report.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 59, wheeltags tags-command (#1895). Task T002's Codex exec attempt ran 3 steps and
// failed with the provider's prompt-policy refusal after 335,981 tokens. The scheduler filed it as
// a lost worker (`cause: worker_lost`) with a stack of BAKED's own code and restarted the task;
// nothing in the run said the provider had refused the input.

const R59 =
  "Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fixture whose implementer is refused `refusals` times; `edits` journals a write first. */
function refusingFixture(refusals: number, edits: boolean) {
  let attempts = 0;
  const fixture = workflowFixture({
    executor: (root) =>
      new (class RefusedImplementer extends FixtureExecutor {
        override async execute(request: ExecutionRequest) {
          if (request.profile.output !== "implementation") return super.execute(request);
          attempts++;
          if (attempts > refusals) return super.execute(request);
          const store = fixture.service.store;
          if (edits) {
            writeFileSync(join(root, "value.txt"), "half");
            const id = store.prepareEffect(
              request.runId,
              request.attemptId,
              "file_patch",
              { path: "value.txt", tool: "write_file" },
              null,
              null,
            );
            store.finishFileEffect(request.runId, id, "half");
          }
          store.recordAttemptUsage(request.runId, request.attemptId, 335_981);
          throw new Error(R59);
        }
      })(root),
  });
  cleanups.push(fixture.dispose);
  return { fixture, attempts: () => attempts };
}

async function driveToTasks(fixture: ReturnType<typeof workflowFixture>) {
  const run = await fixture.start();
  const signal = new AbortController().signal;
  await fixture.service.drive(run.runId, signal);
  await fixture.approve(run.runId);
  const done = await fixture.service.drive(run.runId, signal);
  const events = JSON.stringify(fixture.service.store.events(run.runId, 0));
  return { runId: run.runId, done, events };
}

describe("scenario: wheeltags T002, a usage-policy refusal mid-task (#1895)", () => {
  test("a refused task that changed files runs once more on them, not as a lost worker", async () => {
    const { fixture, attempts } = refusingFixture(1, true);
    const { runId, done, events } = await driveToTasks(fixture);
    expect(done.status).toBe("completed");
    expect(attempts()).toBe(2);
    expect(events).not.toContain("worker_lost");
    expect(events).not.toContain("provider_unavailable");
    // The run records the refusal and the report names it with its tokens.
    const report = runReport(fixture.service.store, runId);
    expect(report).toContain("Refused under the provider's usage policy: 1 attempts, 335,981 tokens.");
    expect(report).toContain("flagged as potentially violating our usage policy");
  }, 60_000);

  test("a refused attempt that changed nothing runs again at once", async () => {
    const { fixture, attempts } = refusingFixture(1, false);
    const { done, events } = await driveToTasks(fixture);
    expect(done.status).toBe("completed");
    expect(attempts()).toBe(2);
    expect(events).not.toContain("worker_lost");
  }, 60_000);

  test("a second refusal on the same model blocks the run with the reroute remedy", async () => {
    const { fixture, attempts } = refusingFixture(10, true);
    const { runId, done, events } = await driveToTasks(fixture);
    expect(done).toMatchObject({ status: "blocked", reason: "provider_policy" });
    expect(attempts()).toBe(2);
    expect(events).not.toContain("worker_lost");
    const diagnostics = fixture.service.store
      .artifacts(runId)
      .filter((a) => a.logical_path.startsWith("errors/"))
      .map((a) => fixture.service.store.readArtifact(runId, a.id))
      .join("\n");
    expect(diagnostics).toContain("under its usage policy 2 times");
    expect(diagnostics).toContain(`baked workflow reroute ${runId}`);

    // The decision replays from the bench trace, without the provider's words (#1649).
    const dir = mkdtempSync(join(tmpdir(), "policy-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(fixture.root, out);
    expect(Buffer.from(Bun.gunzipSync(readFileSync(out))).includes("flagged as potentially")).toBe(false);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.policyRefusals.map((b) => [b.key, b.recorded, b.replayed])).toEqual([
      ["T001", "retry", "retry"],
      ["T001", "stop", "stop"],
    ]);
    expect(replayed?.newPolicyStops).toBe(0);
    // A rule that stopped at the first refusal is a new stop on this run.
    const strict = replayTrace(out, { policyRefusal: () => "stop" }).runs.find((r) => r.runId === runId);
    expect(strict?.newPolicyStops).toBe(1);
  }, 60_000);

  test("a plain error is still not a policy refusal", async () => {
    let attempts = 0;
    const fixture = workflowFixture({
      executor: (root) =>
        new (class BrokenImplementer extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output === "implementation" && ++attempts === 1)
              throw new Error("Cannot read properties of undefined (reading 'path')");
            return super.execute(request);
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    const { runId, done } = await driveToTasks(fixture);
    expect(done).toMatchObject({ status: "blocked", reason: "provider_unavailable" });
    expect(attempts).toBe(1);
    expect(
      fixture.service.store.artifacts(runId).some((a) => a.logical_path.startsWith("provider/policy-refusals/")),
    ).toBe(false);
  }, 60_000);
});

describe("scenario: a response the provider withholds (content-filter finish, #1895)", () => {
  test("is a policy refusal: retried once, then the run blocks for a reroute", async () => {
    // Anthropic's `stop_reason: refusal` and OpenAI's `content_filter` end the step this way.
    let calls = 0;
    const filtered: LanguageModelV2 = {
      specificationVersion: "v2",
      provider: "openai",
      modelId: "gpt-test",
      supportedUrls: {},
      doGenerate: async () => {
        throw new Error("not used");
      },
      doStream: async () => {
        calls++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({
                type: "finish",
                finishReason: "content-filter",
                usage: { inputTokens: 900, outputTokens: 0, totalTokens: 900 },
              });
              controller.close();
            },
          }),
        };
      },
    };
    const adapter = getProvider("openai");
    if (!adapter) throw new Error("OpenAI provider missing");
    const original = adapter.createModel;
    adapter.createModel = () => filtered;
    cleanups.push(() => {
      adapter.createModel = original;
    });
    const fixture = workflowFixture({
      executor: (root) =>
        new (class FilteredSpecExecutor extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output !== "spec") return super.execute(request);
            const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, {
              ...fixture.config,
              repoMap: false,
            });
            try {
              return await native.execute({ ...request, profile: { ...request.profile, model: "openai/gpt-test" } });
            } finally {
              native.dispose();
            }
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(done).toMatchObject({ status: "blocked", reason: "provider_policy" });
    // One call per attempt: no format correction of the withheld response.
    expect(calls).toBe(2);
    const refusals = fixture.service.store
      .artifacts(run.runId)
      .filter((a) => a.logical_path.startsWith("provider/policy-refusals/"))
      .map((a) => JSON.parse(fixture.service.store.readArtifact(run.runId, a.id)) as { provider: string });
    expect(refusals.map((r) => r.provider)).toEqual(["content-filter", "content-filter"]);
  }, 60_000);
});

describe("policy refusal shapes", () => {
  test("every provider adapter has an entry", () => {
    for (const provider of getAllProviders()) expect(POLICY_REFUSALS[provider.id]).toBeDefined();
  });

  test("recognises each provider's refusal and nothing else", () => {
    expect(policyRefusal(new Error(R59), "codex/gpt-6-luna")).toBe("codex");
    expect(
      policyRefusal(
        Object.assign(new Error("Bad request"), {
          responseBody: '{"error":{"code":"invalid_prompt","message":"flagged"}}',
        }),
        "openai/gpt-5",
      ),
    ).toBe("openai");
    expect(
      policyRefusal(
        new Error(
          "API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup).",
        ),
        "claude-code/opus",
      ),
    ).toBe("claude-code");
    expect(
      policyRefusal(new Error("Sorry, the response was filtered by the Responsible AI Service."), "copilot/gpt-5"),
    ).toBe("copilot");
    expect(
      policyRefusal(
        new Error(
          "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
        ),
        "github-models/openai/gpt-4.1",
      ),
    ).toBe("github-models");
    expect(policyRefusal(new AbnormalFinishError("content-filter"), "anthropic/claude")).toBe("content-filter");
    expect(policyRefusal(new AbnormalFinishError("length"), "anthropic/claude")).toBeNull();
    expect(policyRefusal(new Error("socket hang up"), "codex/gpt")).toBeNull();
    expect(policyRefusal(new Error("You've hit your usage limit. Try again at 3pm."), "codex/gpt")).toBeNull();
    // An account refusal is not a policy refusal, and the other way round.
    expect(accountRefusal(new Error(R59))).toBeNull();
  });
});

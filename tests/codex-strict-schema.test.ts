import type { JSONSchema7, LanguageModelV2CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, test } from "bun:test";
import { ProviderUnreachableError, probeProvider } from "../src/core/llm/provider-health.js";
import { buildCodexSchema, createCodexLanguageModel } from "../src/core/llm/providers/codex.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 59 (wheeltags explain-command, #1889): on `codex exec` a stalled task attempt sent
// the run to the provider wait, and its health probe, a call with no tools, built an output
// schema whose `toolCalls.items` object had no `required`. OpenAI's strict structured output
// answered 400 `invalid_json_schema`, and 5 s later the run was blocked `provider_unavailable`
// for a person, with the provider healthy.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Where a schema breaks OpenAI's strict mode: every object closed, every property required. */
function strictProblems(schema: JSONSchema7, path = "schema"): string[] {
  const problems: string[] = [];
  if (schema.type === "object") {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) problems.push(`${path}.additionalProperties`);
    if (!Array.isArray(schema.required)) problems.push(`${path}.required is missing`);
    else if ([...schema.required].sort().join() !== [...keys].sort().join())
      problems.push(`${path}.required does not list every property`);
  }
  for (const [key, value] of Object.entries(schema.properties ?? {}))
    if (typeof value === "object") problems.push(...strictProblems(value, `${path}.properties.${key}`));
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items))
    problems.push(...strictProblems(schema.items, `${path}.items`));
  return problems;
}

/** The OpenAI Responses API's answer to a strict schema it refuses, as `codex exec` reports it. */
function refusal(problem: string): Error {
  return new Error(
    `unexpected status 400 Bad Request: {"error":{"message":"Invalid schema for response_format 'codex_output_schema': '${problem}' is required to be supplied and to be an array including every key in properties when strict is true.","type":"invalid_request_error","param":"text.format.schema","code":"invalid_json_schema"}}`,
  );
}

const prompt: LanguageModelV2CallOptions["prompt"] = [
  { role: "user", content: [{ type: "text", text: "Reply with OK." }] },
];
const tool = {
  type: "function" as const,
  name: "read",
  description: "Read a file",
  inputSchema: { type: "object" as const, properties: { path: { type: "string" as const } } },
};

describe("Codex exec output schema in strict mode (#1889)", () => {
  test.each([
    ["no tools (the health probe, compaction, approval review, chat)", {}],
    ["tools, auto", { tools: [tool], toolChoice: { type: "auto" as const } }],
    ["tools, required", { tools: [tool], toolChoice: { type: "required" as const } }],
    ["one named tool", { tools: [tool], toolChoice: { type: "tool" as const, toolName: "read" } }],
    ["tools, none", { tools: [tool], toolChoice: { type: "none" as const } }],
  ])("%s: every object is closed and requires all its properties", (_, options) => {
    expect(strictProblems(buildCodexSchema({ prompt, ...options }))).toEqual([]);
  });

  test("a tool-less call allows no tool calls", () => {
    const schema = buildCodexSchema({ prompt });
    const calls = schema.properties?.toolCalls as JSONSchema7;
    expect(calls).toMatchObject({ type: "array", maxItems: 0, items: { required: [] } });
  });

  test("the health probe on codex exec gets its answer from a strict API", async () => {
    let sent: JSONSchema7 | undefined;
    const model = createCodexLanguageModel("gpt-6-luna", {
      async run(call) {
        sent = call.schema;
        const problems = strictProblems(call.schema);
        if (problems[0]) throw refusal(problems[0]);
        return {
          text: JSON.stringify({ finishReason: "stop", reasoning: "", text: "OK", toolCalls: [] }),
          usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
        };
      },
    });
    const result = await probeProvider(model as never, "codex/gpt-6-luna", new AbortController().signal);
    expect(sent).toBeDefined();
    expect(result.usage).toBeDefined();
  });
});

describe("a provider probe the provider refuses as a request (#1889)", () => {
  test("resumes the waiting run instead of blocking it provider_unavailable", async () => {
    let failed = false;
    const fixture = workflowFixture({
      executor: (root) =>
        new (class extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output === "implementation" && !failed) {
              failed = true;
              throw new ProviderUnreachableError(request.profile.model, "No model response within 180 seconds");
            }
            return super.execute(request);
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    let probes = 0;
    fixture.service.providerProbe = async () => {
      probes++;
      throw refusal("schema.properties.toolCalls.items.required");
    };
    fixture.service.providerDelay = async () => {};
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(probes).toBe(1);
    expect(done).toMatchObject({ status: "completed", reason: "none" });
    const { store } = fixture.service;
    const healthy = store.latestArtifact(run.runId, "provider/healthy.json");
    expect(healthy).not.toBeNull();
    expect(store.readArtifact(run.runId, healthy?.id ?? "")).toContain("invalid_json_schema");
  }, 30_000);

  test("an account refusal from the probe still blocks for a person", async () => {
    let failed = false;
    const fixture = workflowFixture({
      executor: (root) =>
        new (class extends FixtureExecutor {
          override async execute(request: ExecutionRequest) {
            if (request.profile.output === "implementation" && !failed) {
              failed = true;
              throw new ProviderUnreachableError(request.profile.model, "ECONNREFUSED");
            }
            return super.execute(request);
          }
        })(root),
    });
    cleanups.push(fixture.dispose);
    fixture.service.providerProbe = async () => {
      throw Object.assign(new Error("401 Unauthorized: invalid x-api-key"), { statusCode: 401 });
    };
    fixture.service.providerDelay = async () => {};
    const run = await fixture.start();
    const signal = new AbortController().signal;
    await fixture.service.drive(run.runId, signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, signal);
    expect(done).toMatchObject({ status: "blocked", reason: "provider_account" });
  }, 30_000);
});

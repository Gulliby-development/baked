import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JSONSchema7, LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { asSchema, zodSchema } from "ai";
import { repairToolCall } from "../src/core/agents/stream-options.js";
import {
  acceptedTypes,
  COERCIBLE_TYPES,
  coerceStringifiedFields,
  coerceStringifiedToolCall,
  KEPT_TYPES,
} from "../src/core/agents/tool-input-coercion.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { MemoryManager } from "../src/core/memory/manager.js";
import { buildTools } from "../src/core/tools/index.js";
import { NativeAgentExecutor, outputSchemas } from "../src/core/workflows/agent-executor.js";
import { advertisedSchema } from "../src/core/workflows/host-constants.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { recordToolInputSignal, TOOL_INPUT_THRESHOLD, toolInputSignalPath } from "../src/core/workflows/tool-input-health.js";
import { runUsage } from "../src/core/workflows/usage.js";
import { runUsageMarkdown } from "../src/core/workflows/usage-markdown.js";
import { type AgentProfile, ProfileSchema } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// #2141: Claude Code's Sonnet sent submit_result with array and number fields as JSON text
// (`"inScope": "[\"Tags\"]"`, `"revision": "1"`); 17 attempts of R68 each lost a round to the
// validator's refusal. The tool-input layer every provider shares decodes them now.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const schema: JSONSchema7 = {
  type: "object",
  properties: {
    name: { type: "string" },
    ids: { type: "array", items: { type: "string" } },
    meta: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
    score: { type: "number" },
    count: { type: "integer" },
    done: { type: "boolean" },
    maybe: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    either: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
    rows: {
      type: "array",
      items: { type: "object", properties: { refs: { type: "array", items: { type: "string" } } } },
    },
  },
};

describe("a stringified field is decoded to the type its schema asks for (#2141)", () => {
  test.each([
    ["array", "ids", '["a","b"]', ["a", "b"]],
    ["object", "meta", '{"tags":["x"]}', { tags: ["x"] }],
    ["number", "score", "0.5", 0.5],
    ["integer", "count", "3", 3],
    ["boolean", "done", "true", true],
    ["nullable array", "maybe", '["a"]', ["a"]],
  ])("%s", (_type, field, text, expected) => {
    const { input, coerced } = coerceStringifiedFields({ name: "n", [field]: text }, schema);
    expect(input).toEqual({ name: "n", [field]: expected });
    expect(coerced).toEqual([field]);
  });

  test("nested fields, and fields inside a decoded container, are decoded with their paths", () => {
    const { input, coerced } = coerceStringifiedFields(
      { rows: [{ refs: '["r1"]' }], meta: '{"tags":"[\\"t\\"]"}' },
      schema,
    );
    expect(input).toEqual({ rows: [{ refs: ["r1"] }], meta: { tags: ["t"] } });
    expect(coerced).toEqual(["rows[0].refs", "meta", "meta.tags"]);
  });

  test.each([
    ["text that is not JSON", "ids", "a, b"],
    ["JSON of another type", "ids", '{"a":1}'],
    ["a fraction where an integer is asked", "count", "2.5"],
    ["a quoted number where an array is asked", "ids", "3"],
    ["a string field", "name", '["a"]'],
    ["a field that also accepts a string", "either", '["a"]'],
  ])("%s is left as it is, for the validator to refuse", (_case, field, text) => {
    const { input, coerced } = coerceStringifiedFields({ [field]: text }, schema);
    expect(input).toEqual({ [field]: text });
    expect(coerced).toEqual([]);
  });

  const call = (input: unknown, name = "AI_InvalidToolInputError") => ({
    toolCall: { type: "tool-call" as const, toolCallId: "c1", toolName: "submit_result", input: JSON.stringify(input) },
    inputSchema: async () => schema,
    error: { name },
  });

  test("the repair step returns the decoded call and reports what it decoded", async () => {
    const seen: string[][] = [];
    const repaired = await coerceStringifiedToolCall(call({ ids: '["a"]', score: "1" }), (c) =>
      seen.push(c.fields),
    );
    expect(JSON.parse(repaired?.input ?? "null")).toEqual({ ids: ["a"], score: 1 });
    expect(seen).toEqual([["ids", "score"]]);
  });

  test("a call with nothing to decode, or refused for another reason, is not repaired", async () => {
    expect(await coerceStringifiedToolCall(call({ ids: ["a"] }))).toBeNull();
    expect(await coerceStringifiedToolCall(call({ ids: '["a"]' }, "AI_NoSuchToolError"))).toBeNull();
  });

  test("the interactive agents' repairToolCall decodes before it repairs the JSON text", async () => {
    const repaired = await repairToolCall({ ...call({ ids: '["a"]' }), tools: { submit_result: {} } });
    expect(JSON.parse(repaired?.input ?? "null")).toEqual({ ids: ["a"] });
  });
});

/** Every typed node of a JSON schema, with its path. */
function* typedNodes(node: JSONSchema7, path: string): Generator<[string, JSONSchema7]> {
  if (node.type || node.anyOf || node.oneOf || node.const !== undefined || node.enum) yield [path, node];
  for (const [key, child] of Object.entries(node.properties ?? {}))
    if (typeof child === "object") yield* typedNodes(child, `${path}.${key}`);
  if (node.items && typeof node.items === "object" && !Array.isArray(node.items))
    yield* typedNodes(node.items, `${path}[]`);
  for (const member of [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])])
    if (typeof member === "object") yield* typedNodes(member, path);
}

/** Paths of `schema`'s fields whose types the coercion table does not know. */
function unknownTypes(name: string, schema: JSONSchema7): string[] {
  const missing: string[] = [];
  for (const [path, node] of typedNodes(schema, name)) {
    const types = acceptedTypes(node);
    for (const type of types ?? [])
      if (!(type in COERCIBLE_TYPES) && !KEPT_TYPES.has(type)) missing.push(`${path}: ${type}`);
  }
  return missing;
}

describe("every structured tool the host validates has its field types in COERCIBLE_TYPES", () => {
  test("submit_result of every output", async () => {
    for (const [output, resultSchema] of Object.entries(outputSchemas)) {
      const shown = (await zodSchema(advertisedSchema(output, resultSchema)).jsonSchema) as JSONSchema7;
      expect(unknownTypes(output, shown)).toEqual([]);
    }
  });

  test("the registry's tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-coerce-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // The memory database is closed before the directory goes, which Windows requires.
    const memoryManager = new MemoryManager(root, join(root, "global"));
    cleanups.push(() => memoryManager.close());
    const tools = buildTools(root, undefined, { memoryManager }) as Record<string, { inputSchema?: unknown }>;
    let checked = 0;
    for (const [name, registered] of Object.entries(tools)) {
      if (!registered?.inputSchema) continue;
      const shown = (await asSchema(registered.inputSchema as never).jsonSchema) as JSONSchema7;
      expect(unknownTypes(name, shown)).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

/** The R68 spec submission's shape, with the fields Claude Code's Sonnet sent as JSON text. */
function stringifiedSpec(inScope = '["Tags"]') {
  return {
    schemaVersion: 1,
    featureId: "fixture",
    revision: "1",
    title: "Tags",
    problem: "No tags",
    outcome: "Tags exist",
    inScope,
    outOfScope: "[]",
    assumptions: [],
    openQuestions: [],
    requirements: [
      { id: "FR-001", text: "Tag command", priority: "must", verification: "automated", sourceRefs: [] },
    ],
    criteria: [
      {
        id: "AC-001",
        requirementIds: '["FR-001"]',
        given: "a workspace",
        when: "the command runs",
        then: "it prints the tag",
        method: "automated",
      },
    ],
    dependencies: [],
    deliverables: [{ quote: "a tag command", requirementIds: ["FR-001"] }],
  };
}

/** Runs the spec author on a mock model that sends `submissions` in turn. */
async function author(submissions: unknown[], options: { maxSteps?: number; effort?: "high" } = {}) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (): Promise<LanguageModelV3GenerateResult> => {
      const next = submissions[Math.min(call, submissions.length - 1)];
      const id = `c${call++}`;
      return {
        content: [{ type: "tool-call", toolCallId: id, toolName: "submit_result", input: JSON.stringify(next) }],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage: {
          inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 100, text: 100, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const specAuthor = profiles.find((p) => p.output === "spec");
  if (!specAuthor) throw new Error("spec profile missing");
  const profile: AgentProfile = { ...specAuthor, model: "openai/fixture-model" };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, fixture.policy);
  const executor = new NativeAgentExecutor(store, new WorkspaceLeases(store), {
    ...fixture.config,
    repoMap: false,
  });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId,
    attemptId,
    profile,
    prompt: "Specify the fixture",
    signal: new AbortController().signal,
    maxSteps: options.maxSteps ?? 4,
    ...(options.effort ? { effort: options.effort } : {}),
  };
  const result = await executor.execute(request);
  const diagnostics = store
    .artifacts(run.runId)
    .filter((a) => a.kind === "diagnostic")
    .map((a) => ({ path: a.logical_path, content: store.readArtifact(run.runId, a.id) }));
  return { result, calls: () => call, diagnostics, store, runId: run.runId };
}

describe("a spec author whose submit_result stringifies its arrays (#2141)", () => {
  test("the submission is accepted in one round and the attempt records what was decoded", async () => {
    const { result, calls, diagnostics } = await author([stringifiedSpec()]);
    expect(calls()).toBe(1);
    expect(result.output).toMatchObject({
      revision: 1,
      inScope: ["Tags"],
      outOfScope: [],
      criteria: [{ requirementIds: ["FR-001"] }],
    });
    expect(diagnostics.some((d) => /invalid-\d+\.json$/.test(d.path))).toBe(false);
    const coerced = diagnostics.find((d) => /attempts\/[^/]+\/coerced-1\.json$/.test(d.path));
    expect(JSON.parse(coerced?.content ?? "{}")).toEqual({
      tool: "submit_result",
      coerced: ["revision", "inScope", "outOfScope", "criteria[0].requirementIds"],
    });
  });

  test("a string that is not JSON of the field's type is still refused, then the corrected one accepted", async () => {
    const spec = stringifiedSpec();
    const corrected = {
      ...spec,
      revision: 1,
      inScope: ["Tags"],
      outOfScope: [],
      criteria: spec.criteria.map((c) => ({ ...c, requirementIds: ["FR-001"] })),
    };
    const { result, calls, diagnostics } = await author([stringifiedSpec("Tags"), corrected]);
    expect(calls()).toBe(2);
    expect(result.output).toMatchObject({ inScope: ["Tags"] });
    expect(diagnostics.some((d) => /attempts\/[^/]+\/invalid-1\.json$/.test(d.path))).toBe(true);
  });
});

// #2149: the invalid and decoded inputs were kept per attempt, but nothing counted them per
// model, so a model that kept sending malformed submissions showed up only as lost rounds.
describe("invalid and decoded tool inputs per model (#2149)", () => {
  const corrected = () => {
    const spec = stringifiedSpec();
    return { ...spec, revision: 1, inScope: ["Tags"], outOfScope: [], criteria: spec.criteria.map((c) => ({ ...c, requirementIds: ["FR-001"] })) };
  };

  test("the usage summary counts them, and the shadow ladder records the rung it would take at the threshold", async () => {
    const bad = stringifiedSpec("Tags");
    // Three refused submissions, one decoded and refused for the same field, then one accepted.
    const { result, store, runId } = await author([bad, bad, bad, corrected()], { maxSteps: 8, effort: "high" });
    expect(result.output).toMatchObject({ inScope: ["Tags"] });
    const usage = runUsage(store, runId);
    expect(usage.toolInputs).toEqual([{ model: "openai/fixture-model", invalid: 3, coerced: 3 }]);
    expect(runUsageMarkdown(usage)).toContain("- Tool inputs: openai/fixture-model 3 invalid, 3 decoded");
    const signal = store.latestArtifact(runId, toolInputSignalPath("openai/fixture-model"));
    expect(JSON.parse(store.readArtifact(runId, signal?.id ?? ""))).toMatchObject({
      mode: "shadow", model: "openai/fixture-model", invalid: 3, threshold: TOOL_INPUT_THRESHOLD, rung: "lower-effort",
    });
    // Shadow: the attempt ran on as before and was not placed anew.
    expect(store.attempts(runId)).toHaveLength(1);
  });

  test("below the threshold nothing is recorded, and a model with no other rung records next-model", async () => {
    const bad = stringifiedSpec("Tags");
    const below = await author([bad, bad, corrected()], { maxSteps: 8 });
    expect(runUsage(below.store, below.runId).toolInputs).toEqual([{ model: "openai/fixture-model", invalid: 2, coerced: 2 }]);
    expect(below.store.latestArtifact(below.runId, toolInputSignalPath("openai/fixture-model"))).toBeNull();
    // A third invalid input in the same run crosses it; a route with no rung left still names one.
    const store = below.store;
    const attempt = store.attempts(below.runId)[0];
    store.transaction(() => store.artifact(below.runId, "diagnostic", `attempts/${attempt?.id}/invalid-9.json`, "{}"));
    expect(recordToolInputSignal(store, below.runId, attempt?.id ?? "", "openai/fixture-model", undefined)).toMatchObject({ invalid: 3, rung: "next-model" });
    // Once per model and run.
    expect(recordToolInputSignal(store, below.runId, attempt?.id ?? "", "openai/fixture-model", undefined)).toBeNull();
  });
});

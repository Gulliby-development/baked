import { afterEach, describe, expect, test } from "bun:test";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { zodSchema } from "ai";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { NativeAgentExecutor, outputSchemas } from "../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import {
  advertisedSchema,
  fillHostConstants,
  HOST_FIELDS,
  withHostConstants,
} from "../src/core/workflows/host-constants.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import {
  type AgentProfile,
  PlanSchema,
  ProfileSchema,
  ResearchSchema,
} from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PENDING = "0".repeat(64);
const markdown = "# Plan\n\nCreate value.txt.";

/** A plan as a model might send it: a wrong schema version and invented hashes. */
function sloppyPlan(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    markdown,
    taskGraph: {
      schemaVersion: "1",
      featureId: "fixture",
      specHash: "sha256-of-the-spec",
      tasks: [
        {
          id: "T001",
          title: "Create value",
          description: "Write ready",
          requirementIds: ["FR-001"],
          criterionIds: ["AC-001"],
          dependsOn: [],
          profileId: "implementer",
          writes: [{ path: "value.txt", action: "create" }],
          readHints: [],
          checkIds: [],
          origin: "planned",
          findingIds: [],
          rationale: "Required behavior",
        },
      ],
    },
  };
}

/** Runs a planner whose one model step submits `plan`; returns the result and the model calls. */
async function submitPlan(plan: Record<string, unknown>) {
  const calls: LanguageModelV3CallOptions[] = [];
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const step: LanguageModelV3GenerateResult = {
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "submit_result",
        input: JSON.stringify(plan),
      },
    ],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      calls.push(options);
      return step;
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
  const planner = profiles.find((p) => p.output === "plan");
  if (!planner) throw new Error("plan profile missing");
  const profile: AgentProfile = { ...planner, model: "openai/fixture-model" };
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
    prompt: "Plan the fixture",
    signal: new AbortController().signal,
    maxSteps: 4,
  };
  return { result: await executor.execute(request), calls };
}

/** A JSON schema object as `zodSchema` renders it. */
type JsonObject = { required?: string[]; properties?: Record<string, JsonObject>; pattern?: string };

/** The JSON schema at a dotted path's parent, and the path's last key. */
function parentOf(schema: JsonObject, path: string): [JsonObject | undefined, string] {
  const keys = path.split(".");
  const last = keys.pop() ?? "";
  return [keys.reduce<JsonObject | undefined>((at, key) => at?.properties?.[key], schema), last];
}

describe("the advertised submit_result schema (#1929)", () => {
  test("no output lists a host-filled field as required or keeps its hash pattern", async () => {
    for (const [output, schema] of Object.entries(outputSchemas)) {
      const shown = (await zodSchema(advertisedSchema(output, schema)).jsonSchema) as JsonObject;
      for (const path of [...(HOST_FIELDS["*"] ?? []), ...(HOST_FIELDS[output] ?? [])]) {
        const [parent, key] = parentOf(shown, path);
        expect({ output, path, required: parent?.required?.includes(key) ?? false }).toEqual({
          output,
          path,
          required: false,
        });
        expect(parent?.properties?.[key]?.pattern).toBeUndefined();
      }
    }
  });

  test("every field fillHostConstants adds is in HOST_FIELDS", () => {
    const listed = (output: string) => [...(HOST_FIELDS["*"] ?? []), ...(HOST_FIELDS[output] ?? [])];
    const analysis = fillHostConstants("analysis", 1, {}) as object;
    expect(Object.keys(analysis).every((key) => listed("analysis").includes(key))).toBe(true);
    const plan = fillHostConstants("plan", 1, { taskGraph: { tasks: [] } }) as {
      taskGraph: object;
    };
    const added = Object.keys(plan.taskGraph).filter((key) => key !== "tasks");
    expect(added.every((key) => listed("plan").includes(`taskGraph.${key}`))).toBe(true);
  });
});

describe("host-known fields of a submitted result", () => {
  test("a plan's schema versions, revision and hashes are filled; a valid hash is kept", () => {
    const plan = withHostConstants("plan", PlanSchema).parse(sloppyPlan()) as {
      schemaVersion: number;
      taskGraph: { schemaVersion: number; revision: number; specHash: string; planHash: string };
    };
    expect(plan.schemaVersion).toBe(1);
    expect(plan.taskGraph).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      specHash: PENDING,
      planHash: PENDING,
    });

    const withHash = sloppyPlan();
    (withHash.taskGraph as Record<string, unknown>).planHash = hashBytes(markdown);
    const kept = withHostConstants("plan", PlanSchema).parse(withHash) as {
      taskGraph: { planHash: string };
    };
    expect(kept.taskGraph.planHash).toBe(hashBytes(markdown));
  });

  test("other results get their schema version and keep their real problems", () => {
    const schema = withHostConstants("research", ResearchSchema);
    const research = { summary: "s", facts: [], unknowns: [], constraints: [], suggestedScope: [] };
    expect(schema.parse({ ...research, schemaVersion: 7 })).toMatchObject({ schemaVersion: 1 });
    expect(schema.safeParse({ ...research, summary: 3 }).success).toBe(false);
  });

  test("submit_result accepts a plan with a wrong schema version", async () => {
    const { result } = await submitPlan(sloppyPlan());
    expect(result.output).toMatchObject({ schemaVersion: 1, taskGraph: { schemaVersion: 1 } });
  });

  test("submit_result shows host fields as optional and accepts a plan without them (#1929)", async () => {
    const plan = sloppyPlan();
    const graph = plan.taskGraph as Record<string, unknown>;
    delete plan.schemaVersion;
    delete graph.schemaVersion;
    delete graph.specHash;
    const { result, calls } = await submitPlan(plan);
    const submit = calls[0]?.tools?.find((t) => t.name === "submit_result");
    const shown = (submit as { inputSchema: JsonObject } | undefined)?.inputSchema;
    expect(shown?.required).not.toContain("schemaVersion");
    expect(shown?.properties?.taskGraph?.required).not.toContain("specHash");
    expect(shown?.properties?.taskGraph?.required).not.toContain("planHash");
    expect(result.output).toMatchObject({
      schemaVersion: 1,
      taskGraph: { schemaVersion: 1, revision: 1, specHash: PENDING, planHash: PENDING },
    });
  });
});

/** A planner whose first session ends on prose the format correction cannot recover. */
class ProsePlanner extends FixtureExecutor {
  planCalls = 0;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan" && this.planCalls++ === 0) {
      this.calls.push("plan");
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `Profile ${request.profile.id} returned invalid output after one format correction`,
        { reason: "prose_end", prose: "I could not make the change: no edit tools here." },
      );
    }
    return super.execute(request);
  }
}

test("a planner that ended on prose is restarted once in a fresh session that sees its prose", async () => {
  const fixture = workflowFixture({ executor: (root) => new ProsePlanner(root) });
  cleanups.push(fixture.dispose);
  const run = await fixture.start();
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  expect(outcome.status).toBe("waiting");
  expect(fixture.executor.planCalls).toBe(2);
  const retried = fixture.executor.prompts.plan?.at(-1) ?? "";
  expect(retried).toContain("previousAttempt");
  expect(retried).toContain("no edit tools here");
});

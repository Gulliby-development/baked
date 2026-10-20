import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { contentHash } from "../src/core/tools/tool-utils.js";
import { deleteHashMatches, NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { fileHash } from "../src/core/workflows/effects.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 16, rotaplan c4ae5074 (#970). The approved plan removes the .NET xUnit
// scaffold placeholder tests/Rotaplan.Tests/UnitTest1.cs with a `delete` write. delete_file wanted
// the file's full SHA-256, but `read` prints only its short content hash, so the implementer could
// never delete it and the run blocked with invalid_output.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const scaffold = "tests/Rotaplan.Tests/UnitTest1.cs";
const scaffoldContent = "namespace Rotaplan.Tests;\n\npublic class UnitTest1\n{\n    [Fact]\n    public void Test1() { }\n}\n";
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [{ ...fixturePolicy.checks[0]!, id: "check", args: ["-e", `if (await Bun.file(${JSON.stringify(scaffold)}).exists()) process.exit(1)`] }],
};
const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
type Step = (prompt: LanguageModelV3Prompt) => LanguageModelV3GenerateResult;

/** Route `openai/*` to a scripted model; each step sees the conversation so far. */
function scriptModel(script: Step[]): string[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const results: string[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") results.push(JSON.stringify(last.content));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next(options.prompt);
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return results;
}

/** The `hash:` footer of the last `read` result in the conversation. */
function readHash(prompt: LanguageModelV3Prompt): string {
  const match = /hash:([0-9a-f]+)/.exec(JSON.stringify(prompt.at(-1)));
  if (!match?.[1]) throw new Error("no read hash in the last tool result");
  return match[1];
}

/** Plans the delete of the scaffold file and runs the implementer through the real executor. */
class DeleteScaffoldExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nRemove the scaffold test.\n## Decisions\nDEC-001: FR-001 removes the placeholder.\n## Components\ntests\n## Data\nNone\n## Verification\nCheck it is gone\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: "Remove the scaffold test", description: `Delete ${scaffold}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: scaffold, action: "delete", reason: "The xUnit scaffold placeholder is replaced by real tests" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

async function runScenario(script: Step[]) {
  const fixture = workflowFixture({ policy, executor: (root) => new DeleteScaffoldExecutor(root) });
  cleanups.push(fixture.dispose);
  mkdirSync(join(fixture.root, "tests/Rotaplan.Tests"), { recursive: true });
  writeFileSync(join(fixture.root, scaffold), scaffoldContent);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const results = scriptModel(script);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  return { fixture, outcome, results };
}

const submit: Step = () =>
  call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: `Deleted ${scaffold}`, evidenceIds: [], unresolved: [] });

describe("scenario: rotaplan c4ae5074, a plan that deletes a scaffold test (#970)", () => {
  test("the implementer deletes the file with the short hash read printed", async () => {
    const { fixture, outcome, results } = await runScenario([
      () => call("read", { files: [{ path: scaffold }] }),
      (prompt) => call("delete_file", { path: scaffold, expectedHash: readHash(prompt) }),
      submit,
    ]);
    expect(results.join("\n")).not.toContain("Delete target changed");
    expect(outcome.status).toBe("completed");
    expect(existsSync(join(fixture.root, scaffold))).toBe(false);
  }, 60000);

  test("a hash that does not match the file refuses the delete", async () => {
    const { fixture, outcome, results } = await runScenario([
      () => call("delete_file", { path: scaffold, expectedHash: contentHash("stale content\n") }),
      () => call("read", { files: [{ path: scaffold }] }),
      (prompt) => call("delete_file", { path: scaffold, expectedHash: readHash(prompt) }),
      submit,
    ]);
    expect(results[0]).toContain("Delete target changed");
    expect(outcome.status).toBe("completed");
    expect(existsSync(join(fixture.root, scaffold))).toBe(false);
  }, 60000);

  test("the implementer deletes the file without an expectedHash", async () => {
    const { fixture, outcome } = await runScenario([() => call("delete_file", { path: scaffold }), submit]);
    expect(outcome.status).toBe("completed");
    expect(existsSync(join(fixture.root, scaffold))).toBe(false);
  }, 60000);
});

describe("delete_file hash check", () => {
  function file() {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const path = join(fixture.root, "UnitTest1.cs");
    writeFileSync(path, scaffoldContent);
    return path;
  }

  test("accepts the short hash read prints", () => {
    const path = file();
    expect(deleteHashMatches(path, contentHash(scaffoldContent))).toBe(true);
  });

  test("accepts the full SHA-256 and a prefix of it of at least 16 characters", () => {
    const path = file();
    const sha = fileHash(path) ?? "";
    expect(sha).toHaveLength(64);
    expect(deleteHashMatches(path, sha)).toBe(true);
    expect(deleteHashMatches(path, sha.slice(0, 16))).toBe(true);
    expect(deleteHashMatches(path, sha.slice(0, 8))).toBe(false);
  });

  test("refuses a hash of other content", () => {
    const path = file();
    expect(deleteHashMatches(path, contentHash("other content\n"))).toBe(false);
    expect(deleteHashMatches(path, "0".repeat(64))).toBe(false);
    expect(deleteHashMatches(join(path, "..", "missing.cs"), contentHash(scaffoldContent))).toBe(false);
  });
});

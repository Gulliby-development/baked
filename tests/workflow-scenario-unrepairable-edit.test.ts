import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { syntaxErrors } from "../src/core/intelligence/syntax-check.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { steeringNotice } from "../src/core/workflows/progress-watch.js";
import { restorableVersion } from "../src/core/workflows/restore-file.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 56 (#1835). hdrlens negotiate T004 wrote `wantErr: "\\"a.txt\\": ..."` into
// pick_test.go with a multi_edit, a double backslash that leaves Go string literals malformed. It
// read lines 60 to 72 five times, was steered and stopped for repeated reads, said it had no edit
// tool, and the restart began from the broken file (0.5M tokens after the bad edit). md-site T005
// did the same with backticks inside a template literal of a TypeScript property test.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

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

/** Route `openai/*` to a scripted model; returns the prompts and tool names it was sent. */
function scriptModel(script: (() => LanguageModelV3GenerateResult)[]) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { prompts: [] as string[], tools: [] as string[][] };
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompts.push(JSON.stringify(options.prompt));
      seen.tools.push((options.tools ?? []).map((t) => t.name));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next();
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return seen;
}

/** Plans one task that creates `path` and runs its implementer through the real executor. */
class EditTaskExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  path = "";
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nTests.\n## Decisions\nDEC-001: FR-001 adds the case.\n## Components\ntests\n## Data\nText\n## Verification\nCheck the tests\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T004", title: "Add the error case", description: `Edit ${this.path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: this.path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

async function runScenario(input: { path: string; restoreFile: "on" | "off"; script: (() => LanguageModelV3GenerateResult)[] }) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    restoreFile: input.restoreFile,
    checks: [{ ...fixturePolicy.checks[0]!, id: "check", args: ["-e", "process.exit(0)"] }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new EditTaskExecutor(root) });
  cleanups.push(fixture.dispose);
  fixture.executor.path = input.path;
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const seen = scriptModel(input.script);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  const content = readFileSync(join(fixture.root, input.path), "utf8");
  return { outcome, seen, content };
}

const PICK = "pick_test.go";
const GO = [
  "package pick",
  "",
  'import "testing"',
  "",
  "func TestPick(t *testing.T) {",
  "\tcases := []struct{ args []string; wantErr string }{",
  '\t\t{[]string{"a.txt", "text/plain"}, ""},',
  "\t}",
  "\t_ = cases",
  "}",
  "",
].join("\n");
const OLD = '\t\t{[]string{"a.txt", "text/plain"}, ""},';
// One level of escaping too deep: `"\\"` closes the literal and leaves `a.txt\\": ...` outside it.
const BAD = `${OLD}\n\t\t{[]string{"a.txt", "text/*"}, "\\\\"a.txt\\\\": invalid offer"},`;
const GOOD = `${OLD}\n\t\t{[]string{"a.txt", "text/*"}, "invalid offer \\"text/*\\""},`;
const submit = () => call("submit_result", { schemaVersion: 1, taskId: "T004", outcome: "implemented", summary: `Added the case to ${PICK}`, evidenceIds: [], unresolved: [] });
const reread = () => call("read", { files: [{ path: PICK }] });
const create = () => call("edit_file", { path: PICK, oldString: "", newString: GO });

describe("scenario: hdrlens negotiate T004, a test file the model cannot repair (#1835)", () => {
  test("the steering names the syntax errors and restore_file; the restored file takes the change and no restart runs", async () => {
    expect((await syntaxErrors(PICK, GO.replace(OLD, BAD))).length).toBeGreaterThan(0);
    const { outcome, seen, content } = await runScenario({
      path: PICK,
      restoreFile: "on",
      script: [
        create,
        () => call("edit_file", { path: PICK, oldString: OLD, newString: BAD }),
        reread,
        reread,
        reread,
        () => call("restore_file", { path: PICK }),
        () => call("edit_file", { path: PICK, oldString: OLD, newString: GOOD }),
        submit,
      ],
    });
    expect(seen.tools[0]).toContain("restore_file");
    // The steering after the third read names the file's errors and the tool.
    const steered = seen.prompts.findIndex((p) => p.includes("Progress watcher"));
    expect(steered).toBe(5);
    expect(seen.prompts[5]).toContain(`Your edits left ${PICK} (${PICK}:`);
    expect(seen.prompts[5]).toContain("call restore_file with the path");
    expect(seen.prompts[6]).toContain(`Restored ${PICK} to its last version that parsed; 1 edit was undone.`);
    expect(outcome.status).toBe("completed");
    // One model call per scripted step: a restart would have asked for more.
    expect(seen.prompts).toHaveLength(8);
    expect(content).toBe(GO.replace(OLD, GOOD));
    expect(await syntaxErrors(PICK, content)).toEqual([]);
  }, 90_000);

  test("off, as by default, the tool is absent and the steering is the generic one", async () => {
    const { seen } = await runScenario({
      path: PICK,
      restoreFile: "off",
      script: [
        create,
        () => call("edit_file", { path: PICK, oldString: OLD, newString: BAD }),
        reread,
        reread,
        reread,
        () => call("edit_file", { path: PICK, oldString: BAD, newString: GOOD }),
        submit,
      ],
    });
    expect(seen.tools[0]).not.toContain("restore_file");
    expect(seen.prompts[5]).toContain("Progress watcher");
    expect(seen.prompts[5]).not.toContain("restore_file");
  }, 90_000);
});

const PROPERTY = "tests/markdown.property.test.ts";
const TS = 'import { test } from "bun:test";\n\nconst cases = [\n  "plain",\n];\n\ntest("cases", () => void cases);\n';
const TS_OLD = '  "plain",';
// md-site T005: inline code inside a template literal, its backticks escaped one level too deep.
const TS_BAD = `${TS_OLD}\n  \`see \\\\\`code\\\\\` here\`,`;
const TS_GOOD = `${TS_OLD}\n  \`see \\\`code\\\` here\`,`;

describe("scenario: md-site T005, backticks in a TypeScript template literal (#1835)", () => {
  test("multi_edits that leave the literal broken are undone by restore_file", async () => {
    expect((await syntaxErrors(PROPERTY, TS.replace(TS_OLD, TS_BAD))).length).toBeGreaterThan(0);
    expect(await syntaxErrors(PROPERTY, TS.replace(TS_OLD, TS_GOOD))).toEqual([]);
    const read = () => call("read", { files: [{ path: PROPERTY, lineStart: 4, lineEnd: 4 }] });
    const { outcome, seen, content } = await runScenario({
      path: PROPERTY,
      restoreFile: "on",
      script: [
        () => call("edit_file", { path: PROPERTY, oldString: "", newString: TS }),
        () => call("multi_edit", { path: PROPERTY, edits: [{ oldString: TS_OLD, newString: TS_BAD }] }),
        read,
        read,
        read,
        () => call("restore_file", { path: PROPERTY }),
        () => call("multi_edit", { path: PROPERTY, edits: [{ oldString: TS_OLD, newString: TS_GOOD }] }),
        () => call("submit_result", { schemaVersion: 1, taskId: "T004", outcome: "implemented", summary: `Added the case to ${PROPERTY}`, evidenceIds: [], unresolved: [] }),
      ],
    });
    expect(seen.prompts[5]).toContain(`Your edits left ${PROPERTY} (${PROPERTY}:`);
    expect(seen.prompts[6]).toContain("1 edit was undone");
    expect(outcome.status).toBe("completed");
    expect(content).toBe(TS.replace(TS_OLD, TS_GOOD));
  }, 90_000);
});

describe("restorableVersion (#1835)", () => {
  // The task's edits of one file across its attempts: the restart began from the broken file, so
  // its own first pre-image does not parse and the version before the bad edit is the one back.
  const kept = new Map<string, string>();
  const keep = (text: string) => {
    const hash = hashBytes(Buffer.from(text));
    kept.set(`pre-images/${hash}`, text);
    return hash;
  };
  const created = null;
  const good = keep(GO);
  const bad = keep(GO.replace(OLD, BAD));
  const edit = (attempt: string, before: string | null, path = PICK) => ({
    id: crypto.randomUUID(), attempt_id: attempt, kind: "file_patch" as const, status: "applied" as const, intent_json: JSON.stringify({ path, tool: "edit_file" }), before_hash: before, after_hash: null,
  });
  const store = (effects: ReturnType<typeof edit>[]) =>
    ({
      attemptTaskGenerations: () => new Map([["a0", { taskId: "T004", generation: 0 }], ["a1", { taskId: "T004", generation: 0 }], ["other", { taskId: "T002", generation: 0 }]]),
      effects: () => effects,
      latestArtifact: (_run: string, path: string) => (kept.has(path) ? { id: path } : null),
      readArtifact: (_run: string, id: string) => kept.get(id) ?? "",
    }) as unknown as Parameters<typeof restorableVersion>[0];
  const input = { runId: "r", root: "", path: PICK, taskId: "T004", attemptId: "a1" };

  test("the newest pre-image that parses, across the task's attempts", async () => {
    const version = await restorableVersion(store([edit("a0", created), edit("a0", good), edit("a1", bad), edit("a1", bad)]), input);
    expect(version).toMatchObject({ editsUndone: 3 });
    expect("content" in version && version.content.toString("utf8")).toBe(GO);
  });

  test("another task's edits do not count, and a file the task created with no parsing version is written again", async () => {
    expect(await restorableVersion(store([edit("other", good)]), input)).toEqual({ reason: `This task has not edited ${PICK}; edit it instead.` });
    expect(await restorableVersion(store([edit("a0", created), edit("a1", bad)]), input)).toEqual({
      reason: `${PICK} did not exist before this task and no version of it parsed; write it again with write_file.`,
    });
  });

  test("the steering names at most three files and three errors each", () => {
    const notice = steeringNotice({ signal: "repeated-reads", detail: "read was called 3 times" }, [{ path: PICK, errors: ["a:1:1: x", "a:2:1: y", "a:3:1: z", "a:4:1: w"] }]);
    expect(notice).toContain(`Your edits left ${PICK} (a:1:1: x; a:2:1: y; a:3:1: z) not parsing`);
    expect(steeringNotice({ signal: "unchecked-spend", detail: "50%" }, [{ path: PICK, errors: ["a:1:1: x"] }])).not.toContain("restore_file");
  });
});

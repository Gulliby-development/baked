import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { intentRoot, runRootPath } from "../src/core/workflows/effects.js";
import { refusalInRunRoot, refusedEditAdvice } from "../src/core/workflows/refused-edit.js";
import { taskWritesElsewhere } from "../src/core/workflows/rollback.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// #2928: bench round 99 skillseek (Ruby, RSpec) terms-score fb6cd52c T004. The host declined to
// write the task's row file, so a session edited the spec files in the run root and stopped
// unfinished (there at its cap, `continue_at_cap`). The task was no longer pending, so its
// continuation ran in a batch worker whose worktree is cut from the run root's content and holds
// the first session's edits. The edit guard looked for the task's own writes in that root only,
// found none, compared each file with the pre-task baseline and refused every file the first
// session had changed ("File changed outside this attempt"); after three refusals the run
// blocked and offered `--accept-workspace`, which refuses a task worktree's refusal. The guard
// now reads the task's writes in every root (`taskWritesElsewhere`), and the advice of a refusal
// in a task worktree is resume or revise.

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

/** Route `openai/*` to a scripted model; returns the prompts it was sent. */
function scriptModel(script: (() => LanguageModelV3GenerateResult)[]) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const seen = { prompts: [] as string[] };
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      seen.prompts.push(JSON.stringify(options.prompt));
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

interface SplitShape {
  /** The prescribed row file: a scaffold with no row, so the host cannot read the row form. */
  path: string;
  scaffold: string;
  /** The request's fenced row block, header first. */
  block: string[];
  /** The file once the first session placed row 1, and once every row is placed. */
  first: string;
  written: string;
}

// skillseek (Ruby, RSpec): `spec/terms_spec.rb` rows in a `ROWS = [` list.
const rubyRows = (rows: string[]) =>
  ['require "terms"', "", "ROWS = [", ...rows.map((r) => `  ${r},`), "].freeze", "", "RSpec.describe Terms do", "  ROWS.each { |input, out| it(input) { expect(Terms.score(input)).to eq(out) } }", "end", ""].join("\n");
const RUBY_ROWS = ['["ruby rails", 2]', '["", 0]', '["go go", 1]'];
const SKILLSEEK: SplitShape = {
  path: "spec/terms_spec.rb",
  scaffold: rubyRows([]),
  block: ["TermsRows in spec/terms_spec.rb (3 rows, [input, out])", ...RUBY_ROWS],
  first: rubyRows(RUBY_ROWS.slice(0, 1)),
  written: rubyRows(RUBY_ROWS),
};

// A TypeScript bun rows file (the bun rows template).
const tsRows = (rows: string[]) =>
  ['import { expect, test } from "bun:test";', 'import { score } from "../src/terms";', "", "const rows: [string, number][] = [", ...rows.map((r) => `  ${r},`), "];", "", "for (const [input, out] of rows) test(input, () => expect(score(input)).toBe(out));", ""].join("\n");
const TS_ROWS = ['["ts bun", 2]', '["", 0]', '["a a", 1]'];
const TERMS_TS: SplitShape = {
  path: "tests/terms.test.ts",
  scaffold: tsRows([]),
  block: ["TermsRows in tests/terms.test.ts (3 rows, [input, out])", ...TS_ROWS],
  first: tsRows(TS_ROWS.slice(0, 1)),
  written: tsRows(TS_ROWS),
};

/** One task that writes the row file and the code, run through the real executor in a Git repo. */
class SplitExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  constructor(
    workspace: string,
    private shape: SplitShape,
  ) {
    super(workspace);
    mkdirSync(dirname(join(workspace, shape.path)), { recursive: true });
    writeFileSync(join(workspace, shape.path), shape.scaffold);
    writeFileSync(join(workspace, ".gitignore"), ".baked/\n");
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.name", "Test User"], ["config", "user.email", "test@example.test"], ["config", "commit.gpgsign", "false"], ["config", "core.autocrlf", "false"], ["add", "."], ["commit", "-q", "-m", "Initial"]]) {
      const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nRows.\n## Decisions\nDEC-001: FR-001 takes the rows.\n## Components\ntests\n## Data\nText\n## Verification\nCheck the rows\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{
            id: "T001", title: "Terms score", description: `Place the prescribed rows in ${this.shape.path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer",
            writes: [{ path: this.shape.path, action: "modify", reason: "the request prescribes its rows" }],
            readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior",
          }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

const requestOf = (shape: SplitShape) =>
  ["Score the terms.", "", "The prescribed rows, one test each:", "", "```text", ...shape.block, "```", ""].join("\n");
const rowsCheck = (shape: SplitShape) => ({
  id: "rows",
  executable: "bun",
  args: ["-e", `const t = await Bun.file(${JSON.stringify(shape.path)}).text(); const rows = ${JSON.stringify(shape.block.slice(1))}; if (!rows.every((r) => t.includes(r))) { console.log("a row differs"); process.exit(1); }`],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
});
/** An edit of the row file from one of its states to another: the session types the rows. */
const edit = (shape: SplitShape, from: string, to: string) => () => call("edit_file", { path: shape.path, oldString: from, newString: to });
const submit = (unresolved: string[]) => () =>
  call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Scored the terms", evidenceIds: [], unresolved });

/**
 * The first session edits the code and places the rows in the run root, then ends unfinished;
 * under clarification `assume` the host restarts the task, and with two writers the restart runs
 * in a batch worker cut from the run root's content (#2585's route). `retry` is that session.
 */
interface SplitContext {
  /** The batch worker's root, absolute, and as an intent root (relative to the project). */
  worker: () => string;
  workerRoot: () => string;
  store: ReturnType<typeof workflowFixture>["service"]["store"];
  runId: () => string;
}

async function rootSplit(shape: SplitShape, retry: (context: SplitContext) => (() => LanguageModelV3GenerateResult)[]) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [rowsCheck(shape)], rowFileWrite: "on", clarification: "assume" };
  const fixture = workflowFixture({ policy, executor: (root) => new SplitExecutor(root, shape) });
  cleanups.push(fixture.dispose);
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  let runId = "";
  const store = fixture.service.store;
  const workerRoot = () => `${runRootPath(store, runId).replace(/[/\\][^/\\]+$/, "")}/T001`;
  const worker = () => join(fixture.root, workerRoot());
  const seen = scriptModel([
    edit(shape, shape.scaffold, shape.first),
    submit(["rows 2 and 3 are still to place"]),
    ...retry({ worker, workerRoot, store, runId: () => runId }),
  ]);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: requestOf(shape), ownerLabel: "test", policy, executionMode: "worktree", maxConcurrentWriters: 2 });
  runId = run.runId;
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const edits = store
    .effects(run.runId)
    .filter((e) => e.kind === "file_patch" && (JSON.parse(e.intent_json) as { path: string; tool?: string }).path === shape.path && (JSON.parse(e.intent_json) as { tool?: string }).tool === "edit_file")
    .map((e) => ({ root: intentRoot(e.intent_json), status: e.status }));
  const errors = store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith("errors/"))
    .map((a) => store.readArtifact(run.runId, a.id));
  return { fixture, store, runId: run.runId, current, edits, errors, seen };
}

describe("scenario: R99 skillseek, a task continued in a batch worker keeps its own edits (#2928)", () => {
  for (const [language, shape] of [["ruby", SKILLSEEK], ["typescript", TERMS_TS]] as const)
    test(`${language}: the continuation edits the file its first session changed in the run root, and the run completes`, async () => {
      const { store, runId, current, edits, errors, fixture } = await rootSplit(shape, () => [edit(shape, shape.first, shape.written), submit([])]);
      const runRoot = runRootPath(store, runId);
      // The first edit in the run root, the continuation's in the batch worker; neither refused.
      expect(edits.map((e) => e.root === runRoot)).toEqual([true, false]);
      expect(edits.every((e) => e.status === "applied" || e.status === "reconciled")).toBe(true);
      expect(errors.filter((e) => e.includes("File changed outside this attempt"))).toEqual([]);
      expect(current.status).toBe("completed");
      expect(readFileSync(join(fixture.root, runRoot, shape.path), "utf8")).toBe(shape.written);
    }, 120000);

  test("ruby: a change in the worker root that no write of the task made is still refused, and the stop offers resume and revise, not accept-workspace", async () => {
    const shape = SKILLSEEK;
    const outside = shape.first.replace("ROWS = [", "# edited by hand\nROWS = [");
    const { store, runId, current } = await rootSplit(shape, ({ worker }) => [
      () => {
        writeFileSync(join(worker(), shape.path), outside);
        return edit(shape, outside, shape.written)();
      },
      edit(shape, outside, shape.written),
      edit(shape, outside, shape.written),
      submit([]),
    ]);
    expect(current.status).toBe("blocked");
    const run = store.run(runId);
    expect(run.reason).toBe("input_changed");
    const diagnostic = store.artifacts(runId).filter((a) => a.logical_path.startsWith("errors/")).at(-1);
    const text = diagnostic ? store.readArtifact(runId, diagnostic.id) : "";
    expect(text).toContain("File changed outside this attempt");
    expect(text).toContain("rebuilt from the run root on resume");
    expect(text).not.toContain("--accept-workspace");
  }, 120000);
});

describe("taskWritesElsewhere and the refused-edit advice (#2928)", () => {
  test("a refusal in the run root keeps accept-workspace; one in a task worktree does not", () => {
    const state = { worktree: { path: ".baked/worktrees/r/main" } } as Parameters<typeof refusalInRunRoot>[0];
    expect(refusalInRunRoot(state, ".baked/worktrees/r/main")).toBe(true);
    expect(refusalInRunRoot(state, ".baked/worktrees/r/T004")).toBe(false);
    expect(refusalInRunRoot({ worktree: null } as unknown as Parameters<typeof refusalInRunRoot>[0], "")).toBe(true);
    const advice = (runRoot: boolean) => refusedEditAdvice({ runId: "r", attemptId: "a", path: "spec/cli_spec.rb", count: 3, root: ".baked/worktrees/r/T004", runRoot });
    expect(advice(true).remedies.map((r) => r.action)).toEqual(["accept-workspace"]);
    expect(advice(true).message).toContain("--accept-workspace");
    expect(advice(false).remedies.map((r) => r.action)).toEqual(["resume", "revise"]);
    expect(advice(false).message).not.toContain("--accept-workspace");
  });

  test("the task's writes in another root are its own; this root's and another task's are not", async () => {
    const shape = SKILLSEEK;
    const seen: Record<string, (string | null)[]> = {};
    const { current } = await rootSplit(shape, ({ workerRoot, store, runId }) => [
      () => {
        // In the continuation, before its first edit: the first session wrote in the run root.
        const hashes = (root: string, task = "T001") => [...taskWritesElsewhere(store, runId(), task, shape.path, root)];
        seen.worker = hashes(workerRoot());
        seen.runRoot = hashes(runRootPath(store, runId()));
        seen.otherTask = hashes(workerRoot(), "T999");
        return edit(shape, shape.first, shape.written)();
      },
      submit([]),
    ]);
    expect(current.status).toBe("completed");
    // The scaffold's hash before the first session's edit and the hash after it.
    expect(seen.worker).toEqual([hashBytes(shape.scaffold), hashBytes(shape.first)]);
    expect(seen.runRoot).toEqual([]);
    expect(seen.otherTask).toEqual([]);
  }, 120000);
});

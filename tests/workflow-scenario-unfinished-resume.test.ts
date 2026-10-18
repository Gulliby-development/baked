import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { addsDoubledEscapes, ESCAPE_HINT, escapeHintFor } from "../src/core/workflows/escape-hint.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { DEFAULT_STALL_SETTINGS } from "../src/core/workflows/stall.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 43, md-site 5d69c69e (#1516): T002 attempt 1 edited src/markdown.ts,
// was stopped by the progress watcher and submitted `blocked`, claiming it had no edit tool.
// Its restart ended unfinished too, so the run blocked `invalid_output` for 27 minutes until an
// operator ran the plain resume, whose attempt finished the task.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const LOST_TOOL =
  "This execution exposes no BAKED edit_file or multi_edit tool, so I cannot make the required correction";
const LEFT = "Correct the remaining over-escaped patterns, then run typecheck";

type Attempt = (request: ExecutionRequest) => unknown;

/** Scripted implementation attempts; the base executor finishes the task once the script runs out. */
class UnfinishedExecutor extends FixtureExecutor {
  implementations = 0;
  requests: ExecutionRequest[] = [];
  edit?: (request: ExecutionRequest, write: () => void) => Promise<unknown>;
  constructor(
    private dir: string,
    private attempts: Attempt[],
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    this.requests.push(request);
    const attempt = this.attempts[this.implementations++];
    if (attempt === undefined) return super.execute(request);
    // Through the attempt's tool guard, as a model's edit_file call: the edit is journaled.
    await this.edit?.(request, () => writeFileSync(join(this.dir, "value.txt"), "partial"));
    return { output: attempt(request), inputTokens: 25, outputTokens: 25 };
  }
}

const result = (request: ExecutionRequest, outcome: string, summary: string, unresolved: string[]) => ({
  schemaVersion: 1,
  taskId: request.task?.id,
  outcome,
  summary,
  evidenceIds: [],
  unresolved,
});

type Holder = { store?: ReturnType<typeof workflowFixture>["service"]["store"] };

async function drive(
  attempts: Attempt[],
  policy: RunPolicy = { ...fixturePolicy, clarification: "assume" },
  held: Holder = {},
) {
  const fixture = workflowFixture({ policy, executor: (root) => new UnfinishedExecutor(root, attempts) });
  cleanups.push(fixture.dispose);
  held.store = fixture.service.store;
  (fixture.executor as UnfinishedExecutor).edit = (request, write) => {
    const runPolicy = JSON.parse(fixture.service.store.run(request.runId).policy_json) as RunPolicy;
    return new WorkflowToolPolicy(
      fixture.service.store,
      fixture.service.leases,
      request.runId,
      request.attemptId,
      request.profile,
      runPolicy,
      request.task,
      fixture.root,
      DEFAULT_STALL_SETTINGS,
    ).execute("edit_file", { path: "value.txt" }, async () => {
      write();
      return { success: true };
    });
  };
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  const store = fixture.service.store;
  const read = (path: string) => {
    const artifact = store.latestArtifact(run.runId, path);
    return artifact ? store.readArtifact(run.runId, artifact.id) : null;
  };
  return { fixture, run, outcome, read, executor: fixture.executor as UnfinishedExecutor };
}

describe("scenario: md-site 5d69c69e, a task unfinished after its restart (#1516)", () => {
  test("the run resumes itself once and the next session starts from the stopped attempt", async () => {
    const { outcome, executor, read } = await drive([
      (request) => result(request, "blocked", LOST_TOOL, [LEFT]),
      (request) => result(request, "implemented", "Fixed two of the patterns", [LEFT]),
    ]);
    expect(executor.implementations).toBe(3);
    expect(outcome.status).toBe("completed");
    expect(JSON.parse(read("unfinished/resume-1.json") ?? "{}")).toMatchObject({ attempt: 1, taskId: "T001" });

    // The restart told the session that it has the edit tools its predecessor used.
    const restartPrompt = JSON.stringify(executor.requests[1]);
    expect(restartPrompt).toContain("although it edited value.txt with them");
    // The resumed session starts from the attempt that blocked, not from the first one.
    const resumed = executor.requests[2] as unknown as { previousAttempt?: { summary: string; unresolved: string[] } };
    expect(JSON.stringify(resumed)).toContain("Fixed two of the patterns");
    expect(JSON.stringify(resumed)).toContain(LEFT);
  }, 60000);

  test("a task that stays unfinished after the one resume blocks the run", async () => {
    const left = (request: ExecutionRequest) => result(request, "implemented", "Still partial", [LEFT]);
    const { outcome, executor, read } = await drive([left, left, left, left]);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("invalid_output");
    expect(executor.implementations).toBe(3);
    expect(read("unfinished/resume-1.json")).not.toBeNull();
    expect(read("unfinished/resume-2.json")).toBeNull();
  }, 60000);

  test("a pending request still holds the run for a person", async () => {
    const left = (request: ExecutionRequest) => result(request, "implemented", "Still partial", [LEFT]);
    const held: Holder = {};
    const { outcome, executor, read } = await drive(
      [
        left,
        (request) => {
          const store = held.store;
          store?.transaction(() => store.request(request.runId, "clarification", "b".repeat(64), { questions: [] }));
          return left(request);
        },
      ],
      undefined,
      held,
    );
    expect(held.store).toBeDefined();
    expect(outcome.status).toBe("blocked");
    expect(executor.implementations).toBe(2);
    expect(read("unfinished/resume-1.json")).toBeNull();
  }, 60000);

  test("a schema-invalid output still blocks", async () => {
    const { outcome, read } = await drive(
      [() => ({ schemaVersion: 1, outcome: "implemented" }), () => ({ schemaVersion: 1, outcome: "implemented" })],
      fixturePolicy,
    );
    expect(outcome.status).toBe("blocked");
    expect(read("unfinished/resume-1.json")).toBeNull();
  }, 60000);
});

describe("escape hint after a syntax error (#1516)", () => {
  test("an edit that adds doubled backslashes in a TypeScript regex literal", () => {
    expect(addsDoubledEscapes({ oldString: "", newString: "const link = /\\\\[(.*?)\\\\]/;" })).toBe(true);
    expect(addsDoubledEscapes({ oldString: "const link = /\\[(.*?)\\]/;", newString: "const link = /\\[(.+?)\\]/;" })).toBe(false);
    expect(addsDoubledEscapes({ edits: [{ oldString: "x", newString: "re = /\\\\d+/" }] })).toBe(true);
    const tsc = "src/markdown.ts(17,28): error TS1508: Unexpected ']'. Did you mean '&rbrack;'?";
    expect(escapeHintFor(tsc, true)).toBe(ESCAPE_HINT);
    expect(escapeHintFor(tsc, false)).toBeNull();
    expect(escapeHintFor("src/markdown.ts(4,1): error TS2322: Type 'string' is not assignable", true)).toBeNull();
  });

  test("an edit that adds doubled backslashes in a Python string literal", () => {
    expect(addsDoubledEscapes({ content: 'PATTERN = re.compile(r"\\\\d+\\\\.\\\\d+")\n' })).toBe(true);
    const python = '  File "app/parse.py", line 3\n    PATTERN = "\\\\"\nSyntaxError: unterminated string literal (detected at line 3)';
    expect(escapeHintFor(python, true)).toBe(ESCAPE_HINT);
    expect(escapeHintFor("AssertionError: 2 != 3", true)).toBeNull();
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import { misquoteFixDecision, misquoteFixPlan } from "../src/core/workflows/misquote-fix.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { replayMisquoteFixes } from "../src/core/workflows/trace.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 66, nodepluck eval T004 (#2047). AC-007 gives a query of eleven `[0]`
// segments; the test task wrote ten, saw the code accept the query and reported spec_conflict. The
// host settled it as a misquote (`assumptions/conflicts/T004-misquoted.json`), and a fresh
// implementer session on the full task prompt (1.23M tokens, 28 steps) changed that one literal.
// With `misquoteFix: "on"` the host makes the exact replacement itself, runs the task's required
// checks on it and goes on with the task; a session opens only when a check fails.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const ELEVEN = `$${"[0]".repeat(11)}`;
const TEN = `$${"[0]".repeat(10)}`;
const ERROR = "depth limit exceeded at segment 11";
const TEST = "tests/evaluate.test.ts";
const tsTest = (query: string, extra = "") =>
  `import { expect, test } from "bun:test";\nimport { evaluate } from "../src/evaluate";\n\ntest("rejects a query past the depth limit", () => {\n  expect(() => evaluate("${query}")).toThrow("${ERROR}");\n});\n${extra}`;

const spec: Spec = {
  ...fixtureSpec,
  requirements: [...fixtureSpec.requirements, { id: "FR-007", text: "A query deeper than ten segments is rejected", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-007", requirementIds: ["FR-007"], given: `the query \`${ELEVEN}\``, when: "it is evaluated", then: `it fails with \`${ERROR}\``, method: "automated" },
  ],
};

/** The task's own check: the code is in place and the test holds the eleven-segment row. */
const unitCheck = (requireReady: boolean): RunPolicy["checks"][number] => ({
  id: "unit",
  executable: "bun",
  args: [
    "-e",
    `const t = await Bun.file(${JSON.stringify(TEST)}).text(); const v = await Bun.file("value.txt").text(); if (!t.includes(${JSON.stringify(ELEVEN)})${requireReady ? ` || v !== "ready"` : ""}) process.exit(1)`,
  ],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task",
  envNames: [],
  writes: [],
});

interface Scenario {
  misquoteFix?: "on";
  /** What the first session writes into the test. */
  first: string;
  /** What the first session writes into value.txt (the unit check wants `ready`). */
  value?: string;
  clarification?: RunPolicy["clarification"];
  /** A task worktree with several writers: the batch worker settles the conflict. */
  parallel?: boolean;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

async function conflict(scenario: Scenario) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    clarification: scenario.clarification ?? "ask",
    checks: [...fixturePolicy.checks, unitCheck(true)],
    ...(scenario.misquoteFix ? { misquoteFix: scenario.misquoteFix } : {}),
  };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.specHash = hashJson(spec);
      graph.tasks = [{ ...code, id: "T004", criterionIds: ["AC-001", "AC-007"], checkIds: ["unit"], writes: [...code.writes, { path: TEST, action: "create" }] }];
      return out;
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const out = await original(request);
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-007" }))];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    prompts.push(request.prompt);
    mkdirSync(join(work, dirname(TEST)), { recursive: true });
    if (/Settled spec conflict/.test(request.prompt)) {
      writeFileSync(join(work, "value.txt"), "ready");
      writeFileSync(join(work, TEST), tsTest(ELEVEN));
      return { output: { schemaVersion: 1, taskId: "T004", outcome: "implemented", summary: "The test copies the row as written", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    writeFileSync(join(work, "value.txt"), scenario.value ?? "ready");
    writeFileSync(join(work, TEST), scenario.first);
    return {
      output: {
        schemaVersion: 1,
        taskId: "T004",
        outcome: "spec_conflict",
        summary: `AC-007 requires ${JSON.stringify(ERROR)} for the query ${TEN}, but the evaluator accepts it: the limit counts eleven segments.`,
        evidenceIds: [],
        unresolved: ["Which depth is right?"],
        conflictSides: [{ kind: "criterion", ref: "AC-007", quote: `the query ${TEN}` }],
      },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  if (scenario.parallel) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    writeFileSync(join(root, "README.md"), "# Query\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
  }
  const run = scenario.parallel
    ? await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy, executionMode: "worktree", maxConcurrentWriters: 2 })
    : await fixture.start();
  for (let i = 0; i < 10; i++) {
    const current = await service.get(run.runId);
    if (["completed", "blocked", "failed"].includes(current.status)) break;
    const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
    if (pending?.kind === "approval") await fixture.approve(run.runId);
    else if (pending) break;
    else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(run.runId, artifact.id)) : null;
  };
  const status = (await service.get(run.runId)).status;
  // A run that did not finish shows why: its error diagnostics and host-error stacks.
  if (status !== "completed")
    for (const a of service.store.artifacts(run.runId))
      if (a.logical_path.startsWith("errors/") || a.logical_path.startsWith("host-errors/"))
        console.error(`[misquote-host-fix] ${a.logical_path}: ${service.store.readArtifact(run.runId, a.id)}`);
  return {
    status,
    asked: service.store.requests(run.runId).filter((r) => r.kind === "clarification"),
    sessions: prompts.length,
    read,
    test: scenario.parallel ? "" : readFileSync(join(root, TEST), "utf8"),
    edits: service.store.effects(run.runId).filter((e) => e.kind === "file_patch" && (JSON.parse(e.intent_json) as { path: string }).path === TEST),
    replay: replayMisquoteFixes(service.store, run.runId),
  };
}

describe("scenario: nodepluck eval T004, a misquote conflict settled without a second session (#2047)", () => {
  test("with misquoteFix on, the host replaces the misquoted literal, the task's checks pass, and no session opens", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN) });
    expect(result.sessions).toBe(1);
    expect(result.asked).toEqual([]);
    expect(result.test).toBe(tsTest(ELEVEN));
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({
      taskId: "T004",
      mode: "on",
      apply: true,
      reason: null,
      checks: "passed",
      files: [TEST],
      sites: [{ criterionId: "AC-007", occurrences: 1, unescaped: true, plain: true, held: true }],
    });
    expect(result.read("assumptions/conflicts/T004-misquoted.json")).toMatchObject({ hostFix: [TEST], misquoted: [{ id: "AC-007", literal: ELEVEN, quoted: TEN }] });
    // A journaled host edit of the attempt, with its pre-image.
    expect(result.edits.length).toBeGreaterThan(0);
    expect(result.replay).toEqual([{ taskId: "T004", mode: "on", recorded: true, replayed: true, reason: null, checks: "passed" }]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a failing check on the host's edit puts it back and opens the session as before", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN), value: "draft" });
    expect(result.sessions).toBe(2);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ apply: true, checks: "failed", files: [TEST] });
    expect(result.read("assumptions/conflicts/T004-misquoted.json")?.hostFix).toBeUndefined();
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a spelling the test holds twice is ambiguous: the session corrects the test", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN, `\ntest("the same query again", () => {\n  expect(() => evaluate("${TEN}")).toThrow();\n});\n`) });
    expect(result.sessions).toBe(2);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ apply: false, checks: null, reason: "the test's spelling of AC-007's literal occurs 2 times, so the replacement is ambiguous" });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("without the policy field the decision is shadow: recorded, and the session opens", async () => {
    const result = await conflict({ first: tsTest(TEN) });
    expect(result.sessions).toBe(2);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ mode: "shadow", apply: true, checks: null, files: [] });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("in a task worktree with several writers too", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN), parallel: true });
    expect(result.sessions).toBe(1);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ mode: "on", apply: true, checks: "passed", files: [TEST] });
    expect(result.read("assumptions/conflicts/T004-misquoted.json")).toMatchObject({ hostFix: [TEST] });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("in a task worktree, a failing check puts the edit back and the conflict is settled once", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN), value: "draft", parallel: true });
    expect(result.sessions).toBe(2);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ checks: "failed" });
    expect(result.status).toBe("completed");
  }, 90_000);

  test("under clarification assume the request decision comes first and the misquote is still fixed on the host", async () => {
    const result = await conflict({ misquoteFix: "on", first: tsTest(TEN), clarification: "assume" });
    expect(result.sessions).toBe(1);
    expect(result.read("conflicts/misquote/T004.json")).toMatchObject({ checks: "passed" });
    expect(result.status).toBe("completed");
  }, 90_000);
});

describe("the exact replacement in each language's test spelling (#2047)", () => {
  const forms: [string, (query: string) => string][] = [
    ["C#", (q) => `[Theory]\n[InlineData("${q}")]\npublic void Rejects(string query) => Assert.Throws<DepthError>(() => Evaluate(query));\n`],
    ["Go", (q) => `var cases = []struct{ query string }{\n\t{"${q}"},\n}\n`],
    ["Java", (q) => `@ParameterizedTest\n@ValueSource(strings = {"${q}"})\nvoid rejects(String query) {}\n`],
    ["Python", (q) => `@pytest.mark.parametrize("query", ["${q}"])\ndef test_rejects(query):\n    with pytest.raises(DepthError):\n        evaluate(query)\n`],
    ["Rust", (q) => `const CASES: &[&str] = &["${q}"];\n`],
    ["TypeScript", (q) => `test.each([["${q}"]])("rejects %s", (query) => {});\n`],
  ];
  const misquote = { id: "AC-007", literal: ELEVEN, quoted: TEN };
  for (const [name, form] of forms)
    test(`${name}: the one spelling is replaced and the test then holds the row as written`, () => {
      const plan = misquoteFixPlan([misquote], [{ path: "t", text: form(TEN) }]);
      expect(misquoteFixDecision(plan.sites)).toEqual({ apply: true, reason: null });
      expect(plan.edits).toEqual([{ path: "t", before: form(TEN), after: form(ELEVEN) }]);
    });

  test("an escaped spelling, a literal that needs escaping and a missing spelling are left to a session", () => {
    const escaped = misquoteFixPlan([{ id: "AC-005", literal: String.raw`s/(a)/&\1\n\t\!\0/`, quoted: String.raw`s/(a)/&\\1\\n\\t\\0/` }], [{ path: "t", text: String.raw`["s/(a)/&\\1\\n\\t\\0/"]` }]);
    expect(misquoteFixDecision(escaped.sites).reason).toBe("the test spells AC-005's literal with escapes the host does not rewrite");
    const quote = misquoteFixPlan([{ id: "AC-002", literal: 'say "hi" now', quoted: "say hi now" }], [{ path: "t", text: '["say hi now"]' }]);
    expect(misquoteFixDecision(quote.sites).reason).toBe("AC-002's literal has characters a string literal may need to escape or interpolate");
    const template = misquoteFixPlan([{ id: "AC-003", literal: "total ${n} items", quoted: "total n items" }], [{ path: "t", text: "[`total n items`]" }]);
    expect(misquoteFixDecision(template.sites).apply).toBe(false);
    const absent = misquoteFixPlan([misquote], [{ path: "t", text: "nothing here" }]);
    expect(misquoteFixDecision(absent.sites).reason).toBe("the test's spelling of AC-007's literal is not in its test files");
    expect(misquoteFixDecision([]).reason).toBe("no misquoted literal");
  });

  test("a spelling in two files counts as two", () => {
    const plan = misquoteFixPlan([misquote], [{ path: "a", text: `"${TEN}"` }, { path: "b", text: `"${TEN}"` }]);
    expect(plan.sites[0]?.occurrences).toBe(2);
    expect(plan.edits).toEqual([]);
  });
});

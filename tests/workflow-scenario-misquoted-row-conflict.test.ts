import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import { testsHold } from "../src/core/verification/criteria-cases.js";
import { contestedRows, misquotation } from "../src/core/workflows/conflict-rows.js";
import type { Analysis, RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 51, sedstep 78dabd21 `sedstep_script` T006 (#1709). AC-005 gives the
// script `s/(a)/&\1\n\t\!\0/` and the error `unsupported escape \0 at line 1 column 16`, and the
// derivation audit verified the row. The test task copied the input without `\!`, saw column 14,
// and reported spec_conflict quoting its own copy. The run asked a person with only that
// paraphrase; the person overruled the row, the case walk still demanded `column 16`, and the
// task ran three generations (910k tokens).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const INPUT = String.raw`s/(a)/&\1\n\t\!\0/`;
const DROPPED = String.raw`s/(a)/&\1\n\t\0/`;
const ERROR16 = String.raw`unsupported escape \0 at line 1 column 16`;
const ERROR14 = String.raw`unsupported escape \0 at line 1 column 14`;
const TEST = "tests/Sedstep.Tests/Script/ParserTests.cs";
/** C# source escapes each backslash once. */
const cs = (text: string) => text.replaceAll("\\", "\\\\");
const csTest = (input: string, error: string) =>
  `public class ParserTests\n{\n    [Theory]\n    [InlineData("${cs(input)}", "${cs(error)}")]\n    public void RejectsZeroEscape(string script, string error) => Assert.Equal(error, Parser.Fail(script));\n}\n`;

const spec: Spec = {
  ...fixtureSpec,
  requirements: [...fixtureSpec.requirements, { id: "FR-003", text: "An unsupported replacement escape is an error at its backslash", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-005", requirementIds: ["FR-003"], given: `the script \`${INPUT}\``, when: "the parser reads it", then: `it fails with \`${ERROR16}\``, method: "automated" },
  ],
};
const derivation = (matches: boolean): NonNullable<Analysis["derivations"]>[number] => ({
  criterionId: "AC-005",
  row: `${INPUT} -> ${ERROR16}`,
  recomputed: matches ? "column 16" : "column 14",
  matches,
  derivation: "Zero escape is forbidden; its original backslash is at 16",
});

interface Scenario {
  clarification: RunPolicy["clarification"];
  /** The audit's verdict on AC-005. */
  matches: boolean;
  /** What the test task writes into the test on its first attempt. */
  first: string;
  /** What it writes once the host or a person settled the conflict. */
  then: string;
  answer?: string;
  /** Whether the conflicting attempt leaves its files written; a run that asks a person keeps none. */
  writes?: boolean;
}

async function conflict(scenario: Scenario) {
  const policy: RunPolicy = { ...fixturePolicy, clarification: scenario.clarification };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { service, executor, root } = fixture;
  const original = executor.execute.bind(executor);
  const prompts: string[] = [];
  const walks: string[][] = [];
  let conflicts = 0;
  executor.execute = async (request: ExecutionRequest) => {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const out = await original(request);
      const graph = (out.output as { taskGraph: { specHash: string; tasks: Record<string, unknown>[] } }).taskGraph;
      const code = graph.tasks[0] as Record<string, unknown> & { writes: { path: string; action: string }[] };
      graph.specHash = hashJson(spec);
      graph.tasks = [{ ...code, id: "T001", criterionIds: ["AC-001", "AC-005"], writes: [...code.writes, { path: TEST, action: "create" }] }];
      return out;
    }
    if (request.profile.output === "analysis") {
      const out = await original(request);
      out.output = { ...(out.output as object), derivations: [derivation(scenario.matches)] };
      return out;
    }
    if (request.profile.output === "review" || request.profile.output === "convergence") {
      const out = await original(request);
      const review = out.output as { coverage: { criterionId: string }[] };
      review.coverage = [...review.coverage, ...review.coverage.map((c) => ({ ...c, criterionId: "AC-005" }))];
      return out;
    }
    if (request.profile.output !== "implementation") return original(request);
    const work = request.root ?? root;
    const prompt = request.prompt;
    prompts.push(prompt);
    mkdirSync(join(work, dirname(TEST)), { recursive: true });
    const settled = /Settled spec conflict|User clarification/.test(prompt);
    if (settled || scenario.writes !== false) {
      // The code changes once the conflict is settled.
      writeFileSync(join(work, "value.txt"), settled ? "ready" : "draft");
      writeFileSync(join(work, TEST), settled ? scenario.then : scenario.first);
    }
    if (settled) {
      walks.push((await request.caseCheck?.(work)) ?? []);
      return { output: { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Tests follow the settled rows", evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    conflicts++;
    return {
      output: { schemaVersion: 1, taskId: "T001", outcome: "spec_conflict", summary: `AC-005 requires column 16 for ${DROPPED}, but the request's rule identifies the offending backslash at column 14.`, evidenceIds: [], unresolved: ["Which column is right?"] },
      inputTokens: 25,
      outputTokens: 25,
    };
  };
  const run = await fixture.start();
  for (let i = 0; i < 10; i++) {
    const current = await service.get(run.runId);
    if (["completed", "blocked", "failed"].includes(current.status)) break;
    const pending = service.store.requests(run.runId).find((r) => r.status === "pending");
    if (pending?.kind === "approval") await fixture.approve(run.runId);
    else if (pending?.kind === "clarification") {
      if (!scenario.answer) break;
      const id = (JSON.parse(pending.body_json) as { questions: { id: string }[] }).questions[0]!.id;
      await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: pending.id, answers: { [id]: scenario.answer } });
    } else if (current.status === "paused" || current.status === "created") await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  const read = (path: string) => {
    const artifact = service.store.latestArtifact(run.runId, path);
    return artifact ? JSON.parse(service.store.readArtifact(run.runId, artifact.id)) : null;
  };
  return {
    status: (await service.get(run.runId)).status,
    asked: service.store.requests(run.runId).filter((r) => r.kind === "clarification"),
    conflicts,
    prompts,
    walks,
    read,
    decisions: service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("decisions/clarification-")).map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { criterionIds?: string[]; requestId: string }),
  };
}

describe("scenario: sedstep 78dabd21 T006, a spec conflict about a row the test copied wrongly (#1709)", () => {
  test("the task goes back with the row's input as written, and no person is asked", async () => {
    const result = await conflict({ clarification: "ask", matches: true, first: csTest(DROPPED, ERROR16), then: csTest(INPUT, ERROR16) });
    expect(result.asked).toEqual([]);
    expect(result.conflicts).toBe(1);
    expect(result.read("assumptions/conflicts/T001-misquoted.json")).toMatchObject({ misquoted: [{ id: "AC-005", literal: INPUT, quoted: cs(DROPPED) }] });
    const settled = result.prompts.at(-1) ?? "";
    expect(settled).toContain("does not use the criterion rows as written");
    expect(settled).toContain("Copy each row's input and expected value into the test exactly as the criterion states them");
    expect(settled).toContain("The derivation audit recomputed these rows from the requirements and they match");
    expect(result.walks).toEqual([[]]);
    expect(result.status).toBe("completed");
  }, 90_000);

  test("an audit-verified row decides a conflict the test copied faithfully, with no question", async () => {
    const result = await conflict({ clarification: "ask", matches: true, first: csTest(INPUT, ERROR16), then: csTest(INPUT, ERROR16) });
    expect(result.asked).toEqual([]);
    expect(result.read("assumptions/conflicts/T001-audited.json")?.assumed).toBe("The audit-verified rows of AC-005 win: the derivation audit recomputed each of them from the requirements and they match");
    expect(result.prompts.at(-1)).toContain("Keep each row's input and expected value exactly as written");
    expect(result.status).toBe("completed");
  }, 90_000);

  test("a genuine conflict is asked with the row verbatim, and the answer releases the overruled row from the case walk", async () => {
    const answer = "AC-005 as derived is wrong: the backslash of \\0 is at column 14.";
    const result = await conflict({ clarification: "ask", matches: false, first: csTest(INPUT, ERROR16), then: csTest(INPUT, ERROR14), answer, writes: false });
    expect(result.asked).toHaveLength(1);
    const question = (JSON.parse(result.asked[0]!.body_json) as { questions: { question: string }[] }).questions[0]!.question;
    expect(question).toContain(`AC-005 as written: Given the script \`${INPUT}\`; When the parser reads it; Then it fails with \`${ERROR16}\`.`);
    expect(question).toContain('does not match; the requirements give "column 14"');
    expect(result.decisions.find((d) => !d.requestId.startsWith("assumed-"))?.criterionIds).toEqual(["AC-005"]);
    // Without the release the walk demands the overruled `column 16` the answer replaced.
    expect(result.walks).toEqual([[]]);
    expect(result.status).toBe("completed");
  }, 90_000);
});

describe("a row's literal as each language's table-driven test spells it (#1709)", () => {
  const forms: [string, (input: string, error: string) => string][] = [
    ["C# [InlineData]", csTest],
    ["Python parametrize", (input, error) => `@pytest.mark.parametrize("script,error", [\n    (r"${input}", r"${error}"),\n])\ndef test_rejects(script, error):\n    assert parse_error(script) == error\n`],
    ["Go table", (input, error) => `var cases = []struct{ script, err string }{\n\t{\`${input}\`, \`${error}\`},\n}\n`],
    ["Rust tuple array", (input, error) => `const CASES: &[(&str, &str)] = &[\n    (r"${input}", r"${error}"),\n];\n`],
    ["Java @CsvSource", (input, error) => `@ParameterizedTest\n@CsvSource(delimiter = '|', value = {"${cs(input)} | ${cs(error)}"})\nvoid rejects(String script, String error) {}\n`],
    ["bun test.each", (input, error) => `test.each([[String.raw\`${input}\`, String.raw\`${error}\`]])("rejects %s", (script, error) => {});\n`],
  ];
  for (const [name, form] of forms) {
    test(`${name}: a dropped escape is a misquotation, the row as written is not`, () => {
      expect(misquotation(INPUT, [form(DROPPED, ERROR16)])).not.toBeNull();
      expect(misquotation(INPUT, [form(INPUT, ERROR16)])).toBeNull();
      expect(misquotation(ERROR16, [form(INPUT, ERROR16)])).toBeNull();
    });
  }

  test("a value the test builds differently is not a misquotation", () => {
    expect(misquotation(INPUT, ['var script = Build("s", "(a)", "&");'])).toBeNull();
    expect(misquotation("ab", ["a"])).toBeNull();
  });

  test("only the criteria the report names are contested", () => {
    const rows = contestedRows(spec, "AC-005 requires column 16", [csTest(DROPPED, ERROR16)], [derivation(true)]);
    expect(rows.map((r) => r.criterion.id)).toEqual(["AC-005"]);
    expect(rows[0]?.misquoted).toEqual([{ literal: INPUT, quoted: cs(DROPPED) }]);
    expect(contestedRows(spec, "AC-0050 and the request disagree", [], undefined)).toEqual([]);
  });
});

describe("the case walk holds a backslash literal as escaped strings spell it (#1709)", () => {
  const forms: [string, string][] = [
    ["C#, Java and JavaScript strings", `Assert.Equal(error, Parse("${cs(INPUT)}"));`],
    ["a Go interpreted string", `{"${cs(INPUT)}", "${cs(ERROR16)}"},`],
    ["a Python string", `assert parse_error("${cs(INPUT)}") == "${cs(ERROR16)}"`],
    ["a raw string", `(r"${INPUT}", r"${ERROR16}"),`],
  ];
  for (const [name, text] of forms)
    test(name, () => {
      expect(testsHold(text, INPUT)).toBe(true);
      expect(testsHold(text.replace("!", ""), INPUT)).toBe(false);
    });
});

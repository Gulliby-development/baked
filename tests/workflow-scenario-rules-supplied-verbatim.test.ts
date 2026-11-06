import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkBuiltinRules } from "../src/core/workflows/quality/rules.js";
import { runSast } from "../src/core/workflows/quality/sast.js";
import { newId } from "../src/core/workflows/store.js";
import { suppliedLineNumbers } from "../src/core/workflows/supplied-drift.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// #2489, R80 deltaglue cli: T003 wrote the brief's verbatim `src/main.ts`, whose `catch` clauses
// return the contract's sentinel. At convergence `catch-return-default` matched `src/main.ts:10`,
// and corrective T025 (6 attempts, 313k tokens) reported a spec conflict, reached a person's
// clarification ("the brief controls") and changed nothing. A quality finding on a line the
// request gives verbatim is now a note: nobody may change that line.

const MAIN = ["export function main(raw: string) {", "  try {", "    return parse(raw);", "  } catch {", "    return null;", "  }", "}", ""].join("\n");
const BRIEF = ["Create the CLI. Write `src/main.ts` with exactly this content:", "```ts", MAIN.trimEnd(), "```"].join("\n");
const OTHER = ["export function other(raw: string) {", "  try {", "    return parse(raw);", "  } catch {", "    return null;", "  }", "}", ""].join("\n");

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});

describe("the lines a request gives verbatim (#2489)", () => {
  test("a fenced block's lines and a diff's added lines are supplied; blank lines and other files are not", () => {
    expect([...suppliedLineNumbers(BRIEF, "src/main.ts", MAIN)]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect([...suppliedLineNumbers(BRIEF, "src/other.ts", OTHER)]).toEqual([]);
    expect([...suppliedLineNumbers("", "src/main.ts", MAIN)]).toEqual([]);
    const diff = ["Apply this change:", "```diff", "--- a/src/main.ts", "+++ b/src/main.ts", "@@ -1,2 +1,3 @@", " export const a = 1;", "+export const b = 2;", " export const c = 3;", "```"].join("\n");
    expect([...suppliedLineNumbers(diff, "src/main.ts", "export const a = 1;\nexport const b = 2;\nexport const own = 4;\n")]).toEqual([1]);
  });

  test("the rule pack notes a match on supplied lines and still blocks one the run added beside them", () => {
    const supplied = suppliedLineNumbers(BRIEF, "src/main.ts", MAIN);
    const of = (content: string) =>
      checkBuiltinRules([{ path: "src/main.ts", content, before: null, supplied: suppliedLineNumbers(BRIEF, "src/main.ts", content) }], {}).map((f) => [f.rule, f.line, f.blocking, f.supplied ?? false]);
    expect(supplied.size).toBe(7);
    expect(of(MAIN)).toEqual([["catch-return-default", 4, false, true]]);
    // The run's own catch after the supplied block blocks.
    expect(of(`${MAIN}${OTHER.replace("other", "own").replace("return null;", "return undefined;")}`)).toContainEqual(["catch-return-default", 11, true, false]);
  });

  test("Semgrep's error on a supplied line is a note", async () => {
    const output = JSON.stringify({ results: [{ check_id: "r", path: "src/main.ts", start: { line: 5 }, extra: { severity: "ERROR", message: "m" } }] });
    const result = await runSast("/", [{ path: "src/main.ts", content: MAIN, before: null, supplied: suppliedLineNumbers(BRIEF, "src/main.ts", MAIN) }], "auto", "semgrep", async () => ({ status: 0, stdout: output, stderr: "" }));
    expect(result.findings.map((f) => [f.line, f.blocking, f.supplied ?? false])).toEqual([[5, false, true]]);
    const own = await runSast("/", [{ path: "src/main.ts", content: MAIN, before: null }], "auto", "semgrep", async () => ({ status: 0, stdout: output, stderr: "" }));
    expect(own.findings.map((f) => f.blocking)).toEqual([true]);
  });
});

/** Writes the brief's `src/main.ts` verbatim, and with `own` a file of its own with the same catch. */
class VerbatimExecutor extends FixtureExecutor {
  implementations = 0;
  constructor(
    private readonly dir: string,
    private readonly own: boolean,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]?.writes.push({ path: "src/main.ts", action: "create" });
      if (this.own) plan.taskGraph.tasks[0]?.writes.push({ path: "src/other.ts", action: "create" });
      return result;
    }
    if (request.profile.output === "implementation") {
      const first = this.implementations++ === 0;
      mkdirSync(join(this.dir, "src"), { recursive: true });
      writeFileSync(join(this.dir, "src/main.ts"), MAIN);
      // The correction of the run's own catch lets the error propagate.
      if (this.own) writeFileSync(join(this.dir, "src/other.ts"), first ? OTHER : "export function other(raw: string) {\n  return parse(raw);\n}\n");
    }
    return super.execute(request);
  }
}

async function scenario(own: boolean) {
  const fixture = workflowFixture({ executor: (root) => new VerbatimExecutor(root, own) });
  disposals.push(fixture.dispose);
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: BRIEF, ownerLabel: "test", policy: fixture.policy });
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const done = await service.drive(run.runId, new AbortController().signal);
  const claims = service.store.findings(run.runId).map((f) => String(JSON.parse(f.body_json).claim));
  const rules = service.store.latestArtifact(run.runId, "quality/rules.json");
  const recorded = rules ? (JSON.parse(service.store.readArtifact(run.runId, rules.id)) as { findings: { file: string; rule: string; blocking: boolean; supplied?: true }[] }) : null;
  return { done, claims, recorded, implementations: fixture.executor.implementations };
}

describe("scenario: R80 deltaglue cli, the brief's verbatim src/main.ts returns a default from catch (#2489)", () => {
  test("the rule pack records a note, opens no corrective and the run needs no clarification", async () => {
    const { done, claims, recorded, implementations } = await scenario(false);
    expect(done.status).toBe("completed");
    expect(implementations).toBe(1);
    expect(claims.filter((c) => c.startsWith("Rule "))).toEqual([]);
    expect(recorded?.findings.filter((f) => f.file === "src/main.ts").map((f) => [f.rule, f.blocking, f.supplied])).toEqual([["catch-return-default", false, true]]);
  }, 60_000);

  test("the same catch the model writes in its own file still blocks until corrected", async () => {
    const { done, claims, implementations } = await scenario(true);
    expect(done.status).toBe("completed");
    expect(claims.filter((c) => c.startsWith("Rule catch-return-default: ")).map((c) => c.includes("src/other.ts"))).toEqual([true]);
    expect(implementations).toBe(2);
  }, 60_000);
});

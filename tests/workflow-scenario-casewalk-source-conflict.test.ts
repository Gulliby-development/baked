import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { caseCommand, probeCase } from "../src/core/verification/case-source-probe.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 56, hdrlens negotiate (#1836). The case walk refused test task T004 for AC-007's
// expected error `invalid offer "text/*"`, which T002's cmd.go printed with the file prefix
// (`"a.txt": invalid offer "text/*"`). T004 could not change cmd.go, looped and broke its test
// file; the review found the defect and its corrective cost 1.0M tokens, about 2.8M in all.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const COMMAND = 'hdrlens pick a.txt "text/*"';
const EXPECTED = 'invalid offer "text/*"';
const spec: Spec = {
  schemaVersion: 1, featureId: "fixture", revision: 1, title: "hdrlens negotiate", problem: "No negotiation", outcome: "pick works",
  inScope: ["pick"], outOfScope: [], assumptions: [], openQuestions: [],
  requirements: [{ id: "FR-007", text: "pick rejects an offer with a wildcard", priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [{ id: "AC-007", requirementIds: ["FR-007"], given: "a file a.txt", when: `the user runs \`${COMMAND}\``, then: `it prints \`${EXPECTED}\` and exits 2`, method: "automated" }],
  dependencies: [],
};
const PACKAGE = JSON.stringify({ name: "hdrlens", bin: { hdrlens: "cli.js" } });
/** T002's code: the error with the file display prefix the criterion does not have. */
const PREFIXED = `console.error('"' + process.argv[3] + '": invalid offer "' + process.argv[4] + '"'); process.exit(2);\n`;
const RIGHT = `console.error('invalid offer "' + process.argv[4] + '"'); process.exit(2);\n`;

class NegotiateExecutor extends FixtureExecutor {
  refusals: string[][] = [];
  constructor(private dir: string, private source: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") return { output: spec, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nNegotiate.\n## Decisions\nDEC-001: FR-007 is checked in pick.\n## Components\ncli.js\n## Data\nText\n## Verification\nTests\n## Risks\nNone";
      const task = (id: string, path: string, dependsOn: string[]) => ({ id, title: `Write ${path}`, description: `Write ${path}`, requirementIds: ["FR-007"], criterionIds: ["AC-007"], dependsOn, profileId: "implementer", writes: [{ path, action: "create" }, { path: `${id}.txt`, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required" });
      const taskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task("T002", "cli.js", []), task("T004", "tests/pick.test.ts", ["T002"])] };
      return { output: { schemaVersion: 1, markdown, taskGraph }, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      const id = request.task?.id ?? "";
      writeFileSync(join(this.dir, `${id}.txt`), id);
      if (id === "T002") writeFileSync(join(this.dir, "cli.js"), this.source);
      if (id === "T004") {
        // The test asserts what the code printed, as R56's T004 did, not the criterion's text.
        writeFileSync(join(this.dir, "tests/pick.test.ts"), 'import { test } from "bun:test";\ntest("pick", () => {});\n');
        this.refusals.push((await request.caseCheck?.(this.dir)) ?? []);
      }
      return { output: { schemaVersion: 1, taskId: id, outcome: "implemented", summary: `Wrote ${id}`, evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
    }
    return super.execute(request);
  }
}

async function negotiate(caseSourceProbe: "on" | "off", source: string) {
  const policy: RunPolicy = { ...fixturePolicy, caseSourceProbe };
  const fixture = workflowFixture({ policy, executor: (root) => new NegotiateExecutor(root, source) });
  cleanups.push(fixture.dispose);
  writeFileSync(join(fixture.root, "package.json"), PACKAGE);
  writeFileSync(join(fixture.root, "a.txt"), "Accept: text/plain\n");
  writeFileSync(join(fixture.root, "value.txt"), "ready");
  mkdirSync(join(fixture.root, "tests"), { recursive: true });
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  // The fixture's review covers another criterion; the run stops there, after both tasks ran.
  await fixture.service.drive(run.runId, new AbortController().signal);
  const store = fixture.service.store;
  const probes = store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith("tasks/T004/case-probe-"))
    .map((a) => JSON.parse(store.readArtifact(run.runId, a.id)) as { contradicted: { printed: string } | null; files?: string[]; owners?: string[] });
  return { refusals: fixture.executor.refusals, probes };
}

describe("scenario: hdrlens negotiate T004, a case the source contradicts (#1836)", () => {
  test("the refusal names the program's output, the source file and its owner", async () => {
    const { refusals, probes } = await negotiate("on", PREFIXED);
    const line = refusals[0]?.find((l) => l.includes(JSON.stringify(EXPECTED))) ?? "";
    expect(line).toContain(`as the output of \`${COMMAND}\`, but the program prints ${JSON.stringify(`"a.txt": ${EXPECTED}`)}`);
    expect(line).toContain("the code T002 wrote (cli.js) disagrees with the criterion");
    expect(line).toContain("Write the test with");
    expect(line).toContain("the host hands the failing check to T002");
    expect(probes.find((p) => p.contradicted)).toMatchObject({ files: ["cli.js"], owners: ["T002"] });
  }, 90_000);

  test("a program that prints the expected output keeps the ordinary refusal", async () => {
    const { refusals, probes } = await negotiate("on", RIGHT);
    const line = refusals[0]?.find((l) => l.includes(JSON.stringify(EXPECTED))) ?? "";
    expect(line).toContain("and no test file this task writes (tests/pick.test.ts) contains it.");
    expect(probes.every((p) => p.contradicted === null)).toBe(true);
  }, 90_000);

  test("off, as by default, nothing runs", async () => {
    const { refusals, probes } = await negotiate("off", PREFIXED);
    expect(refusals[0]?.some((l) => l.includes("the program prints"))).toBe(false);
    expect(probes).toEqual([]);
  }, 90_000);
});

describe("caseCommand and probeCase (#1836)", () => {
  test("the command is a code span of When or Given; the literal must be an output the Then states", () => {
    const criterion = spec.criteria[0]!;
    expect(caseCommand(criterion, EXPECTED)).toEqual({ command: COMMAND, argv: ["hdrlens", "pick", "a.txt", "text/*"] });
    expect(caseCommand(criterion, "a.txt")).toBeNull();
    expect(caseCommand({ ...criterion, when: "the user picks" }, EXPECTED)).toBeNull();
    expect(caseCommand({ ...criterion, when: "the user runs `./hdrlens pick a.txt`" }, EXPECTED)).toBeNull();
  });

  test("only the project's own program runs, and only a difference is reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-case-probe-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "package.json"), PACKAGE);
    writeFileSync(join(root, "a.txt"), "x");
    const options = { root, files: ["package.json", "a.txt", "cli.js"], executables: ["bun"], signal: new AbortController().signal, sandbox: () => null };
    const argv = ["hdrlens", "pick", "a.txt", "text/*"];
    writeFileSync(join(root, "cli.js"), PREFIXED);
    expect(await probeCase(new ProcessScope(), argv, EXPECTED, options)).toMatchObject({ printed: `"a.txt": ${EXPECTED}`, exitCode: 2 });
    writeFileSync(join(root, "cli.js"), RIGHT);
    expect(await probeCase(new ProcessScope(), argv, EXPECTED, options)).toBeNull();
    expect(await probeCase(new ProcessScope(), ["other", "pick"], EXPECTED, options)).toBeNull();
    expect(await probeCase(new ProcessScope(), argv, EXPECTED, { ...options, executables: ["go"] })).toBeNull();
  });
});

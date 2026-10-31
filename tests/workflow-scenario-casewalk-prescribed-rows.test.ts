import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CaseWalk,
  type CaseWalkRecord,
  caseCheck,
  casePrescribed,
  caseWalkDecision,
  criterionCases,
} from "../src/core/verification/criteria-cases.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { notPrescribedFindings, perRowNotPrescribed, prescribedRowFiles } from "../src/core/workflows/supplied-content.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #2501: the case walk demanded a criterion's literals of a task that owns a prescribed row file
// from that task's own file, and from a sibling's file only once it was on disk. R81 ratdec
// exact-cli T007 (`test/arith_test.exs`) was refused for six rows of T006's
// `test/literals_test.exs`, written in parallel (377k tokens against about 100k for its sibling
// row tasks); T011 (`test/cli_test.exs`) for `["eval","--as","frac","7/3"]`, a row no block of the
// brief prescribes, so it added a 14th row and a corrective (T013, 368k) removed it. R80 ratdec
// and deltaglue (TypeScript) did the same in four tasks. The walk now reads the request's rows: a
// literal a sibling file's prescribed rows hold is held, and one no prescribed row holds is not
// demanded of a task that writes only prescribed row files (recorded `case_not_prescribed`, and a
// note at analysis).

const roots: string[] = [];
const disposals: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const dispose of disposals) await dispose();
});

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-case-prescribed-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

type Criterion = Spec["criteria"][number];
/** AC-001 cites a row of each file and one example row the request never prescribes. */
const CRITERION: Criterion = {
  id: "AC-001",
  requirementIds: ["FR-001"],
  given: "the prescribed rows",
  when: 'the user runs eval on "1/3", "1/6" and "--as frac 7/3"',
  then: 'it prints "0.(3)", "0.1(6)" and "2 1/3"',
  method: "automated",
};
const spec: Spec = { ...fixtureSpec, criteria: [CRITERION] };
const OWN = ["1/3", "0.(3)"];
const SIBLING = ["1/6", "0.1(6)"];
const NOT_PRESCRIBED = ["--as frac 7/3", "2 1/3"];

interface Notation {
  name: string;
  fence: string;
  /** The walked task's row file and its sibling's. */
  own: string;
  sibling: string;
  /** A block's header line, naming the file and saying it holds rows. */
  header: (path: string) => string;
  /** One row in the notation: arguments and expected output. */
  row: (arg: string, out: string) => string;
  /** A test file that transcribes rows. */
  file: (rows: string[]) => string;
}

const q = (s: string) => JSON.stringify(s);
const NOTATIONS: Notation[] = [
  {
    name: "elixir",
    fence: "elixir",
    own: "test/arith_test.exs",
    sibling: "test/literals_test.exs",
    header: (path) => `# Rows in ${path} (1 row)`,
    row: (arg, out) => `row(["eval", ${q(arg)}], "", 0, ${q(`${out}\n`)}, "")`,
    file: (rows) =>
      `defmodule ArithTest do\n  use ExUnit.Case\n  import RowHelper\n\n${rows.map((r) => `  ${r}`).join("\n")}\nend\n`,
  },
  {
    name: "typescript",
    fence: "ts",
    own: "tests/arith.test.ts",
    sibling: "tests/literals.test.ts",
    header: (path) => `// Rows in ${path} (1 row)`,
    row: (arg, out) => `{ args: ["eval", ${q(arg)}], stdout: ${q(`${out}\n`)} },`,
    file: (rows) =>
      `import { expect, test } from "bun:test";\nimport { run } from "./run";\n\nconst ROWS = [\n${rows.map((r) => `  ${r}`).join("\n")}\n];\n\nfor (const row of ROWS) test(row.args.join(" "), () => {\n  expect(run(row.args).stdout).toBe(row.stdout);\n});\n`,
  },
  {
    name: "go",
    fence: "go",
    own: "arith_test.go",
    sibling: "literals_test.go",
    header: (path) => `// Rows in ${path} (1 row)`,
    row: (arg, out) => `{[]string{"eval", ${q(arg)}}, ${q(`${out}\n`)}},`,
    file: (rows) =>
      `package main\n\nimport "testing"\n\nfunc TestArith(t *testing.T) {\n\tfor _, row := range []struct {\n\t\targs []string\n\t\tout  string\n\t}{\n${rows.map((r) => `\t\t${r}`).join("\n")}\n\t} {\n\t\tif got := run(row.args); got != row.out {\n\t\t\tt.Fatal(got)\n\t\t}\n\t}\n}\n`,
  },
];

type PlanTask = Pick<Task, "id" | "description" | "criterionIds" | "writes" | "dependsOn">;
const task = (id: string, description: string, paths: string[]): PlanTask => ({
  id,
  description,
  criterionIds: ["AC-001"],
  writes: paths.map((path) => ({ path, action: "create" as const })),
  dependsOn: [],
});

describe("the case walk reads the request's prescribed rows (#2501)", () => {
  for (const n of NOTATIONS) {
    const ownRow = n.row("1/3", "0.(3)");
    const siblingRow = n.row("1/6", "0.1(6)");
    const request = `Build ratdec.\n\n\`\`\`${n.fence}\n${n.header(n.own)}\n${ownRow}\n\`\`\`\n\n\`\`\`${n.fence}\n${n.header(n.sibling)}\n${siblingRow}\n\`\`\`\n`;
    // T006 writes the sibling row file in parallel; T007, last in plan order, owns AC-001's cases.
    const T006 = task("T006", "Write the literal rows.", [n.sibling]);
    const T007 = task("T007", "Write the arith rows.", [n.own]);
    const tasks = [T006, T007];
    const prescribedRows = prescribedRowFiles(request, { tasks: tasks as Task[] });
    const walk = async (walked: PlanTask, files: Record<string, string>, plan: PlanTask[] = tasks) => {
      const walks: (CaseWalk & { refused: number[] })[] = [];
      const literals: string[][] = [];
      const check = caseCheck(spec, walked, {
        checks: [],
        tasks: plan,
        prescribedRows,
        record: (w, cases) => {
          walks.push(w);
          literals.push(cases.map((c) => c.literal));
        },
      });
      if (!check) throw new Error("no case check");
      const refusals = await check(workspace(files));
      const [record] = walks;
      if (!record) throw new Error("no walk recorded");
      const by = (kind: string | undefined) =>
        record.cases.flatMap((c, i) => (c.prescribed === kind ? [literals[0]?.[i]] : []));
      return { refusals, record, by };
    };

    test(`${n.name}: the request's block of each file is read as its prescribed rows`, () => {
      expect([...prescribedRows]).toEqual([
        [n.own, [ownRow]],
        [n.sibling, [siblingRow]],
      ]);
    });

    test(`${n.name}: a literal of a sibling's prescribed rows is held before the sibling writes its file`, async () => {
      const { refusals, record, by } = await walk(T007, { [n.own]: n.file([ownRow]) });
      expect(refusals).toEqual([]);
      expect(by("sibling")).toEqual(SIBLING);
      expect(by("none")).toEqual(NOT_PRESCRIBED);
      expect(record.cases.filter((c) => c.held).length).toBe(OWN.length);
      expect(caseWalkDecision(record)).toEqual(record.refused);
      // The record keeps no literal (#1715).
      for (const literal of [...OWN, ...SIBLING, ...NOT_PRESCRIBED])
        expect(JSON.stringify(record).includes(literal)).toBe(false);
    });

    test(`${n.name}: a literal of the task's own prescribed rows is still demanded`, async () => {
      const { refusals, by } = await walk(T007, { [n.own]: n.file([]) });
      expect(by("own")).toEqual(OWN);
      expect(refusals).toHaveLength(OWN.length);
      expect(refusals.join("\n")).toContain('"0.(3)"');
      expect(refusals.join("\n")).not.toContain('"0.1(6)"');
      expect(refusals.join("\n")).not.toContain('"2 1/3"');
    });

    test(`${n.name}: a corrective that rewrites the prescribed row file is not refused for either`, async () => {
      const corrective = task("T013", "Remove the extra row.", [n.own]);
      const { refusals, by } = await walk(corrective, { [n.own]: n.file([ownRow]) });
      expect(refusals).toEqual([]);
      expect(by("none")).toEqual(NOT_PRESCRIBED);
    });

    test(`${n.name}: a task with a test file of its own choosing still owes a literal no row holds`, async () => {
      const free = n.name === "go" ? "cli_test.go" : n.own.replace("arith", "cli");
      const mixed = task("T007", "Write the arith rows and the CLI tests.", [n.own, free]);
      const { refusals, by } = await walk(mixed, { [n.own]: n.file([ownRow]), [free]: n.file([]) }, [T006, mixed]);
      expect(by("none")).toEqual([]);
      expect(by("sibling")).toEqual(SIBLING);
      expect(refusals).toHaveLength(NOT_PRESCRIBED.length);
      expect(refusals.join("\n")).toContain('"2 1/3"');
    });

    test(`${n.name}: analysis notes each literal no prescribed row holds, as a non-blocking finding`, () => {
      const findings = notPrescribedFindings(spec, { tasks: tasks as Task[] }, request, { checks: [] });
      expect(findings).toHaveLength(1);
      const [finding] = findings;
      expect(finding?.id).toBe("NOT-PRESCRIBED-AC-001");
      expect(finding?.blocking).toBe(false);
      expect(finding?.refs).toEqual(["spec.json", "AC-001"]);
      for (const literal of NOT_PRESCRIBED) expect(finding?.description).toContain(JSON.stringify(literal));
      expect(finding?.description).not.toContain('"0.1(6)"');
      // A request that prescribes no rows notes nothing.
      expect(notPrescribedFindings(spec, { tasks: tasks as Task[] }, "Build ratdec.", { checks: [] })).toEqual([]);
    });
  }

  test("a recorded walk without prescribed rows replays its refusals unchanged", () => {
    const record: Pick<CaseWalkRecord, "rowsIntact" | "siblings" | "cases"> = {
      rowsIntact: false,
      siblings: 7,
      cases: [
        { criterionId: "AC-001", held: false, row: false, sibling: false },
        { criterionId: "AC-001", held: true, row: false, sibling: null },
        { criterionId: "AC-001", held: false, row: false, sibling: false, prescribed: "own" },
        { criterionId: "AC-001", held: false, row: false, sibling: false, prescribed: "sibling" },
        { criterionId: "AC-001", held: false, row: false, sibling: false, prescribed: "none" },
        // A literal that describes rows (#2524) is no more demanded than `none`.
        { criterionId: "AC-001", held: false, row: false, sibling: false, prescribed: "cited" },
      ],
    };
    expect(caseWalkDecision(record)).toEqual([0, 2]);
  });
});

// Scripted R81 shape through the scheduler: T001 writes `test/arith_test.exs` while T002, which
// runs after it, has not yet written `test/literals_test.exs`. The task-end walk is handed the
// request's rows, so T001 passes at its first walk; the literals no row holds are recorded as
// shadow `case_not_prescribed` would-stops, at analysis (per criterion) and at the walk (per
// literal), and the run goes on.
test("scenario: the scheduler hands the walk the request's rows and records case_not_prescribed in shadow (#2501)", async () => {
  const [elixir] = NOTATIONS;
  if (!elixir) throw new Error("no notation");
  const ownRow = elixir.row("1/3", "0.(3)");
  const siblingRow = elixir.row("1/6", "0.1(6)");
  const request = `Create ready value.\n\n\`\`\`elixir\n${elixir.header(elixir.own)}\n${ownRow}\n\`\`\`\n\n\`\`\`elixir\n${elixir.header(elixir.sibling)}\n${siblingRow}\n\`\`\`\n`;
  const plain: Criterion = { ...CRITERION, id: "AC-002", given: "a workspace", when: "the task completes", then: "value is ready" };
  const twoCriteria: Spec = { ...fixtureSpec, criteria: [CRITERION, plain] };
  const fixture = workflowFixture();
  disposals.push(fixture.dispose);
  const { executor, root, service } = fixture;
  const original = executor.execute.bind(executor);
  const walked: string[][] = [];
  executor.execute = async (req: ExecutionRequest) => {
    if (req.profile.output === "spec") return { output: twoCriteria, inputTokens: 25, outputTokens: 25 };
    const out = await original(req);
    if (req.profile.output === "plan") {
      const plan = out.output as { markdown: string; taskGraph: TaskGraph };
      plan.taskGraph.specHash = hashJson(twoCriteria);
      plan.taskGraph.planHash = hashBytes(plan.markdown);
      const [first] = plan.taskGraph.tasks;
      if (!first) throw new Error("no planned task");
      plan.taskGraph.tasks = [
        { ...first, id: "T001", criterionIds: ["AC-001"], writes: [{ path: "value.txt", action: "create" }, { path: elixir.own, action: "create" }] },
        { ...first, id: "T002", title: "Literal rows", criterionIds: ["AC-002"], dependsOn: ["T001"], writes: [{ path: elixir.sibling, action: "create" }] },
      ];
    }
    if (req.profile.output === "implementation") {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      if (req.task?.id === "T001") {
        write(elixir.own, elixir.file([ownRow]));
        walked.push((await req.caseCheck?.(root)) ?? ["no case check"]);
      } else write(elixir.sibling, elixir.file([siblingRow]));
    }
    if (req.profile.output === "review" || req.profile.output === "convergence") {
      const review = out.output as { coverage: { criterionId: string }[] };
      const [covered] = review.coverage;
      if (covered) review.coverage.push({ ...covered, criterionId: "AC-002" });
    }
    return out;
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy: fixture.policy });
  let current = await service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, new AbortController().signal);
  }
  // T001's first walk: the sibling's row is held by the request's block, the example row not demanded.
  expect(walked[0]).toEqual([]);
  const wouldStops = service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; mode: string; key: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "case_not_prescribed");
  expect(wouldStops.every((w) => w.mode === "shadow")).toBe(true);
  expect(wouldStops.map((w) => w.key).sort()).toEqual(
    ["analysis-AC-001", ...NOT_PRESCRIBED.map((l) => `task-T001-AC-001-${l}`)].sort(),
  );
  // `kind` says which reader answered (#2532): `literal` for the walk's own `none`.
  expect(wouldStops.find((w) => w.key === "task-T001-AC-001-2 1/3")?.inputs).toEqual({ taskId: "T001", criterionId: "AC-001", literal: "2 1/3", kind: "literal" });
  expect(wouldStops.find((w) => w.key === "analysis-AC-001")?.inputs).toEqual({ criterionId: "AC-001", finding: "NOT-PRESCRIBED-AC-001", kind: "literal" });
  // Shadow: nothing stops on it.
  expect((await service.get(run.runId)).status).toBe("completed");
});

// #2544: `casePrescribed` read a file's prescribed rows as one joined text, so a case whose values
// two rows spread between them (the arguments of one row, the output of another) was held, though
// no row tests it, and analysis did not note it (the sibling of #2521 on the request side). The
// per-row reader holds such a multi-value case only when one row holds it; it runs in shadow: the
// walk records its answer beside the joined one (`prescribedPerRow`) and `case_not_prescribed`
// records it with `kind: "per-row"`, while the decision and the notes still read the joined text.
describe("a multi-value case spread over two prescribed rows (#2544, shadow)", () => {
  const SPREAD: Criterion = { ...CRITERION, when: "the user runs eval on the rows", then: 'it prints the row `["eval","a=1"], "42"`' };
  const spreadSpec: Spec = { ...fixtureSpec, criteria: [SPREAD] };
  const LITERAL = '["eval","a=1"], "42"';
  for (const n of NOTATIONS) {
    const ownRow = n.row("1/3", "0.(3)");
    // Row 2 holds the arguments, row 3 the output; no row holds both.
    const spread = [n.row("a=1", "7"), n.row("b=2", "42")];
    const header = (path: string, count: number) => n.header(path).replace("(1 row)", `(${String(count)} rows)`);
    const request = `Build ratdec.\n\n\`\`\`${n.fence}\n${n.header(n.own)}\n${ownRow}\n\`\`\`\n\n\`\`\`${n.fence}\n${header(n.sibling, 2)}\n${spread.join("\n")}\n\`\`\`\n`;
    const T006 = task("T006", "Write the literal rows.", [n.sibling]);
    const T007 = task("T007", "Write the arith rows.", [n.own]);
    const tasks = [T006, T007];
    const rows = prescribedRowFiles(request, { tasks: tasks as Task[] });

    test(`${n.name}: one case, held by the joined rows (own today), by no single row`, () => {
      expect(rows.get(n.sibling)).toEqual(spread);
      // T006 alone, so it owns the case (with T007 the last carrier owns it, #1597).
      const cases = criterionCases(spreadSpec, T006, { checks: [], tasks: [T006], prescribedRows: rows });
      expect(cases.map((c) => c.literal)).toEqual([LITERAL]);
      const [c] = cases;
      if (!c) throw new Error("no case");
      expect(casePrescribed(c, [n.sibling], rows)).toBe("own");
      expect(casePrescribed(c, [n.sibling], rows, true)).toBe("none");
      // A single value is read on the joined text as before.
      expect(casePrescribed({ criterionId: "AC-001", literal: "42" }, [n.sibling], rows, true)).toBe("own");
    });

    test(`${n.name}: the walk records the per-row answer beside the joined one and decides as before`, async () => {
      const walks: (CaseWalk & { refused: number[] })[] = [];
      const check = caseCheck(spreadSpec, T007, { checks: [], tasks, prescribedRows: rows, record: (w) => walks.push(w) });
      if (!check) throw new Error("no case check");
      expect(await check(workspace({ [n.own]: n.file([ownRow]) }))).toEqual([]);
      const [record] = walks;
      expect(record?.cases).toEqual([{ criterionId: "AC-001", row: false, held: false, sibling: false, prescribed: "sibling", prescribedPerRow: "none" }]);
      if (record) expect(caseWalkDecision(record)).toEqual([]);
    });

    test(`${n.name}: analysis notes nothing yet and lists the case for the shadow record`, () => {
      expect(notPrescribedFindings(spreadSpec, { tasks: tasks as Task[] }, request, { checks: [] })).toEqual([]);
      expect(perRowNotPrescribed(spreadSpec, { tasks: tasks as Task[] }, request, { checks: [] })).toEqual([
        { taskId: "T007", criterionId: "AC-001", literal: LITERAL },
      ]);
    });
  }

  // Through the scheduler: T001 writes its own row file before T002 writes the file whose two
  // rows spread the case. Both readers' answers reach `case_not_prescribed` as `kind: "per-row"`
  // (#2532), at analysis and at T001's walk, and nothing stops on them.
  test("scenario: the scheduler records the per-row answer under case_not_prescribed in shadow", async () => {
    const [elixir] = NOTATIONS;
    if (!elixir) throw new Error("no notation");
    const ownRow = elixir.row("1/3", "0.(3)");
    const spread = [elixir.row("a=1", "7"), elixir.row("b=2", "42")];
    const request = `Create ready value.\n\n\`\`\`elixir\n${elixir.header(elixir.own)}\n${ownRow}\n\`\`\`\n\n\`\`\`elixir\n${elixir.header(elixir.sibling).replace("(1 row)", "(2 rows)")}\n${spread.join("\n")}\n\`\`\`\n`;
    const plain: Criterion = { ...CRITERION, id: "AC-002", given: "a workspace", when: "the task completes", then: "value is ready" };
    const twoCriteria: Spec = { ...fixtureSpec, criteria: [SPREAD, plain] };
    const fixture = workflowFixture();
    disposals.push(fixture.dispose);
    const { executor, root, service } = fixture;
    const original = executor.execute.bind(executor);
    const walked: string[][] = [];
    executor.execute = async (req: ExecutionRequest) => {
      if (req.profile.output === "spec") return { output: twoCriteria, inputTokens: 25, outputTokens: 25 };
      const out = await original(req);
      if (req.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: TaskGraph };
        plan.taskGraph.specHash = hashJson(twoCriteria);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
        const [first] = plan.taskGraph.tasks;
        if (!first) throw new Error("no planned task");
        plan.taskGraph.tasks = [
          { ...first, id: "T001", criterionIds: ["AC-001"], writes: [{ path: "value.txt", action: "create" }, { path: elixir.own, action: "create" }] },
          { ...first, id: "T002", title: "Literal rows", criterionIds: ["AC-002"], dependsOn: ["T001"], writes: [{ path: elixir.sibling, action: "create" }] },
        ];
      }
      if (req.profile.output === "implementation") {
        const write = (path: string, text: string) => {
          mkdirSync(dirname(join(root, path)), { recursive: true });
          writeFileSync(join(root, path), text);
        };
        if (req.task?.id === "T001") {
          write(elixir.own, elixir.file([ownRow]));
          walked.push((await req.caseCheck?.(root)) ?? ["no case check"]);
        } else write(elixir.sibling, elixir.file(spread));
      }
      if (req.profile.output === "review" || req.profile.output === "convergence") {
        const review = out.output as { coverage: { criterionId: string }[] };
        const [covered] = review.coverage;
        if (covered) review.coverage.push({ ...covered, criterionId: "AC-002" });
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy: fixture.policy });
    let current = await service.drive(run.runId, new AbortController().signal);
    for (let i = 0; i < 5 && current.status === "waiting"; i++) {
      if (service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
      await fixture.approve(run.runId);
      current = await service.drive(run.runId, new AbortController().signal);
    }
    expect(walked[0]).toEqual([]);
    const wouldStops = service.store
      .eventsOfType(run.runId, "decision.would_stop")
      .map((e) => e.payload as { reason: string; mode: string; key: string; inputs: Record<string, unknown> })
      .filter((p) => p.reason === "case_not_prescribed");
    expect(wouldStops.map((w) => [w.key, w.mode, w.inputs.kind])).toEqual([
      [`analysis-per-row-AC-001-T001-${LITERAL}`, "shadow", "per-row"],
      [`task-T001-per-row-AC-001-${LITERAL}`, "shadow", "per-row"],
    ]);
    expect(wouldStops[1]?.inputs).toEqual({ taskId: "T001", criterionId: "AC-001", literal: LITERAL, kind: "per-row", prescribed: "sibling" });
    expect((await service.get(run.runId)).status).toBe("completed");
  });
});

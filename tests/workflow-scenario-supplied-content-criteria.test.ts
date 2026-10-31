import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { type CaseWalk, caseCheck, citedKind } from "../src/core/verification/criteria-cases.js";
import type { Spec, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { requestConflictDecision } from "../src/core/workflows/request-conflict.js";
import {
  namesExactContent,
  notPrescribedFindings,
  prescribedRowFiles,
  suppliedConflictCriteria,
  suppliedContentFindings,
  suppliedTestFiles,
} from "../src/core/workflows/supplied-content.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 64, mdtoc-update (#2006, follow-up of #2000). The request gave
// tests/version.test.ts verbatim, and AC-006 named a literal that file does not contain. Only the
// task-end case walk found it, after an implementer session (237,581 tokens) and a second refusal
// (323,183 tokens). The host now walks the criterion against the supplied text at analysis.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TEST = "tests/version.test.ts";
const SUPPLIED = `import { expect, test } from "bun:test";
import { version } from "../src/version";

test("prints the version", () => {
  expect(version()).toBe("mdtoc 2.1.0");
});`;
const REQUEST = `Add a --version flag to mdtoc. Create \`${TEST}\` with exactly this content:\n\n\`\`\`ts\n${SUPPLIED}\n\`\`\`\n\nThe flag prints mdtoc 2.1.0.`;

const spec = (then: string): Spec => ({
  ...fixtureSpec,
  criteria: [...fixtureSpec.criteria, { id: "AC-006", requirementIds: ["FR-001"], given: "the built CLI", when: "mdtoc --version runs", then, method: "automated" }],
});
const WRONG = spec("it prints `mdtoc version 2.1.0`");
const RIGHT = spec("it prints `mdtoc 2.1.0`");

const task = (id: string, writes: TaskGraph["tasks"][number]["writes"], criterionIds = ["AC-006"]): TaskGraph["tasks"][number] => ({
  id, title: id, description: id, requirementIds: ["FR-001"], criterionIds, dependsOn: [], profileId: "implementer", writes, readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "x",
});
const graph = (tasks: TaskGraph["tasks"]) => ({ tasks });
const checks = fixturePolicy.checks;

describe("criteria against file content the request supplies verbatim (#2006)", () => {
  test("a criterion literal the supplied test lacks is a finding for the spec author", () => {
    const findings = suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }])]), REQUEST, { checks });
    expect(findings).toEqual([expect.objectContaining({ id: "SUPPLIED-AC-006", kind: "inconsistency", blocking: true, refs: ["spec.json", "AC-006"] })]);
    expect(findings[0]?.description).toContain('"mdtoc version 2.1.0" (task T004 writes only tests/version.test.ts)');
  });

  test("a literal the supplied test holds raises nothing", () => {
    expect(suppliedContentFindings(RIGHT, graph([task("T004", [{ path: TEST, action: "create" }])]), REQUEST, { checks })).toEqual([]);
  });

  test("a block for an existing file is an excerpt unless the prose says it is the whole file", () => {
    const excerpt = REQUEST.replace("with exactly this content:", "and add this test:").replace("Create", "In");
    expect(suppliedTestFiles(excerpt, graph([task("T004", [{ path: TEST, action: "modify" }])])).size).toBe(0);
    expect(suppliedTestFiles(REQUEST, graph([task("T004", [{ path: TEST, action: "modify" }])])).get("T004")).toEqual([{ path: TEST, content: `${SUPPLIED}\n` }]);
  });

  test("a task that also writes a test file the request does not supply is left to the walk", () => {
    expect(suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }, { path: "tests/cli.test.ts", action: "create" }])]), REQUEST, { checks })).toEqual([]);
  });

  test("a sibling that carries the criterion and writes its own test may hold the case", () => {
    const tasks = [task("T004", [{ path: TEST, action: "create" }]), task("T005", [{ path: "tests/cli.test.ts", action: "create" }])];
    expect(suppliedContentFindings(WRONG, graph(tasks), REQUEST, { checks })).toEqual([]);
  });

  test("a request without verbatim files raises nothing", () => {
    expect(suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }])]), "Add a --version flag.", { checks })).toEqual([]);
  });

  test("scenario: the analysis returns the criterion before any implementer session", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: WRONG, inputTokens: 25, outputTokens: 25 };
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: TaskGraph };
        plan.taskGraph.specHash = hashJson(WRONG);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
        plan.taskGraph.tasks = [{ ...(plan.taskGraph.tasks[0] as TaskGraph["tasks"][number]), id: "T001", criterionIds: ["AC-001", "AC-006"], writes: [{ path: "value.txt", action: "create" }, { path: TEST, action: "create" }] }];
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy: fixture.policy });
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    expect(executor.calls).not.toContain("implementation");
    expect(snapshot.reason).not.toBe("approval");
    const asked = service.store.requests(run.runId).filter((r) => r.kind === "clarification");
    expect(asked.map((r) => r.body_json).join("\n")).toContain("Supplied content: AC-006");
  }, 60000);

  // Part c: a spec_conflict about the supplied file that cites no criterion by id still gets the
  // request re-audit at its first report, on the criteria the supplied file lacks.
  describe("a conflict about a supplied test file (#2006, part c)", () => {
    const T004 = task("T004", [{ path: TEST, action: "create" }]);
    const conflictCriteria = (text: string, paths: string[] = []) =>
      suppliedConflictCriteria(WRONG, T004, graph([T004]), REQUEST, { text, paths }, { checks });

    test("a report that names the supplied file gives the criteria it lacks", () => {
      expect(conflictCriteria("The version line differs from what tests/version.test.ts expects.", [TEST])).toEqual(["AC-006"]);
    });

    test("so does a report that says the file's content is fixed", () => {
      for (const text of ["The test must stay verbatim, so the criterion cannot hold.", "The request gives exactly this content for the test.", "The file is to be kept byte for byte."])
        expect(conflictCriteria(text)).toEqual(["AC-006"]);
      expect(namesExactContent("The version flag prints the wrong text.")).toBe(false);
    });

    test("a report about something else, or a supplied file that holds every case, gives none", () => {
      expect(conflictCriteria("The version flag prints the wrong text.")).toEqual([]);
      expect(suppliedConflictCriteria(RIGHT, T004, graph([T004]), REQUEST, { text: "verbatim", paths: [TEST] }, { checks })).toEqual([]);
    });

    test("those criteria send the first report to the request re-audit", () => {
      const input = { sides: [], foreignTests: 0, criterionIds: conflictCriteria("verbatim"), supplied: true as const, reaudit: null, reauditedBefore: false };
      expect(requestConflictDecision(input)).toBe("reaudit");
      expect(requestConflictDecision({ ...input, criterionIds: [] })).toBe("none");
    });
  });
});

// #2524: the NOT-PRESCRIBED note (#2501, shadow `case_not_prescribed`) told the spec author to
// remove literals that describe rows instead of quoting one. R82 slotprompt filters (a7c8cf04), 4 of
// 4 records false: AC-008 cited its own row counts and test names (`12`, `filter_args`,
// `filter_errors`, `17`, `52`), AC-002 the error envelope `slotprompt: LINE:COL: MESSAGE\n`,
// AC-005 `default "\n"` "(backslash followed by letter n)", AC-004 the control characters `\^@`,
// `\^_` and "U+0000 and U+001F". The case walk marks such a literal `cited`; R81's
// `["eval","--as","frac","7/3"]`, a row no block of the brief holds, is still noted.
describe("a literal that describes rows is not a case to remove (#2524)", () => {
  const ARGS = "test/filter_args_test.dart";
  const ERRORS = "test/filter_errors_test.dart";
  const argRows = Array.from({ length: 12 }, (_, i) => `row(r'{{ v${i} | upper }}', {'v${i}': 'a${i}'}, 'A${i}'),`);
  const errorRows = Array.from({ length: 5 }, (_, i) => `err(r'{{ v | nope${i} }}', 'slotprompt: 1:6: unknown filter "nope${i}"\\n'),`);
  const block = (path: string, rows: string[]) => `\`\`\`dart\n// Rows in ${path} (${rows.length} rows)\n${rows.join("\n")}\n\`\`\``;
  const REQUEST_R82 = `Add filters to slotprompt.\n\n${block(ARGS, argRows)}\n\n${block(ERRORS, errorRows)}\n`;
  const criterion = (id: string, then: string, when = "the filter tests run"): Spec["criteria"][number] => ({
    id, requirementIds: ["FR-001"], given: "the prescribed rows", when, then, method: "automated",
  });
  const R82: Spec["criteria"] = [
    criterion("AC-008", "exactly the supplied `12` rows of `filter_args` and the rows of `filter_errors` run, `17` rows in all, and the suite runs its `52` tests"),
    criterion("AC-002", String.raw`an unknown filter writes ` + "`" + String.raw`slotprompt: LINE:COL: MESSAGE\n` + "`" + " to stderr"),
    criterion("AC-005", String.raw`with no argument the join separator value is ` + "`" + String.raw`default "\n"` + "`" + " (backslash followed by letter n)"),
    criterion("AC-004", "| input | output |\n|---|---|\n| `\\^@` | `\\u0000` |\n| `\\^_` | `\\u001f` |\n\nthe escape filter covers \"U+0000 and U+001F\" and every control between"),
  ];
  const R81 = criterion("AC-009", "it exits 0", 'the user runs `["eval","--as","frac","7/3"]`');
  const ids = [...R82, R81].map((c) => c.id);
  const tasks = [task("T003", [{ path: ARGS, action: "create" }], ids), task("T004", [{ path: ERRORS, action: "create" }], ids)];
  const r82Spec = (extra: Spec["criteria"] = []): Spec => ({ ...fixtureSpec, criteria: [...fixtureSpec.criteria, ...R82, ...extra] });

  test("R82 slotprompt filters: the four criteria raise no note", () => {
    expect(notPrescribedFindings(r82Spec(), graph(tasks), REQUEST_R82, { checks })).toEqual([]);
  });

  test("R81 exact-cli: a row the brief never prescribes is still noted beside them", () => {
    const findings = notPrescribedFindings(r82Spec([R81]), graph(tasks), REQUEST_R82, { checks });
    expect(findings.map((f) => f.id)).toEqual(["NOT-PRESCRIBED-AC-009"]);
    expect(findings[0]?.description).toContain(JSON.stringify('["eval","--as","frac","7/3"]'));
    expect(findings[0]?.blocking).toBe(false);
  });

  test("each R82 literal is cited, and how", () => {
    const names = { names: new Set(["filter_args", "filter_errors"]), counts: new Set([12, 5, 17]) };
    expect(citedKind("12", " rows of", names)).toBe("count");
    expect(citedKind("52", " tests", names)).toBe("count");
    expect(citedKind("17", ", and", names)).toBe("count");
    expect(citedKind("filter_args", " and", names)).toBe("name");
    expect(citedKind(String.raw`slotprompt: LINE:COL: MESSAGE\n`, " to stderr", names)).toBe("placeholder");
    expect(citedKind(String.raw`default "\n"`, " (backslash followed by letter n)", names)).toBe("description");
    expect(citedKind(String.raw`\^@`, "", names)).toBe("description");
    expect(citedKind(String.raw`\u001f`, "", names)).toBe("description");
    expect(citedKind("U+0000 and U+001F", " and every", names)).toBe("description");
    // Literals of a row: a value, an argument list, a message, a lone upper-case word.
    for (const literal of ['["eval","--as","frac","7/3"]', "3", "slotprompt: 1:6: unknown filter", "NAME", "default"])
      expect(citedKind(literal, " is printed", names)).toBeUndefined();
  });

  // The task-end walk marks the same cases `cited`: not refused, as before, and no longer recorded
  // as `case_not_prescribed`, which the scheduler records only for `none`.
  test("the task-end walk marks them cited, not none", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-cited-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // The last carrier of the shared criteria owns their cases (#1597).
    mkdirSync(dirname(join(root, ERRORS)), { recursive: true });
    writeFileSync(join(root, ERRORS), `import 'package:test/test.dart';\n\nvoid main() {\n${errorRows.map((r) => `  ${r}`).join("\n")}\n}\n`);
    const walks: CaseWalk[] = [];
    const literals: string[][] = [];
    const check = caseCheck(r82Spec([R81]), tasks[1] as TaskGraph["tasks"][number], {
      checks, tasks, prescribedRows: prescribedRowFiles(REQUEST_R82, graph(tasks)),
      record: (w, cases) => { walks.push(w); literals.push(cases.map((c) => c.literal)); },
    });
    expect(await check?.(root)).toEqual([]);
    const by = (kind: string) => (walks[0]?.cases ?? []).flatMap((c, i) => (c.prescribed === kind ? [literals[0]?.[i]] : []));
    expect(by("none")).toEqual(['["eval","--as","frac","7/3"]']);
    expect(by("cited")).toEqual(expect.arrayContaining(["12", "filter_args", "17", "52", String.raw`slotprompt: LINE:COL: MESSAGE\n`, String.raw`default "\n"`, "U+0000 and U+001F", String.raw`\u0000`]));
  });

  // One case per language for the count, name and placeholder shapes; the R81 row is noted in each.
  const LANGUAGES = [
    { name: "dart", fence: "dart", args: "test/filter_args_test.dart", errors: "test/filter_errors_test.dart", header: (p: string, n: number) => `// Rows in ${p} (${n} rows)`, row: (i: number) => `row(r'{{ v | f${i} }}', 'out${i}'),` },
    { name: "c", fence: "c", args: "tests/test_filter_args.c", errors: "tests/test_filter_errors.c", header: (p: string, n: number) => `/* Rows in ${p} (${n} rows) */`, row: (i: number) => `ROW("{{ v | f${i} }}", "out${i}"),` },
    { name: "elixir", fence: "elixir", args: "test/filter_args_test.exs", errors: "test/filter_errors_test.exs", header: (p: string, n: number) => `# Rows in ${p} (${n} rows)`, row: (i: number) => `row("{{ v | f${i} }}", "out${i}")` },
    { name: "typescript", fence: "ts", args: "tests/filter_args.test.ts", errors: "tests/filter_errors.test.ts", header: (p: string, n: number) => `// Rows in ${p} (${n} rows)`, row: (i: number) => `{ template: "{{ v | f${i} }}", out: "out${i}" },` },
  ];
  for (const l of LANGUAGES)
    test(`${l.name}: counts, test names and a placeholder envelope raise no note; the R81 row does`, () => {
      const rows = (from: number, n: number) => Array.from({ length: n }, (_, i) => l.row(from + i));
      const fenced = (p: string, r: string[]) => `\`\`\`${l.fence}\n${l.header(p, r.length)}\n${r.join("\n")}\n\`\`\``;
      const request = `Add filters.\n\n${fenced(l.args, rows(0, 3))}\n\n${fenced(l.errors, rows(3, 2))}\n`;
      const spec: Spec = {
        ...fixtureSpec,
        criteria: [
          criterion("AC-001", "the supplied `3` rows of `filter_args` and `2` of `filter_errors` run, `5` in all"),
          criterion("AC-002", "an unknown filter prints `error: LINE:COL: unknown filter NAME`"),
          R81,
        ],
      };
      const plan = [task("T001", [{ path: l.args, action: "create" }], ["AC-001", "AC-002", "AC-009"]), task("T002", [{ path: l.errors, action: "create" }], ["AC-001", "AC-002", "AC-009"])];
      const findings = notPrescribedFindings(spec, graph(plan), request, { checks });
      expect(findings.map((f) => f.id)).toEqual(["NOT-PRESCRIBED-AC-009"]);
    });

  // Scripted R82 shape through the scheduler: analysis of the filters plan records no
  // `case_not_prescribed` would-stop for the four criteria, only for the R81 row.
  test("scenario: analysis records case_not_prescribed only for the row no block holds", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const full = r82Spec([R81]);
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "spec") return { output: full, inputTokens: 25, outputTokens: 25 };
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { markdown: string; taskGraph: TaskGraph };
        plan.taskGraph.specHash = hashJson(full);
        plan.taskGraph.planHash = hashBytes(plan.markdown);
        const [first] = plan.taskGraph.tasks;
        if (!first) throw new Error("no planned task");
        plan.taskGraph.tasks = [
          // Two source tasks, so the row criteria are not broad (#1366: more than half the tasks).
          { ...first, id: "T001", criterionIds: ["AC-001"], writes: [{ path: "value.txt", action: "create" }] },
          { ...first, id: "T002", title: "Filters", criterionIds: ["AC-001"], writes: [{ path: "lib/src/filters.dart", action: "create" }] },
          { ...first, id: "T003", title: "Filter args rows", criterionIds: ids, dependsOn: ["T001"], writes: [{ path: ARGS, action: "create" }] },
          { ...first, id: "T004", title: "Filter error rows", criterionIds: ids, dependsOn: ["T001"], writes: [{ path: ERRORS, action: "create" }] },
        ];
      }
      return out;
    };
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST_R82, ownerLabel: "test", policy: fixture.policy });
    await service.drive(run.runId, new AbortController().signal);
    const keys = service.store
      .eventsOfType(run.runId, "decision.would_stop")
      .map((e) => e.payload as { reason: string; key: string })
      .filter((p) => p.reason === "case_not_prescribed" && p.key.startsWith("analysis-"))
      .map((p) => p.key);
    expect(keys).toEqual(["analysis-AC-009"]);
  }, 60000);
});

// #2531: outside prescribed rows the walk still demanded a cited literal (#2524 applied
// `CriterionCase.cited` only through `casePrescribed`), so a criterion that cites a supplied
// verbatim test file's row count, its name or a `LINE:COL: MESSAGE` envelope raised a blocking
// `SUPPLIED-` finding at analysis and a refusal at the task end, though no such file can hold
// them as written. `citedCases: "skip"` (opt-in) has both leave such a literal out; the walk
// records it as `cited`. A real missing literal is found either way.
describe("cited literals outside prescribed rows, under citedCases (#2531)", () => {
  const LANGUAGES = [
    { name: "dart", fence: "dart", path: "test/filter_args_test.dart", row: (i: number) => `row(r'{{ v | f${i} }}', 'out${i}');`, file: (rows: string[]) => `import 'package:test/test.dart';\n\nvoid main() {\n${rows.map((r) => `  ${r}`).join("\n")}\n}` },
    { name: "c", fence: "c", path: "tests/test_filter_args.c", row: (i: number) => `ROW("{{ v | f${i} }}", "out${i}");`, file: (rows: string[]) => `#include "rows.h"\n\nint main(void) {\n${rows.map((r) => `  ${r}`).join("\n")}\n  return 0;\n}` },
    { name: "elixir", fence: "elixir", path: "test/filter_args_test.exs", row: (i: number) => `row("{{ v | f${i} }}", "out${i}")`, file: (rows: string[]) => `defmodule FilterArgsTest do\n  use ExUnit.Case\n${rows.map((r) => `  ${r}`).join("\n")}\nend` },
    { name: "typescript", fence: "ts", path: "tests/filter_args.test.ts", row: (i: number) => `row("{{ v | f${i} }}", "out${i}");`, file: (rows: string[]) => `import { row } from "./rows";\n\n${rows.join("\n")}` },
  ];
  const CITED = ["12", "filter_args", String.raw`slotprompt: LINE:COL: MESSAGE\n`];
  const citing = criterion("AC-007", "exactly the supplied `12` rows of `filter_args` run, and an unknown filter writes `slotprompt: LINE:COL: MESSAGE\\n` to stderr");
  const missing = criterion("AC-008", "it prints `mdtoc version 2.1.0`");
  function criterion(id: string, then: string): Spec["criteria"][number] {
    return { id, requirementIds: ["FR-001"], given: "the supplied tests", when: "the filter tests run", then, method: "automated" };
  }
  for (const l of LANGUAGES) {
    const content = l.file(Array.from({ length: 12 }, (_, i) => l.row(i)));
    const request = `Add filters. Create \`${l.path}\` with exactly this content:\n\n\`\`\`${l.fence}\n${content}\n\`\`\`\n`;
    const T001 = task("T001", [{ path: l.path, action: "create" }], ["AC-007", "AC-008"]);
    const plan = graph([T001]);
    const both: Spec = { ...fixtureSpec, criteria: [...fixtureSpec.criteria, citing, missing] };
    const walk = async (citedCases?: "skip") => {
      const root = mkdtempSync(join(tmpdir(), "baked-cited-skip-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(dirname(join(root, l.path)), { recursive: true });
      writeFileSync(join(root, l.path), `${content}\n`);
      const walks: CaseWalk[] = [];
      const literals: string[][] = [];
      const check = caseCheck(both, T001, {
        checks, tasks: plan.tasks, ...(citedCases ? { citedCases } : {}),
        record: (w, cases) => { walks.push(w); literals.push(cases.map((c) => c.literal)); },
      });
      const refusals = (await check?.(root)) ?? ["no case check"];
      const cited = (walks[0]?.cases ?? []).flatMap((c, i) => (c.cited ? [literals[0]?.[i]] : []));
      return { refusals, cited };
    };

    test(`${l.name}: with citedCases skip, a cited count, name and envelope raise no SUPPLIED- finding and no refusal`, async () => {
      const findings = suppliedContentFindings(both, plan, request, { checks, citedCases: "skip" });
      expect(findings.map((f) => f.id)).toEqual(["SUPPLIED-AC-008"]);
      const { refusals, cited } = await walk("skip");
      expect(cited).toEqual(CITED);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('"mdtoc version 2.1.0"');
    });

    test(`${l.name}: off by default, the finding and the refusal stay`, async () => {
      const findings = suppliedContentFindings(both, plan, request, { checks });
      expect(findings.map((f) => f.id)).toEqual(["SUPPLIED-AC-007", "SUPPLIED-AC-008"]);
      for (const literal of CITED) expect(findings[0]?.description).toContain(JSON.stringify(literal));
      const { refusals, cited } = await walk();
      expect(cited).toEqual([]);
      expect(refusals).toHaveLength(CITED.length + 1);
    });
  }

  test("the R64 mdtoc literal the supplied file lacks is found with the setting on", () => {
    const findings = suppliedContentFindings(WRONG, graph([task("T004", [{ path: TEST, action: "create" }])]), REQUEST, { checks, citedCases: "skip" });
    expect(findings.map((f) => f.id)).toEqual(["SUPPLIED-AC-006"]);
  });

  // Through the scheduler: `citedCases: "skip"` in the run's policy reaches analysis, which then
  // asks the spec author nothing about a criterion that cites a test count of the supplied file.
  test("scenario: the run's citedCases reaches the analysis finding", async () => {
    const cites = spec("exactly the supplied `12` tests of `tests/version.test.ts` pass, and it prints `mdtoc 2.1.0`");
    const asked = async (citedCases?: "skip") => {
      const fixture = workflowFixture();
      cleanups.push(fixture.dispose);
      const { service, executor } = fixture;
      const original = executor.execute.bind(executor);
      executor.execute = async (request: ExecutionRequest) => {
        if (request.profile.output === "spec") return { output: cites, inputTokens: 25, outputTokens: 25 };
        const out = await original(request);
        if (request.profile.output === "plan") {
          const plan = out.output as { markdown: string; taskGraph: TaskGraph };
          plan.taskGraph.specHash = hashJson(cites);
          plan.taskGraph.planHash = hashBytes(plan.markdown);
          plan.taskGraph.tasks = [{ ...(plan.taskGraph.tasks[0] as TaskGraph["tasks"][number]), id: "T001", criterionIds: ["AC-001", "AC-006"], writes: [{ path: "value.txt", action: "create" }, { path: TEST, action: "create" }] }];
        }
        return out;
      };
      const policy = { ...fixture.policy, ...(citedCases ? { citedCases } : {}) };
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: REQUEST, ownerLabel: "test", policy });
      await service.drive(run.runId, new AbortController().signal);
      return service.store.requests(run.runId).filter((r) => r.kind === "clarification").map((r) => r.body_json).join("\n");
    };
    expect(await asked()).toContain("Supplied content: AC-006");
    expect(await asked("skip")).not.toContain("Supplied content");
  }, 60000);
});

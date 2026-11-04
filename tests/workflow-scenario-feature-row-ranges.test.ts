import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isNoRow } from "../src/core/intelligence/language-records.js";
import { FEATURE_ROWS_HEADING, framedFeatureRows, parseRowList, scopeRowRanges } from "../src/core/workflows/feature-rows.js";
import { hostApplyContents, hostApplyInputs, hostApplyRecords, rowFileTasks } from "../src/core/workflows/host-apply.js";
import { type InitiativePlan, featureRowFiles, featureRowSplit, rowOwnerProblems } from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";
import { ROW_FILE_SHAPES } from "../src/core/workflows/row-file.js";
import { rowBlockDrifts } from "../src/core/workflows/row-block-drift.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { suppliedRows } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { runRoot } from "../src/core/workflows/worktree.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2898, bench round 96 varprompt (C#): the split gave `CliRows.cs` to four features by row range
// in words ("Own ... CliRows rows 1-10", "CliRows row 12", "CliRows row 13", "CliRows row 11"),
// and the host wrote all 13 rows into the first feature, cli. Its required `tests-written` check
// ran the rows of template, reports and values, which print "varprompt: not implemented" until
// those features run; three correctives later a session reported a spec conflict and the run
// waited for a person. The feature prompt now states each feature's rows of a shared row file,
// and `suppliedRows` keeps only those in the feature's run, so every reader sees the same rows.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";
const CLI_ROWS = "tests/Varprompt.Tests/CliRows.cs";
const SCAFFOLD = "tests/Varprompt.Tests/ScaffoldTests.cs";
// The 13 rows: cli's 1-10 run `version`, `help` and `parse`; 11 is values', 12 template's, 13 reports'.
const ROWS = [
  ...Array.from({ length: 10 }, (_, i) => `[InlineData("parse a${i}.tmpl", 0, "ok a${i}")]`),
  '[InlineData("check --set a= --strict a.tmpl", 1, "varprompt: unused --set a")]',
  '[InlineData("render place.tmpl", 1, "varprompt: no value for place")]',
  '[InlineData("stats a.tmpl", 0, "tags 3 variables 3")]',
];
const OWN = { cli: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], values: [11], template: [12], reports: [13] };
const classFile = (rows: readonly string[]) =>
  ["using Xunit;", "", "public class CliRows", "{", "    [Theory]", ...rows.map((r) => `    ${r}`), "    public void Runs(string args, int code, string output) => Assert.Equal((code, output), Cli.Run(args));", "}", ""].join("\n");
const brief = [
  "Build varprompt, a prompt template tool.",
  "",
  `${fence}text`,
  `CliRows in ${CLI_ROWS} (13 rows: args | code | output)`,
  ...ROWS,
  fence,
  "",
].join("\n");
const feature = (id: string, scope: string, dependsOn: string[], extra: Partial<InitiativePlan["features"][number]> = {}) => ({
  id,
  title: id,
  boundary: { scope, paths: [`src/Varprompt/${id}.cs`, CLI_ROWS] },
  contract: `The ${id} commands of varprompt.`,
  dependsOn,
  mandatory: true,
  ...extra,
});
// Plan revision 1 of R96 varprompt, cut to the one shared file: the ranges are in the scopes.
const varprompt = (overrides: Record<string, Partial<InitiativePlan["features"][number]>> = {}): InitiativePlan => ({
  schemaVersion: 1,
  title: "varprompt",
  goals: ["varprompt renders prompt templates."],
  completionCriteria: ["Every prescribed row passes."],
  features: [
    feature("cli", "Own ReadsRows all 28 rows, CliRows rows 1-10, OptionsRows rows 1-17, 20 and 22, and the entry point.", [], overrides.cli),
    feature("template", "The template parser; CliRows row 12.", ["cli"], overrides.template),
    feature("reports", "The stats report; CliRows row 13.", ["cli", "template"], overrides.reports),
    feature("values", "OptionsRows rows 18-19 and 21, value files, CliRows row 11.", ["cli", "template", "reports"], overrides.values),
  ],
});
const row = { id: "varprompt", prompt: brief } as InitiativeRow;
const promptOf = (plan: InitiativePlan, id: string) => featurePrompt(row, plan, plan.features.find((f) => f.id === id)!, []);

describe("which rows of a shared prescribed row file a feature owns (#2898)", () => {
  test("the R96 scopes give cli rows 1-10, values 11, template 12 and reports 13, with no split problem", () => {
    const split = featureRowSplit(varprompt(), brief).get(CLI_ROWS);
    expect(split?.total).toBe(13);
    expect(Object.fromEntries(split?.own ?? [])).toEqual(OWN);
    expect(split?.problems).toEqual([]);
  });

  test("each feature's run holds its own rows and those of the sharers it depends on", () => {
    const plan = varprompt();
    const rows = (id: string) => featureRowFiles(plan, brief, { id }).map((f) => [f.path, f.rows, f.upstream]);
    expect(rows("cli")).toEqual([[CLI_ROWS, OWN.cli, []]]);
    expect(rows("template")).toEqual([[CLI_ROWS, [...OWN.cli, 12], OWN.cli]]);
    expect(rows("reports")).toEqual([[CLI_ROWS, [...OWN.cli, 12, 13], [...OWN.cli, 12]]]);
    expect(rows("values")).toEqual([[CLI_ROWS, Array.from({ length: 13 }, (_, i) => i + 1), [...OWN.cli, 12, 13]]]);
  });

  test("the feature prompt states the rows, and suppliedRows in that run reads only them", () => {
    const prompt = promptOf(varprompt(), "cli");
    expect(prompt).toContain(FEATURE_ROWS_HEADING);
    expect(prompt).toContain(`- ${CLI_ROWS}: rows 1-10 of 13 (this feature adds rows 1-10)`);
    expect(framedFeatureRows(prompt)?.get(CLI_ROWS)).toEqual(new Set(OWN.cli));
    expect(suppliedRows(prompt, [CLI_ROWS]).get(CLI_ROWS)?.lines).toEqual(ROWS.slice(0, 10));
    // The initiative's own request and any run outside an initiative keep the whole block.
    expect(suppliedRows(brief, [CLI_ROWS]).get(CLI_ROWS)?.lines).toEqual(ROWS);
    const template = promptOf(varprompt(), "template");
    expect(template).toContain(`- ${CLI_ROWS}: rows 1-10, 12 of 13 (rows 1-10 are upstream features' and stay as delivered; this feature adds rows 12)`);
    expect(suppliedRows(template, [CLI_ROWS]).get(CLI_ROWS)?.lines).toEqual([...ROWS.slice(0, 10), ROWS[11]]);
  });

  test("a row range typed on the feature wins over the scope's words", () => {
    const plan = varprompt({ cli: { rows: [{ path: CLI_ROWS, rows: [1, 2, 3] }] }, values: { rows: [{ path: CLI_ROWS, rows: [4, 5, 6, 7, 8, 9, 10, 11] }] } });
    expect(Object.fromEntries(featureRowSplit(plan, brief).get(CLI_ROWS)?.own ?? [])).toEqual({ cli: [1, 2, 3], values: [4, 5, 6, 7, 8, 9, 10, 11], template: [12], reports: [13] });
  });

  test("a file no sharer states rows for keeps the whole block in every feature, as before", () => {
    const plain = varprompt();
    for (const f of plain.features) f.boundary.scope = `The ${f.id} commands.`;
    expect(featureRowSplit(plain, brief).size).toBe(0);
    expect(promptOf(plain, "cli")).not.toContain(FEATURE_ROWS_HEADING);
    expect(suppliedRows(promptOf(plain, "cli"), [CLI_ROWS]).get(CLI_ROWS)?.lines).toEqual(ROWS);
  });

  test("a sharer that states no rows takes the rows no other sharer states", () => {
    const plan = varprompt();
    plan.features[3]!.boundary.scope = "Value files and the --set option.";
    expect(featureRowSplit(plan, brief).get(CLI_ROWS)?.own.get("values")).toEqual([11]);
  });

  test("rows two features claim, or no feature claims, are a row-split problem in the would-stop record", () => {
    const twice = varprompt();
    twice.features[1]!.boundary.scope = "The template parser; CliRows rows 10 and 12.";
    expect(rowOwnerProblems(twice, brief)).toEqual([expect.objectContaining({ path: CLI_ROWS, owner: "cli", needs: "template", shape: "row-split", rows: 1, problem: `${CLI_ROWS}: cli and template both claim row 10: give each row of the file to one feature in its rows.` })]);
    const free = varprompt();
    free.features[3]!.boundary.scope = "Value files, CliRows row 12.";
    free.features[1]!.boundary.scope = "The template parser; CliRows row 12.";
    const found = rowOwnerProblems(free, brief).filter((p) => p.shape === "row-split");
    expect(found.map((p) => p.problem)).toEqual([
      `${CLI_ROWS}: template and values both claim row 12: give each row of the file to one feature in its rows.`,
      `${CLI_ROWS}: no feature claims row 11 of 13: give each row of the file to the feature whose code makes it pass, in its rows.`,
    ]);
  });

  test("the later-row rule reads only the owner's rows: a row ranged to the later feature is no problem", () => {
    // reports' contract quotes the stats output that row 13 holds.
    const quoted = varprompt({ reports: { contract: "`varprompt stats` prints `tags 3 variables 3`." } });
    expect(rowOwnerProblems(quoted, brief)).toEqual([]);
    // Without ranges cli owns all 13 rows, and row 13 needs reports (#2487).
    for (const f of quoted.features) f.boundary.scope = `The ${f.id} commands.`;
    expect(rowOwnerProblems(quoted, brief)).toContainEqual(expect.objectContaining({ owner: "cli", needs: "reports", shape: "later-row", literal: "tags 3 variables 3" }));
  });

  test("scope words: lists, `to`, singular rows, `all N rows`, backticks; other files' names do not match", () => {
    expect(scopeRowRanges("Own `CliRows` rows 1-10, OptionsRows rows 1-17, 20 and 22", ["CliRows"], 13)).toEqual(OWN.cli);
    expect(scopeRowRanges("Own CliRows rows 1-10, OptionsRows rows 1-17, 20 and 22", ["OptionsRows"], 22)).toEqual([...parseRowList("1-17", 22), 20, 22]);
    expect(scopeRowRanges("ReadsRows all 28 rows", ["ReadsRows"], 28)).toHaveLength(28);
    expect(scopeRowRanges("CliRows row 12", ["CliRows"], 13)).toEqual([12]);
    expect(scopeRowRanges("CliRows rows 3 to 5", ["CliRows"], 13)).toEqual([3, 4, 5]);
    expect(scopeRowRanges("MoreCliRows rows 1-2", ["CliRows"], 13)).toBeNull();
    expect(scopeRowRanges("CliRows rows 12-40", ["CliRows"], 13)).toEqual([12, 13]);
    expect(scopeRowRanges("Own TemplateRows all 24, CheckRows all 16", ["TemplateRows"], 24)).toHaveLength(24);
    expect(scopeRowRanges("Own TemplateRows all 24, CheckRows all 16", ["CheckRows"], 16)).toHaveLength(16);
    expect(scopeRowRanges("TagsRows all rows", ["TagsRows"], 5)).toEqual([1, 2, 3, 4, 5]);
  });

  // R96 varprompt template (run 0509c8c1): the plan's own scopes split TagsRows and LimitsRows
  // between template and reports, and the host wrote reports' rows into template.
  test("R96 template and reports: TagsRows and LimitsRows split as the plan's scopes say", () => {
    const fileOf = (name: string) => `tests/Varprompt.Tests/${name}.cs`;
    const request = (["TagsRows", "LimitsRows"] as const)
      .map((name, i) => [`${fence}text`, `${name} in ${fileOf(name)} (${[18, 3][i]} rows)`, ...Array.from({ length: [18, 3][i]! }, (_, r) => `[InlineData("${name} ${r + 1}")]`), fence].join("\n"))
      .join("\n\n");
    const paths = [fileOf("TagsRows"), fileOf("LimitsRows")];
    const plan: InitiativePlan = {
      schemaVersion: 1,
      title: "varprompt",
      goals: ["g"],
      completionCriteria: ["c"],
      features: [
        { id: "cli", title: "cli", boundary: { scope: "Own Cli.Run.", paths: ["src/Varprompt/Cli.cs"] }, contract: "c", dependsOn: [], mandatory: true },
        { id: "template", title: "template", boundary: { scope: "Own Template.cs, Report.cs and CheckCommand.cs. Own TemplateRows all 24, CheckRows all 16, TagsRows rows 11-18, LimitsRows rows 1-2, SizesRows rows 1-9 and 12, and CliRows row 12. Shared files retain the union of delivered rows in supplied order; only InlineData lines change.", paths: ["src/Varprompt/Template.cs", ...paths] }, contract: "c", dependsOn: ["cli"], mandatory: true },
        { id: "reports", title: "reports", boundary: { scope: "Own VarsCommand and StatsCommand. Own VarsRows all 13, StatsRows all 14, TagsRows rows 1-10, LimitsRows row 3 and CliRows row 13. Preserve other owners' InlineData rows.", paths: ["src/Varprompt/VarsCommand.cs", "src/Varprompt/StatsCommand.cs", ...paths] }, contract: "c", dependsOn: ["cli", "template"], mandatory: true },
      ],
    };
    const prompt = featurePrompt({ id: "varprompt", prompt: request } as InitiativeRow, plan, plan.features[1]!, []);
    const rows = suppliedRows(prompt, paths);
    expect(rows.get(fileOf("TagsRows"))?.lines).toEqual(Array.from({ length: 8 }, (_, r) => `[InlineData("TagsRows ${r + 11}")]`));
    expect(rows.get(fileOf("LimitsRows"))?.lines).toEqual(['[InlineData("LimitsRows 1")]', '[InlineData("LimitsRows 2")]']);
    expect(rowOwnerProblems(plan, request)).toEqual([]);
  });
});

// One case per row notation: the language's own golden example (`ROW_FILE_SHAPES`), its two rows
// split between two features of one chain. The first feature's host write holds only its row; the
// second's, on the first's file, holds both.
describe("the host writes only a feature's rows of a shared row file, in every row notation (#2898)", () => {
  for (const [language, record] of Object.entries(ROW_FILE_SHAPES)) {
    if (isNoRow(record)) continue;
    const { path, reference, rows } = record.example;
    test(`${language}: ${path}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "feature-row-ranges-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const ext = path.slice(path.lastIndexOf("."));
      const scaffold = join(dirname(path), `scaffold_shape${ext}`);
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, scaffold), reference);
      const name = (path.split("/").at(-1) ?? path).replace(/\.[^.]*$/, "");
      const request = [`${fence}text`, `${name} in ${path} (${rows.length} rows)`, ...rows, fence, ""].join("\n");
      const plan: InitiativePlan = {
        schemaVersion: 1,
        title: "shared",
        goals: ["g"],
        completionCriteria: ["c"],
        features: [
          { id: "first", title: "first", boundary: { scope: `${name} row 1.`, paths: ["src/first", path] }, contract: "first", dependsOn: [], mandatory: true },
          { id: "second", title: "second", boundary: { scope: `${name} row 2.`, paths: ["src/second", path] }, contract: "second", dependsOn: ["first"], mandatory: true },
        ],
      };
      const run = (id: string) => featurePrompt({ id: "shared", prompt: request } as InitiativeRow, plan, plan.features.find((f) => f.id === id)!, []);
      const task = { writes: [{ path, action: "create" as const }], reference: scaffold };
      const graph = { tasks: [{ ...task, id: "T001", origin: "planned" }] } as unknown as Pick<TaskGraph, "tasks">;
      expect(rowFileTasks(run("first"), graph)).toEqual(["T001"]);
      const [first] = await hostApplyContents(root, run("first"), task);
      expect(first?.content).toContain(rows[0]!.trim());
      expect(first?.content).not.toContain(rows[1]!.trim());
      // The first feature's file is no drift against its own rows.
      expect(rowBlockDrifts(run("first"), { tasks: [{ ...task, id: "T001" } as never] }, () => first!.content).filter((c) => c.drifts.length)).toEqual([]);
      // The second feature's run, on the first's file, writes both rows. A one-row file is no shape
      // for two rows in some notations (a Java `Stream.of(` close, #2553): then the host declines
      // and a session places them, so the decision's inputs carry the count either way.
      writeFileSync(join(root, path), first!.content);
      const [inputs] = (await hostApplyInputs(root, run("second"), task)) ?? [];
      expect(inputs?.rows?.count).toBe(2);
      rmSync(join(root, path));
      const [second] = await hostApplyContents(root, run("second"), task);
      expect(second?.content).toContain(rows[0]!.trim());
      expect(second?.content).toContain(rows[1]!.trim());
    });
  }
});

/** T001 writes the source; T002 is the row file the host writes from the scaffold. */
class CliRowsExecutor extends FixtureExecutor {
  sessions: string[] = [];
  private action: "create" | "modify";
  constructor(workspace: string, existing: string | null, git: boolean) {
    super(workspace);
    this.action = existing === null ? "create" : "modify";
    mkdirSync(dirname(join(workspace, SCAFFOLD)), { recursive: true });
    writeFileSync(join(workspace, SCAFFOLD), classFile(['[InlineData("x", 0, "x")]', '[InlineData("y", 0, "y")]']));
    if (existing !== null) writeFileSync(join(workspace, CLI_ROWS), existing);
    // Worktree execution (two writers) branches from a commit that holds the scaffold; with
    // Windows' default `core.autocrlf` its checkout would turn the LF scaffold into CRLF.
    if (git) {
      for (const args of [["init"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "Fixture"], ["config", "core.autocrlf", "false"], ["add", "-A"], ["-c", "core.hooksPath=", "commit", "-m", "Fixture"]])
        expect(Bun.spawnSync(["git", ...args], { cwd: workspace }).exitCode).toBe(0);
    }
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      const first = graph.tasks[0]!;
      graph.tasks.push({ ...first, id: "T002", title: "Deliver the owned CliRows cases", dependsOn: ["T001"], writes: [{ path: CLI_ROWS, action: this.action }], reference: SCAFFOLD, checkIds: [] });
    }
    if (request.profile.output === "implementation") {
      this.sessions.push(request.task?.id ?? "");
      // In worktree execution the task's tree is the request's root, not the workspace.
      if (request.task?.id === "T001" && request.root) writeFileSync(join(request.root, "value.txt"), "ready");
    }
    return result;
  }
}

// The feature's `tests-written` check: every row it owns passes, and a row of a feature that has
// not run prints "varprompt: not implemented" (R96 T004's failures).
const testsWritten = (implemented: readonly number[]) => ({
  id: "tests-written",
  executable: "bun",
  args: [
    "-e",
    `const t = await Bun.file(${JSON.stringify(CLI_ROWS)}).text(); const rows = ${JSON.stringify(ROWS)}; const ok = new Set(${JSON.stringify(implemented)}); const bad = rows.flatMap((r, i) => t.includes(r) && !ok.has(i + 1) ? [r] : []); if (bad.length) { console.log("Actual: varprompt: not implemented " + bad.join(" ")); process.exit(1); } if (![...ok].every((n) => t.includes(rows[n - 1]))) { console.log("a row is missing"); process.exit(1); }`,
  ],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
});

async function featureRun(id: string, writers: number, before: string | null, plan = varprompt()) {
  const holds = featureRowFiles(plan, brief, { id })[0]?.rows ?? [];
  const policy: RunPolicy = { ...fixturePolicy, rowFileWrite: "on", ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}), checks: [...fixturePolicy.checks, testsWritten(holds)] };
  let executor: CliRowsExecutor | undefined;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new CliRowsExecutor(root, before, writers > 1);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: promptOf(plan, id), ownerLabel: "test", policy, ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 8 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const store = fixture.service.store;
  const final = await fixture.service.get(run.runId);
  return {
    final,
    file: readFileSync(join(runRoot(fixture.root, store.state(run.runId)), CLI_ROWS), "utf8"),
    sessions: executor?.sessions ?? [],
    record: hostApplyRecords(store, run.runId).find((r) => r.taskId === "T002"),
  };
}

describe("scenario: R96 varprompt, a shared row file written per feature by the host (#2898)", () => {
  for (const writers of [1, 2]) {
    test(`cli (writers ${writers}): the host writes rows 1-10 only and tests-written passes`, async () => {
      const { final, file, sessions, record } = await featureRun("cli", writers, null);
      expect(final.status).toBe("completed");
      expect(sessions).toEqual(["T001"]);
      // On main the host wrote all 13 rows, and tests-written failed on rows 11-13.
      expect(record).toMatchObject({ mode: "on", applied: true });
      expect(record?.writes[0]?.rows?.count).toBe(10);
      expect(file).toBe(classFile(ROWS.slice(0, 10)));
    }, 120000);

    test(`template (writers ${writers}): on cli's file the host adds row 12 and keeps rows 1-10`, async () => {
      const { final, file, record } = await featureRun("template", writers, classFile(ROWS.slice(0, 10)));
      expect(final.status).toBe("completed");
      expect(record?.writes[0]?.rows?.count).toBe(11);
      expect(file).toBe(classFile([...ROWS.slice(0, 10), ROWS[11]!]));
    }, 120000);
  }
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { placeRowForms, placeRowNumbers, placeRows, placeRowsDescription, placeRowTargets } from "../src/core/tools/place-rows.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import type { InitiativeFeature, InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { featurePrompt } from "../src/core/workflows/initiatives/service.js";
import type { InitiativeRow } from "../src/core/workflows/initiatives/store.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";

// Follow-up of #2939 (#2942): a feature's run holds only its rows of a shared row file
// (`suppliedRows` keeps the rows its prompt states under `FEATURE_ROWS_HEADING`), and the prompt
// names them by the request block's numbers ("rows 2, 4 of 4"). `place_rows` numbered the rows
// it holds 1 to n instead: a session that placed "row 4" as its prompt says was refused ("The
// request prescribes rows 1 to 2 ...; row 4 is not one of them"), and `[1, 2]` placed rows 2 and
// 4, reported as "rows 1 to 2 of the request's rows". The tool, its description and the brief's
// note now take and name the request's numbers (`placeRowNumbers`).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";

/** C++ and Java: languages with no `ROW_FILE_SHAPES` row, whose row files a session writes. */
const layouts = [
  {
    language: "C++",
    path: "tests/cli_test.cpp",
    rows: ['{"--help", 0, "usage"}', '{"--version", 0, "1.0"}', '{"--scale", 2, "needs a value"}', '{"--invert", 0, "inverted"}'],
    file: (rows: string[]) => ['#include "check.h"', "", "static const Row rows[] = {", ...rows.map((r) => `    ${r},`), "};", "", "int main() { return run_rows(rows); }", ""].join("\n"),
    line: 3,
    options: {},
  },
  {
    language: "Java",
    path: "src/test/java/pnm/CliTest.java",
    rows: ['new Row("--help", 0)', 'new Row("--version", 0)', 'new Row("--scale", 2)', 'new Row("--invert", 0)'],
    file: (rows: string[]) => ["package pnm;", "", "import java.util.List;", "", "class CliTest {", "  static final List<Row> ROWS =", "      List.of(", ...rows.map((r, i) => `          ${r}${i === rows.length - 1 ? "" : ","}`), "      );", "}", ""].join("\n"),
    line: 7,
    options: { indent: "          ", lastSeparator: "" },
  },
];

for (const layout of layouts) {
  const brief = ["Build pnmforge.", "", `${fence}text`, `CliTests in ${layout.path} (4 rows, { args, code, out })`, ...layout.rows, fence, ""].join("\n");
  const feature = (id: string, rows: number[]): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} options.`, paths: [`src/${id}.cpp`, layout.path] }, contract: `The ${id} options.`, dependsOn: [], mandatory: true, rows: [{ path: layout.path, rows }],
  });
  /** core and flags run side by side: flags' run holds rows 2 and 4 only. */
  const plan: InitiativePlan = {
    schemaVersion: 1, title: "pnmforge", goals: ["g"], completionCriteria: ["c"],
    features: [feature("core", [1, 3]), feature("flags", [2, 4])],
  };
  const prompt = featurePrompt({ id: "pnmforge", prompt: brief } as InitiativeRow, plan, plan.features[1]!, []);
  const task = { writes: [{ path: layout.path, action: "modify" as const }] };
  const flagsRows = [layout.rows[1]!, layout.rows[3]!];

  describe(`${layout.language}: place_rows takes the request's row numbers in a feature run (#2939 follow-up)`, () => {
    test("the prompt names rows 2 and 4, and so do the tool's numbers and description", () => {
      expect(prompt).toContain(`- ${layout.path}: rows 2, 4 of 4 (this feature adds rows 2, 4)`);
      const targets = placeRowTargets(prompt, task);
      expect(targets.get(layout.path)).toEqual(flagsRows);
      const numbers = placeRowNumbers(prompt, targets);
      expect(numbers.get(layout.path)).toEqual([2, 4]);
      expect(placeRowsDescription(targets, numbers)).toContain(`${layout.path} (rows 2, 4)`);
    });

    test("rows [2, 4] place the feature's two rows, a row of core is refused by its number", () => {
      const targets = placeRowTargets(prompt, task);
      const numbers = placeRowNumbers(prompt, targets);
      const scaffold = layout.file([]);
      const placed = placeRows({ path: layout.path, line: layout.line, rows: [2, 4], ...layout.options }, targets, scaffold, new Map(), numbers);
      expect(placed).toMatchObject({ placed: [2, 4], content: layout.file(flagsRows) });
      // On main: "The request prescribes rows 1 to 2 for ...; row 4 is not one of them."
      expect(placeRows({ path: layout.path, line: layout.line, rows: [3] }, targets, scaffold, new Map(), numbers)).toEqual({
        refusal: `The request prescribes rows 2, 4 for ${layout.path}; row 3 is not one of them. Call place_rows with rows [first, last] from 2, 4.`,
      });
      const once = "content" in placed ? placed.content : "";
      expect(placeRows({ path: layout.path, line: layout.line, rows: [4], ...layout.options }, targets, once, new Map(), numbers)).toEqual({
        refusal: expect.stringContaining(`${layout.path} already holds row 4 (line ${layout.line + 2})`),
      });
    });

    test("a request without the feature framing keeps rows 1 to n", () => {
      const targets = placeRowTargets(brief, task);
      expect(placeRowNumbers(brief, targets).size).toBe(0);
      expect(placeRowsDescription(targets)).toContain(`${layout.path} (rows 1 to 4)`);
      expect(placeRowForms(targets).code.get(layout.path)).toHaveLength(4);
    });
  });
}

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

/** Plans one task that places flags' rows in the scaffold and runs it through the real executor. */
class PlaceExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  constructor(
    workspace: string,
    private path: string,
    scaffold: string,
  ) {
    super(workspace);
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), scaffold);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nRows.\n## Decisions\nDEC-001: FR-001 takes the rows.\n## Components\ntests\n## Data\nText\n## Verification\nCheck the rows\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: "Row file", description: `Place flags' rows in ${this.path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: this.path, action: "modify", reason: "the request prescribes its rows" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

describe("scenario: flags' session places its rows by the numbers its prompt gives", () => {
  for (const layout of layouts)
    test(`${layout.language}: place_rows rows [2, 4] places rows 2 and 4 in one call`, async () => {
      const brief = ["Build pnmforge.", "", `${fence}text`, `CliTests in ${layout.path} (4 rows, { args, code, out })`, ...layout.rows, fence, ""].join("\n");
      const feature = (id: string, rows: number[]): InitiativeFeature => ({
        id, title: id, boundary: { scope: `The ${id} options.`, paths: [`src/${id}.cpp`, layout.path] }, contract: `The ${id} options.`, dependsOn: [], mandatory: true, rows: [{ path: layout.path, rows }],
      });
      const plan: InitiativePlan = { schemaVersion: 1, title: "pnmforge", goals: ["g"], completionCriteria: ["c"], features: [feature("core", [1, 3]), feature("flags", [2, 4])] };
      const prompt = featurePrompt({ id: "pnmforge", prompt: brief } as InitiativeRow, plan, plan.features[1]!, []);
      const rowsCheck = {
        id: "rows", executable: "bun", cwd: ".", timeoutMs: 10000, required: true, scope: "feature" as const, envNames: [], writes: [],
        args: ["-e", `const t = await Bun.file(${JSON.stringify(layout.path)}).text(); if (!${JSON.stringify([layout.rows[1], layout.rows[3]])}.every((r) => t.includes(r))) process.exit(1);`],
      };
      const policy: RunPolicy = { ...fixturePolicy, checks: [rowsCheck], rowFileWrite: "on" };
      const fixture = workflowFixture({ policy, executor: (root) => new PlaceExecutor(root, layout.path, layout.file([])) });
      cleanups.push(fixture.dispose);
      const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
      cleanups.push(() => native.dispose());
      fixture.executor.native = native;
      const seen = scriptModel([
        () => call("place_rows", { path: layout.path, line: layout.line, rows: [2, 4], ...layout.options }),
        () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: `Placed flags' rows of ${layout.path}`, evidenceIds: [], unresolved: [] }),
      ]);
      const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt, ownerLabel: "test", policy });
      let current = await fixture.service.drive(run.runId, new AbortController().signal);
      for (let i = 0; i < 8 && current.status === "waiting"; i++) {
        if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
        await fixture.approve(run.runId);
        current = await fixture.service.drive(run.runId, new AbortController().signal);
      }
      expect(seen.tools[0]).toContain("place_rows");
      // On main: "The request prescribes rows 1 to 2 for ...; row 4 is not one of them."
      expect(seen.prompts[1]).toContain(`Placed rows 2, 4 of the request's rows for ${layout.path} at lines ${layout.line + 1} to ${layout.line + 2}`);
      // The brief's note names the request's numbers, as the feature framing does.
      expect(seen.prompts[0]).toContain(`${layout.path} (2 rows: rows 2, 4 of the request's block)`);
      expect((await fixture.service.get(run.runId)).status).toBe("completed");
      expect(seen.prompts).toHaveLength(2);
      const store = fixture.service.store;
      expect(readFileSync(join(fixture.root, runRootPath(store, run.runId), layout.path), "utf8")).toBe(layout.file([layout.rows[1]!, layout.rows[3]!]));
    }, 60000);
});

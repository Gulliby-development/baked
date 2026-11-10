import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type InitiativeFeature, type InitiativePlan, rowNeedsFeatures, rowOwnerProblems, sequenceSharedPaths, testOwnershipProblems } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Bench round 108, netknot (Zig, #3010). The split gave `src/mask_rows_test.zig` whole to feature
// styles. Its `totals` rows run `merge --style mask`, and only feature merge writes
// `src/merge_command.zig`. merge's contract quoted no row literal, so `rowOwnerProblems` (#2487)
// found nothing; it also ran before `sequenceSharedPaths`, which then made merge depend on styles
// because the two share `src/options_rows_test.zig`. The styles run wrote the merge rows, its
// required test check printed `not implemented`, and it blocked `no_progress` after 1.64M tokens.
// R107 netweave (Kotlin) had the same split and passed only because its planner left the rows out.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";

/** One row notation per layout: a sort row, two merge rows (one through the program's name). */
const layouts = [
  {
    language: "Zig",
    rowsFile: "src/mask_rows_test.zig",
    optionsFile: "src/options_rows_test.zig",
    sources: { core: "src/main.zig", styles: "src/styles.zig", merge: "src/merge_command.zig", mask: "src/mask.zig" },
    row: (args: string[], out: string) => `.{ &.{ ${args.map((a) => `"${a}"`).join(", ")} }, 0, "${out}" },`,
  },
  {
    language: "Kotlin",
    rowsFile: "src/test/kotlin/MaskRowsTest.kt",
    optionsFile: "src/test/kotlin/OptionsRowsTest.kt",
    sources: { core: "src/main/kotlin/Main.kt", styles: "src/main/kotlin/Styles.kt", merge: "src/main/kotlin/MergeCommand.kt", mask: "src/main/kotlin/Mask.kt" },
    row: (args: string[], out: string) => `row(listOf(${args.map((a) => `"${a}"`).join(", ")}), 0, "${out}"),`,
  },
  {
    language: "Go",
    rowsFile: "cmd/netknot/mask_rows_test.go",
    optionsFile: "cmd/netknot/options_rows_test.go",
    sources: { core: "cmd/netknot/main.go", styles: "internal/styles/styles.go", merge: "internal/cli/merge/main.go", mask: "internal/styles/mask.go" },
    row: (args: string[], out: string) => `{[]string{${args.map((a) => `"${a}"`).join(", ")}}, 0, "${out}"},`,
  },
  {
    language: "TypeScript",
    rowsFile: "tests/mask-rows.test.ts",
    optionsFile: "tests/options-rows.test.ts",
    sources: { core: "src/cli.ts", styles: "src/styles.ts", merge: "src/commands/merge.ts", mask: "src/mask.ts" },
    row: (args: string[], out: string) => `[[${args.map((a) => `"${a}"`).join(", ")}], 0, "${out}"],`,
  },
  {
    language: "Python",
    rowsFile: "tests/test_mask_rows.py",
    optionsFile: "tests/test_options_rows.py",
    sources: { core: "netknot/cli.py", styles: "netknot/styles.py", merge: "netknot/merge_cmd.py", mask: "netknot/mask.py" },
    row: (args: string[], out: string) => `([${args.map((a) => `"${a}"`).join(", ")}], 0, "${out}"),`,
  },
  {
    language: "Elixir",
    rowsFile: "test/mask_rows_test.exs",
    optionsFile: "test/options_rows_test.exs",
    sources: { core: "lib/netknot/cli.ex", styles: "lib/netknot/styles.ex", merge: "lib/netknot/merge_command.ex", mask: "lib/netknot/mask.ex" },
    row: (args: string[], out: string) => `{[${args.map((a) => `"${a}"`).join(", ")}], 0, "${out}"},`,
  },
  {
    language: "request notation",
    rowsFile: "tests/mask_rows.bats",
    optionsFile: "tests/options_rows.bats",
    sources: { core: "bin/netknot", styles: "lib/styles.sh", merge: "lib/merge_command.sh", mask: "lib/mask.sh" },
    row: (args: string[], out: string) => `run ${args.map((a) => `"${a}"`).join(" ")} => 0 "${out}" ""`,
  },
];

for (const layout of layouts) {
  const { rowsFile, optionsFile, sources } = layout;
  /** `mutual`: the options rows run `mask`, whose source styles writes, so merge needs styles too. */
  const brief = (mutual = false) =>
    [
      "Build netknot, a CIDR set tool.",
      "",
      `${fence}text`,
      `totals in ${rowsFile} (4 rows: args | code | stdout)`,
      layout.row(["sort", "--style", "mask"], "10.0.0.0/8"),
      layout.row(["sort", "--style", "MASK"], "10.0.0.0/8"),
      layout.row(["merge", "--style", "mask"], "10.0.0.0/7"),
      layout.row(["netknot", "merge", "--style", "mask"], "10.0.0.0/7"),
      fence,
      "",
      `${fence}text`,
      `options in ${optionsFile} (1 row: args | code | stdout)`,
      layout.row(mutual ? ["mask", "--help"] : ["--help"], "usage"),
      fence,
      "",
    ].join("\n");
  const feature = (id: string, paths: string[], dependsOn: string[], scope: string, contract: string): InitiativeFeature => ({
    id, title: id, boundary: { scope, paths }, contract, dependsOn, mandatory: true,
  });
  /** The R108 split: merge on core only, as the decomposer wrote it, unless `mergeOn` says. */
  const split = (mergeOn: string[] = ["core"], mutual = false): InitiativePlan => ({
    schemaVersion: 1, title: "netknot", goals: ["netknot sorts and merges CIDR sets."], completionCriteria: ["Every prescribed row passes."],
    features: [
      feature("core", [sources.core], [], "The entry point and argument parsing.", "Parses arguments and dispatches commands."),
      feature("styles", [sources.styles, ...(mutual ? [sources.mask] : []), rowsFile, optionsFile], ["core"], "The mask and hex output styles of sort.", "Prints sorted sets in mask and hex style."),
      feature("merge", [sources.merge, optionsFile], mergeOn, "Merging adjacent and overlapping ranges.", "Merges adjacent ranges and prints the result in the chosen style."),
    ],
  });

  describe(`${layout.language}: a row that runs a later feature's command (#3010)`, () => {
    test("the row's command names the feature that writes its source", () => {
      const plan = split();
      expect(rowNeedsFeatures(plan, layout.row(["merge", "--style", "mask"], "x"))).toEqual({ command: "merge", features: ["merge"] });
      // The program's own name is skipped.
      expect(rowNeedsFeatures(plan, layout.row(["netknot", "merge"], "x"))?.features).toEqual(["merge"]);
      // A command no feature writes the source of, and a flag, need nobody.
      expect(rowNeedsFeatures(plan, layout.row(["sort", "--style", "mask"], "x"))).toBeNull();
      expect(rowNeedsFeatures(plan, layout.row(["--help"], "x"))).toBeNull();
    });

    test("the host orders styles after merge, so no row of styles needs a later feature", () => {
      const plan = split();
      const { plan: sequenced, added } = sequenceSharedPaths(plan, new Set(), new Set(), brief());
      // On main: merge -> styles by plan order, which leaves styles' merge rows red.
      expect(added).toEqual([{ featureId: "styles", dependsOn: "merge", paths: [optionsFile] }]);
      expect(sequenced.features.find((f) => f.id === "merge")?.dependsOn).toEqual(["core"]);
      expect(sequenceSharedPaths(plan).added).toEqual([{ featureId: "merge", dependsOn: "styles", paths: [optionsFile] }]);
      expect(rowOwnerProblems(plan, brief())).toEqual([]);
    });

    test("merge after styles, set by the decomposer: styles' merge rows are reported", () => {
      const found = rowOwnerProblems(split(["core", "styles"]), brief());
      // On main: [] (merge's contract quotes no row literal).
      expect(found).toEqual([
        expect.objectContaining({ path: rowsFile, owner: "styles", needs: "merge", literal: "merge", rows: 2, shape: "later-command" }),
      ]);
      expect(found[0]?.problem).toContain("runs `merge`, whose source only merge writes");
    });

    test("merge after styles, set by the host: the rule reads the sequenced plan", () => {
      // Both features' rows need the other, so the host keeps plan order (merge -> styles) and the
      // rule sees the dependency it added. On main the rule ran before sequencing and saw none.
      const plan = split(["core"], true);
      expect(sequenceSharedPaths(plan, new Set(), new Set(), brief(true)).added).toEqual([{ featureId: "merge", dependsOn: "styles", paths: [optionsFile] }]);
      expect(rowOwnerProblems(plan, brief(true))).toEqual([expect.objectContaining({ path: rowsFile, owner: "styles", needs: "merge", shape: "later-command" })]);
    });

    test("enforced, the decomposer gets the problem back; in shadow it does not", () => {
      const plan = split(["core", "styles"]);
      expect(testOwnershipProblems(plan, { request: brief(), mode: "enforce" }).join("\n")).toContain(`${rowsFile} holds 2 rows that only merge can pass`);
      expect(testOwnershipProblems(plan, { request: brief(), mode: "shadow" }).filter((p) => p.includes(rowsFile))).toEqual([]);
    });

    test("a command styles writes itself, or that an earlier feature also writes, needs no later feature", () => {
      const plan = split(["core", "styles"]);
      const shared = { ...plan, features: plan.features.map((f) => (f.id === "core" ? { ...f, boundary: { ...f.boundary, paths: [...f.boundary.paths, sources.merge] } } : f)) };
      expect(rowOwnerProblems(shared, brief())).toEqual([]);
    });
  });
}

describe("scenario: the R108 split through the initiative service (#3010)", () => {
  const layout = layouts[0];
  if (!layout) throw new Error("no layout");
  const { rowsFile, optionsFile, sources } = layout;
  const request = [
    "Build netknot, a CIDR set tool.",
    "",
    `${fence}text`,
    `totals in ${rowsFile} (2 rows: args | code | stdout)`,
    layout.row(["sort", "--style", "mask"], "10.0.0.0/8"),
    layout.row(["merge", "--style", "mask"], "10.0.0.0/7"),
    fence,
    "",
  ].join("\n");
  const plan = (mergeOn: string[]): InitiativePlan => ({
    schemaVersion: 1, title: "netknot", goals: ["netknot sorts and merges CIDR sets."], completionCriteria: ["Every prescribed row passes."],
    features: [
      { id: "core", title: "core", boundary: { scope: "The entry point.", paths: [sources.core, "src/core_test.zig"] }, contract: "Parses arguments.", dependsOn: [], mandatory: true },
      { id: "styles", title: "styles", boundary: { scope: "The mask and hex styles.", paths: [sources.styles, rowsFile, optionsFile] }, contract: "Prints sets in mask style.", dependsOn: ["core"], mandatory: true },
      { id: "merge", title: "merge", boundary: { scope: "Merging ranges.", paths: [sources.merge, "src/merge_test.zig", optionsFile] }, contract: "Merges adjacent ranges.", dependsOn: mergeOn, mandatory: true },
    ],
  });
  const launch = async (initiativeId: string, split: InitiativePlan) => {
    class Decomposer implements AgentExecutor {
      async execute(req: ExecutionRequest) {
        if (req.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${req.profile.output}`);
        return { output: split, inputTokens: 20, outputTokens: 30 };
      }
    }
    const root = mkdtempSync(join(tmpdir(), "baked-row-command-owner-"));
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: fixturePolicy } };
    const workflows = new NativeWorkflowService(root, config, new Decomposer());
    const initiatives = new InitiativeService(workflows);
    cleanups.push(() => {
      workflows.close();
      rmSync(root, { recursive: true, force: true });
    });
    await initiatives.start({ commandId: newId(), initiativeId, prompt: request, policy: fixturePolicy, ownerLabel: "test", keepFeatures: true });
    const view = await initiatives.drive(initiativeId, new AbortController().signal);
    const events = initiatives.events(initiativeId);
    const wouldStops = events
      .filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-row-owner")
      .map((e) => e.payload as { featureId: string; inputs: { needs: string; path: string } });
    const sequenced = events.filter((e) => e.type === "split.sequenced").map((e) => (e.payload as { added: unknown[] }).added);
    return { view, wouldStops, sequenced };
  };

  test("merge after styles: the split records a would-stop for styles' merge row", async () => {
    const { view, wouldStops } = await launch("netknot-after", plan(["core", "styles"]));
    expect(view.status).toBe("awaiting_approval");
    // On main: no would-stop, and the styles run blocked on the merge rows.
    expect(wouldStops).toEqual([expect.objectContaining({ featureId: "styles", inputs: expect.objectContaining({ path: rowsFile, needs: "merge" }) })]);
  }, 60000);

  test("merge on core only: the host makes styles wait for merge and records nothing", async () => {
    const { view, wouldStops, sequenced } = await launch("netknot-core", plan(["core"]));
    expect(view.status).toBe("awaiting_approval");
    expect(sequenced).toEqual([[{ featureId: "styles", dependsOn: "merge", paths: [optionsFile] }]]);
    expect(wouldStops).toEqual([]);
  }, 60000);
});

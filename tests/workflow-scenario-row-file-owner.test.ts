import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import type { InitiativeFeature, InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy } from "./helpers/workflow-fixture.js";

// Bench round 80, ratdec (Elixir, #2487): the brief prescribed one row file per topic, and the
// decomposer gave all 16 rows of `test/stdin_test.exs` to core although the row `eval --as mixed`
// on stdin needs the mixed output of representations, which depends on core. The plan checks
// accepted it; core's test check ran the row, T013 failed twice, T014 rewrote the row (582k
// tokens) and representations then failed on it (#2485). The split's test ownership now reads
// the prescribed rows (`suppliedRows`) against the later features' contracts: shadow by default
// (`initiative-row-owner` would-stop on the initiative), enforced it goes back to the decomposer.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const fence = "```";
const rowBlock = (name: string, path: string, rows: string[]) =>
  `${fence}text\n${name} in ${path} (${rows.length} rows: stdin | args | stdout)\n${rows.join("\n")}\n${fence}`;

/** Elixir (the R80 shape) and one other language layout. */
const layouts = [
  { language: "Elixir", code: ["lib/ratdec/cli.ex", "lib/ratdec/rat.ex"], format: "lib/ratdec/format.ex", own: "test/literals_test.exs", stdin: "test/stdin_test.exs", mixed: "test/mixed_test.exs" },
  { language: "TypeScript", code: ["src/cli.ts", "src/rat.ts"], format: "src/format.ts", own: "tests/literals.test.ts", stdin: "tests/stdin.test.ts", mixed: "tests/mixed.test.ts" },
];

for (const layout of layouts) {
  const prompt = [
    "Build ratdec, an exact rational calculator. Each row file below is prescribed; transcribe its rows as given.",
    rowBlock("LiteralsTest", layout.own, ["| eval 1/2 | 1/2", "| eval 4/2 | 2"]),
    rowBlock("StdinTest", layout.stdin, ["7/3 | eval | 7/3", "1/2+1/3 | eval | 5/6", "7/3 | eval --as mixed | 2 1/3"]),
    rowBlock("MixedTest", layout.mixed, ["| eval 7/3 --as mixed | 2 1/3", "| eval -7/3 --as mixed | -2 1/3"]),
  ].join("\n\n");
  const feature = (id: string, paths: string[], dependsOn: string[], contract: string): InitiativeFeature => ({
    id, title: id, boundary: { scope: `The ${id} layer`, paths }, contract, dependsOn, mandatory: true, size: "medium",
  });
  const split = (stdinOwner: "core" | "representations"): InitiativePlan => ({
    schemaVersion: 1, title: "ratdec", goals: ["An exact rational calculator"], completionCriteria: ["Every prescribed row passes"],
    features: [
      feature("core", [...layout.code, layout.own, ...(stdinOwner === "core" ? [layout.stdin] : [])], [],
        "`ratdec eval` reads an expression on stdin and prints the exact fraction. The mixed-format stdin row requires representations and may only pass after that dependent feature."),
      feature("representations", [layout.format, layout.mixed, ...(stdinOwner === "representations" ? [layout.stdin] : [])], ["core"],
        "`--as mixed` prints a mixed number such as `2 1/3`."),
      feature("docs", ["README.md", "docs/usage.md"], ["core", "representations"], "The README documents every command."),
    ],
  });

  const launch = async (initiativeId: string, stopModes?: Record<string, string>) => {
    const problems: string[][] = [];
    class Decomposer implements AgentExecutor {
      async execute(request: ExecutionRequest) {
        if (request.profile.output !== "initiativePlan") throw new Error(`Unexpected profile ${request.profile.output}`);
        // Like submit_result: first the R80 answer; a returned problem gets the corrected split.
        let output = split("core");
        problems.push(request.validate?.(output) ?? []);
        if (problems[0]?.length) {
          output = split("representations");
          problems.push(request.validate?.(output) ?? []);
        }
        return { output, inputTokens: 20, outputTokens: 30 };
      }
    }
    const root = mkdtempSync(join(tmpdir(), "baked-row-file-owner-"));
    const policy = { ...fixturePolicy, ...(stopModes ? { stopModes } : {}) };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy } };
    const workflows = new NativeWorkflowService(root, config, new Decomposer());
    const initiatives = new InitiativeService(workflows);
    cleanups.push(() => {
      workflows.close();
      rmSync(root, { recursive: true, force: true });
    });
    await initiatives.start({ commandId: newId(), initiativeId, prompt, policy, ownerLabel: "test", keepFeatures: true });
    const view = await initiatives.drive(initiativeId, new AbortController().signal);
    const wouldStops = initiatives
      .events(initiativeId)
      .filter((e) => e.type === "decision.would_stop" && (e.payload as { reason?: string }).reason === "initiative-row-owner")
      .map((e) => e.payload);
    return { view, problems, wouldStops };
  };

  describe(`${layout.language}: a prescribed row file with a row only a later feature can pass (#2487)`, () => {
    test("shadow (the default): the split is proposed as given and the initiative records the would-stop", async () => {
      const { view, problems, wouldStops } = await launch("ratdec");
      expect(view.status).toBe("awaiting_approval");
      expect(problems).toEqual([[]]);
      expect(view.features.find((f) => f.id === "core")?.boundary.paths).toContain(layout.stdin);
      expect(wouldStops).toEqual([
        expect.objectContaining({
          reason: "initiative-row-owner",
          mode: "shadow",
          featureId: "core",
          key: `row-owner-r1-${layout.stdin}`,
          summary: `${layout.stdin} holds a row that only representations can pass (\`7/3 | eval --as mixed | 2 1/3\` holds \`--as mixed\`, which the contract or scope of representations cites): give the file to representations (it depends on core), or ask for the row in the brief to be split into a file of representations.`,
          inputs: { path: layout.stdin, owner: "core", needs: "representations", row: "7/3 | eval --as mixed | 2 1/3", literal: "--as mixed", rows: 1 },
        }),
      ]);
    }, 60000);

    test("enforced: the decomposer gets the sentence back and its corrected split gives the file to representations", async () => {
      const { view, problems, wouldStops } = await launch("ratdec", { "initiative-row-owner": "enforce" });
      expect(problems).toHaveLength(2);
      expect(problems[0]).toHaveLength(1);
      expect(problems[0]?.[0]).toStartWith(`${layout.stdin} holds a row that only representations can pass`);
      expect(problems[1]).toEqual([]);
      expect(view.status).toBe("awaiting_approval");
      expect(view.features.find((f) => f.id === "representations")?.boundary.paths).toContain(layout.stdin);
      expect(view.features.find((f) => f.id === "core")?.boundary.paths).not.toContain(layout.stdin);
      expect(wouldStops).toEqual([]);
    }, 60000);
  });
}

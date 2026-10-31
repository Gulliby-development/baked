import { describe, expect, test } from "bun:test";
import type { PastRun } from "../src/core/workflows/estimate.js";
import {
  DEFAULT_PER_COMMAND,
  documentedSurfaceRate,
  documentsProgram,
  README_CORRECTION_TOKENS,
  requestCommands,
} from "../src/core/workflows/initiatives/documented-surface.js";
import {
  estimateInitiative,
  type FeatureRunSample,
  type FeatureToEstimate,
} from "../src/core/workflows/initiatives/estimate.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";

// Bench round 83, bytemerge (#2569): the 8th feature, `documentation` (README.md and LICENSE of a
// 15-command program), was priced from its two files at the size class of the one-file command
// features (expected 723,473, high 883,972) and used 2,252,251 tokens: two README attempts, two
// defects the documented-example review found and a 508k correction. It is now priced by the
// commands the request lists, plus one README correction round.
const SDD = [
  { id: "specify", type: "agent", models: [] },
  { id: "implement", type: "tasks", models: [] },
];
const history: PastRun[] = Array.from({ length: 6 }, (_, i) => ({
  runId: `h${i}`,
  workflowId: "sdd",
  status: "completed",
  tokens: 800_000,
  calls: 10,
  activeMs: 1000,
  taskCount: 3,
  stageTokens: { specify: 200_000, implement: 600_000 },
  taskTokens: 600_000,
}));
const sample = (runId: string, tokens: number, extra: Partial<FeatureRunSample> = {}): FeatureRunSample => ({
  runId,
  workflowId: "sdd",
  size: "small",
  tokens,
  taskCount: 3,
  ...extra,
});
// The small class R83 priced its features in: 380,968 to 883,972.
const SMALL = [sample("s1", 380_968), sample("s2", 883_972)];
const feature = (id: string, documentedCommands?: number): FeatureToEstimate => ({
  id,
  title: id,
  workflowId: "sdd",
  size: "small",
  stages: SDD,
  ...(documentedCommands ? { documentedCommands } : {}),
});
const COMMANDS = ["count", "split", "join", "hash", "diff", "patch", "pack", "unpack", "grep", "head", "tail", "slice", "fill", "swap", "stat"];
const REQUEST = [
  "# bytemerge",
  "",
  "A byte-level tool. Usage:",
  "",
  "```",
  ...COMMANDS.map((c) => `$ bytemerge ${c} FILE`),
  "```",
  "",
  "Build it with `cmake --build build` and run `git status` before you commit.",
].join("\n");

describe("scenario: a documentation feature is priced by its documented surface (#2569, R83 bytemerge)", () => {
  test("the commands the request lists, from invocations of its program and a commands list", () => {
    expect(requestCommands(REQUEST)).toEqual([...COMMANDS].sort());
    // Inline invocations count as fenced ones; a launcher or build tool is not the program.
    expect(requestCommands("Run `pnmforge tone in.pnm` or `pnmforge crop in.pnm`, never `java -cp build Main`.")).toEqual(["crop", "tone"]);
    // A list under a heading that names commands, with no invocation.
    expect(requestCommands("## Commands\n\n- `encode` writes it\n- `decode` reads it\n\n## Notes\n\n- `other` is not one")).toEqual(["decode", "encode"]);
    // A library lists no commands: one invocation, or none, is no surface.
    expect(requestCommands("A parser library. Call `parse(text)`; see `tool --help`.")).toEqual([]);
  });

  test("a feature documents the program when its boundary is documentation, legal files and tests of the docs", () => {
    const of = (...paths: string[]) => documentsProgram({ boundary: { scope: "s", paths } });
    expect(of("README.md", "LICENSE")).toBe(true);
    expect(of("README.md", "LICENSE", "tests/test_docs.py")).toBe(true);
    expect(of("docs/usage.md")).toBe(true);
    expect(of("README.md", "src/cli.ts")).toBe(false);
    expect(of("LICENSE")).toBe(false);
    expect(of("README.md", "tests/test_cli.py")).toBe(false);
  });

  test("the rate is measured per finished documentation run, the default below two", () => {
    expect(documentedSurfaceRate([])).toEqual({ perCommand: DEFAULT_PER_COMMAND, correction: README_CORRECTION_TOKENS, samples: 0, basis: "defaults" });
    // Runs at 100k and 50k a command past the correction round; a feature without commands is not one.
    const rate = documentedSurfaceRate([
      sample("d1", README_CORRECTION_TOKENS + 1_500_000, { documentedCommands: 15 }),
      sample("d2", README_CORRECTION_TOKENS + 500_000, { documentedCommands: 10 }),
      sample("c1", 3_000_000),
    ]);
    expect(rate).toEqual({ perCommand: { low: 50_000, high: 75_000 }, correction: README_CORRECTION_TOKENS, samples: 2, basis: "measured" });
  });

  test("in shadow the range is unchanged and the price is recorded; on, the docs feature is dearer than the rest", () => {
    const features = [feature("count"), feature("decoding"), feature("documentation", 15)];
    const rate = documentedSurfaceRate([]);
    const without = estimateInitiative({ features, history, samples: SMALL, maxTotalTokens: 30_000_000 });
    const shadow = estimateInitiative({ features, history, samples: SMALL, maxTotalTokens: 30_000_000, documentedSurface: { rate, mode: "shadow" } });
    const on = estimateInitiative({ features, history, samples: SMALL, maxTotalTokens: 30_000_000, documentedSurface: { rate, mode: "on" } });
    const of = (e: typeof on, id: string) => e.features.find((f) => f.featureId === id)!;
    // Today: the class range, and the actual 2,252,251 is 2.5 times its high end.
    expect(of(without, "documentation").tokens).toEqual({ low: 380_968, high: 883_972 });
    // 15 commands at 70.2k-116.4k plus 507k: 1,560,000-2,253,000.
    const priced = { low: 1_560_000, high: 2_253_000 };
    expect(of(shadow, "documentation")).toMatchObject({ tokens: { low: 380_968, high: 883_972 }, documentedSurface: { tokens: priced, mode: "shadow" } });
    expect(shadow.tokens).toEqual(without.tokens);
    expect(shadow.notes).toEqual(without.notes);
    expect(of(on, "documentation")).toMatchObject({ tokens: priced, floor: "documented", documentedCommands: 15, documentedSurface: { mode: "on" } });
    expect(of(on, "documentation").tokens.low).toBeLessThanOrEqual(2_252_251);
    expect(of(on, "documentation").tokens.high).toBeGreaterThanOrEqual(2_252_251);
    expect(of(on, "documentation").expectedTokens).toBeGreaterThan(of(on, "count").tokens.high);
    // The command features keep their class.
    expect(of(on, "count")).toEqual(of(without, "count"));
    expect(on.notes).toContain(
      "A feature that documents the program is forecast at no less than 70k–116k tokens per command the request lists (documentation 15) plus 507k for one README correction round, the bench round 83 allowance: fewer than two finished documentation features with listed commands.",
    );
  });

  test("the high end follows the measured actual-to-low spread, not the rate's own high", () => {
    // Two initiatives of six small features each: the spread the high end is measured on.
    const spread = [
      ...[400_000, 450_000, 500_000, 600_000, 700_000, 800_000].map((t, i) => sample(`a${i}`, t, { initiativeId: "a" })),
      ...[420_000, 480_000, 520_000, 640_000, 760_000, 900_000].map((t, i) => sample(`b${i}`, t, { initiativeId: "b" })),
    ];
    const estimate = estimateInitiative({
      features: [feature("count"), feature("documentation", 15)],
      history,
      samples: spread,
      maxTotalTokens: 30_000_000,
      documentedSurface: { rate: documentedSurfaceRate([]), mode: "on" },
    });
    const calibration = estimate.highCalibration!;
    expect(calibration).not.toBeNull();
    const docs = estimate.features.find((f) => f.featureId === "documentation")!;
    expect(docs).toMatchObject({ floor: "documented", highBasis: "ratios" });
    expect(docs.tokens).toEqual({ low: 1_560_000, high: Math.max(1_560_000, Math.round(1_560_000 * calibration.high)) });
    expect(docs.documentedSurface?.tokens).toEqual(docs.tokens);
  });

  test("the policy turns it on by `sizing.documentedSurface`", () => {
    expect(PolicySchema.shape.sizing.unwrap().safeParse({ documentedSurface: true }).success).toBe(true);
  });
});

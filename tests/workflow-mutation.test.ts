import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codeOnly,
  generateMutants,
  isTestCheck,
  type MutationRunner,
  presetMutation,
  runMutants,
  thresholdFor,
} from "../src/core/workflows/quality/mutation.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

describe("mutants", () => {
  test("strings and comments are not mutated", () => {
    const line = 'const a = "x < y"; // a && b';
    expect(codeOnly(line)).toHaveLength(line.length);
    expect(codeOnly(line).trimEnd()).toBe('const a = "     ";');
    const mutants = generateMutants([
      {
        path: "src/a.ts",
        before: null,
        content:
          'import { b } from "./b";\nexport const f = (n: number) => n < 0 && b ? "a < b" : 1;\n// x === y\n',
      },
    ]);
    expect(mutants.map((m) => [m.operator, m.mutated])).toEqual([
      ["boundary", 'export const f = (n: number) => n <= 0 && b ? "a < b" : 1;'],
      ["logical", 'export const f = (n: number) => n < 0 || b ? "a < b" : 1;'],
      ["literal", 'export const f = (n: number) => n < 1 && b ? "a < b" : 1;'],
    ]);
    expect(mutants.map((m) => m.id)).toEqual(["M1", "M2", "M3"]);
  });

  test("only added lines of non-test code are mutated, spread over the lines first", () => {
    const before = "const a = x === 1;\n";
    const content = "const a = x === 1;\nconst b = y > 2 && z;\nconst c = w + 3;\n";
    const mutants = generateMutants(
      [
        { path: "src/a.ts", before, content },
        { path: "tests/a.test.ts", before: null, content: "expect(1 === 1).toBe(true);\n" },
      ],
      3,
    );
    expect(mutants.map((m) => `${m.line}:${m.operator}`)).toEqual(["2:boundary", "3:arithmetic", "2:logical"]);
  });

  test("test checks, thresholds and preset defaults", () => {
    expect(isTestCheck({ id: "unit", executable: "bun", args: ["test"] })).toBe(true);
    expect(isTestCheck({ id: "py", executable: "python", args: ["-m", "pytest"] })).toBe(true);
    expect(isTestCheck({ id: "lint", executable: "bunx", args: ["biome", "check"] })).toBe(false);
    // #844: Maven and Gradle run the tests in their verify and check lifecycles.
    expect(isTestCheck({ id: "build", executable: "mvn", args: ["-q", "verify"] })).toBe(true);
    expect(isTestCheck({ id: "build", executable: "./mvnw.cmd", args: ["package"] })).toBe(true);
    expect(isTestCheck({ id: "build", executable: "gradle", args: ["check"] })).toBe(true);
    expect(isTestCheck({ id: "build", executable: "./gradlew", args: ["build"] })).toBe(true);
    expect(isTestCheck({ id: "build", executable: "mvn", args: ["verify", "-DskipTests"] })).toBe(false);
    expect(isTestCheck({ id: "build", executable: "gradlew", args: ["build", "-x", "test"] })).toBe(false);
    expect(isTestCheck({ id: "build", executable: "mvn", args: ["compile"] })).toBe(false);
    expect(thresholdFor("src/auth/login.ts", { "src/auth/**": 70, "src/**": 50 })).toBe(70);
    expect(thresholdFor("src/util.ts", { "src/auth/**": 70, "src/*.ts": 50 })).toBe(50);
    expect(thresholdFor("lib/x.ts", { "src/**": 50 })).toBe(100);
    expect([presetMutation("quick"), presetMutation("standard"), presetMutation("full"), presetMutation("harden")]).toEqual([
      "off",
      "off",
      "advisory",
      "required",
    ]);
  });

  test("survivors block under required, killed and timed-out ones do not; the budget leaves the rest not run", async () => {
    const file = { path: "src/a.ts", before: "", content: "const a = x > 1 && y;\nconst b = z === 2;\n" };
    const mutants = generateMutants([file]);
    const planted: string[] = [];
    let clock = 0;
    const runner: MutationRunner = {
      plant: async (_path, content) => {
        planted.push(content);
      },
      restore: async () => {
        planted.push("restored");
      },
      test: async () => {
        clock += 1000;
        const last = planted.at(-1) ?? "";
        if (last.includes(">=")) return { status: "passed" };
        if (last.includes("||")) return { status: "timeout" };
        return { status: "failed", check: "unit" };
      },
      now: () => clock,
    };
    const result = await runMutants("required", mutants, [file], ["unit"], runner, { budgetMs: 3500 });
    expect(result.mutants.map((m) => [m.operator, m.status, m.blocking])).toEqual([
      ["boundary", "survived", true],
      ["equality", "killed", false],
      ["logical", "timeout", false],
      ["literal", "killed", false],
      ["literal", "not-run", false],
    ]);
    expect(result.score).toBe(67);
    expect(result.note).toContain("time budget");
    expect(planted.filter((p) => p === "restored")).toHaveLength(4);
    const advisory = await runMutants("advisory", mutants.slice(0, 1), [file], ["unit"], { ...runner, now: () => 0 });
    expect(advisory.mutants[0]?.blocking).toBe(false);
    const lenient = await runMutants("required", mutants.slice(0, 2), [file], ["unit"], { ...runner, now: () => 0 }, {
      thresholds: { "src/**": 50 },
    });
    expect(lenient.mutants.map((m) => m.blocking)).toEqual([false, false]);
  });
});

describe("mutation gate in a run", () => {
  class SignExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(
      private readonly dir: string,
      /** The skeptic's answer on a surviving mutant; `strengthen` makes the correction kill it. */
      private readonly options: { equivalence?: "confirmed" | "refuted"; strengthen?: boolean } = {},
    ) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
        extra: { finding?: { id: string }; evidence?: { id: string }[] };
      };
      if (request.profile.output === "mutants" || request.profile.output === "refutation") {
        this.calls.push(request.profile.output);
        (this.prompts[request.profile.output] ??= []).push(request.prompt);
      }
      if (request.profile.output === "mutants")
        return {
          output: {
            schemaVersion: 1,
            mutants: [
              {
                criterionId: "AC-001",
                file: "src/sign.ts",
                line: 1,
                original: "export const sign = (n: number) => (n < 0 ? -1 : 1);",
                mutated: "export const sign = (n: number) => (n < 0 ? -1 : -1);",
                rationale: "Positive numbers would get the negative sign",
              },
            ],
          },
          inputTokens: 10,
          outputTokens: 10,
        };
      if (request.profile.output === "refutation")
        return {
          output: {
            schemaVersion: 1,
            findingId: data.extra.finding?.id,
            decision: this.options.equivalence ?? "confirmed",
            evidenceIds: (data.extra.evidence ?? []).map((e) => e.id).slice(0, 1),
            explanation: "The changed boundary is never reached",
          },
          inputTokens: 10,
          outputTokens: 10,
        };
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push(
          { path: "src/sign.ts", action: "create" },
          { path: "tests/sign.test.ts", action: "create" },
        );
        return result;
      }
      if (request.profile.output === "implementation") {
        mkdirSync(join(this.dir, "src"), { recursive: true });
        mkdirSync(join(this.dir, "tests"), { recursive: true });
        writeFileSync(join(this.dir, "src/sign.ts"), "export const sign = (n: number) => (n < 0 ? -1 : 1);\n");
        const strong = this.implementations++ > 0 && this.options.strengthen !== false;
        writeFileSync(
          join(this.dir, "tests/sign.test.ts"),
          [
            'import { expect, test } from "bun:test";',
            'import { sign } from "../src/sign";',
            'test("sign", () => {',
            "  expect(sign(-5)).toBe(-1);",
            ...(strong ? ["  expect(sign(0)).toBe(1);", "  expect(sign(5)).toBe(1);"] : []),
            "});",
            "",
          ].join("\n"),
        );
      }
      return super.execute(request);
    }
  }

  test("a mutant the new tests leave alive is a finding, and the correction adds a test that kills it", async () => {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const fixture = workflowFixture({
      policy: {
        ...fixturePolicy,
        mutation: "required",
        checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "tests/"] }],
      },
      executor: (root) => new SignExecutor(root),
    });
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, body: JSON.parse(f.body_json) }));
      const mutant = findings.find((f) => String(f.body.claim).startsWith("Surviving mutant "));
      expect(mutant?.body.claim).toContain("src/sign.ts:1");
      expect(mutant?.body.file).toBe("tests/sign.test.ts");
      expect(mutant?.status).toBe("resolved");
      // The agent's mutant for the criterion survived the weak test too.
      expect(findings.some((f) => String(f.body.claim).endsWith("(it breaks AC-001)"))).toBe(true);
      // Every mutant was taken out again.
      expect(readFileSync(join(fixture.root, "src/sign.ts"), "utf8")).toBe(
        "export const sign = (n: number) => (n < 0 ? -1 : 1);\n",
      );
      const report = runReport(service.store, run.runId);
      expect(report).toContain("Mutation gate (`required`): score 100%");
    } finally {
      await fixture.dispose();
    }
  });

  const requiredPolicy = () => {
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    return {
      ...fixturePolicy,
      mutation: "required" as const,
      checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "tests/"] }],
    };
  };

  test("a survivor the equivalence check judges equivalent is not a finding", async () => {
    const fixture = workflowFixture({
      policy: requiredPolicy(),
      executor: (root) => new SignExecutor(root, { equivalence: "refuted", strengthen: false }),
    });
    try {
      const { service, executor } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      expect(executor.calls).toContain("refutation");
      expect(executor.prompts.refutation?.[0]).toContain("Is this mutant equivalent?");
      const claims = service.store.findings(run.runId).map((f) => String(JSON.parse(f.body_json).claim));
      expect(claims.some((c) => c.startsWith("Surviving mutant "))).toBe(false);
      const report = runReport(service.store, run.runId);
      expect(report).toMatch(/Mutation gate \(`required`\): no score \(0 of 0 mutants killed, \d+ judged equivalent\)/);
      expect(report).toContain("equivalent: The changed boundary is never reached");
    } finally {
      await fixture.dispose();
    }
  });

  test("with Stryker installed the gate reports Stryker's mutants instead of its own", async () => {
    const fixture = workflowFixture({
      policy: requiredPolicy(),
      executor: (root) => {
        // A stand-in for Stryker: the mutant on line 1 survives until the test checks sign(0).
        const bin = join(root, "node_modules/@stryker-mutator/core/bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(
          join(bin, "stryker.js"),
          [
            'const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
            "const args = process.argv.slice(2);",
            'const files = args[args.indexOf("--mutate") + 1].split(",");',
            'const strong = readFileSync("tests/sign.test.ts", "utf8").includes("sign(0)");',
            'mkdirSync("reports/mutation", { recursive: true });',
            "const location = { start: { line: 1, column: 37 }, end: { line: 1, column: 42 } };",
            "const mutants = [",
            '  { id: "0", mutatorName: "EqualityOperator", replacement: "n <= 0", status: strong ? "Killed" : "Survived", location },',
            '  { id: "1", mutatorName: "EqualityOperator", replacement: "n >= 0", status: "Killed", location },',
            "];",
            'writeFileSync("reports/mutation/mutation.json", JSON.stringify({ schemaVersion: "1.0", files: Object.fromEntries(files.map((f) => [f, { mutants }])) }));',
            "",
          ].join("\n"),
        );
        return new SignExecutor(root);
      },
    });
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, body: JSON.parse(f.body_json) }));
      const mutant = findings.find((f) => String(f.body.claim).startsWith("Surviving mutant "));
      expect(mutant?.body.claim).toBe(
        "Surviving mutant M1: src/sign.ts:1 changed (stryker) from `export const sign = (n: number) => (n < 0 ? -1 : 1);` to `export const sign = (n: number) => (n <= 0 ? -1 : 1);` and every test check still passed",
      );
      expect(mutant?.status).toBe("resolved");
      const report = runReport(service.store, run.runId);
      expect(report).toContain("Mutation gate (`required`, stryker): score 100% (2 of 2 mutants killed); tests: `stryker`.");
      // The report Stryker wrote into the working copy is gone again.
      expect(existsSync(join(fixture.root, "reports"))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });
});

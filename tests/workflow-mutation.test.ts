import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { maskNonCode } from "../src/core/workflows/quality/code-mask.js";
import {
  generateMutants,
  greenSuiteMs,
  MIN_MUTANT_DEADLINE_MS,
  mutantDeadlineMs,
  proposalFiles,
  proposedMutants,
  isTestCheck,
  type MutationRunner,
  presetMutation,
  runMutants,
  thresholdFor,
} from "../src/core/workflows/quality/mutation.js";
import { QUALITY_MUTATION } from "../src/core/workflows/quality/mutation.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

describe("mutants", () => {
  const booleanFile = (path: string, count: number) => ({
    path, before: null, content: Array.from({ length: count }, (_, i) => `const flag${i} = true;`).join("\n"),
  });

  test("the cap is shared across files before taking more lines from one file (#1567)", () => {
    const files = ["a", "b", "c"].map((name) => booleanFile(`src/${name}.ts`, 30));
    const mutants = generateMutants(files);
    expect(mutants).toHaveLength(24);
    for (const file of files) expect(mutants.filter((m) => m.file === file.path)).toHaveLength(8);
    expect(mutants.slice(0, 3).map((m) => m.file)).toEqual(files.map((f) => f.path));
    expect(generateMutants([...files].reverse())).toEqual(mutants);
    expect(mutants.map((m) => m.id)).toEqual(Array.from({ length: 24 }, (_, i) => `M${i + 1}`));
  });

  test("a small file keeps its candidates and gives its unused share to larger files", () => {
    const files = [booleanFile("src/a.ts", 40), booleanFile("src/b.ts", 40), booleanFile("src/z.ts", 3)];
    const mutants = generateMutants(files);
    expect(mutants).toHaveLength(24);
    expect(mutants.filter((m) => m.file === "src/z.ts").map((m) => m.line)).toEqual([1, 2, 3]);
    expect(mutants.filter((m) => m.file === "src/a.ts")).toHaveLength(11);
    expect(mutants.filter((m) => m.file === "src/b.ts")).toHaveLength(10);
  });

  test("larger additions get priority when the cap cannot cover every eligible file", () => {
    const files = [booleanFile("src/a.ts", 1), booleanFile("src/z.ts", 10)];
    expect(generateMutants(files, 1).map((m) => m.file)).toEqual(["src/z.ts"]);
    expect(generateMutants(files, 0)).toEqual([]);
    expect(generateMutants([])).toEqual([]);
    expect(generateMutants([booleanFile("tests/z.test.ts", 40), { path: "src/empty.ts", before: null, content: "// true\n" }])).toEqual([]);
  });

  test("proposal text shares its character budget across files and reuses a small file's share", () => {
    const large = (path: string) => ({
      path, before: null, content: Array.from({ length: 100 }, (_, i) => `const flag${i} = true; // ${"x".repeat(300)}`).join("\n"),
    });
    const files = [large("src/a.ts"), large("src/b.ts"), large("src/z.ts")];
    const listed = proposalFiles(files);
    expect(listed.map((f) => f.path)).toEqual(files.map((f) => f.path));
    const sizes = listed.map((f) => f.lines.join("").length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(400);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(24_000);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(23_600);
    expect(proposalFiles([...files].reverse())).toEqual(listed);

    const small = booleanFile("src/z.ts", 3);
    const redistributed = proposalFiles([files[0]!, files[1]!, small, booleanFile("tests/ignored.test.ts", 100)]);
    expect(redistributed.find((f) => f.path === small.path)?.lines).toHaveLength(3);
    for (const path of ["src/a.ts", "src/b.ts"])
      expect(redistributed.find((f) => f.path === path)!.lines.join("").length).toBeGreaterThan(11_500);
    expect(proposalFiles([])).toEqual([]);
    expect(proposalFiles([{ path: "src/long.ts", before: null, content: `const flag = true; // ${"x".repeat(24_000)}` }, small])).toEqual([
      { path: small.path, lines: ["1: const flag0 = true;", "2: const flag1 = true;", "3: const flag2 = true;"] },
    ]);
  });

  test("strings and comments are not mutated", () => {
    const line = 'const a = "x < y"; // a && b';
    expect(maskNonCode("src/a.ts", line)).toHaveLength(line.length);
    expect(maskNonCode("src/a.ts", line).trimEnd()).toBe('const a = "     ";');
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

  // #1521 (R43): a line in the middle of a docstring or a multi-line string was masked on its
  // own, read as code, and its prose or CSS mutated; 5 of 12 listed survivors were such noise.
  describe("lines inside multi-line strings and comments (#1521)", () => {
    const cases: { language: string; path: string; content: string; code: string }[] = [
      {
        language: "a Python docstring",
        path: "expenses/parsing.py",
        content:
          'def parse(row):\n    """Parse one row.\n\n    Returns the record or a human-readable reason.\n    Fatal errors raise if count > 0.\n    """\n    return row is not None and len(row) > 2\n',
        code: "    return row is not None and len(row) > 2",
      },
      {
        language: "a TypeScript template literal",
        path: "src/build.ts",
        content:
          "const css = `\n  html, body { max-width: 100%; }\n  body { margin: 0 auto; }\n`;\nexport const wide = width > 100;\n",
        code: "export const wide = width > 100;",
      },
      {
        language: "a Java text block",
        path: "src/main/java/a/Page.java",
        content:
          'class Page {\n  String html = """\n      <p>a < b && c</p>\n      width: 0;\n      """;\n  boolean small(int n) { return n < 10; }\n}\n',
        code: "  boolean small(int n) { return n < 10; }",
      },
      {
        language: "a C# raw and verbatim string",
        path: "src/Report.cs",
        content:
          'class Report {\n  string a = """\n    total == 0 or more\n    """;\n  string b = @"line one\n    x > 1 ""quoted"" && y\n    ";\n  bool Big(int n) => n > 1;\n}\n',
        code: "  bool Big(int n) => n > 1;",
      },
      {
        language: "a Go raw string",
        path: "cmd/usage.go",
        content:
          "package main\n\nconst usage = `usage:\n  -n 0   count == 1 means one\n`\n\nfunc ok(n int) bool { return n >= 0 }\n",
        code: "func ok(n int) bool { return n >= 0 }",
      },
      {
        language: "a Rust raw string and a block comment",
        path: "src/lib.rs",
        content:
          'const HELP: &str = r#"\n  a "quoted" x < 1\n"#;\n/* x == 1\n   true or false */\nfn f<\'a>(s: &\'a str) -> bool { s.len() > 0 }\n',
        code: "fn f<'a>(s: &'a str) -> bool { s.len() > 0 }",
      },
    ];
    for (const { language, path, content, code } of cases)
      test(`${language} gets no mutants; the code line next to it does`, () => {
        const masked = maskNonCode(path, content);
        expect(masked).toHaveLength(content.length);
        expect(masked.split("\n").length).toBe(content.split("\n").length);
        const mutants = generateMutants([{ path, before: null, content }], 50);
        expect(mutants.length).toBeGreaterThan(0);
        expect([...new Set(mutants.map((m) => m.original))]).toEqual([code]);
        expect(proposalFiles([{ path, before: null, content }])[0]?.lines.map((l) => l.replace(/^\d+: /, ""))).toContain(code);
      });

    test("JavaScript code inside ${...} is still code, and a private field is not a comment", () => {
      const content = "const s = `a ${n > 1 ? `x ${m + 1}` : 0} b`;\nthis.#count = this.#count + 1;\n";
      const mutated = generateMutants([{ path: "src/a.ts", before: null, content }], 50).map(
        (m) => m.mutated,
      );
      expect(mutated).toContain("const s = `a ${n >= 1 ? `x ${m + 1}` : 0} b`;");
      expect(mutated).toContain("const s = `a ${n > 1 ? `x ${m - 1}` : 0} b`;");
      expect(mutated).toContain("this.#count = this.#count - 1;");
    });

    test("an agent-proposed mutant on a docstring line is dropped", () => {
      const file = { path: "expenses/parsing.py", before: null, content: cases[0]?.content ?? "" };
      const proposals = [
        {
          criterionId: "AC-1",
          file: file.path,
          line: 4,
          original: "Returns the record or a human-readable reason.",
          mutated: "Returns the record and a human-readable reason.",
        },
        {
          criterionId: "AC-1",
          file: file.path,
          line: 7,
          original: "return row is not None and len(row) > 2",
          mutated: "return row is not None and len(row) > 3",
        },
      ];
      expect(proposedMutants(proposals, [file], []).map((m) => m.line)).toEqual([7]);
      expect(proposalFiles([file])[0]?.lines.some((l) => l.includes("human-readable"))).toBe(false);
    });
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

  // #1534 (R44 cayleykit): a mutant that made `dotnet test` loop ran until the 300 s budget was
  // gone, so 18 of 24 mutants were never run and the score came from the first five.
  describe("one hanging mutant does not take the budget (#1534)", () => {
    const file = {
      path: "src/Chain.cs",
      before: "",
      content: [1, 2, 3, 4, 5, 6].map((n) => `var v${n} = a > ${n};`).join("\n"),
    };
    // A fake clock: a killed mutant takes the suite's 4 s, the looping one runs until its deadline.
    const hanging = (greenMs?: number) => {
      let clock = 0;
      const deadlines: number[] = [];
      let planted = "";
      const runner: MutationRunner = {
        plant: async (_path, content) => {
          planted = content;
        },
        restore: async () => {},
        test: async (timeLeftMs) => {
          deadlines.push(timeLeftMs);
          if (planted.includes("v2 = a >= 2")) {
            clock += timeLeftMs;
            return { status: "timeout" };
          }
          clock += 4000;
          return { status: "failed", check: "unit" };
        },
        now: () => clock,
      };
      const mutants = generateMutants([file]).filter((m) => m.operator === "boundary");
      return {
        deadlines,
        run: () =>
          runMutants("advisory", mutants, [file], ["unit"], runner, {
            ...(greenMs !== undefined ? { greenMs } : {}),
          }),
      };
    };

    test("with the green suite's duration every mutant runs and the timeout scores as detected", async () => {
      const { run, deadlines } = hanging(4000);
      const result = await run();
      expect(result.mutants).toHaveLength(6);
      expect(result.mutants.map((m) => m.status)).toEqual(["killed", "timeout", "killed", "killed", "killed", "killed"]);
      expect(result.note ?? "").not.toContain("time budget");
      expect(result.score).toBe(100);
      expect(deadlines.every((d) => d === mutantDeadlineMs(4000))).toBe(true);
      expect(mutantDeadlineMs(4000)).toBe(22_000);
    });

    test("without it, the slowest finished mutant run sets the deadline", async () => {
      const { run, deadlines } = hanging();
      const result = await run();
      expect(result.mutants.every((m) => m.status !== "not-run")).toBe(true);
      // The first mutant has nothing to go by and gets the budget; the rest get a deadline.
      expect(deadlines[0]).toBe(300_000);
      expect(deadlines.slice(1).every((d) => d === mutantDeadlineMs(4000))).toBe(true);
    });

    test("the green duration is each test check's slowest passing run, summed", () => {
      const rows = [
        { check_id: "unit", status: "passed", duration_ms: 3000 },
        { check_id: "unit", status: "passed", duration_ms: 3600 },
        { check_id: "unit", status: "failed", duration_ms: 90_000 },
        { check_id: "e2e", status: "passed", duration_ms: 1000 },
      ];
      expect(greenSuiteMs(rows, ["unit", "e2e"])).toBe(4600);
      expect(greenSuiteMs(rows, ["unit", "never"])).toBeUndefined();
      expect(greenSuiteMs(rows, [])).toBeUndefined();
      expect(mutantDeadlineMs(100_000)).toBe(310_000);
      expect(mutantDeadlineMs(1000)).toBe(MIN_MUTANT_DEADLINE_MS);
    });
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
    // #1534: the timed-out mutant was detected and scores with the killed ones.
    expect(result.score).toBe(75);
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

  /**
   * An advisory run in a Git repository whose test check takes a while; `ignored` lists files
   * Git ignores, which a copy of the run does not have. Returns what the first review saw: whether
   * the score existed yet, and the file the gate mutates.
   */
  async function besideReview(ignored: string[], verify: (report: string) => void) {
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    };
    const seen: { score: boolean; sign: string }[] = [];
    let store: WorkflowStore | null = null;
    let runId = "";
    class ReviewWatcher extends SignExecutor {
      constructor(private readonly root: string) {
        super(root);
      }
      override async execute(request: ExecutionRequest) {
        if (request.profile.output === "review" && store && !seen.length)
          seen.push({
            score: Boolean(store.latestArtifact(runId, QUALITY_MUTATION)),
            sign: readFileSync(join(this.root, "src/sign.ts"), "utf8"),
          });
        return super.execute(request);
      }
    }
    const first = fixturePolicy.checks[0] as (typeof fixturePolicy.checks)[number];
    const fixture = workflowFixture({
      policy: {
        ...fixturePolicy,
        mutation: "advisory",
        // Each test run takes a while, so the gate is still running when the review starts.
        checks: [...fixturePolicy.checks, { ...first, id: "unit", args: ["test", "--preload", "./slow.ts", "tests/"] }],
      },
      executor: (root) => new ReviewWatcher(root),
    });
    try {
      const { service, root } = fixture;
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test User");
      git(root, "config", "user.email", "test@example.test");
      git(root, "config", "commit.gpgsign", "false");
      writeFileSync(join(root, ".gitignore"), [".baked/", ...ignored, ""].join("\n"));
      writeFileSync(join(root, "README.md"), "# Sign\n");
      writeFileSync(join(root, "slow.ts"), "await Bun.sleep(400);\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "Initial");
      store = service.store;
      const run = await fixture.start();
      runId = run.runId;
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      // The review read the unmutated file.
      expect(seen.map((s) => s.sign)).toEqual(["export const sign = (n: number) => (n < 0 ? -1 : 1);\n"]);
      // The copy is gone and the run's own file was never mutated.
      expect(existsSync(join(root, ".baked/worktrees", run.runId, "quality-mutation"))).toBe(false);
      expect(readFileSync(join(root, "src/sign.ts"), "utf8")).toBe("export const sign = (n: number) => (n < 0 ? -1 : 1);\n");
      verify(runReport(service.store, run.runId));
      return seen;
    } finally {
      await fixture.dispose();
    }
  }

  test("an advisory gate runs beside the review in a copy, so the review starts before its score", async () => {
    // The score still reaches the report before the run finishes.
    const seen = await besideReview([], (report) =>
      expect(report).toMatch(/Mutation gate \(`advisory`\): score \d+%/),
    );
    // The review started while the gate was still running.
    expect(seen.map((s) => s.score)).toEqual([false]);
  });

  test("a copy whose tests fail without a mutant reports why instead of a score", async () => {
    // The ignored preload is missing in the copy, so every mutant would look killed.
    await besideReview(["slow.ts"], (report) => {
      expect(report).not.toMatch(/Mutation gate \(`advisory`\): score/);
      expect(report).toContain("check unit fails in a copy of the run without any mutant, so no mutant ran");
    });
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

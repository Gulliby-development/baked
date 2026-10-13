import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareWithBaseline,
  isTestCodePath,
  measureBaseline,
  metricDeltas,
} from "../src/core/workflows/quality/duplication.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const parser = `export function parseRange(text: string): { start: number; end: number } {
  const [rawStart, rawEnd] = text.split("-");
  const start = Number.parseInt(rawStart ?? "", 10);
  const end = Number.parseInt(rawEnd ?? "", 10);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(\`Invalid range \${text}\`);
  if (start > end) throw new Error(\`Range \${text} ends before it starts\`);
  return { start, end };
}
`;
const copy = parser.replace("parseRange", "readRange");
const main = `import { parseRange } from "./range.js";
console.log(parseRange(process.argv[2] ?? "1-2"));
`;

describe("duplication ratchet", () => {
  const base = new Map([
    ["src/range.ts", parser],
    ["src/main.ts", main],
  ]);
  const baseline = measureBaseline(base);

  test("a copied function is a finding that names the original", () => {
    const after = new Map([...base, ["src/report.ts", `${copy}`]]);
    const result = compareWithBaseline("ratchet", baseline, after, new Set(["src/report.ts"]));
    expect(result.clones).toHaveLength(1);
    expect(result.clones[0]?.file).toBe("src/report.ts");
    expect(result.clones[0]?.original.file).toBe("src/range.ts");
    expect(result.clones[0]?.original.startLine).toBe(1);
    expect(result.after.duplicatedLines).toBeGreaterThan(result.baseline.duplicatedLines);
    // readRange is called by nothing either.
    expect(result.unused.map((u) => u.name)).toEqual(["readRange"]);
    expect(result.blocking).toBe(true);
    expect(metricDeltas(result)[0]).toMatch(/^duplicated lines 0 -> \d+ \(\+\d+\)$/);
  });

  test("warn reports the same copy without blocking", () => {
    const after = new Map([...base, ["src/report.ts", copy]]);
    const result = compareWithBaseline("warn", baseline, after, new Set(["src/report.ts"]));
    expect(result.clones).toHaveLength(1);
    expect(result.blocking).toBe(false);
  });

  test("copies that existed before the run are not the run's", () => {
    const old = new Map([...base, ["src/old.ts", copy]]);
    const before = measureBaseline(old);
    const after = new Map([...old, ["src/old.ts", `${copy}\nexport const VERSION = 2;\n`]]);
    const result = compareWithBaseline("ratchet", before, after, new Set(["src/old.ts"]));
    expect(result.clones).toEqual([]);
    expect(result.blocking).toBe(false);
  });

  test("reusing the helper passes, and a test that calls a function makes it used", () => {
    const after = new Map([
      ...base,
      ["src/report.ts", `import { parseRange } from "./range.js";\nexport function width(t: string) {\n  const r = parseRange(t);\n  return r.end - r.start;\n}\n`],
      ["tests/report.test.ts", `import { width } from "../src/report.js";\nwidth("1-3");\n`],
    ]);
    const result = compareWithBaseline("ratchet", baseline, after, new Set(["src/report.ts", "tests/report.test.ts"]));
    expect(result.clones).toEqual([]);
    expect(result.unused).toEqual([]);
    expect(result.blocking).toBe(false);
    expect(result.after.files).toBe(3);
  });

  test("tests are read but not counted as copies", () => {
    const after = new Map([...base, ["tests/range.test.ts", copy]]);
    const result = compareWithBaseline("ratchet", baseline, after, new Set(["tests/range.test.ts"]));
    expect(result.clones).toEqual([]);
    expect(isTestCodePath("pkg/util_test.go")).toBe(true);
    expect(isTestCodePath("app/test_cli.py")).toBe(true);
    expect(isTestCodePath("src/testing.ts")).toBe(false);
  });

  test("a skipped baseline never blocks", () => {
    const skipped = measureBaseline(new Map(), "too large");
    const result = compareWithBaseline("ratchet", skipped, base, new Set(["src/range.ts"]));
    expect(result.blocking).toBe(false);
    expect(result.skipped).toBe("too large");
  });
});

describe("duplication ratchet in a run", () => {
  const range = `export function parseRange(text: string): { start: number; end: number } {
  const [rawStart, rawEnd] = text.split("-");
  const start = Number.parseInt(rawStart ?? "", 10);
  const end = Number.parseInt(rawEnd ?? "", 10);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error(\`Invalid range \${text}\`);
  if (start > end) throw new Error(\`Range \${text} ends before it starts\`);
  return { start, end };
}
`;
  const reused = `import { parseRange } from "./range.js";\nexport const width = (t: string) => parseRange(t).end - parseRange(t).start;\nconsole.log(width("1-3"));\n`;

  class CopyingExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/report.ts", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation") {
        // The first attempt copies parseRange; the correction reuses it.
        writeFileSync(
          join(this.dir, "src/report.ts"),
          this.implementations++ === 0 ? `${range.replace("parseRange", "readRange")}console.log(readRange("1-3"));\n` : reused,
        );
      }
      return super.execute(request);
    }
  }

  test("a run that copies a function gets a blocking finding and repairs it by reusing the original", async () => {
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, duplication: "ratchet" },
      executor: (root) => {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/range.ts"), range);
        writeFileSync(join(root, "src/main.ts"), `import { parseRange } from "./range.js";\nconsole.log(parseRange("1-2"));\n`);
        return new CopyingExecutor(root);
      },
    });
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const findings = service.store.findings(run.runId).map((f) => ({ status: f.status, claim: JSON.parse(f.body_json).claim as string }));
      const copy = findings.find((f) => f.claim.startsWith("Duplicated code: src/report.ts:1-"));
      expect(copy?.claim).toContain("copies src/range.ts:1-");
      expect(copy?.status).toBe("resolved");
      expect(fixture.executor.implementations).toBe(2);
      const report = runReport(service.store, run.runId);
      expect(report).toContain("## Code quality");
      expect(report).toContain("Duplication ratchet (`ratchet`): clean.");
    } finally {
      await fixture.dispose();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUALITY_MUTATION, type MutationResult } from "../src/core/workflows/quality/mutation.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// R46, md-site and url-shortener (#1567): the first code file supplied all 24 mutants,
// and exhausted the proposer's added-line text budget before markdown.ts or storage.ts.
const paths = ["src/build.ts", "src/html.ts", "src/markdown.ts"];
const source = (file: number) => Array.from({ length: 100 }, (_, line) =>
  `export const boundary${file}_${line}_${"value".repeat(50)} = (value: number) => value > 0;`,
).join("\n") + "\n";
const tests = [
  'import { expect, test } from "bun:test";',
  ...paths.map((path, i) => `import * as module${i} from "../${path}";`),
  'test("every exported boundary rejects zero and accepts one", () => {',
  "  for (const module of [module0, module1, module2]) for (const boundary of Object.values(module)) {",
  "    expect(boundary(0)).toBe(false);",
  "    expect(boundary(1)).toBe(true);",
  "  }",
  "});",
].join("\n");

class ScriptedExecutor extends FixtureExecutor {
  proposalInputs: { path: string; lines: string[] }[][] = [];
  constructor(private readonly dir: string) { super(dir); }

  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "mutants") {
      const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
        extra: { files: { path: string; lines: string[] }[] };
      };
      this.proposalInputs.push(data.extra.files);
      return { output: { schemaVersion: 1, mutants: [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]!.writes.push(...[...paths, "tests/boundaries.test.ts"].map((path) => ({ path, action: "create" })));
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(this.dir, "src"), { recursive: true });
      mkdirSync(join(this.dir, "tests"), { recursive: true });
      paths.forEach((path, i) => writeFileSync(join(this.dir, path), source(i)));
      writeFileSync(join(this.dir, "tests/boundaries.test.ts"), tests);
    }
    return result;
  }
}

describe("scenario: R46, mutation caps across a multi-file change (#1567)", () => {
  test("the gate tests every file and the mutant author sees every file within its text cap", async () => {
    const fixture = workflowFixture({
      policy: {
        ...fixturePolicy, mutation: "required", mutationEngine: "built-in",
        checks: [...fixturePolicy.checks, { ...fixturePolicy.checks[0]!, id: "unit", args: ["test", "tests/"] }],
      },
      executor: (root) => new ScriptedExecutor(root),
    });
    try {
      const { service, executor, root } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const artifact = service.store.latestArtifact(run.runId, QUALITY_MUTATION);
      expect(artifact).toBeDefined();
      const result = JSON.parse(service.store.readArtifact(run.runId, artifact!.id)) as MutationResult;
      expect(result.engine).toBe("built-in");
      expect(result.mutants).toHaveLength(24);
      expect(result.score).toBe(100);
      expect(executor.proposalInputs).toHaveLength(1);
      const listed = executor.proposalInputs[0]!;
      expect({
        mutantsPerFile: paths.map((path) => result.mutants.filter((m) => m.file === path).length),
        filesShownToAuthor: listed.map((f) => f.path).sort(),
      }).toEqual({ mutantsPerFile: [8, 8, 8], filesShownToAuthor: paths });
      for (const [i, path] of paths.entries()) {
        const inFile = result.mutants.filter((m) => m.file === path);
        expect(inFile).toHaveLength(8);
        expect(inFile.every((m) => m.status === "killed")).toBe(true);
        expect(new Set(inFile.map((m) => m.line)).size).toBe(8);
        expect(readFileSync(join(root, path), "utf8")).toBe(source(i));
      }
      expect(listed.every((f) => f.lines.length > 0)).toBe(true);
      expect(listed.flatMap((f) => f.lines).join("").length).toBeLessThanOrEqual(24_000);
    } finally {
      await fixture.dispose();
    }
  }, 60_000);
});

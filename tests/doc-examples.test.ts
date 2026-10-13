import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandArgv,
  DOC_EXAMPLE_LIMIT,
  type DocExampleResult,
  extractExamples,
  firstDifference,
  isDocFile,
  runDocExamples,
} from "../src/core/verification/doc-examples.js";
import { capturePreImage } from "../src/core/workflows/rollback.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const fence = "```";
const say = (text: string) => `bun -e "console.log('${text}')"`;

describe("documented examples", () => {
  test("prompted lines and a command block followed by its output are examples", () => {
    const readme = [
      "# Tool",
      `${fence}console`,
      `$ ${say("one")}`,
      "one",
      `$ ${say("two")} \\`,
      "  --flag",
      "two",
      fence,
      "Run it:",
      `${fence}sh`,
      "# a comment",
      say("three"),
      fence,
      "It prints:",
      fence,
      "three",
      fence,
      `${fence}ts`,
      "const x = 1;",
      fence,
      fence,
      "not output",
      fence,
    ].join("\n");
    const examples = extractExamples("README.md", readme);
    expect(examples.map((e) => [e.line, e.command, e.documented])).toEqual([
      [3, say("one"), "one"],
      [5, `${say("two")} --flag`, "two"],
      [12, say("three"), "three"],
    ]);
    expect(examples[1]?.argv).toEqual(["bun", "-e", "console.log('two')", "--flag"]);
  });

  test("a command that needs a shell has no argv", () => {
    expect(commandArgv(`python -m app "a b" 'c d' x\\ y`)).toEqual(["python", "-m", "app", "a b", "c d", "x y"]);
    expect(commandArgv("app list # all of them")).toEqual(["app", "list"]);
    expect(commandArgv("app list | head")).toBeNull();
    expect(commandArgv("app > out.txt")).toBeNull();
    expect(commandArgv('app "$HOME"')).toBeNull();
    expect(commandArgv("NAME=x app")).toBeNull();
    expect(commandArgv("app *.txt")).toBeNull();
  });

  test("the first documented line that differs is reported", () => {
    expect(firstDifference("a\nb\n", "a\r\nb  \n\n")).toBeNull();
    expect(firstDifference("a\nb", "a\nc")).toEqual({ line: 2, expected: "b", actual: "c" });
    expect(firstDifference("a\nb", "a")).toEqual({ line: 2, expected: "b", actual: "(no more lines)" });
  });

  test("only Markdown files and READMEs are documents", () => {
    expect(["README.md", "docs/use.markdown", "README", "pkg/readme.txt"].every(isDocFile)).toBe(true);
    expect(["notes.txt", "src/app.ts", "README.rst.bak"].some(isDocFile)).toBe(false);
  });

  test("a document's examples run in order in a copy and leave the workspace unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-doc-examples-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "source.txt"), "data");
    const write = `bun -e "require('fs').writeFileSync('store.txt', 'saved'); console.log('added')"`;
    const read = `bun -e "console.log(require('fs').readFileSync('store.txt', 'utf8'))"`;
    const text = [
      `${fence}console`,
      `$ ${write}`,
      "added",
      `$ ${read}`,
      "saved",
      `$ ${say("wrong")}`,
      "right",
      "$ cat store.txt",
      "saved",
      "$ cat store.txt | head",
      fence,
    ].join("\n");
    const results = await runDocExamples(new ProcessScope(), [{ path: "README.md", text }], {
      root,
      files: ["source.txt"],
      executables: ["bun"],
      signal: new AbortController().signal,
      sandbox: () => null,
    });
    expect(results.map((r) => r.status)).toEqual(["match", "match", "mismatch", "not_run", "not_run"]);
    expect(results[2]?.firstDifference).toEqual({ line: 1, expected: "right", actual: "wrong" });
    expect(results[3]?.reason).toContain("cat is not a program the run's checks start");
    expect(results[4]?.reason).toContain("needs a shell");
    expect(readdirSync(root)).toEqual(["source.txt"]);
  });

  test("at most a fixed number of examples run per review", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-doc-examples-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const lines = Array.from({ length: DOC_EXAMPLE_LIMIT + 1 }, (_, i) => [`$ ${say(`n${i}`)}`, `n${i}`]).flat();
    const results = await runDocExamples(
      new ProcessScope(),
      [{ path: "README.md", text: [`${fence}console`, ...lines, fence].join("\n") }],
      { root, files: [], executables: ["bun"], signal: new AbortController().signal, sandbox: () => null },
    );
    expect(results.filter((r) => r.status === "match")).toHaveLength(DOC_EXAMPLE_LIMIT);
    expect(results.at(-1)?.reason).toContain(`Only ${DOC_EXAMPLE_LIMIT} examples`);
  });
});

describe("review stage", () => {
  test("the correctness reviewer gets the host-run README examples and a capped step count", async () => {
    const readme = [`${fence}console`, `$ ${say("ready")}`, "ready", `$ ${say("done")}`, "finished", fence].join("\n");
    class ReadmeRun extends FixtureExecutor {
      service: ReturnType<typeof workflowFixture>["service"] | null = null;
      reviews: { dimension: string; maxSteps: number; examples?: DocExampleResult[] }[] = [];
      constructor(private dir: string) {
        super(dir);
      }
      override async execute(request: ExecutionRequest) {
        if (request.profile.output === "implementation" && this.service) {
          const service = this.service;
          const before = service.store.transaction(() => capturePreImage(service.store, request.runId, join(this.dir, "README.md")));
          service.scheduler.journal.publish(request.runId, request.attemptId, "README.md", readme, before, "file_patch");
        }
        if (request.profile.output === "review") {
          const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as {
            extra: { dimension: string; documentedExamples?: DocExampleResult[] };
          };
          this.reviews.push({ dimension: data.extra.dimension, maxSteps: request.maxSteps, ...(data.extra.documentedExamples ? { examples: data.extra.documentedExamples } : {}) });
        }
        const result = await super.execute(request);
        if (request.profile.output === "plan")
          (result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } }).taskGraph.tasks[0]?.writes.push({ path: "README.md", action: "create" });
        return result;
      }
    }
    const fixture = workflowFixture({ executor: (root) => new ReadmeRun(root) });
    cleanups.push(fixture.dispose);
    fixture.executor.service = fixture.service;
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, new AbortController().signal);
    const correctness = fixture.executor.reviews.find((r) => r.dimension === "correctness");
    expect(correctness?.examples?.map((e) => e.status)).toEqual(["match", "mismatch"]);
    expect(correctness?.examples?.[1]?.firstDifference).toEqual({ line: 1, expected: "finished", actual: "done" });
    expect(fixture.executor.reviews.every((r) => r.maxSteps <= 16)).toBe(true);
    expect(fixture.executor.reviews.filter((r) => r.examples)).toHaveLength(1);
    expect(existsSync(join(fixture.root, "README.md"))).toBe(true);
  });
});

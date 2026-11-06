import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import type { TaskGraph } from "../src/core/workflows/schemas.js";
import { emptyHostContent, hostContentProblems, hostWritten, withoutEmptyHostContent } from "../src/core/workflows/task-graph.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Cloud smoke 2026-11-01, php-wordcount trial 1 (run 25a8a2e3, #2610): the quick planner gave
// `"content": ""` to every write of its one task (src/wordcount.php, tests/run.php, README.md).
// The host took that as fixed content and wrote three 0-byte files with no implementer session,
// and `php tests/run.php` passed on the empty script. Empty content on every write now counts as
// absent: the planner is told to leave it out, and a plan that still carries it runs an agent.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const base = { requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", readHints: [], checkIds: [], origin: "planned" as const, findingIds: [], rationale: "Required behavior" };
const wordcount: Task = {
  ...base,
  id: "T001",
  title: "Word count",
  description: "Write the word counter, its test script and README",
  writes: [
    { path: "src/wordcount.php", action: "create", content: "" },
    { path: "tests/run.php", action: "create", content: "" },
    { path: "README.md", action: "create", content: "" },
  ],
};

describe("empty host content (#2610)", () => {
  test("a task whose writes all carry empty content is a plan problem and not host-written", () => {
    expect(emptyHostContent(wordcount)).toBe(true);
    expect(hostWritten(wordcount)).toBe(false);
    const problems = hostContentProblems({ tasks: [wordcount] });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Task T001 gives empty content to every write (src/wordcount.php, tests/run.php, README.md)");
    expect(problems[0]).toContain("Leave content out so an agent writes the files");
    // Whitespace only is empty too.
    expect(hostWritten({ writes: [{ path: "src/a.php", action: "create", content: "\n" }] })).toBe(false);
  });

  test("a marker file left empty next to real content, or a package of empty inits, is fine", () => {
    const marked: Task = {
      ...wordcount,
      writes: [
        { path: "pkg/__init__.py", action: "create", content: "" },
        { path: "data/.gitkeep", action: "create", content: "" },
        { path: "pkg/version.py", action: "create", content: 'VERSION = "1.0"\n' },
      ],
    };
    const inits: Task = { ...wordcount, id: "T002", writes: [{ path: "pkg/__init__.py", action: "create", content: "" }, { path: "pkg/io/__init__.py", action: "create", content: "" }] };
    expect(hostWritten(marked)).toBe(true);
    expect(hostWritten(inits)).toBe(true);
    expect(hostContentProblems({ tasks: [marked, inits] })).toEqual([]);
  });

  test("empty content on a test file or a requirement's path in a host-written task is a plan problem", () => {
    const test: Task = { ...wordcount, writes: [{ path: "src/wordcount.php", action: "create", content: "<?php\nfunction wc() {}\n" }, { path: "tests/run.php", action: "create", content: "" }] };
    expect(hostContentProblems({ tasks: [test] })[0]).toContain("Task T001 gives empty content to tests/run.php");
    const named: Task = { ...wordcount, writes: [{ path: "src/wordcount.php", action: "create", content: "" }, { path: "src/util.php", action: "create", content: "<?php\n" }] };
    expect(hostContentProblems({ tasks: [named] })).toEqual([]);
    const spec = { requirements: [{ ...fixtureSpec.requirements[0]!, text: "src/wordcount.php counts the words of its input" }] };
    expect(hostContentProblems({ tasks: [named] }, spec)[0]).toContain("gives empty content to src/wordcount.php");
  });

  test("the graph the scheduler stores has the empty content taken out", () => {
    const graph = withoutEmptyHostContent({ tasks: [wordcount] });
    expect(graph.tasks[0]?.writes).toEqual([
      { path: "src/wordcount.php", action: "create" },
      { path: "tests/run.php", action: "create" },
      { path: "README.md", action: "create" },
    ]);
    const kept = { tasks: [{ ...wordcount, writes: [{ path: "pkg/__init__.py", action: "create" as const, content: "" }] }] };
    expect(withoutEmptyHostContent(kept)).toBe(kept);
  });
});

/** The php-wordcount planner, on the fixture's value task: every write carries `""`. */
class EmptyContentExecutor extends FixtureExecutor {
  implemented: string[] = [];
  corrective: string[] = [];
  constructor(private dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nCreate value.txt and its notes.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
      const task: Task = { ...base, id: "T001", title: "Create value", description: "Write ready", writes: [{ path: "value.txt", action: "create", content: "" }, { path: "NOTES.md", action: "create", content: "" }] };
      const taskGraph: TaskGraph = { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown), tasks: [task] };
      const output = { schemaVersion: 1, markdown, taskGraph };
      // The submission check the planner's session would run; the scripted planner ignores it.
      this.corrective.push(...(request.validate?.(output) ?? []));
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output === "implementation") {
      this.implemented.push(request.task?.id ?? "");
      writeFileSync(join(this.dir, "NOTES.md"), "Value is ready.\n");
    }
    return super.execute(request);
  }
}

describe("scenario: php-wordcount, a planner that fills content with empty strings (#2610)", () => {
  test("the planner is told to leave content out, and the plan that keeps it runs an implementer", async () => {
    const fixture = workflowFixture({ executor: (root) => new EmptyContentExecutor(root) });
    cleanups.push(fixture.dispose);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.executor.corrective.some((p) => p.includes("Leave content out so an agent writes the files"))).toBe(true);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    expect(fixture.executor.implemented).toEqual(["T001"]);
    expect(outcome.status).toBe("completed");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("ready");
    const edits = fixture.service.store.state(run.runId).hostEdits;
    expect(edits.some((e) => e.kind === "content-written")).toBe(false);
    expect(edits.some((e) => e.kind === "empty-host-content" && e.task === "T001" && e.field === "writes")).toBe(true);
    // The stored graph is an agent task with no content.
    const stored = fixture.service.store.state(run.runId).graph?.tasks.find((t) => t.id === "T001");
    expect(stored?.writes.every((w) => w.content === undefined)).toBe(true);
  }, 60000);
});

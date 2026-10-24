import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareDelivery } from "../src/core/workflows/delivery.js";
import { wordCut } from "../src/core/workflows/run-title.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// ecfit-update R64 fca353b8 (#2001): a quick run's branch commit subject was the request cut at 72
// characters mid-word, "Add this feature to the existing project in the current folder. Keep eve".
// A quick run has no spec stage; its host-made spec's title is the request's first characters. The
// planned task's title was available.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const REQUEST =
  "Add this feature to the existing project in the current folder. Keep every existing test passing and document the new check in the README.";
const PLANNED =
  "Add EC008 mixed-indentation detection, literal tests, and documentation for the new check";

/** Works in the root the scheduler hands out (the run's worktree) and names its one task PLANNED. */
class TitledExecutor extends FixtureExecutor {
  constructor(private workspace: string) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const out = await new FixtureExecutor(request.root ?? this.workspace).execute(request);
    if (request.profile.output === "plan") {
      const graph = (out.output as { taskGraph: { tasks: { title: string }[] } }).taskGraph;
      graph.tasks = graph.tasks.map((task) => ({ ...task, title: PLANNED }));
    }
    return out;
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function completed(workflowId: "quick" | "sdd", prompt: string) {
  const fixture = workflowFixture({ policy: fixturePolicy, executor: (root) => new TitledExecutor(root) });
  cleanups.push(fixture.dispose);
  const { root, service } = fixture;
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, ".gitignore"), ".baked/\n");
  writeFileSync(join(root, "README.md"), "# Project\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "Initial");
  const run = await service.start({
    commandId: newId(), featureId: "fixture", workflowId, prompt, ownerLabel: "test", policy: fixturePolicy, executionMode: "worktree",
  });
  let current = await service.drive(run.runId, signal());
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, signal());
  }
  expect(current.status).toBe("completed");
  const commit = service.store.state(run.runId).worktree?.commit ?? "";
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  const subject = git(root, "log", "-1", "--format=%s", commit);
  const delivery = await prepareDelivery(service.store, fixture.config, run.runId, { local: true, now: 1700000000 });
  return { subject, delivered: delivery.plan.commitMessage.split("\n")[0] };
}

describe("scenario: the subject of a run's commit and delivery (#2001)", () => {
  test("quick: the planned task's title, cut at a word boundary to 72 characters", async () => {
    const { subject, delivered } = await completed("quick", REQUEST);
    expect(subject).toBe("Add EC008 mixed-indentation detection, literal tests, and documentation");
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(PLANNED.startsWith(`${subject} `)).toBe(true);
    expect(subject).not.toContain(REQUEST.slice(0, 40));
    expect(delivered).toBe(subject);
  }, 60000);

  // The fixture spec covers only value.txt, so the sdd run takes the fixture's own request.
  test("sdd: the spec author's title", async () => {
    const { subject, delivered } = await completed("sdd", "Create ready value");
    expect(subject).toBe("Fixture");
    expect(delivered).toBe("Fixture");
  }, 60000);
});

describe("wordCut (#2001)", () => {
  test("keeps a line that fits and cuts a longer one at the last word boundary", () => {
    expect(wordCut("Report the mdtoc version")).toBe("Report the mdtoc version");
    expect(wordCut(REQUEST)).toBe("Add this feature to the existing project in the current folder. Keep");
    expect(wordCut("one two three", 7)).toBe("one two");
    expect(wordCut("one two three", 8)).toBe("one two");
    expect(wordCut("one two, three", 9)).toBe("one two");
  });

  test("takes the first line, collapses whitespace and never adds an ellipsis", () => {
    expect(wordCut("  Fix   the\tparser  \nsecond line")).toBe("Fix the parser");
    expect(wordCut("a".repeat(80) + " b")).toBe("a".repeat(72));
    expect(wordCut("x ".repeat(60)).endsWith("…")).toBe(false);
  });
});

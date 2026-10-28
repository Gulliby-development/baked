import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostApplyRecord, HostApplyWrite } from "../src/core/workflows/host-apply.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { blockDrift, comparableWrite, patchHunks, suppliedDriftSummary, suppliedDrifts } from "../src/core/workflows/supplied-drift.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2332 part 2, R74 ewvet-update: the request gave the README change as an exact diff, the
// implementer wrote the printf example with a doubled backslash (`...=\\n'` where the diff has
// `...=\n'`), the reviewer rated it low, and no check read the README: the run completed with two
// failing criteria. The host now compares the delivered file with the verbatim block (shadow).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BASE_README = "# ewvet\n\nChecks .env files.\n\n## Usage\n\n```sh\newvet .env\n```\n";
const GOOD_LINE = "printf 'A=1\\nB=\\n' | ewvet -";
const DOUBLED_LINE = "printf 'A=1\\\\nB=\\\\n' | ewvet -";
const DIFF = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -7,3 +7,4 @@",
  " ```sh",
  " ewvet .env",
  `+${GOOD_LINE}`,
  " ```",
  "",
].join("\n");
const REQUEST = `Update the README with exactly this diff:\n\n\`\`\`diff\n${DIFF}\`\`\`\n`;

const write = (overrides: Partial<HostApplyWrite> = {}): HostApplyWrite => ({
  path: "README.md",
  action: "modify",
  files: 0,
  diffs: 1,
  whole: false,
  exists: true,
  applies: true,
  ...overrides,
});
const record = (taskId: string, writes: HostApplyWrite[]): HostApplyRecord => ({ taskId, mode: "shadow", writes, wouldApply: true, reason: null });
const task = (id: string, paths: string[], origin: "planned" | "repair" = "planned") =>
  ({ id, origin, writes: paths.map((path) => ({ path, action: "modify" as const })) }) as unknown as TaskGraph["tasks"][number];

describe("suppliedDrifts: delivered files against the request's verbatim blocks (#2332)", () => {
  test("R74 ewvet: a doubled backslash in a line the exact diff adds is a drift naming both lines", () => {
    const delivered = BASE_README.replace("ewvet .env\n", `ewvet .env\n${DOUBLED_LINE}\n`);
    const drifts = suppliedDrifts(REQUEST, [record("T002", [write()])], { tasks: [task("T002", ["README.md"])] }, () => delivered);
    expect(drifts).toEqual([
      { task: "T002", path: "README.md", block: "diff", hunk: 1, problem: "missing", line: 9, expected: GOOD_LINE, actual: { line: 9, text: DOUBLED_LINE } },
    ]);
    expect(suppliedDriftSummary(drifts[0]!)).toBe(
      `T002 delivered README.md, which has ${JSON.stringify(DOUBLED_LINE)} at line 9 where the request's verbatim diff (hunk 1) gives ${JSON.stringify(GOOD_LINE)}. A repair task would rewrite it from the request's text.`,
    );
  });

  test("the diff applied as given (LF or CRLF) records nothing", () => {
    const delivered = BASE_README.replace("ewvet .env\n", `ewvet .env\n${GOOD_LINE}\n`);
    const tasks = { tasks: [task("T002", ["README.md"])] };
    expect(suppliedDrifts(REQUEST, [record("T002", [write()])], tasks, () => delivered)).toEqual([]);
    expect(suppliedDrifts(REQUEST, [record("T002", [write()])], tasks, () => delivered.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  test("added lines present but out of the hunk's order are moved", () => {
    const delivered = BASE_README.replace("```sh\newvet .env\n", `${GOOD_LINE}\n\`\`\`sh\newvet .env\n`);
    const [drift] = suppliedDrifts(REQUEST, [record("T002", [write()])], { tasks: [task("T002", ["README.md"])] }, () => delivered);
    expect(drift).toMatchObject({ problem: "moved", hunk: 1, line: 7, actual: null });
    expect(suppliedDriftSummary(drift!)).toContain("does not hold the new lines of the request's verbatim diff (hunk 1) as consecutive lines from line 7");
  });

  test("a whole file and a Markdown section are compared line by line", () => {
    const whole = "Write `src/env.ts` as the whole file:\n\n```ts src/env.ts\nexport const sep = \"\\n\";\nexport const n = 1;\n```\n";
    const block = { kind: "file" as const, lines: 2, content: 'export const sep = "\\n";\nexport const n = 1;\n', whole: true };
    expect(blockDrift("T001", "src/env.ts", block, 'export const sep = "\\\\n";\nexport const n = 1;\n')).toMatchObject({
      block: "file", problem: "differs", line: 1, expected: 'export const sep = "\\n";', actual: { line: 1, text: 'export const sep = "\\\\n";' },
    });
    expect(blockDrift("T001", "src/env.ts", block, block.content)).toBeNull();
    expect(blockDrift("T001", "src/env.ts", block, null)).toMatchObject({ problem: "missing", actual: null });
    expect(suppliedDrifts(whole, [record("T001", [write({ path: "src/env.ts", files: 1, diffs: 0, whole: true, applies: null })])], { tasks: [task("T001", ["src/env.ts"])] }, () => block.content)).toEqual([]);

    const section = { kind: "file" as const, lines: 3, content: "## Usage\n\nRun `ewvet .env`.\n", whole: false, region: { title: "Usage", level: 2 } };
    expect(blockDrift("T003", "README.md", section, "# ewvet\n\n## Usage\n\nRun `ewvet .env`.\n\n## License\n\nMIT\n")).toBeNull();
    expect(blockDrift("T003", "README.md", section, "# ewvet\n\n## Usage\n\nRun `ewvet  .env`.\n")).toMatchObject({ block: "section", problem: "differs", line: 5 });
    expect(blockDrift("T003", "README.md", section, "# ewvet\n")).toMatchObject({ block: "section", problem: "missing", expected: "## Usage" });
    // Two sections of the heading: which one is the block cannot be told.
    expect(blockDrift("T003", "README.md", section, "## Usage\n\na\n\n## Usage\n\nb\n")).toBeNull();
  });

  test("only writes the request fixes are compared, and never a path another planned task writes", () => {
    expect(comparableWrite(write())).toBe(true);
    expect(comparableWrite(write({ applies: false }))).toBe(false);
    expect(comparableWrite(write({ action: "delete" }))).toBe(false);
    expect(comparableWrite(write({ files: 1, diffs: 0, whole: false, applies: null }))).toBe(false);
    expect(comparableWrite(write({ files: 1, diffs: 0, whole: false, exists: false, applies: null }))).toBe(true);
    expect(comparableWrite(write({ files: 1, diffs: 0, applies: null, region: { level: 2, matches: 2 } }))).toBe(false);
    expect(comparableWrite(write({ files: 1, diffs: 1 }))).toBe(false);
    const delivered = BASE_README;
    const records = [record("T002", [write()])];
    expect(suppliedDrifts(REQUEST, records, { tasks: [task("T002", ["README.md"]), task("T004", ["README.md"])] }, () => delivered)).toEqual([]);
    // A corrective of the task writing the same file keeps the comparison.
    expect(suppliedDrifts(REQUEST, records, { tasks: [task("T002", ["README.md"]), task("R001", ["README.md"], "repair")] }, () => delivered)).toHaveLength(1);
    // A record whose task the graph no longer has.
    expect(suppliedDrifts(REQUEST, records, { tasks: [] }, () => delivered)).toEqual([]);
  });

  test("patchHunks reads new lines with their start, skipping removed lines and markers", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n\\ No newline at end of file\n@@ -10 +10,2 @@\n ten\n+eleven\n\n";
    expect(patchHunks(patch)).toEqual([
      { start: 1, lines: [{ text: "new", added: true }, { text: "keep", added: false }] },
      { start: 10, lines: [{ text: "ten", added: false }, { text: "eleven", added: true }] },
    ]);
  });
});

/** The fixture flow, whose one task also applies the request's README diff, as `readme` says. */
class ReadmeExecutor extends FixtureExecutor {
  constructor(
    private workspace: string,
    private readme: string,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const graph = (result.output as { taskGraph: TaskGraph }).taskGraph;
      graph.tasks[0]?.writes.push({ path: "README.md", action: "modify" });
    }
    if (request.profile.output === "implementation") writeFileSync(join(this.workspace, "README.md"), this.readme);
    return result;
  }
}

async function deliver(readme: string, workflowId: "sdd" | "quick" = "sdd") {
  const policy: RunPolicy = { ...fixturePolicy, ...(workflowId === "quick" ? { clarification: "assume" as const } : {}) };
  const fixture = workflowFixture({ policy, executor: (root) => new ReadmeExecutor(root, readme) });
  cleanups.push(fixture.dispose);
  writeFileSync(join(fixture.root, "README.md"), BASE_README);
  const run = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: `Create ready value.\n\n${REQUEST}`, ownerLabel: "test", policy });
  let current = await fixture.service.drive(run.runId, new AbortController().signal);
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    if (fixture.service.store.requests(run.runId).find((r) => r.status === "pending")?.kind !== "approval") break;
    await fixture.approve(run.runId);
    current = await fixture.service.drive(run.runId, new AbortController().signal);
  }
  const wouldStops = fixture.service.store
    .eventsOfType(run.runId, "decision.would_stop")
    .map((e) => e.payload as { reason: string; mode: string; key: string; summary: string; inputs: Record<string, unknown> })
    .filter((p) => p.reason === "supplied_drift");
  return { final: await fixture.service.get(run.runId), wouldStops };
}

describe("scenario: a run delivers a README that leaves the request's exact diff (#2332)", () => {
  test("the checks stage records a shadow supplied_drift naming the line, and the run still completes", async () => {
    const { final, wouldStops } = await deliver(BASE_README.replace("ewvet .env\n", `ewvet .env\n${DOUBLED_LINE}\n`));
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({
      mode: "shadow",
      key: "T001#README.md",
      inputs: { task: "T001", path: "README.md", block: "diff", hunk: 1, problem: "missing", line: 9, expected: GOOD_LINE, actual: { line: 9, text: DOUBLED_LINE } },
    });
    // Shadow: nothing stops.
    expect(final.status).toBe("completed");
  });

  test("the quick workflow's command-gate stage records it too", async () => {
    const { wouldStops } = await deliver(BASE_README.replace("ewvet .env\n", `ewvet .env\n${DOUBLED_LINE}\n`), "quick");
    expect(wouldStops.map((w) => w.key)).toEqual(["T001#README.md"]);
  });

  test("a README with the diff applied as given records nothing", async () => {
    const { final, wouldStops } = await deliver(BASE_README.replace("ewvet .env\n", `ewvet .env\n${GOOD_LINE}\n`));
    expect(wouldStops).toEqual([]);
    expect(final.status).toBe("completed");
  });
});

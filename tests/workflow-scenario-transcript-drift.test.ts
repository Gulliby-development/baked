import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { exactTranscripts, transcriptDrift, transcriptDriftSummary, transcriptDrifts } from "../src/core/workflows/transcript-drift.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2648, R88 pokerank (JavaScript): the request gave a `$` transcript the README had to hold
// "exactly as shown"; the implementer wrote the printf line with a doubled backslash, the reviewer
// found it without a repro, the review gate kept it as a note, and the README's first example
// failed as written (R87 citeseek, Python, the same). The host now compares the document with the
// transcript (shadow).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PRINTF = "$ printf 'board 2c 7d 9h Jc Kd\\nseat ann 100 Ah Kh\\n' > hand.txt";
const DOUBLED = "$ printf 'board 2c 7d 9h Jc Kd\\\\nseat ann 100 Ah Kh\\\\n' > hand.txt";
const TRANSCRIPT = [PRINTF, "$ node bin/pokerank.js showdown hand.txt", "ann wins 100 with a flush"];
const REQUEST = [
  "Write the CLI and its README.",
  "",
  "The README must hold these examples exactly as shown:",
  "",
  "```console",
  ...TRANSCRIPT,
  "```",
  "",
].join("\n");
const readme = (lines: string[]) => `# pokerank\n\nRanks poker hands.\n\n## Example\n\n\`\`\`console\n${lines.join("\n")}\n\`\`\`\n`;
const task = (id: string, paths: string[]) => ({ id, origin: "planned", writes: paths.map((path) => ({ path, action: "create" as const })) }) as unknown as TaskGraph["tasks"][number];
const graph = { tasks: [task("T001", ["bin/pokerank.js"]), task("T002", ["README.md"])] };

describe("transcriptDrifts: documents against the request's exact transcripts (#2648)", () => {
  test("R88 pokerank: the doubled backslash in the printf line is a drift naming both lines", () => {
    const drifts = transcriptDrifts(REQUEST, graph, (path) => (path === "README.md" ? readme([DOUBLED, ...TRANSCRIPT.slice(1)]) : "x"));
    expect(drifts).toEqual([{ tasks: ["T002"], path: "README.md", block: 5, problem: "differs", expected: PRINTF, actual: { line: 8, text: DOUBLED } }]);
    expect(transcriptDriftSummary(drifts[0]!)).toBe(
      `T002 delivered README.md, which has ${JSON.stringify(DOUBLED)} at line 8 where the request's transcript (its block at line 5) gives ${JSON.stringify(PRINTF)}. A repair task would rewrite it from the request's text.`,
    );
  });

  test("the transcript held as given (LF, CRLF, trailing spaces) records nothing", () => {
    const held = readme(TRANSCRIPT);
    for (const text of [held, held.replaceAll("\n", "\r\n"), held.replace("flush\n", "flush   \n")])
      expect(transcriptDrifts(REQUEST, graph, () => text)).toEqual([]);
  });

  test("a line left out of a transcript the document shows is missing", () => {
    const [drift] = transcriptDrifts(REQUEST, graph, () => readme([PRINTF, "$ node bin/pokerank.js showdown hand.txt"]));
    expect(drift).toMatchObject({ problem: "missing", expected: "ann wins 100 with a flush", actual: null });
    expect(transcriptDriftSummary(drift!)).toContain("without its line");
  });

  test("a document that shows none of the transcript, or a request that does not fix the text, records nothing", () => {
    expect(transcriptDrifts(REQUEST, graph, () => "# pokerank\n\nSee the source.\n")).toEqual([]);
    const loose = REQUEST.replace("must hold these examples exactly as shown", "could show examples like these");
    expect(exactTranscripts(loose)).toEqual([]);
    // Exactness about program output, with no document named, is no document's text.
    expect(exactTranscripts(REQUEST.replace("The README must hold these examples exactly as shown:", "The CLI must print exactly this:"))).toEqual([]);
    // A block without a `$` prompt is no transcript.
    expect(exactTranscripts(REQUEST.replaceAll("$ ", ""))).toEqual([]);
  });

  test("the prose names which document holds it; with none named, every document the plan writes", () => {
    const named = REQUEST.replace("The README", "docs/usage.md");
    const two = { tasks: [...graph.tasks, task("T003", ["docs/usage.md"])] };
    const read = (path: string) => (path.endsWith(".md") ? readme([DOUBLED, ...TRANSCRIPT.slice(1)]) : "x");
    expect(transcriptDrifts(named, two, read).map((d) => d.path)).toEqual(["docs/usage.md"]);
    const unnamed = REQUEST.replace("The README must hold", "The documentation must hold");
    expect(transcriptDrifts(unnamed, two, read).map((d) => d.path)).toEqual(["README.md", "docs/usage.md"]);
    // A missing document records nothing; the plan's task does.
    expect(transcriptDrifts(REQUEST, graph, () => null)).toEqual([]);
  });

  test("transcriptDrift compares one block; Python's activation line as in R87 citeseek", () => {
    const fence = { start: 3, lines: ["$ .venv\\Scripts\\activate", "$ citeseek check refs.bib"] };
    expect(transcriptDrift(["T004"], "README.md", fence, "```\n$ .venv\\\\Scripts\\\\activate\n$ citeseek check refs.bib\n```\n")).toMatchObject({
      problem: "differs",
      expected: "$ .venv\\Scripts\\activate",
      actual: { line: 2, text: "$ .venv\\\\Scripts\\\\activate" },
    });
  });
});

/** The fixture flow, whose task also writes the README as `text` says. */
class ReadmeExecutor extends FixtureExecutor {
  constructor(
    private workspace: string,
    private text: string,
  ) {
    super(workspace);
  }
  override async execute(request: ExecutionRequest) {
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = (result.output as { taskGraph: TaskGraph }).taskGraph;
      plan.tasks[0]?.writes.push({ path: "README.md", action: "create" });
    }
    if (request.profile.output === "implementation") writeFileSync(join(request.root ?? this.workspace, "README.md"), this.text);
    return result;
  }
}

async function deliver(text: string, workflowId: "sdd" | "quick" = "sdd") {
  // The request names a CLI the fixture plan does not build: the run assumes instead of asking.
  const policy: RunPolicy = { ...fixturePolicy, clarification: "assume" };
  const fixture = workflowFixture({ policy, executor: (root) => new ReadmeExecutor(root, text) });
  cleanups.push(fixture.dispose);
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
    .filter((p) => p.reason === "transcript_drift");
  return { final: await fixture.service.get(run.runId), wouldStops };
}

describe("scenario: a run delivers a README that leaves the request's exact transcript (#2648)", () => {
  test("the checks stage records a shadow transcript_drift naming the line, and the run still completes", async () => {
    const { final, wouldStops } = await deliver(readme([DOUBLED, ...TRANSCRIPT.slice(1)]));
    expect(wouldStops).toHaveLength(1);
    expect(wouldStops[0]).toMatchObject({
      mode: "shadow",
      key: "README.md#block-7",
      inputs: { tasks: ["T001"], path: "README.md", problem: "differs", expected: PRINTF, actual: { line: 8, text: DOUBLED } },
    });
    expect(final.status).toBe("completed");
  });

  test("the quick workflow's command-gate stage records it too", async () => {
    const { wouldStops } = await deliver(readme([DOUBLED, ...TRANSCRIPT.slice(1)]), "quick");
    expect(wouldStops.map((w) => w.key)).toEqual(["README.md#block-7"]);
  });

  test("a README holding the transcript as given records nothing", async () => {
    const { final, wouldStops } = await deliver(readme(TRANSCRIPT));
    expect(wouldStops).toEqual([]);
    expect(final.status).toBe("completed");
  });
});

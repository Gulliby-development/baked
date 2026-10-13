import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { narrowCorrectionWrites } from "../src/core/workflows/scheduler.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const task = (writes: string[], extra: Partial<Task> = {}): Task => ({
  id: "T004",
  title: "Correct F1",
  description: "Correct F1",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  dependsOn: [],
  profileId: "implementer",
  writes: writes.map((path) => ({ path, action: "modify" as const })),
  readHints: [],
  checkIds: [],
  origin: "repair",
  findingIds: ["F1"],
  rationale: "Finding",
  ...extra,
});

// #765: a correction carries every file of the tasks it corrects; its first attempt starts small.
describe("the first attempt of a correction", () => {
  test("may write the files its findings point at and their tests", () => {
    const writes = ["LICENSE", "README.md", "src/parse.rs", "src/cli.rs", "tests/parse.rs"];
    expect(narrowCorrectionWrites(task(writes), ["src/parse.rs"])?.map((w) => w.path)).toEqual([
      "src/parse.rs",
      "tests/parse.rs",
    ]);
    // Nothing to narrow: no focus, a focus that is the whole scope, or a planned task.
    expect(narrowCorrectionWrites(task(writes), [])).toBeNull();
    expect(narrowCorrectionWrites(task(["src/parse.rs", "tests/parse.rs"]), ["src/parse.rs"])).toBeNull();
    expect(narrowCorrectionWrites(task(writes, { origin: "planned" }), ["src/parse.rs"])).toBeNull();
  });
});

/**
 * One planned task writes value.txt and notes.md; it leaves value.txt broken, and the check names
 * value.txt when it fails. `blockFirstCorrection` makes the first correction attempt report that
 * it needs notes.md.
 */
class TwoFileExecutor extends FixtureExecutor {
  implementations: ExecutionRequest[] = [];
  constructor(
    private dir: string,
    private blockFirstCorrection: boolean,
  ) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nCreate value.txt.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\nvalue.txt\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture";
      const writes = ["value.txt", "notes.md"].map((path) => ({ path, action: "create" as const }));
      return {
        output: {
          schemaVersion: 1,
          markdown,
          taskGraph: {
            schemaVersion: 1,
            featureId: "fixture",
            revision: 1,
            specHash: hashJson(fixtureSpec),
            planHash: hashBytes(markdown),
            tasks: [{ ...task([]), id: "T001", title: "Create value", description: "Write ready", writes, origin: "planned", findingIds: [] }],
          },
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    this.implementations.push(request);
    const attempt = this.implementations.length;
    if (attempt === 1) {
      writeFileSync(join(this.dir, "value.txt"), "broken");
      writeFileSync(join(this.dir, "notes.md"), "notes");
    } else if (attempt === 2 && this.blockFirstCorrection) {
      return {
        output: {
          schemaVersion: 1,
          taskId: request.task?.id,
          outcome: "blocked",
          summary: "The fix needs notes.md",
          evidenceIds: [],
          unresolved: ["notes.md must change too"],
        },
        inputTokens: 25,
        outputTokens: 25,
      };
    } else {
      writeFileSync(join(this.dir, "value.txt"), "ready");
      writeFileSync(join(this.dir, "notes.md"), `notes ${String(attempt)}`);
    }
    return {
      output: { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] },
      inputTokens: 25,
      outputTokens: 25,
    };
  }
}

const policy = {
  ...fixturePolicy,
  checks: fixturePolicy.checks.map((check) => ({
    ...check,
    args: ["-e", "if (await Bun.file('value.txt').text() !== 'ready') { console.log('value.txt: not ready'); process.exit(1) }"],
  })),
};

async function run(blockFirstCorrection: boolean) {
  const fx = workflowFixture({ policy, executor: (root) => new TwoFileExecutor(root, blockFirstCorrection) });
  cleanups.push(() => fx.dispose());
  const started = await fx.start();
  await fx.service.drive(started.runId, signal());
  await fx.approve(started.runId);
  const final = await fx.service.drive(started.runId, signal());
  const scopes = fx.executor.implementations.map((r) => r.task?.writes.map((w) => w.path));
  const notes = fx.executor.implementations.map(
    (r) =>
      (JSON.parse(r.prompt.split("\n").at(-1) ?? "{}") as { extra: { correctionFocus?: { scope?: { writable: string[]; later: string[] } } } }).extra
        .correctionFocus?.scope,
  );
  return { final, scopes, notes };
}

describe("a correction in a run", () => {
  test("starts on the file the failing check names", async () => {
    const { final, scopes, notes } = await run(false);
    expect(final.status).toBe("completed");
    expect(scopes).toEqual([["value.txt", "notes.md"], ["value.txt"]]);
    expect(notes[1]).toMatchObject({ writable: ["value.txt"], later: ["notes.md"] });
  }, 120000);

  test("widens to every file of the corrected task after a failed first attempt", async () => {
    const { final, scopes, notes } = await run(true);
    expect(final.status).toBe("completed");
    expect(scopes).toEqual([["value.txt", "notes.md"], ["value.txt"], ["value.txt", "notes.md"]]);
    expect(notes[2]).toBeUndefined();
  }, 120000);
});

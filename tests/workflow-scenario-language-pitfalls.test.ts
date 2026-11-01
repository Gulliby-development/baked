import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PITFALLS_DIR, type PitfallsRecord } from "../src/core/workflows/pitfall-notes.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 84, wrapsmith (PowerShell, #2598): each handler file was written by a
// different task from the same registry contract, each wrote `[Parameter(Mandatory)] [int[]]
// $Positional` without `[AllowEmptyCollection()]`, and each failed Pester with the same
// `ParameterBindingValidationException`: 25 checks across three features, and the line-tools row
// tasks T004 to T012 each ran twice (6.83M of the feature's 8.27M tokens). Here T001 writes the
// trap, its check fails and a correction fixes it; T002 then starts on its own handler file.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const TRAP = "param([Parameter(Mandatory)] [int[]] $Positional)\n";
const FIXED = "param([Parameter(Mandatory)] [AllowEmptyCollection()] [int[]] $Positional)\n";

class HandlerExecutor extends FixtureExecutor {
  /** The input each implementer step received, in order. */
  steps: { taskId: string; extra: Record<string, unknown> }[] = [];
  constructor(private directory: string) {
    super(directory);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") return this.implement(request);
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: Record<string, unknown>[] } };
      const [first] = plan.taskGraph.tasks;
      plan.taskGraph.tasks = [
        { ...first, id: "T001", title: "Lines handler", writes: [{ path: "src/Lines.ps1", action: "create" }], checkIds: ["pester"] },
        { ...first, id: "T002", title: "Layout handler", dependsOn: ["T001"], writes: [{ path: "src/Layout.ps1", action: "create" }], checkIds: ["pester"] },
      ];
    }
    return result;
  }
  private implement(request: ExecutionRequest) {
    const taskId = request.task?.id ?? "";
    const extra = (JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: Record<string, unknown> }).extra;
    this.steps.push({ taskId, extra });
    const path = request.task?.writes[0]?.path ?? "src/Lines.ps1";
    mkdirSync(join(this.directory, "src"), { recursive: true });
    // T001's first session writes the trap; its correction and every later task do not.
    writeFileSync(join(this.directory, path), this.steps.length === 1 ? TRAP : FIXED);
    return { output: { schemaVersion: 1, taskId, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
  }
}

// Pester on a handler called with no positional arguments: the binding error, as R84 printed it.
const pester = [
  "const { readdirSync, readFileSync, existsSync } = await import('node:fs');",
  "const files = existsSync('src') ? readdirSync('src').filter((f) => f.endsWith('.ps1')) : [];",
  "const bad = files.filter((f) => !readFileSync('src/' + f, 'utf8').includes('AllowEmptyCollection'));",
  "if (bad.length) {",
  "  console.log('Describing ' + bad[0]);",
  "  console.log('  [-] handles no positional arguments ' + Math.floor(Math.random() * 90 + 10) + 'ms');",
  "  console.log(\"   ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array.\");",
  "  console.log('Tests Passed: 3, Failed: 1, Skipped: 0');",
  "  process.exit(1);",
  "}",
].join("\n");

async function run(languagePitfalls?: "on") {
  const policy: RunPolicy = {
    ...fixturePolicy,
    ...(languagePitfalls ? { languagePitfalls } : {}),
    checks: [{ ...fixturePolicy.checks[0]!, id: "pester", scope: "task", args: ["-e", pester] }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new HandlerExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  const done = await service.drive(started.runId, new AbortController().signal);
  const store = service.store;
  const records = store
    .artifacts(started.runId)
    .filter((a) => a.logical_path.startsWith(PITFALLS_DIR))
    .map((a) => JSON.parse(store.readArtifact(started.runId, a.id)) as PitfallsRecord);
  return { done, steps: fixture.executor.steps, records };
}

describe("scenario: R84 wrapsmith, a sibling task meets the trap its predecessor fixed (#2598)", () => {
  test("with languagePitfalls on, T002 starts with the PowerShell note and T001's binding error as a rule", async () => {
    const { done, steps } = await run("on");
    expect(done.status).toBe("completed");
    const first = steps[0];
    expect(first?.taskId).toBe("T001");
    // The first session already hears the language's pitfalls, before any failure.
    expect((first?.extra.languagePitfalls as string[])[0]).toContain("[AllowEmptyCollection()]");
    expect(first?.extra.runTraps).toBeUndefined();
    const next = steps.find((s) => s.taskId === "T002");
    expect((next?.extra.languagePitfalls as string[])[0]?.startsWith("PowerShell:")).toBe(true);
    expect(next?.extra.runTraps).toEqual([
      "T001 of this run failed pester with: ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array. (avoid the same mistake in the files you write)",
    ]);
  }, 90000);

  test("absent is shadow: T002's input holds neither, and its record says what it would have been told", async () => {
    const { done, steps, records } = await run();
    expect(done.status).toBe("completed");
    for (const step of steps) {
      expect(step.extra.languagePitfalls).toBeUndefined();
      expect(step.extra.runTraps).toBeUndefined();
    }
    const record = records.findLast((r) => r.taskId === "T002");
    expect(record?.applied).toBe(false);
    expect(record?.notes[0]?.startsWith("PowerShell:")).toBe(true);
    expect(record?.traps.map((t) => [t.taskId, t.checkId, t.line])).toEqual([
      ["T001", "pester", "ParameterBindingValidationException: Cannot bind argument to parameter 'Positional' because it is an empty array."],
    ]);
    expect(record?.chars).toBeLessThan(800);
  }, 90000);
});

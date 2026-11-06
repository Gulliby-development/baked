import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunPolicy } from "../../src/core/workflows/schemas.js";
import { newId } from "../../src/core/workflows/store.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./workflow-fixture.js";

/**
 * The cascade of #2948 (R101 turntrim c1633b0b): a whole-unit `lintr` check, red on a file an
 * earlier task wrote (`R/input.R`), failed every later task's task-end check, and each failure
 * opened its own corrective (18 correctives, 3.79M tokens). Here T001 writes `R/input.R`, and
 * T002 to T004 each write their own file. The task-scoped check lints the whole `R/` folder: it
 * passes on T001's file alone and prints R101's one-line indentation lint once another file
 * exists, until a corrective rewrites `R/input.R`.
 *
 * `holds: true` makes the corrective's fix hold; `false` stands for R101's fixer, which restyled
 * the file after every corrective: the corrective's text is clean only for the number of R files
 * it saw, so the next task's file brings the same lint back.
 */
const R101_LINT = "R/input.R:65:6: style: [indentation_linter] Indentation should be 10 spaces but is 6 spaces.";

const lintr = [
  "const { existsSync, readdirSync, readFileSync } = await import('node:fs');",
  "if (!existsSync('R/input.R')) process.exit(0);",
  "const others = readdirSync('R').filter((f) => f !== 'input.R').length;",
  "const text = readFileSync('R/input.R', 'utf8');",
  "if (others > 0 && text !== 'fixed' && text !== 'fixed ' + others) {",
  `  console.log(${JSON.stringify(R101_LINT)});`,
  "  process.exit(1);",
  "}",
].join("\n");

class CascadeExecutor extends FixtureExecutor {
  /** The task id of each implementer session, in order. */
  sessions: string[] = [];
  constructor(
    private directory: string,
    private chained: boolean,
    private holds: boolean,
  ) {
    super(directory);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") return this.implement(request);
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: Record<string, unknown>[] } };
      const [first] = plan.taskGraph.tasks;
      const task = (id: string, path: string, dependsOn: string[]) => ({
        ...first, id, title: `Write ${path}`, description: `Write ${path}`, dependsOn, writes: [{ path, action: "create" }], checkIds: ["lintr"],
      });
      plan.taskGraph.tasks = [
        task("T001", "R/input.R", []),
        task("T002", "R/tally.R", ["T001"]),
        task("T003", "R/report.R", [this.chained ? "T002" : "T001"]),
        task("T004", "R/cli.R", [this.chained ? "T003" : "T001"]),
      ];
    }
    return result;
  }
  private implement(request: ExecutionRequest) {
    const task = request.task;
    const taskId = task?.id ?? "";
    this.sessions.push(taskId);
    const root = request.root ?? this.directory;
    const dir = join(root, "R");
    mkdirSync(dir, { recursive: true });
    if (task?.origin === "planned") {
      const path = task.writes[0]?.path ?? "R/input.R";
      writeFileSync(join(root, path), path === "R/input.R" ? "styled" : "ok");
    } else if (task?.writes.some((w) => w.path === "R/input.R")) {
      const others = readdirSync(dir).filter((f) => f !== "input.R").length;
      writeFileSync(join(dir, "input.R"), this.holds ? "fixed" : `fixed ${others}`);
    }
    return { output: { schemaVersion: 1, taskId, outcome: "implemented", summary: `Wrote ${taskId}`, evidenceIds: [], unresolved: [] }, inputTokens: 25, outputTokens: 25 };
  }
}

/** `chained` makes each later task depend on the one before; otherwise all depend on T001. */
export async function wholeUnitCascade(options: { chained: boolean; holds: boolean }) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [{ ...fixturePolicy.checks[0]!, id: "lintr", scope: "task", args: ["-e", lintr] }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new CascadeExecutor(root, options.chained, options.holds) });
  const { service } = fixture;
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  const done = await service.drive(started.runId, new AbortController().signal);
  const store = service.store;
  const tasks = store.state(started.runId).graph?.tasks ?? [];
  const wouldStops = store
    .eventsOfType(started.runId, "decision.would_stop")
    .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "repeated_failure" ? [e.payload] : []));
  return {
    ...fixture,
    runId: started.runId,
    done,
    correctives: tasks.filter((t) => t.origin !== "planned"),
    sessions: fixture.executor.sessions,
    wouldStops,
  };
}

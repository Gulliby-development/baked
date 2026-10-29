import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { STOP_REASONS } from "../src/core/workflows/stop-reasons.js";
import { newId } from "../src/core/workflows/store.js";
import { suppliedCheckRecords } from "../src/core/workflows/supplied-checks.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #2456, R78 pairwick cli: the plan's task T002 carried the brief's `Main.scala` as content, so the
// host wrote it with no session. scalafmt could not parse it (`';' expected but ',' found`), its
// fixer failed seven times, and host correctives T010 to T012 wrote the same content again until
// the feature blocked `no_progress`. The #2275 check of supplied content never saw the task: it ran
// only before a model session. Now it runs before the host writes a task's files, and a task-level
// corrective that would write its files with the content they already hold records the
// `host_content_conflict` would-stop (shadow).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A fake formatter that cannot parse a line with `, ()`, printed as scalafmt prints it. */
const FORMATTER = [
  'import { readdirSync, readFileSync } from "node:fs";',
  "let bad = 0;",
  'for (const f of readdirSync("src")) {',
  '  readFileSync(`src/${f}`, "utf8").split("\\n").forEach((line, i) => {',
  "    if (line.includes(\", ()\")) {",
  "      console.log(`src/${f}:${i + 1}: error: [dialect scala3] ';' expected but ',' found`);",
  "      bad++;",
  "    }",
  "  });",
  "}",
  "process.exit(bad ? 1 : 0);",
].join("\n");
/** The fixer cannot parse the file either, and changes nothing. */
const fix = { executable: "bun", args: ["-e", "console.log(\"error: ';' expected but ',' found\"); process.exit(1)"] };
const fmt: Check = { id: "scalafmt", executable: "bun", args: ["fmt.ts"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [], fix };

const BROKEN = ["object Main:", "  def read() = try in.readAllBytes() catch case _: IOException => None, () => in.readAllBytes()", ""].join("\n");
const CLEAN = ["object Main:", "  def read() = in.readAllBytes()", ""].join("\n");

const spec: Spec = { schemaVersion: 1, featureId: "cli", revision: 1, title: "CLI", problem: "No entry point", outcome: "A main", inScope: ["CLI"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The CLI reads its input", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "input", when: "run", then: "it reads it", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nWrite the brief's Main.scala.\n## Decisions\nDEC-001: FR-001 in src.\n## Components\nsrc/Main.scala\n## Data\nNone\n## Verification\nscalafmt\n## Risks\nNone for fixture";
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [fmt] };

class HostOnlyExecutor implements AgentExecutor {
  implementations: string[] = [];
  constructor(private content: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    const task: Task = { id: "T001", title: "write src/Main.scala", description: "write src/Main.scala as the brief gives it", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/Main.scala", action: "create", content: this.content }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "cli", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation":
        this.implementations.push(request.task?.id ?? "");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Nothing to do", evidenceIds: [], unresolved: [] };
        break;
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function scenario(content: string) {
  const root = mkdtempSync(join(tmpdir(), "baked-host-written-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "fmt.ts"), FORMATTER);
  const executor = new HostOnlyExecutor(content);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const brief = ["Create `src/Main.scala` with exactly this content, and keep scalafmt clean:", "```scala", content.trimEnd(), "```"].join("\n");
  const run = await service.start({ commandId: newId(), featureId: "cli", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy });
  await service.drive(run.runId, new AbortController().signal);
  const waiting = await service.get(run.runId);
  const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(run.runId, new AbortController().signal);
  const stops = service.store.eventsOfType(run.runId, "decision.would_stop").filter((e) => e.payload.reason === "host_content_conflict");
  return { root, done, executor, records: suppliedCheckRecords(service.store, run.runId), stops };
}

describe("scenario: R78 pairwick cli, host-written content the project's formatter cannot parse (#2456)", () => {
  test("the content is checked before the host writes it, and a corrective that would write it again records host_content_conflict", async () => {
    const { root, executor, records, stops } = await scenario(BROKEN);
    // No model session runs for a host-written task or its correctives.
    expect(executor.implementations).toEqual([]);
    const [record] = records;
    expect(record).toMatchObject({ taskId: "T001", mode: "shadow", conflict: true, skipped: null });
    expect(record?.files).toEqual([{ path: "src/Main.scala", kind: "file", lines: [[1, 2]] }]);
    expect(record?.checks).toEqual([{ checkId: "scalafmt", status: "failed", offenses: [{ path: "src/Main.scala", line: 2, rule: null }] }]);
    expect(stops.length).toBeGreaterThanOrEqual(1);
    const [stop] = stops;
    expect(stop?.payload.mode).toBe("shadow");
    expect(String(stop?.payload.summary)).toContain("would write src/Main.scala with the content they already hold");
    // The host wrote the content verbatim; nothing changed it.
    expect(readFileSync(join(root, "src/Main.scala"), "utf8")).toBe(BROKEN);
  }, 120000);

  test("content that passes the formatter records no conflict and no would-stop", async () => {
    const { done, records, stops } = await scenario(CLEAN);
    expect(done.status).toBe("completed");
    expect(records).toHaveLength(1);
    expect(records[0]?.conflict).toBe(false);
    expect(stops).toHaveLength(0);
  }, 120000);

  test("the reason ships in shadow", () => {
    expect(STOP_REASONS.host_content_conflict.modes).toEqual(["shadow", "advisory"]);
    expect(STOP_REASONS.host_content_conflict.defaultMode).toBe("shadow");
  });
});

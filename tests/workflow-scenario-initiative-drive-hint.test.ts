import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initiativeLine } from "../apps/desktop/src/renderer/screens/insights/initiative-model.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { startApiServer } from "../src/core/api/server.js";
import { IDLE_TEXT } from "../src/core/workflows/initiatives/drive-state.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeService, type InitiativeStep, type InitiativeView } from "../src/core/workflows/initiatives/service.js";
import { initiativeActions, summarizeInitiative } from "../src/core/workflows/initiatives/view-model.js";
import type { RunPolicy, Spec } from "../src/core/workflows/schemas.js";
import type { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #2024 (uritpl R65): the cli feature asked a question; `workflow answer` drove its run to the end
// and exited, and the initiative sat idle for 18.4 minutes until the next `initiative drive`.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const plan: InitiativePlan = {
  schemaVersion: 1, title: "Templates", goals: ["Create the value files"],
  completionCriteria: ["All value files exist"],
  features: ["core", "cli", "docs"].map((id, index) => ({
    id, title: id, size: "small", workflow: "sdd",
    boundary: { scope: `The ${id} value`, paths: [`${id}.txt`] },
    contract: `${id}.txt contains ready`, dependsOn: index === 0 ? [] : [index === 1 ? "core" : "cli"], mandatory: true,
  })),
};
const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [{ id: "check", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] }],
};

/** Feature runs that complete on their own, except cli's first spec, which asks a blocking question. */
class AskingExecutor extends FixtureExecutor {
  asked = false;
  /** The drive state another service instance read while docs was implemented. */
  seenWhileDriving: string[] = [];
  workflows: NativeWorkflowService | null = null;
  override async execute(request: ExecutionRequest) {
    const [documents, attempt] = request.prompt.split("\n").slice(-2);
    const data = { ...JSON.parse(documents ?? "{}"), ...JSON.parse(attempt ?? "{}") } as {
      spec: Spec | null; extra: { featureId: string };
    };
    const spec: Spec = data.spec ?? { ...fixtureSpec, featureId: data.extra.featureId };
    const name = spec.featureId?.split("_").at(-1) ?? "core";
    const path = `${name}.txt`;
    let output: unknown;
    switch (request.profile.output) {
      case "initiativePlan": output = plan; break;
      case "spec": {
        const ask = name === "cli" && !this.asked;
        output = ask ? { ...spec, openQuestions: [{ id: "Q-1", question: "Which flag prints the version?", blocking: true }] } : { ...spec, openQuestions: [] };
        if (ask) {
          expect(request.validate?.(output) ?? []).toEqual([]);
          this.asked = true;
        }
        break;
      }
      case "plan": {
        const markdown = `# Plan\n## Context\nCreate ${path}.\n## Decisions\nDEC-001: FR-001 needs ready.\n## Components\n${path}\n## Data\nText\n## Verification\nCheck ready\n## Risks\nNone for fixture`;
        output = { schemaVersion: 1, markdown, taskGraph: {
          schemaVersion: 1, featureId: spec.featureId, revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown),
          tasks: [{ id: "T001", title: `Create ${path}`, description: "Write ready", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action: existsSync(join(request.root, path)) ? "modify" : "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        } };
        break;
      }
      case "implementation":
        if (name === "docs" && this.workflows)
          this.seenWhileDriving.push(new InitiativeService(this.workflows).view("tpl").drive?.state ?? "none");
        for (const write of request.task?.writes ?? []) writeFileSync(join(request.root, write.path), "ready");
        output = { schemaVersion: 1, taskId: request.task?.id, outcome: "implemented", summary: "Wrote value", evidenceIds: [], unresolved: [] };
        break;
      default: return super.execute(request);
    }
    this.calls.push(request.profile.output);
    return { output, inputTokens: 50, outputTokens: 50 };
  }
}

test("answering a feature run's question names the initiative drive, and the idle initiative says it waits for one", async () => {
  const fixture = workflowFixture({ policy, executor: (root) => new AskingExecutor(root) });
  cleanups.push(fixture.dispose);
  const { service, executor } = fixture;
  executor.workflows = service;
  const initiatives = new InitiativeService(service);
  const signal = new AbortController().signal;
  const id = () => ({ commandId: newId(), expectedRevision: initiatives.view("tpl").revision });

  await initiatives.start({ commandId: newId(), initiativeId: "tpl", prompt: "Add the template values", plan, policy, ownerLabel: "test", featureAutoApproval: { maxTasks: 5, maxFiles: 5 } });
  const split = initiatives.view("tpl").pendingDecisions.find((d) => d.scope === "initiative");
  if (!split) throw new Error("No split approval");
  await initiatives.approve("tpl", id(), { requestId: split.requestId, digest: split.digest });

  // core completes; cli asks its question and the drive stops for a person: no drive hint then.
  let view: InitiativeView = await initiatives.drive("tpl", signal);
  expect(view.next.kind).toBe("decide");
  expect(view.next.featureId).toBe("cli");
  expect(view.drive).toBeNull();
  const runId = view.next.runId ?? "";
  const question = service.store.requests(runId).find((r) => r.kind === "clarification" && r.status === "pending");
  if (!question) throw new Error("No pending clarification");

  // `baked workflow answer` continues only the run; it completes and the answer names the drive.
  const file = join(fixture.root, "answers.json");
  writeFileSync(file, JSON.stringify({ answers: { "Q-1": "--version" } }));
  const answered = (await executeWorkflowCommand(
    service,
    parseWorkflowArgs(["answer", runId, "--request", question.id, "--answers-file", file, "--expected-revision", String((await service.get(runId)).revision)]),
    signal,
  )) as { status: string; initiative?: InitiativeStep; next?: string };
  expect(answered.status).toBe("completed");
  expect(answered.next).toBe("baked workflow initiative drive tpl");
  expect(answered.initiative?.initiativeId).toBe("tpl");
  expect(answered.initiative?.status).toBe("active");
  expect(answered.initiative?.drive).toEqual({ state: "idle", text: IDLE_TEXT, command: "baked workflow initiative drive tpl" });

  // `initiative show` reports idle in place of active, and every surface reads it.
  view = initiatives.view("tpl");
  expect(view.status).toBe("active");
  expect(view.drive?.state).toBe("idle");
  expect(view.drive?.text).toBe("idle: waiting for a drive");
  const summary = summarizeInitiative(view);
  expect(summary.idle).toBe(true);
  expect(summary.needsYou).toBe(true);
  expect(initiativeActions(view, false).some((o) => o.action.kind === "drive")).toBe(true);

  // The desktop reads the same state from `baked serve` and continues it with the drive endpoint.
  const server = await startApiServer({ service, pollMs: 20, log: () => {} });
  cleanups.push(() => server.stop());
  const send = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${server.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await response.json()) as T;
    if (!response.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const listed = await send<{ initiatives: Parameters<typeof initiativeLine>[0][] }>("/v1/initiatives");
  const item = listed.initiatives.find((i) => i.initiativeId === "tpl");
  if (!item) throw new Error("Initiative not listed");
  expect(initiativeLine(item)).toBe("idle: waiting for a drive · 3 features");
  await send("/v1/initiatives/tpl/drive", {});
  const deadline = Date.now() + 60_000;
  while (initiatives.view("tpl").status !== "completed" && Date.now() < deadline) await Bun.sleep(50);
  view = initiatives.view("tpl");
  expect(view.status).toBe("completed");
  expect(view.drive).toBeNull();
  // While the server's drive ran docs, another service instance saw it as driven, not idle.
  expect(executor.seenWhileDriving.length).toBeGreaterThan(0);
  expect(executor.seenWhileDriving.every((state) => state === "driving")).toBe(true);
}, 60_000);

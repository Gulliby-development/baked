import { describe, expect, test } from "bun:test";
import type { EventPayloads, EventType, RunRequest, WorkflowEvent } from "../src/renderer/client/runs.ts";
import { gateView, type WalkRecord } from "../src/renderer/screens/runs/acceptance.ts";
import {
  duration,
  latestByPath,
  nextTasks,
  pipeline,
  refetchFor,
  replay,
  type Spec,
  stageLabel,
  stageProgress,
  type Task,
  type TaskGraph,
  taskCount,
  taskLevels,
  taskState,
} from "../src/renderer/screens/runs/model.ts";
import {
  answersOf,
  approvalReviewText,
  blockingRequests,
  clarificationTask,
  questionsOf,
} from "../src/renderer/screens/runs/requests.ts";

let seq = 0;
function ev<K extends EventType>(type: K, payload: EventPayloads[K]): WorkflowEvent {
  seq++;
  return {
    seq,
    at: new Date(Date.UTC(2026, 9, 10, 7, seq)).toISOString(),
    runId: "run-1",
    type,
    payload,
  } as WorkflowEvent;
}
const stage = (id: string, status = "completed"): WorkflowEvent[] => [
  ev("stage.started", { stepId: `s-${id}`, stageId: id, generation: 0 }),
  ev("stage.finished", { stepId: `s-${id}`, status, artifactId: null }),
];
const task = (id: string, to: string): WorkflowEvent =>
  ev("task.state_changed", { taskId: id, from: "pending", to, generation: 0 });
const node = (id: string, dependsOn: string[] = []): Task => ({
  id,
  title: id,
  description: id,
  dependsOn,
  writes: [],
  checkIds: [],
  origin: "planned",
});

describe("event replay", () => {
  test("stages follow their steps and finish by step ID", () => {
    const trace = replay([
      ...stage("research"),
      ...stage("plan"),
      ev("stage.started", { stepId: "s-approve", stageId: "approve", generation: 0 }),
    ]);
    expect(trace.stageOrder).toEqual(["research", "plan", "approve"]);
    expect(trace.stages.get("plan")?.status).toBe("completed");
    expect(trace.stages.get("approve")?.status).toBe("running");
    expect(trace.activity.map((a) => a.text)).toContain("Plan finished");
  });

  test("a model switch shows in the activity and refetches the run", () => {
    const switched = ev("run.rerouted", {
      artifactId: "a1",
      runModel: { from: "openai/gpt-6-luna", to: "codex/gpt-6-luna" },
      changes: [{ target: "profile implementer", from: "openai/gpt-6-luna", to: "codex/gpt-6-luna" }],
    });
    expect(replay([switched]).activity.map((a) => a.text)).toEqual(["Switched to codex/gpt-6-luna (was openai/gpt-6-luna)"]);
    const waiting = ev("wait.progress", { stageId: "wait-ci", deadline: "2026-10-10T08:00:00.000Z", intervalSeconds: 30, pending: ["ci-green"], polls: 0 });
    const passed = ev("wait.progress", { stageId: "wait-ci", deadline: "2026-10-10T08:00:00.000Z", intervalSeconds: 30, pending: [], polls: 4 });
    const lines = replay([waiting, passed]).activity.map((a) => a.text);
    expect(lines[0]).toContain("waits for ci-green until");
    expect(lines[0]).toContain("every 30s");
    expect(lines[1]).toContain("its gates pass");
    expect(refetchFor([switched]).status).toBe(true);
  });

  test("running tasks take the lowest free writer slot and integrate when done", () => {
    const trace = replay([
      task("T001", "running"),
      task("T002", "running"),
      task("T001", "implemented"),
      task("T003", "running"),
      task("T004", "running"),
    ]);
    expect(trace.writers.map((w) => w.current)).toEqual(["T003", "T002", "T004"]);
    expect(trace.writers[0]?.done).toEqual(["T001"]);
    expect(trace.integrated).toEqual(["T001"]);
    expect(trace.tasks.get("T004")?.slot).toBe(2);
  });

  test("an invalidated task leaves the integrated list", () => {
    const trace = replay([task("T001", "running"), task("T001", "verified"), task("T001", "invalidated")]);
    expect(trace.integrated).toEqual([]);
  });

  test("events already seen are skipped when replayed again", () => {
    const first = [task("T001", "running")];
    const trace = replay(first);
    replay([...first, task("T001", "implemented")], trace);
    expect(trace.activity.filter((a) => a.text === "T001 started")).toHaveLength(1);
    expect(trace.tasks.get("T001")?.status).toBe("implemented");
  });

  test("checks, criteria, findings and requests", () => {
    const trace = replay([
      ev("check.finished", { checkId: "lint", evidenceId: "e1", status: "failed" }),
      ev("check.finished", { checkId: "lint", evidenceId: "e2", status: "passed" }),
      ev("criterion.assessed", { criterionId: "AC-001", snapshotId: "x", verdict: "pass" }),
      ev("finding.recorded", { findingId: "F1", artifactId: "rev-1" }),
      ev("request.created", { requestId: "r1", kind: "approval", digest: "d" }),
      ev("request.decided", { requestId: "r1", status: "accepted", actor: "user" }),
    ]);
    expect(trace.checks.get("lint")).toMatchObject({ status: "passed", runs: 2 });
    expect(trace.criteria.get("AC-001")).toBe("pass");
    expect(trace.findings.get("F1")).toBe("rev-1");
    expect(trace.requests.get("r1")).toEqual({ kind: "approval", status: "accepted" });
  });
});

describe("pipeline", () => {
  const definition = ["research", "specify", "plan", "approve", "implement"];
  test("marks done, waiting and pending stages", () => {
    const trace = replay([...stage("research"), ...stage("specify"), ...stage("plan")]);
    const stages = pipeline(definition, trace, { stageId: "approve", status: "waiting" });
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "done", "waiting", "pending"]);
    expect(stageProgress(stages, "approve")).toEqual({ index: 4, total: 5 });
  });

  test("adds stages the definition no longer has", () => {
    const trace = replay([...stage("custom")]);
    const stages = pipeline(["research"], trace, { stageId: "custom", status: "running" });
    expect(stages.map((s) => [s.id, s.state])).toEqual([
      ["research", "pending"],
      ["custom", "current"],
    ]);
  });

  test("a completed run shows stages it never entered as skipped", () => {
    const trace = replay([...stage("research")]);
    const stages = pipeline(["research", "learn"], trace, { stageId: "research", status: "completed" });
    expect(stages.map((s) => s.state)).toEqual(["done", "skipped"]);
  });

  test("a run cancelled at a stage shows that stage stopped, not working", () => {
    const trace = replay([...stage("research"), ...stage("specify"), ...stage("plan")]);
    const stages = pipeline(definition, trace, { stageId: "approve", status: "cancelled" });
    expect(stages.map((s) => s.state)).toEqual(["done", "done", "done", "failed", "pending"]);
  });
});

describe("tasks", () => {
  const graph: TaskGraph = {
    tasks: [node("T001"), node("T002", ["T001"]), node("T003", ["T001"]), node("T004", ["T002", "T003"])],
  };
  test("levels by dependency depth", () => {
    expect(taskLevels(graph).map((l) => l.map((t) => t.id))).toEqual([
      ["T001"],
      ["T002", "T003"],
      ["T004"],
    ]);
  });
  test("states, next tasks and counts", () => {
    const trace = replay([task("T001", "running"), task("T001", "verified"), task("T002", "running")]);
    expect(graph.tasks.map((t) => taskState(t, trace))).toEqual(["done", "running", "ready", "waiting"]);
    expect(nextTasks(graph, trace)).toEqual(["T003"]);
    expect(taskCount(graph, trace)).toEqual({ done: 1, total: 4 });
  });
});

describe("live refetch", () => {
  test("maps events to what must be read again", () => {
    expect(refetchFor([task("T001", "running")])).toEqual({ status: false, artifacts: false, usage: false });
    expect(
      refetchFor([
        ev("run.state_changed", { from: "running", to: "waiting", reason: "approval", revision: 3 }),
        ev("artifact.committed", { artifactId: "a", kind: "tasks", hash: "h" }),
        ev("attempt.finished", { attemptId: "x", status: "completed", usageComplete: true, usedTokens: 1 }),
      ]),
    ).toEqual({ status: true, artifacts: true, usage: true });
    expect(refetchFor([ev("artifact.committed", { artifactId: "a", kind: "attempt-usage", hash: "h" })]).artifacts).toBe(false);
  });
});

describe("helpers", () => {
  test("labels and durations", () => {
    expect(stageLabel("research")).toBe("Research");
    expect(stageLabel("quick-fix")).toBe("Quick fix");
    expect(duration(460_000)).toBe("7m 40s");
    expect(duration(7_200_000)).toBe("2h");
    expect(duration(42_000)).toBe("42s");
  });
  test("latest revision per path", () => {
    const latest = latestByPath([
      { path: "spec.json", revision: 1, id: "a" },
      { path: "spec.json", revision: 2, id: "b" },
      { path: "plan.md", revision: 1, id: "c" },
    ]);
    expect(latest.get("spec.json")?.id).toBe("b");
  });
});

const request = (id: string, kind: string, body: unknown, status = "pending"): RunRequest => ({
  id: id,
  kind,
  status,
  digest: "d",
  body_json: JSON.stringify(body),
});

describe("requests", () => {
  test("questions and answers keep the question in the key", () => {
    const questions = questionsOf({ questions: [{ id: "Q1", question: "Exit 2 or 3?", blocking: true }] });
    expect(answersOf(questions, ["3"])).toEqual({ "Q1: Exit 2 or 3?": "3" });
    expect(answersOf(questions, ["  "])).toEqual({});
    expect(questionsOf({})).toHaveLength(1);
  });
  test("acceptance decisions do not block; clarifications name their task", () => {
    const list = [
      request("a", "approval", { writes: [] }),
      request("b", "approval", { acceptance: { gateId: "g" } }),
      request("c", "clarification", { taskId: "T004", questions: [] }),
      request("d", "approval", {}, "accepted"),
    ];
    expect(blockingRequests(list).map((r) => r.id)).toEqual(["a", "c"]);
    expect(clarificationTask(list[2] as RunRequest)).toBe("T004");
  });
});

describe("acceptance gate view", () => {
  const spec: Spec = {
    title: "t",
    problem: "p",
    outcome: "o",
    inScope: [],
    outOfScope: [],
    requirements: [],
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["FR-001"],
        given: "g",
        when: "w",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "t",
        method: "automated",
      },
      {
        id: "AC-002",
        requirementIds: ["FR-001"],
        given: "g",
        when: "w",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "t",
        method: "manual",
      },
    ],
  };
  const walk: WalkRecord = {
    gateId: "ui",
    attemptId: "a1",
    walk: {
      expectations: [
        { expectationId: "E1", verdict: "pass", stepIds: ["s1"], explanation: "ok" },
        { expectationId: "E2", verdict: "fail", stepIds: ["s1", "missing"], explanation: "bad" },
      ],
    },
    steps: [{ stepId: "s1", action: "goto /", observation: "seen", expectationIds: [], frame: "f", url: "http://localhost/" }],
    violations: [],
    problems: [],
    failure: null,
    verdict: "failed",
  };
  test("joins spec criteria, manual requests and walk expectations", () => {
    const view = gateView({
      spec,
      trace: replay([ev("criterion.assessed", { criterionId: "AC-001", snapshotId: "x", verdict: "pass" })]),
      reviews: [],
      walks: [walk],
      gates: [
        {
          id: "ui",
          type: "ai-acceptance",
          acceptance: {
            driver: "browser",
            scenario: { title: "UI", steps: [], expectations: ["first", "second"] },
            capabilities: { outboundHosts: [], listenPorts: [5173] },
          },
        },
      ],
      requests: [
        request("m1", "manual_evidence", { criterionId: "AC-002" }),
        request("t1", "approval", { acceptance: { gateId: "ui", testPath: "a.spec.ts", testContent: "x", verdict: "failed", scenario: "UI", stableRuns: 3 } }),
      ],
    });
    expect(view.criteria.map((c) => [c.label, c.verdict])).toEqual([
      ["AC-001", "pass"],
      ["AC-002", "manual"],
      ["UI · E1", "pass"],
      ["UI · E2", "fail"],
    ]);
    expect(view.criteria[1]?.manualRequestId).toBe("m1");
    expect(view.criteria[3]?.steps.map((s) => s.stepId)).toEqual(["s1"]);
    expect(view.criteria[3]?.url).toBe("http://localhost/");
    expect(view).toMatchObject({ passed: 2, total: 4, setup: "browser · outbound: localhost only" });
    expect(view.decisions[0]).toMatchObject({ requestId: "t1", digest: "d", testPath: "a.spec.ts" });
  });
});

describe("approval reviewer verdict", () => {
  test("says what the reviewer decided, or that it failed closed", () => {
    expect(approvalReviewText({ declined: ["Limits: 4 tasks exceed 3"] })).toBeNull();
    expect(
      approvalReviewText({
        review: { verdict: "escalate", risk: "medium", reasons: ["It edits the login flow."] },
      }),
    ).toBe("The approval reviewer escalated at medium risk: It edits the login flow.");
    expect(approvalReviewText({ reviewError: "timeout" })).toContain("could not decide (timeout)");
  });
});

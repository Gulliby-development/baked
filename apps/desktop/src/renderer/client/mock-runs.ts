import type { RunState } from "../../shared/api.js";
import type { AcceptanceGate, WalkRecord } from "../screens/runs/acceptance.js";
import type { SavedEstimate, Spec, TaskGraph } from "../screens/runs/model.js";
import { type MockRoute, type MockStream, response } from "./mock-routes.js";
import type {
  ArtifactEntry,
  ComparedRun,
  EventPayloads,
  EventType,
  RunComparison,
  RunDetailStatus,
  RunRequest,
  RunUsage,
  RunWorktree,
  WorkflowEvent,
} from "./runs.js";

/**
 * Sample runs of the BAKED project for the run screens: one waiting for plan approval, one
 * implementing with three parallel writers (its events keep arriving), one completed with AI
 * acceptance results, one waiting for a manual observation and one stopped on its budget.
 */

const PROJECT = "baked";
const SDD = [
  "research",
  "specify",
  "plan",
  "analyze",
  "approve",
  "implement",
  "checks",
  "review",
  "converge",
  "learn",
];
const DIGEST = "4f0c2a9d7b1e3c5a6f8d0b2c4e6a8c0e2f4a6b8d0c2e4f6a8b0c2d4e6f8a0b2c";

interface MockRun {
  runId: string;
  featureId: string;
  status: RunState;
  reason: string;
  stageId: string | null;
  revision: number;
  tokenUsage: number;
  activeMs: number;
  events: WorkflowEvent[];
  artifacts: { entry: ArtifactEntry; content: string }[];
  requests: RunRequest[];
  usage: RunUsage;
  /** A frozen input changed while the run was not driving; resuming is refused until revised. */
  inputChanged?: boolean;
  worktree?: RunWorktree | null;
}

class Log {
  readonly events: WorkflowEvent[] = [];
  private at: number;
  constructor(
    readonly runId: string,
    minutesAgo: number,
  ) {
    this.at = Date.now() - minutesAgo * 60_000;
  }
  add<K extends EventType>(type: K, payload: EventPayloads[K], seconds = 40): void {
    this.at += seconds * 1000;
    this.events.push({
      seq: this.events.length + 1,
      at: new Date(Math.min(this.at, Date.now())).toISOString(),
      runId: this.runId,
      type,
      payload,
    } as WorkflowEvent);
  }
  stage(id: string, model: string | null, status = "completed", seconds = 90): void {
    this.add("stage.started", { stepId: `step-${id}`, stageId: id, generation: 0 }, 5);
    if (model)
      this.add(
        "attempt.started",
        { attemptId: `att-${id}`, stepId: `step-${id}`, modelId: model },
        2,
      );
    if (status === "running" || status === "waiting") {
      if (status === "waiting")
        this.add("stage.finished", { stepId: `step-${id}`, status, artifactId: null }, seconds);
      return;
    }
    if (model)
      this.add(
        "attempt.finished",
        { attemptId: `att-${id}`, status: "completed", usageComplete: true, usedTokens: 40_000 },
        seconds,
      );
    this.add("stage.finished", { stepId: `step-${id}`, status, artifactId: null }, 3);
  }
  task(id: string, to: string, seconds = 60): void {
    this.add("task.state_changed", { taskId: id, from: "pending", to, generation: 0 }, seconds);
  }
}

function artifact(runId: string, n: number, path: string, kind: string, content: unknown) {
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return {
    entry: {
      id: `${runId}-a${n}`,
      kind,
      path,
      revision: 1,
      hash: DIGEST,
      bytes: text.length,
    },
    content: text,
  };
}

const estimate = (maxTokens: number, low: number, high: number): SavedEstimate => ({
  tokens: { low, high },
  maxTokens,
  workflowId: "sdd",
  costUsd: { low: low / 330_000, high: high / 330_000 },
});

function usage(stages: string[], models: string[]): RunUsage {
  return {
    totalTokens: stages.length * 40_000,
    stages: stages.map((stage) => ({ stage, attempts: 1, tokens: 40_000 })),
    models: models.map((model) => ({ model, attempts: 2, tokens: 80_000 })),
    attempts: stages.map((stage, i) => ({
      attemptId: `att-${stage}`,
      stage,
      model: models[i % models.length] ?? null,
      status: "completed",
    })),
  };
}

// --- usage-totals: waiting for plan approval ---------------------------------------------------

function usageTotals(): MockRun {
  const runId = "run-usage-totals";
  const log = new Log(runId, 14);
  log.add("run.created", { featureId: "usage-totals" }, 0);
  log.add("run.state_changed", { from: "created", to: "running", reason: "none", revision: 1 }, 1);
  log.stage("research", "provider/model-b");
  log.stage("specify", "claude-opus-5-5");
  log.add("artifact.committed", { artifactId: `${runId}-a1`, kind: "spec", hash: DIGEST }, 2);
  log.stage("plan", "claude-opus-5-5");
  log.add("artifact.committed", { artifactId: `${runId}-a2`, kind: "plan", hash: DIGEST }, 2);
  log.add("artifact.committed", { artifactId: `${runId}-a3`, kind: "tasks", hash: DIGEST }, 1);
  log.stage("analyze", "gpt-5.1");
  log.add("finding.recorded", { findingId: "F1", artifactId: `${runId}-a5` }, 2);
  log.stage("approve", null, "waiting", 4);
  log.add("request.created", { requestId: "req-usage-approval", kind: "approval", digest: DIGEST });
  log.add(
    "run.state_changed",
    { from: "running", to: "waiting", reason: "approval", revision: 9 },
    1,
  );
  const spec: Spec = {
    title: "Usage totals in run report",
    problem: "The run report shows tokens per attempt only, so nobody sees what a stage cost.",
    outcome: "The report and the headless CLI show input, output and cached tokens per stage.",
    inScope: ["Run report totals", "Headless --json output"],
    outOfScope: ["Usage across projects"],
    requirements: [
      {
        id: "FR-001",
        text: "The run report shows input, output and cached tokens per stage and in total.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "FR-002",
        text: "Totals match the sum of model events recorded for the run.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "FR-003",
        text: "The headless CLI prints the same totals with --json.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "NFR-001",
        text: "Reading the report stays under 50 ms for a run with 500 attempts.",
        priority: "should",
        verification: "automated",
      },
    ],
    criteria: [1, 2, 3, 4, 5].map((n) => ({
      id: `AC-00${n}`,
      requirementIds: ["FR-001"],
      given: `a run with ${n} stages`,
      when: "the report is printed",
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
      then: "every stage has a token line and the total matches",
      method: "automated" as const,
    })),
  };
  const graph: TaskGraph = {
    tasks: [
      task("T001", "Usage rows per stage", [], ["src/core/workflows/usage.ts"]),
      task("T002", "Cached tokens in usage records", ["T001"], ["src/core/workflows/usage.ts"]),
      task("T003", "Report totals section", ["T002"], ["src/core/workflows/report.ts"]),
      task("T004", "Headless --json totals", [], ["src/headless/workflow.ts"]),
      task("T005", "Totals tests", ["T003"], ["tests/workflow-usage.test.ts"]),
      task("T006", "CLI snapshot tests", ["T004"], ["tests/headless-json.test.ts"]),
    ],
  };
  return {
    runId,
    featureId: "usage-totals",
    status: "waiting",
    reason: "approval",
    stageId: "approve",
    revision: 9,
    tokenUsage: 412_000,
    activeMs: 460_000,
    events: log.events,
    artifacts: [
      artifact(runId, 1, "spec.json", "spec", spec),
      artifact(
        runId,
        2,
        "plan.md",
        "plan",
        "# Plan: usage totals\n\nTouches src/core/workflows/usage.ts and the headless report.\n\n1. Record cached tokens per attempt.\n2. Sum per stage in runUsage.\n3. Print the totals section in the report and in --json.\n",
      ),
      artifact(runId, 3, "tasks.json", "tasks", graph),
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(800_000, 380_000, 680_000)),
      artifact(runId, 5, "reviews/analyze.json", "review", {
        verdict: "pass",
        coverage: [],
        findings: [
          {
            id: "F1",
            kind: "partial",
            severity: "low",
            file: "src/headless/workflow.ts",
            claim: "T004 and T006 do not name the exit code for a run without usage.",
            impact: "Scripts may read an empty report as a failure.",
            suggestedFix: "State that an empty report exits with 0.",
            criterionIds: ["AC-003"],
          },
        ],
      }),
    ],
    requests: [
      {
        id: "req-usage-approval",
        kind: "approval",
        status: "pending",
        digest: DIGEST,
        body_json: JSON.stringify({
          writes: graph.tasks.flatMap((t) => t.writes),
          executionMode: "worktree",
          worktree: {
            path: `.baked/worktrees/${runId}/main`,
            branch: `baked/wf/${runId}`,
            userChangesInScope: [],
          },
        }),
      },
    ],
    usage: usage(["research", "specify", "plan", "analyze"], ["claude-opus-5-5", "gpt-5.1"]),
  };
}

function task(id: string, title: string, dependsOn: string[], paths: string[]) {
  return {
    id,
    title,
    description: title,
    dependsOn,
    writes: paths.map((path) => ({ path, action: "modify" })),
    checkIds: ["typecheck"],
    origin: "planned",
  };
}

// --- headless-json: three parallel writers -----------------------------------------------------

const HEADLESS_GRAPH: TaskGraph = {
  tasks: [
    task("T001", "Output schema", [], ["src/headless/schema.ts"]),
    task("T002", "JSON formatter", ["T001"], ["src/headless/format.ts"]),
    task("T003", "--json flag in boot", ["T001"], ["src/boot.tsx"]),
    task("T004", "Exit codes", ["T001"], ["src/headless/exit.ts"]),
    task("T005", "Snapshot tests", ["T002"], ["tests/headless-format.test.ts"]),
    task("T006", "CLI tests", ["T003", "T004"], ["tests/headless-cli.test.ts"]),
    task("T007", "Docs", ["T005", "T006"], ["docs/headless.md"]),
  ],
};

function headlessJson(): MockRun {
  const runId = "run-headless-json";
  const log = new Log(runId, 30);
  log.add("run.created", { featureId: "headless-json" }, 0);
  log.add("run.state_changed", { from: "created", to: "running", reason: "none", revision: 1 }, 1);
  for (const id of ["research", "specify", "plan", "analyze"])
    log.stage(id, id === "plan" ? "claude-opus-5-5" : "provider/model-b");
  log.stage("approve", null);
  log.add("request.decided", { requestId: "req-hj-approval", status: "accepted", actor: "user" });
  log.stage("implement", "provider/model-b", "running");
  log.task("T001", "running", 5);
  log.task("T001", "implemented", 120);
  log.add("check.finished", { checkId: "typecheck", evidenceId: "ev-1", status: "passed" }, 20);
  log.task("T002", "running", 5);
  log.task("T003", "running", 2);
  log.task("T004", "running", 2);
  log.add("request.created", { requestId: "req-hj-exit", kind: "clarification", digest: DIGEST });
  const spec: Spec = {
    title: "Headless JSON output",
    problem: "Scripts parse the headless CLI's text output, which changes between releases.",
    outcome: "baked --json prints one stable JSON document per run.",
    inScope: ["--json flag", "exit codes"],
    outOfScope: ["Streaming JSON"],
    requirements: [
      {
        id: "FR-001",
        text: "--json prints one JSON document.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "FR-002",
        text: "Exit codes tell success, failure and blocked runs apart.",
        priority: "must",
        verification: "automated",
      },
    ],
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["FR-001"],
        given: "a finished run",
        when: "baked runs with --json",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "stdout parses as one JSON document",
        method: "automated",
      },
    ],
  };
  return {
    runId,
    featureId: "headless-json",
    status: "running",
    reason: "none",
    stageId: "implement",
    revision: 14,
    tokenUsage: 296_000,
    activeMs: 1_380_000,
    events: log.events,
    artifacts: [
      artifact(runId, 1, "spec.json", "spec", spec),
      artifact(
        runId,
        2,
        "plan.md",
        "plan",
        "# Plan: headless JSON\n\nOne schema, one formatter, exit codes from the run state.\n",
      ),
      artifact(runId, 3, "tasks.json", "tasks", HEADLESS_GRAPH),
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(800_000, 420_000, 720_000)),
    ],
    requests: [
      {
        id: "req-hj-exit",
        kind: "clarification",
        status: "pending",
        digest: DIGEST,
        body_json: JSON.stringify({
          taskId: "T004",
          questions: [
            { id: "Q1", question: "Should a blocked run exit with 2 or with 3?", blocking: true },
          ],
        }),
      },
    ],
    usage: usage(["research", "specify", "plan", "analyze", "implement"], ["provider/model-b"]),
  };
}

/** Events the headless-json run sends while its screen is open, one every few seconds. */
const HEADLESS_LIVE: { type: EventType; payload: EventPayloads[EventType] }[] = [
  {
    type: "attempt.finished",
    payload: { attemptId: "att-t2", status: "completed", usageComplete: true, usedTokens: 22_000 },
  },
  {
    type: "task.state_changed",
    payload: { taskId: "T002", from: "running", to: "implemented", generation: 0 },
  },
  { type: "check.finished", payload: { checkId: "lint", evidenceId: "ev-2", status: "passed" } },
  {
    type: "task.state_changed",
    payload: { taskId: "T005", from: "pending", to: "running", generation: 0 },
  },
  {
    type: "task.state_changed",
    payload: { taskId: "T003", from: "running", to: "implemented", generation: 0 },
  },
  {
    type: "check.finished",
    payload: { checkId: "typecheck", evidenceId: "ev-3", status: "passed" },
  },
];

// --- settings-dark-mode: completed, AI acceptance results --------------------------------------

function settingsDarkMode(): MockRun {
  const runId = "run-settings-dark-mode";
  const log = new Log(runId, 180);
  log.add("run.created", { featureId: "settings-dark-mode" }, 0);
  log.add("run.state_changed", { from: "created", to: "running", reason: "none", revision: 1 }, 1);
  for (const id of SDD.slice(0, 5)) log.stage(id, id === "approve" ? null : "provider/model-b");
  log.stage("implement", "provider/model-b", "running");
  for (const id of ["T001", "T002", "T003"]) {
    log.task(id, "running", 5);
    log.task(id, "verified", 200);
  }
  log.add("stage.finished", { stepId: "step-implement", status: "completed", artifactId: null }, 2);
  log.stage("checks", null);
  for (const checkId of ["typecheck", "lint", "tests"])
    log.add("check.finished", { checkId, evidenceId: `ev-${checkId}`, status: "passed" }, 15);
  log.stage("review", "gpt-5.1");
  log.add("acceptance.phase", { gateId: "settings-ui", phase: "walking", detail: null }, 5);
  log.add("acceptance.phase", { gateId: "settings-ui", phase: "walked", detail: null }, 120);
  log.add(
    "gate.finished",
    {
      gateId: "settings-ui",
      mode: "advisory",
      status: "failed",
      attempts: 1,
      flaky: false,
      evidenceId: "ev-walk",
    },
    3,
  );
  log.add(
    "acceptance.phase",
    { gateId: "settings-ui", phase: "awaiting_approval", detail: null },
    60,
  );
  log.add("request.created", { requestId: "req-sdm-test", kind: "approval", digest: DIGEST }, 1);
  log.stage("converge", "claude-opus-5-5");
  for (const [criterionId, verdict] of [
    ["AC-001", "pass"],
    ["AC-002", "pass"],
    ["AC-003", "fail"],
  ] as const)
    log.add("criterion.assessed", { criterionId, snapshotId: "snap-2", verdict }, 4);
  log.add("finding.recorded", { findingId: "F7", artifactId: `${runId}-a6` }, 2);
  log.stage("learn", "provider/model-b");
  log.add(
    "run.state_changed",
    { from: "running", to: "completed", reason: "none", revision: 31 },
    2,
  );

  const spec: Spec = {
    title: "Settings page, dark mode",
    problem: "The settings page has no theme choice.",
    outcome: "A dark mode switch on the settings page that persists.",
    inScope: ["Theme switch", "Persistence"],
    outOfScope: ["Per-project themes"],
    requirements: [
      {
        id: "FR-001",
        text: "The settings page has a dark mode switch.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "NFR-001",
        text: "Body text contrast is at least 4.5:1.",
        priority: "must",
        verification: "automated",
      },
    ],
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["FR-001"],
        given: "the settings page",
        when: "it opens",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "a Dark mode switch is shown",
        method: "automated",
      },
      {
        id: "AC-002",
        requirementIds: ["FR-001"],
        given: "dark mode is on",
        when: "the page reloads",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "it stays on",
        method: "automated",
      },
      {
        id: "AC-003",
        requirementIds: ["NFR-001"],
        given: "dark mode",
        when: "captions render",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "their contrast is at least 4.5:1",
        method: "automated",
      },
    ],
  };
  const gates: AcceptanceGate[] = [
    {
      id: "settings-ui",
      type: "ai-acceptance",
      acceptance: {
        driver: "browser",
        scenario: {
          title: "Settings dark mode",
          steps: ["Open /settings", "Turn dark mode on", "Reload"],
          expectations: [
            "Theme toggle is on the Settings page",
            "The choice survives a reload",
            "Caption text contrast is at least 4.5:1",
            "No requests leave localhost",
            "Toggle feels instant on a slow machine",
          ],
        },
        capabilities: { outboundHosts: [], listenPorts: [5173] },
      },
    },
  ];
  const frame = (focus: string): string =>
    `- banner: Settings\n- heading "Appearance" [level=2]\n- switch "Dark mode" [checked]\n- text "Theme" \n- text "Applies to every project window" ${focus}\n- button "Save"`;
  const walk: WalkRecord = {
    gateId: "settings-ui",
    attemptId: "att-walk",
    walk: {
      expectations: [
        {
          expectationId: "E1",
          verdict: "pass",
          stepIds: ["s1"],
          explanation: 'Found by role "switch", label "Dark mode".',
        },
        {
          expectationId: "E2",
          verdict: "pass",
          stepIds: ["s2", "s3"],
          explanation: 'Reloaded twice, data-theme stayed "dark".',
        },
        {
          expectationId: "E3",
          verdict: "fail",
          stepIds: ["s2", "s4"],
          explanation:
            "Caption text measured 3.1:1 on the raised background. Sent to Converge as a finding.",
        },
        {
          expectationId: "E4",
          verdict: "pass",
          stepIds: ["s3"],
          explanation: "The proxy refused 0 requests.",
        },
        {
          expectationId: "E5",
          verdict: "inconclusive",
          stepIds: [],
          explanation: "Timing on a slow machine cannot be observed in the walk-through.",
        },
      ],
    },
    steps: [
      {
        stepId: "s1",
        action: "goto /settings",
        observation: 'Switch "Dark mode" is visible',
        expectationIds: ["E1"],
        frame: frame(""),
        url: "http://localhost:5173/settings",
      },
      {
        stepId: "s2",
        action: 'click role=switch name="Dark mode"',
        observation: 'data-theme is "dark"',
        expectationIds: ["E2", "E3"],
        frame: frame(""),
        url: "http://localhost:5173/settings",
      },
      {
        stepId: "s3",
        action: "reload",
        observation: 'data-theme is still "dark"; 0 requests refused',
        expectationIds: ["E2", "E4"],
        frame: frame(""),
        url: "http://localhost:5173/settings",
      },
      {
        stepId: "s4",
        action: "measure contrast .setting-caption",
        observation: "3.1 : 1 (needs 4.5 : 1)",
        expectationIds: ["E3"],
        frame: frame("<- 3.1:1"),
        url: "http://localhost:5173/settings",
      },
    ],
    violations: [],
    problems: [],
    failure: null,
    verdict: "failed",
  };
  return {
    runId,
    featureId: "settings-dark-mode",
    status: "completed",
    reason: "none",
    stageId: "learn",
    revision: 31,
    tokenUsage: 664_000,
    activeMs: 3_120_000,
    events: log.events,
    artifacts: [
      artifact(runId, 1, "spec.json", "spec", spec),
      artifact(
        runId,
        2,
        "plan.md",
        "plan",
        "# Plan: dark mode\n\nA theme switch in settings, stored in app settings.\n",
      ),
      artifact(runId, 3, "tasks.json", "tasks", {
        tasks: [
          task("T001", "Theme tokens", [], ["src/styles/tokens.css"]),
          task("T002", "Dark mode switch", ["T001"], ["src/settings/Appearance.tsx"]),
          task("T003", "Persist the choice", ["T002"], ["src/settings/store.ts"]),
        ],
      }),
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(800_000, 500_000, 760_000)),
      artifact(runId, 5, "definition/gates.json", "gates", gates),
      artifact(runId, 6, "reviews/converge.json", "review", {
        verdict: "changes_requested",
        coverage: [
          {
            criterionId: "AC-001",
            verdict: "pass",
            explanation: "Switch rendered with role switch.",
          },
          { criterionId: "AC-002", verdict: "pass", explanation: "Reload keeps data-theme." },
          { criterionId: "AC-003", verdict: "fail", explanation: "Captions measure 3.1:1." },
        ],
        findings: [
          {
            id: "F7",
            kind: "partial",
            severity: "medium",
            file: "src/styles/tokens.css",
            claim: "Caption color on raised panels has 3.1:1 contrast in dark mode.",
            impact: "Captions are hard to read for people with low vision.",
            suggestedFix: "Use the secondary text token for captions on raised panels.",
            criterionIds: ["AC-003"],
          },
        ],
      }),
      artifact(runId, 7, "acceptance/settings-ui/att-walk/walk.json", "acceptance", walk),
    ],
    requests: [
      {
        id: "req-sdm-test",
        kind: "approval",
        status: "pending",
        digest: DIGEST,
        body_json: JSON.stringify({
          acceptance: {
            gateId: "settings-ui",
            scenario: "Settings dark mode",
            verdict: "failed",
            testPath: "tests/acceptance/settings-dark-mode.spec.ts",
            testContent:
              'test("dark mode survives a reload", async ({ page }) => {\n  await page.goto("/settings");\n  await page.getByRole("switch", { name: "Dark mode" }).click();\n  await page.reload();\n  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");\n});\n',
            stableRuns: 3,
          },
        }),
      },
    ],
    usage: usage(
      SDD.filter((s) => s !== "approve" && s !== "checks"),
      ["provider/model-b", "gpt-5.1"],
    ),
  };
}

// --- theme-contrast: waits for a manual observation --------------------------------------------

function themeContrast(): MockRun {
  const runId = "run-theme-contrast";
  const log = new Log(runId, 50);
  log.add("run.created", { featureId: "theme-contrast" }, 0);
  for (const id of [
    "research",
    "specify",
    "plan",
    "analyze",
    "approve",
    "implement",
    "checks",
    "review",
  ])
    log.stage(id, id === "approve" || id === "checks" ? null : "provider/model-b", "completed", 60);
  log.stage("converge", "claude-opus-5-5", "waiting");
  log.add(
    "criterion.assessed",
    { criterionId: "AC-001", snapshotId: "snap-1", verdict: "pass" },
    3,
  );
  log.add(
    "request.created",
    { requestId: "req-tc-manual", kind: "manual_evidence", digest: DIGEST },
    2,
  );
  log.add(
    "run.state_changed",
    { from: "running", to: "waiting", reason: "manual_evidence", revision: 22 },
    1,
  );
  const spec: Spec = {
    title: "Readable captions in both themes",
    problem: "Captions are too faint.",
    outcome: "Captions meet 4.5:1 and feel instant to switch.",
    inScope: ["Caption tokens"],
    outOfScope: [],
    requirements: [
      {
        id: "NFR-001",
        text: "Caption contrast is at least 4.5:1.",
        priority: "must",
        verification: "automated",
      },
      {
        id: "NFR-002",
        text: "Switching themes feels instant on a slow machine.",
        priority: "should",
        verification: "manual",
      },
    ],
    criteria: [
      {
        id: "AC-001",
        requirementIds: ["NFR-001"],
        given: "either theme",
        when: "captions render",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "contrast is at least 4.5:1",
        method: "automated",
      },
      {
        id: "AC-002",
        requirementIds: ["NFR-002"],
        given: "a slow machine",
        when: "the theme toggles",
        // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the spec criterion contract.
        then: "the change feels instant",
        method: "manual",
      },
    ],
  };
  return {
    runId,
    featureId: "theme-contrast",
    status: "waiting",
    reason: "manual_evidence",
    stageId: "converge",
    revision: 22,
    tokenUsage: 238_000,
    activeMs: 1_560_000,
    events: log.events,
    artifacts: [
      artifact(runId, 1, "spec.json", "spec", spec),
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(400_000, 200_000, 320_000)),
    ],
    requests: [
      {
        id: "req-tc-manual",
        kind: "manual_evidence",
        status: "pending",
        digest: DIGEST,
        body_json: JSON.stringify({
          criterionId: "AC-002",
          question: "Does the toggle feel instant?",
        }),
      },
    ],
    usage: usage(["research", "specify", "plan", "review", "converge"], ["provider/model-b"]),
  };
}

// --- locale-validation: stopped on its budget ---------------------------------------------------

function localeValidation(): MockRun {
  const runId = "run-locale-validation";
  const log = new Log(runId, 300);
  log.add("run.created", { featureId: "locale-validation" }, 0);
  for (const id of ["research", "specify", "plan", "analyze", "approve", "implement", "checks"])
    log.stage(
      id,
      id === "approve" || id === "checks" ? null : "provider/model-b",
      "completed",
      200,
    );
  log.stage("review", "gpt-5.1", "running");
  log.add(
    "run.state_changed",
    { from: "running", to: "blocked", reason: "budget_exhausted", revision: 18 },
    60,
  );
  return {
    runId,
    featureId: "locale-validation",
    status: "blocked",
    reason: "budget_exhausted",
    stageId: "review",
    revision: 18,
    tokenUsage: 598_000,
    activeMs: 2_900_000,
    events: log.events,
    artifacts: [
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(600_000, 300_000, 520_000)),
      artifact(runId, 5, "routing.json", "routing", {
        schemaVersion: 1,
        runModel: "provider/model-b",
        profiles: {},
        stages: { review: { model: "gpt-5.1", source: "route override review" } },
      }),
    ],
    requests: [],
    usage: usage(
      ["research", "specify", "plan", "implement", "review"],
      ["provider/model-b", "gpt-5.1"],
    ),
  };
}

const worktreeOf = (runId: string): RunWorktree => ({
  path: `.baked/worktrees/${runId}/main`,
  branch: `baked/wf/${runId}`,
  present: true,
});

/** A worktree run whose migration command was interrupted: it waits for a recovery decision. */
function cacheWarmup(): MockRun {
  const runId = "run-cache-warmup";
  const log = new Log(runId, 90);
  log.add("run.created", { featureId: "cache-warmup" }, 0);
  for (const id of ["research", "specify", "plan", "analyze", "approve"])
    log.stage(id, id === "approve" ? null : "provider/model-b", "completed", 120);
  log.stage("implement", "provider/model-b", "running");
  log.add("request.created", { requestId: "req-cache-recovery", kind: "recovery", digest: DIGEST });
  log.add(
    "run.state_changed",
    { from: "running", to: "waiting", reason: "interrupted_effect", revision: 14 },
    5,
  );
  return {
    runId,
    featureId: "cache-warmup",
    status: "waiting",
    reason: "interrupted_effect",
    stageId: "implement",
    revision: 14,
    tokenUsage: 312_000,
    activeMs: 1_500_000,
    events: log.events,
    artifacts: [
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(600_000, 300_000, 520_000)),
    ],
    requests: [
      {
        id: "req-cache-recovery",
        kind: "recovery",
        status: "pending",
        digest: DIGEST,
        body_json: JSON.stringify({
          effectId: "eff-cache-migrate",
          intent: { kind: "command", command: "bun run db:migrate", root: worktreeOf(runId).path },
        }),
      },
    ],
    usage: usage(["research", "specify", "plan", "implement"], ["provider/model-b"]),
    worktree: worktreeOf(runId),
  };
}

/** A worktree run that failed its checks; its worktree is still on disk. */
function exportCsv(): MockRun {
  const runId = "run-export-csv";
  const log = new Log(runId, 600);
  log.add("run.created", { featureId: "export-csv" }, 0);
  for (const id of ["research", "specify", "plan", "analyze", "approve", "implement"])
    log.stage(id, id === "approve" ? null : "provider/model-b", "completed", 150);
  log.stage("checks", null, "failed");
  log.add(
    "run.state_changed",
    { from: "running", to: "failed", reason: "checks_failed", revision: 21 },
    5,
  );
  return {
    runId,
    featureId: "export-csv",
    status: "failed",
    reason: "checks_failed",
    stageId: "checks",
    revision: 21,
    tokenUsage: 455_000,
    activeMs: 2_100_000,
    events: log.events,
    artifacts: [
      artifact(runId, 4, "estimates/start.json", "estimate", estimate(600_000, 300_000, 520_000)),
    ],
    requests: [],
    usage: usage(["research", "specify", "plan", "implement"], ["provider/model-b"]),
    worktree: worktreeOf(runId),
  };
}

let state: MockRun[] | null = null;
const all = (): MockRun[] => {
  state ??= [
    usageTotals(),
    headlessJson(),
    settingsDarkMode(),
    themeContrast(),
    localeValidation(),
    cacheWarmup(),
    exportCsv(),
  ];
  return state;
};
const find = (runId: string): MockRun | undefined => all().find((r) => r.runId === runId);

function snapshot(run: MockRun) {
  return {
    runId: run.runId,
    featureId: run.featureId,
    status: run.status,
    reason: run.reason,
    revision: run.revision,
    eventSeq: run.events.at(-1)?.seq ?? 0,
    stageId: run.stageId,
    approvalDigest: null,
    tokenUsage: run.tokenUsage,
    activeMs: run.activeMs,
    estimatedCostUsd: run.tokenUsage / 330_000,
    pendingRequestIds: run.requests.filter((r) => r.status === "pending").map((r) => r.id),
  };
}

function append<K extends EventType>(run: MockRun, type: K, payload: EventPayloads[K]): void {
  run.events.push({
    seq: (run.events.at(-1)?.seq ?? 0) + 1,
    at: new Date().toISOString(),
    runId: run.runId,
    type,
    payload,
  } as WorkflowEvent);
}

function setStatus(run: MockRun, to: RunState, reason = "none"): void {
  append(run, "run.state_changed", { from: run.status, to, reason, revision: run.revision + 1 });
  run.status = to;
  run.reason = reason;
  run.revision++;
}

function decide(run: MockRun, body: { requestId?: string }, status: string): void {
  const request = run.requests.find((r) => r.id === body.requestId);
  if (!request) return;
  request.status = status;
  append(run, "request.decided", { requestId: request.id, status, actor: "user" });
  run.revision++;
  if (request.body_json?.includes('"acceptance"')) return;
  if (run.status === "waiting") setStatus(run, "paused", "none");
}

const ENDED: readonly RunState[] = ["completed", "failed", "cancelled"];

/**
 * An instruction file the given runs froze was saved: the runs that are driving stop as blocked
 * with `input_changed`, as the backend does at their next step, and the others are marked so
 * that resuming them is refused until the plan is revised. Returns the runs that have not ended.
 */
export function freezeInputChanged(key: string, runIds: readonly string[]): string[] {
  if (key !== PROJECT) return [];
  const affected = all().filter((r) => runIds.includes(r.runId) && !ENDED.includes(r.status));
  for (const run of affected) {
    if (run.status === "running") setStatus(run, "blocked", "input_changed");
    else run.inputChanged = true;
  }
  return affected.map((r) => r.runId);
}

/** IDs of the sample runs that have not ended. */
export function activeRunIds(key: string): string[] {
  return key === PROJECT
    ? all()
        .filter((r) => !ENDED.includes(r.status))
        .map((r) => r.runId)
    : [];
}

/** A new sample run from this one's spec and plan, waiting to start like a fork of the backend. */
function forkOf(parent: MockRun): MockRun {
  const runs = all();
  let n = 1;
  while (runs.some((r) => r.runId === `${parent.runId}-fork-${n}`)) n++;
  const runId = `${parent.runId}-fork-${n}`;
  const log = new Log(runId, 0);
  log.add("run.created", { featureId: parent.featureId }, 0);
  const run: MockRun = {
    runId,
    featureId: parent.featureId,
    status: "created",
    reason: "none",
    stageId: null,
    revision: 1,
    tokenUsage: 0,
    activeMs: 0,
    events: log.events,
    artifacts: [...parent.artifacts],
    requests: [],
    usage: usage([], []),
    worktree: null,
  };
  runs.unshift(run);
  return run;
}

/**
 * A run the New run form started (`POST /v1/workflow/runs` in the start fixtures), so its detail
 * page opens like the sample runs. Only the BAKED sample project has run details.
 */
export function addStartedRun(key: string, runId: string, featureId: string, stageId: string) {
  if (key !== PROJECT || find(runId)) return;
  const log = new Log(runId, 0);
  log.add("run.created", { featureId }, 0);
  log.stage(stageId, "provider/model-b", "running");
  all().unshift({
    runId,
    featureId,
    status: "running",
    reason: "none",
    stageId,
    revision: 1,
    tokenUsage: 0,
    activeMs: 0,
    events: log.events,
    artifacts: [],
    requests: [],
    usage: usage([], []),
    worktree: null,
  });
}

const conflict = (code: string, message: string) => response(409, { error: { code, message } });

/** A run action on the sample runs: changes their state the way the backend would, roughly. */
function mutate(run: MockRun, action: string, body: { requestId?: string; tokens?: number }) {
  switch (action) {
    case "candidate":
      // Adopts the current instruction files; the hash only has to look like one.
      return response(200, {
        candidateHash: run.runId
          .padEnd(64, "0")
          .replace(/[^0-9a-f]/g, "a")
          .slice(0, 64),
        reportArtifactId: `art-candidate-${run.revision}`,
      });
    case "revise":
      if (ENDED.includes(run.status) || run.status === "running")
        return conflict("RUN_TERMINAL", "Only a stopped run can be revised");
      run.inputChanged = false;
      setStatus(run, "waiting", "approval");
      break;
    case "approve":
      decide(run, body, "accepted");
      if (run.stageId === "approve") {
        append(run, "stage.finished", {
          stepId: "step-approve",
          status: "completed",
          artifactId: null,
        });
        run.stageId = "implement";
      }
      break;
    case "reject":
      decide(run, body, "rejected");
      break;
    case "answer":
    case "evidence":
    case "continue":
    case "accept":
    case "recover":
      decide(run, body, "accepted");
      break;
    case "fork":
      if (!ENDED.includes(run.status) && run.status !== "blocked")
        return conflict("STALE_DECISION", "Only a blocked or ended run can be forked");
      return response(200, snapshot(forkOf(run)));
    case "discard-worktree":
      if (!ENDED.includes(run.status))
        return conflict(
          "STALE_DECISION",
          `Only a completed, failed or cancelled run's worktree can be discarded; run ${run.runId} is ${run.status}. Cancel it first.`,
        );
      if (!run.worktree?.present)
        return response(404, {
          error: { code: "NOT_FOUND", message: `Run ${run.runId} has no worktree to discard` },
        });
      run.worktree = { ...run.worktree, present: false };
      run.revision++;
      break;
    case "resume":
      if (run.inputChanged || run.reason === "input_changed")
        return conflict("INPUT_CHANGED", "An input of this run changed; revise its plan first");
      if (run.status !== "running") setStatus(run, "running");
      if (
        run.stageId === "implement" &&
        !run.events.some((e) => e.type === "stage.started" && e.payload.stageId === "implement")
      )
        append(run, "stage.started", {
          stepId: "step-implement",
          stageId: "implement",
          generation: 0,
        });
      break;
    case "pause":
      setStatus(run, "paused", "user_pause");
      break;
    case "undo": {
      if (run.status === "created" || run.status === "running")
        return conflict("RUN_ACTIVE", "Undo needs a run that is not executing; pause it first");
      // The first undo restores the sample edits; later ones find nothing left to undo.
      if (run.artifacts.some((a) => a.entry.kind === "workspace-rollback")) break;
      run.artifacts.push(
        artifact(run.runId, run.artifacts.length + 1, "rollbacks/undo.json", "workspace-rollback", {
          reason: "undo",
          effectIds: ["eff-1", "eff-2", "eff-3"],
          restored: [
            { path: "src/core/workflows/usage.ts", from: DIGEST, to: DIGEST, keptAs: null },
            { path: "tests/usage-totals.test.ts", from: DIGEST, to: null, keptAs: null },
          ],
          kept: [{ path: "src/headless/report.ts", reason: "changed after the run wrote it" }],
        }),
      );
      break;
    }
    case "cancel":
      setStatus(run, "cancelled");
      break;
    case "reroute": {
      if (run.status === "running" || ENDED.includes(run.status))
        return conflict("WORKSPACE_BUSY", "Pause the run before switching its models");
      const model = (body as { model?: string }).model;
      const found = run.artifacts.find((a) => a.entry.path === "routing.json");
      if (!model || !found) break;
      const record = JSON.parse(found.content) as { runModel: string };
      const next = artifact(run.runId, run.artifacts.length + 1, "routing.json", "routing", {
        ...record,
        runModel: model,
      });
      next.entry.revision = found.entry.revision + 1;
      run.artifacts.push(next);
      append(run, "run.rerouted", {
        artifactId: next.entry.id,
        runModel: { from: record.runModel, to: model },
        changes: [],
      });
      run.revision += 1;
      break;
    }
    case "extend":
      if (run.status !== "blocked" || run.reason !== "budget_exhausted")
        return response(409, {
          error: {
            code: "STALE_DECISION",
            message: "Only a run that stopped on its budget can be extended",
          },
        });
      setStatus(run, "paused");
      break;
    default:
      return undefined;
  }
  return response(200, snapshot(run));
}

interface GcBody {
  before: string;
  dryRun?: boolean;
}
interface ImportBody {
  source: string;
  path: string;
  featureId: string;
}
interface RedactBody {
  artifactId: string;
  reason: string;
}

const invalid = (message: string) =>
  response(400, { error: { code: "INVALID_DEFINITION", message } });

/** Ended runs older than 30 days and the cutoff; the sample runs are all recent. */
function gc(body: GcBody) {
  const cutoff = Date.parse(body.before);
  if (!Number.isFinite(cutoff)) return invalid("Expected an ISO date for retention");
  const threshold = Math.min(cutoff, Date.now() - 30 * 86_400_000);
  const old = all().filter(
    (r) => ENDED.includes(r.status) && Date.parse(r.events.at(-1)?.at ?? "") < threshold,
  );
  if (!body.dryRun) state = all().filter((r) => !old.includes(r));
  return response(200, {
    runIds: old.map((r) => r.runId),
    bytes: old.reduce((sum, r) => sum + r.artifacts.reduce((n, a) => n + a.entry.bytes, 0), 0),
  });
}

function importCandidate(body: ImportBody) {
  if (!body.path.trim()) return invalid("Import source must be a local directory without symlinks");
  return response(200, {
    candidateHash: DIGEST,
    warnings:
      body.source === "spec-kit"
        ? [
            "Markdown imported as a draft. A spec-author must map requirements and Given/When/Then criteria to SpecSchema before acceptance.",
          ]
        : [],
    unsupported: [],
  });
}

function redact(run: MockRun, body: RedactBody) {
  if (!body.reason?.trim()) return invalid("Redaction reason is required");
  const target = run.artifacts.find((a) => a.entry.id === body.artifactId);
  if (!target || target.entry.kind === "state")
    return invalid("Select a content artifact for redaction");
  target.content = "[redacted]";
  run.artifacts.push(
    artifact(
      run.runId,
      run.artifacts.length + 1,
      `redactions/${body.artifactId}.json`,
      "redaction",
      {
        artifactId: body.artifactId,
        hash: target.entry.hash,
        reason: body.reason,
      },
    ),
  );
  return response(200, { redacted: true });
}

/** A short stand-in for `runReport` (src/core/workflows/run-report.ts). */
function mockReport(run: MockRun): string {
  return [
    `# ${run.featureId}`,
    "",
    `Run \`${run.runId}\` · status **${run.status}**`,
    "",
    "## Usage",
    "",
    `${run.tokenUsage.toLocaleString("en-US")} tokens.`,
    "",
    "| Stage | Attempts | Tokens |",
    "| --- | --- | --- |",
    ...run.usage.stages.map((s) => `| ${s.stage} | ${s.attempts} | ${s.tokens} |`),
    "",
    "## Artifacts",
    "",
    ...run.artifacts.map((a) => `- \`${a.entry.path}\` (${a.entry.kind})`),
    "",
  ].join("\n");
}

/** `GET /v1/workflow/compare`: run A on the default routes, B with its stages routed elsewhere. */
function mockCompare(a: MockRun, b: MockRun): RunComparison {
  const side = (run: MockRun, model: string): ComparedRun => ({
    runId: run.runId,
    featureId: run.featureId,
    workflowId: "sdd",
    status: run.status,
    reason: run.reason,
    routes: [{ target: "run", model }],
    tokens: run.tokenUsage,
    costUsd: run.tokenUsage / 330_000,
    activeMs: run.activeMs,
    agentCalls: run.usage.attempts.length,
    repairRounds: 0,
    correctiveTasks: 0,
    stages: run.usage.stages,
    models: run.usage.models.map((m) => ({ model: m.model, tokens: m.tokens })),
    checks: { passed: 3, failed: run.status === "failed" ? 1 : 0 },
    findings: { critical: 0, high: 0, medium: 1, low: 2 },
    openFindings: 0,
    limitations: 0,
  });
  const left = side(a, "provider/model-a");
  const right = side(b, "provider/model-b");
  const stages = [...new Set([...left.stages, ...right.stages].map((s) => s.stage))];
  return {
    a: left,
    b: right,
    sameFeature: a.featureId === b.featureId,
    sameWorkflow: true,
    routeDifferences: [{ target: "run", a: "provider/model-a", b: "provider/model-b" }],
    stages: stages.map((stage) => ({
      stage,
      a: left.stages.find((s) => s.stage === stage)?.tokens ?? null,
      b: right.stages.find((s) => s.stage === stage)?.tokens ?? null,
    })),
    delta: {
      tokens: right.tokens - left.tokens,
      costUsd: (right.costUsd ?? 0) - (left.costUsd ?? 0),
      activeMs: right.activeMs - left.activeMs,
    },
    markdown: `# Run comparison: ${a.runId} (A) and ${b.runId} (B)\n`,
  };
}

const runRoutes: MockRoute = ({ key, method, path, query, body }) => {
  if (key !== PROJECT) return undefined;
  if (method === "GET" && path === "/v1/workflow/runs") {
    const status = query.get("status");
    return response(200, {
      items: all()
        .filter((r) => !status || r.status === status)
        .map(snapshot),
    });
  }
  // Workflow definitions come from the start screen's fixtures, which carry the full summary
  // (problems, execution) the New run form reads; their `sdd` stages match `SDD`.
  if (method === "GET" && path === "/v1/workflow/compare") {
    const a = find(query.get("a") ?? "");
    const b = find(query.get("b") ?? "");
    if (!a || !b)
      return response(404, { error: { code: "NOT_FOUND", message: "No such run in the mock" } });
    return response(200, mockCompare(a, b));
  }
  if (method === "POST" && path === "/v1/workflow/gc") return gc(body as GcBody);
  if (method === "POST" && path === "/v1/workflow/import")
    return importCandidate(body as ImportBody);
  const match = /^\/v1\/workflow\/runs\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  const run = match?.[1] ? find(decodeURIComponent(match[1])) : undefined;
  if (!match || !run) return undefined;
  const action = match[2];
  if (method === "POST" && action === "export")
    return response(200, {
      path: `C:\\Project\\BAKED\\.baked\\exports\\${run.runId}-${Date.now()}`,
      manifestHash: DIGEST,
    });
  if (method === "POST" && action === "redact") return redact(run, body as RedactBody);
  if (method === "POST" && action)
    return mutate(run, action, (body ?? {}) as { requestId?: string; tokens?: number });
  if (method !== "GET") return undefined;
  switch (action) {
    case undefined:
      return response<RunDetailStatus>(200, {
        ...snapshot(run),
        requests: run.requests,
        worktree: run.worktree ?? null,
      });
    case "usage":
      return response(200, run.usage);
    case "report":
      return response(200, { runId: run.runId, markdown: mockReport(run) });
    case "artifacts": {
      const file = query.get("file");
      if (!file)
        return response(
          200,
          run.artifacts.map((a) => a.entry),
        );
      const found = run.artifacts.find((a) => a.entry.id === file);
      return found
        ? response(200, { content: found.content })
        : response(404, { error: { code: "ARTIFACT_MISSING", message: "No such artifact" } });
    }
    case "events": {
      const after = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 200);
      const events = run.events.filter((e) => e.seq > after).slice(0, limit);
      return response(200, { events, lastSeq: events.at(-1)?.seq ?? after });
    }
    default:
      return undefined;
  }
};

const LIVE_INTERVAL_MS = 4000;

/** Streams a sample run's new events; headless-json also makes progress while it is watched. */
const runEvents: MockStream = ({ key, path, emit }) => {
  const match = /^\/v1\/workflow\/runs\/([^/]+)\/events$/.exec(path);
  const run = key === PROJECT && match?.[1] ? find(decodeURIComponent(match[1])) : undefined;
  if (!run) return undefined;
  let sent = run.events.at(-1)?.seq ?? 0;
  const timer = setInterval(() => {
    if (run.runId === "run-headless-json" && run.status === "running") {
      const next = HEADLESS_LIVE.shift();
      if (next) {
        append(run, next.type, next.payload as EventPayloads[typeof next.type]);
        run.tokenUsage += 9_000;
        append(run, "budget.updated", {
          usedTokens: run.tokenUsage,
          reservedTokens: 0,
          activeMs: run.activeMs,
          estimatedCostUsd: run.tokenUsage / 330_000,
        });
      }
    }
    for (const event of run.events.filter((e) => e.seq > sent)) {
      emit({ id: String(event.seq), event: "message", data: JSON.stringify(event) });
      sent = event.seq;
    }
  }, LIVE_INTERVAL_MS);
  return () => clearInterval(timer);
};

export const RUN_ROUTES: MockRoute[] = [runRoutes];
export const RUN_STREAMS: MockStream[] = [runEvents];

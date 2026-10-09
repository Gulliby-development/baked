/**
 * The AI acceptance gate at run time (workflow v2 design, section 9.3): a model walks the
 * scenario through the terminal driver, a second profile writes a deterministic test, the host
 * runs that test without a model, and a person decides whether it is promoted to a command gate.
 * The walk-through is advisory: nothing here can close a required gate.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { scopedProcesses } from "../../platform/index.js";
import { buildSafeEnv } from "../../spawn.js";
import { canonical, hashBytes, hashJson } from "../../specs/hash.js";
import { workspacePath } from "../../specs/validate.js";
import { changedPaths, sourceManifest } from "../../verification/snapshot.js";
import { fileHash } from "../effects.js";
import { WorkflowFault } from "../errors.js";
import { leaseOwnerAlive } from "../leases.js";
import { ProcessScope } from "../process-scope.js";
import { redactSecrets } from "../redaction.js";
import {
  type AgentProfile,
  type Decision,
  generatedPaths,
  PolicySchema,
  type RunPolicy,
  type WorkflowEvent,
} from "../schemas.js";
import type { RequestRow, WorkflowStore } from "../store.js";
import type { HostTool, RuntimeState } from "../types.js";
import {
  type AcceptanceDraft,
  AcceptanceDraftSchema,
  type AcceptanceGateDefinition,
  type AcceptanceWalk,
  AcceptanceWalkSchema,
  ASSERTION_MARKER,
  draftProblems,
  expectationIds,
  failedAssertions,
  forbiddenConstructs,
  isAcceptanceRequest,
  promotedGate,
  StepInputSchema,
  stabilityProblems,
  testCommand,
  walkProblems,
  walkVerdict,
} from "./acceptance.js";
import { GateSchema } from "./definition.js";
import { confirmGates, loadGateLibrary } from "./library.js";
import { listenerViolations, listeningSockets, TerminalApp } from "./terminal-driver.js";

/** A flaky or wrong test goes back to the writer at most this many times. */
export const MAX_REWRITES = 2;
const MAX_STEPS = 60;
const FRAME_LINES = 40;
const READ_LIMIT = 8000;
const PORT_POLL_MS = 200;

type AcceptanceEntry = RuntimeState["acceptance"][string];
type PhaseName = Extract<WorkflowEvent, { type: "acceptance.phase" }>["payload"]["phase"];
export interface AcceptanceGateResult {
  status: "passed" | "failed" | "inconclusive" | "skipped";
  evidenceId: string | null;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escape sequences needs ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Terminal text as evidence: escape sequences removed, known secrets masked. */
const clean = (text: string): string =>
  redactSecrets(text.replace(ANSI, "").replaceAll("\r\n", "\n"));
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The safe environment plus the declared names; the walk-through also gets its granted ports. */
function appEnv(names: readonly string[], ports: readonly number[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = buildSafeEnv();
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (ports.length) {
    env.PORT = String(ports[0]);
    env.BAKED_ACCEPTANCE_PORTS = ports.join(",");
  }
  return env;
}
const resolveExecutable = (executable: string): string =>
  executable === "bun" ? process.execPath : executable;

/** Logical path of the steps an attempt recorded. */
export const stepPrefix = (gateId: string, attemptId: string): string =>
  `acceptance/${gateId}/${attemptId}/steps/`;

export interface WalkStep {
  stepId: string;
  attemptId: string;
  gateId: string;
  action: string;
  observation: string;
  expectationIds: string[];
  /** The last lines of the terminal when the step was recorded. */
  frame: string;
  exit: { exitCode: number | null; signal: string | null } | null;
}

/**
 * One attempt of the walk-through model: the application it may start, the tools it gets and the
 * steps it recorded. The host closes it; a closed session stops the application's process group.
 */
export class WalkSession {
  readonly violations: string[] = [];
  private recorded: string[] = [];
  private app: TerminalApp | null = null;
  private monitor: ReturnType<typeof setInterval> | null = null;
  private effects: string[] = [];
  constructor(
    private store: WorkflowStore,
    private runId: string,
    readonly attemptId: string,
    private gate: AcceptanceGateDefinition,
    private workspace: string,
    private signal: AbortSignal,
  ) {}
  get stepIds(): Set<string> {
    return new Set(this.recorded);
  }
  tools(): Record<string, HostTool> {
    return {
      app_start: {
        description:
          "Start the application with its declared command (no arguments can be added) and wait for its readiness signal.",
        inputSchema: z.object({}).strict(),
        execute: () => this.start(),
      },
      app_stop: {
        description: "Stop the application and every process it started.",
        inputSchema: z.object({}).strict(),
        execute: async () => ({ exit: await this.stopApp() }),
      },
      terminal_send: {
        description:
          "Write text to the application's standard input. enter (default true) appends a newline; eof closes the input afterwards.",
        inputSchema: z
          .object({
            text: z.string().max(8000),
            enter: z.boolean().optional(),
            eof: z.boolean().optional(),
          })
          .strict(),
        execute: async (input) => {
          const { text, enter, eof } = input as { text: string; enter?: boolean; eof?: boolean };
          const app = this.running();
          if (!app.send(enter === false ? text : `${text}\n`))
            throw new WorkflowFault("OUTPUT_INVALID", "The application no longer reads its input");
          if (eof) app.closeInput();
          return { sent: true };
        },
      },
      terminal_read: {
        description:
          "Read the output since the previous read, waiting up to waitMs (default 1000) for any output, or for the text in until.",
        inputSchema: z
          .object({
            waitMs: z.number().int().min(0).max(15000).optional(),
            until: z.string().min(1).max(200).optional(),
          })
          .strict(),
        execute: async (input) => {
          const { waitMs, until } = input as { waitMs?: number; until?: string };
          const app = this.app;
          if (!app) throw new WorkflowFault("OUTPUT_INVALID", "Start the application first");
          const read = await app.read(waitMs ?? 1000, until, this.signal);
          return { output: clean(read.output).slice(-READ_LIMIT), exit: read.exit };
        },
      },
      record_step: {
        description:
          "Record the action you took and what you observed, with the expectations (E1, E2, ...) it concerns. Returns the step ID to cite in the result.",
        inputSchema: StepInputSchema,
        execute: async (input) => this.record(StepInputSchema.parse(input)),
      },
    };
  }
  private running(): TerminalApp {
    if (!this.app || this.app.exited)
      throw new WorkflowFault("OUTPUT_INVALID", "The application is not running");
    return this.app;
  }
  private async start(): Promise<unknown> {
    const { start, capabilities, driver } = this.gate.acceptance;
    if (driver !== "terminal")
      throw new WorkflowFault("CAPABILITY_DENIED", `The ${driver} driver is not available`);
    if (!capabilities.spawnApp) {
      this.violations.push("app_start was refused: spawnApp is not granted");
      throw new WorkflowFault("CAPABILITY_DENIED", "spawnApp is not granted to this walk-through");
    }
    if (this.app && !this.app.exited)
      throw new WorkflowFault("OUTPUT_INVALID", "The application is already running");
    const cwd = start.cwd === "." ? this.workspace : workspacePath(this.workspace, start.cwd);
    const effectId = this.store.transaction(() =>
      this.store.prepareEffect(
        this.runId,
        this.attemptId,
        "command",
        { acceptanceGateId: this.gate.id, executable: start.executable, args: start.args },
        null,
        null,
      ),
    );
    this.effects.push(effectId);
    const app = new TerminalApp(resolveExecutable(start.executable), start.args, {
      cwd,
      env: appEnv(start.envNames, capabilities.listenPorts),
      onSpawn: (pid, scope) =>
        this.store.transaction(() => this.store.recordProcess(this.runId, effectId, pid, scope)),
    });
    this.app = app;
    try {
      await app.start();
    } catch (error) {
      throw new WorkflowFault("OUTPUT_INVALID", `The application did not start: ${message(error)}`);
    }
    this.watchPorts();
    const ready = await this.ready(app);
    return { started: true, ready, output: clean(app.frame(FRAME_LINES)), exit: app.exited };
  }
  private async ready(app: TerminalApp): Promise<boolean> {
    const { readyWhen } = this.gate.acceptance.start;
    const limit = Math.min(this.gate.timeoutMs, 60000);
    if (readyWhen.logIncludes) {
      const text = readyWhen.logIncludes;
      return app.waitFor(() => app.includes(text), limit, this.signal);
    }
    if (readyWhen.url) {
      const url = new URL(readyWhen.url);
      // The terminal driver has no outbound grant; only a loopback readiness URL is polled.
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new WorkflowFault("CAPABILITY_DENIED", "A readiness URL must be on loopback");
      const deadline = Date.now() + limit;
      while (Date.now() < deadline && !app.exited && !this.signal.aborted) {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
          if (response.status < 500) return true;
        } catch {
          // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    }
    return true;
  }
  /** Compares the listening sockets of the process tree with the grant while the app runs. */
  private watchPorts(): void {
    if (this.monitor) return;
    const granted = this.gate.acceptance.capabilities.listenPorts;
    this.monitor = setInterval(() => {
      const app = this.app;
      if (!app || app.exited) return;
      const sockets = listeningSockets(app.pids());
      if (!sockets) return;
      const problems = listenerViolations(sockets, granted).filter(
        (p) => !this.violations.includes(p),
      );
      if (!problems.length) return;
      this.violations.push(...problems);
      void app.stop();
    }, PORT_POLL_MS);
  }
  private async stopApp(): Promise<unknown> {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    const exit = (await this.app?.stop()) ?? null;
    this.store.transaction(() => {
      for (const id of this.effects.splice(0))
        this.store.effectStatus(this.runId, id, "reconciled");
    });
    return exit;
  }
  private record(input: z.infer<typeof StepInputSchema>): { stepId: string } {
    const known = expectationIds(this.gate);
    const unknown = input.expectationIds.filter((id) => !known.includes(id));
    if (unknown.length)
      throw new WorkflowFault(
        "OUTPUT_INVALID",
        `Unknown expectations ${unknown.join(", ")}; the scenario has ${known.join(", ")}`,
      );
    if (this.recorded.length >= MAX_STEPS)
      throw new WorkflowFault(
        "BUDGET_EXHAUSTED",
        `A walk-through records at most ${MAX_STEPS} steps`,
      );
    const stepId = `S${this.recorded.length + 1}`;
    const step: WalkStep = {
      stepId,
      attemptId: this.attemptId,
      gateId: this.gate.id,
      action: input.action,
      observation: input.observation,
      expectationIds: input.expectationIds,
      frame: clean(this.app?.frame(FRAME_LINES) ?? ""),
      exit: this.app?.exited ?? null,
    };
    this.store.transaction(() =>
      this.store.artifact(
        this.runId,
        "acceptance-step",
        `${stepPrefix(this.gate.id, this.attemptId)}${stepId}.json`,
        canonical(step),
      ),
    );
    this.recorded.push(stepId);
    return { stepId };
  }
  async close(): Promise<void> {
    await this.stopApp();
  }
}

/** The steps of an attempt as the store holds them; this is what a cited step ID must name. */
export function recordedSteps(
  store: WorkflowStore,
  runId: string,
  gateId: string,
  attemptId: string,
): WalkStep[] {
  const prefix = stepPrefix(gateId, attemptId);
  return store
    .artifacts(runId)
    .filter((a) => a.kind === "acceptance-step" && a.logical_path.startsWith(prefix))
    .map((a) => JSON.parse(store.readArtifact(runId, a.id)) as WalkStep)
    .filter((step) => step.attemptId === attemptId && step.gateId === gateId);
}

/** The writer's only write: the declared test path. */
export function writerTools(
  gate: AcceptanceGateDefinition,
  workspace: string,
  onWrite: () => void,
): Record<string, HostTool> {
  const testPath = gate.acceptance.promote.testPath;
  return {
    write_test: {
      description: `Write the complete test file at ${testPath}. It replaces any earlier content.`,
      inputSchema: z
        .object({
          content: z
            .string()
            .min(1)
            .max(256 * 1024),
        })
        .strict(),
      execute: async (input) => {
        const { content } = input as { content: string };
        const path = workspacePath(workspace, testPath);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
        onWrite();
        return { path: testPath, hash: hashBytes(content) };
      },
    },
  };
}

export interface TestRun {
  exitCode: number | null;
  timedOut: boolean;
  failed: string[];
  violations: string[];
  output: string;
}

/**
 * Runs the generated test once without a model, as its promoted command gate would: no shell, the
 * safe environment, the gate's timeout. Writes outside the granted paths and listeners outside the
 * granted ports are violations.
 */
export async function runTestOnce(
  workspace: string,
  gate: AcceptanceGateDefinition,
  policy: RunPolicy,
  signal: AbortSignal,
): Promise<TestRun> {
  const excluded = [...generatedPaths(policy), ...gate.acceptance.capabilities.writePaths];
  const before = await sourceManifest(workspace, excluded, signal);
  const command = testCommand(gate.acceptance.promote.testPath);
  const scope = new ProcessScope();
  const violations: string[] = [];
  let monitor: ReturnType<typeof setInterval> | null = null;
  let result: Awaited<ReturnType<ProcessScope["execute"]>>;
  try {
    result = await scope.execute(resolveExecutable(command.executable), command.args, {
      cwd: workspace,
      env: appEnv(gate.acceptance.start.envNames),
      timeoutMs: gate.timeoutMs,
      signal,
      onSpawn: (pid, marker) => {
        monitor = setInterval(() => {
          const sockets = listeningSockets([pid, ...(scopedProcesses(marker) ?? [])]);
          if (!sockets) return;
          for (const problem of listenerViolations(
            sockets,
            gate.acceptance.capabilities.listenPorts,
          ))
            if (!violations.includes(problem)) violations.push(problem);
        }, PORT_POLL_MS);
      },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    result = {
      exitCode: null,
      signal: null,
      output: message(error),
      timedOut: false,
      cancelled: false,
      truncated: false,
      durationMs: 0,
    };
  } finally {
    if (monitor) clearInterval(monitor);
    await scope.stop();
  }
  const after = await sourceManifest(workspace, excluded);
  const changed = changedPaths(before, after);
  if (changed.length)
    violations.push(`the test changed ${changed.join(", ")} outside the granted write paths`);
  const output = clean(result.output);
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    failed: failedAssertions(output),
    violations,
    output: output.trimEnd().split("\n").slice(-FRAME_LINES).join("\n"),
  };
}

/** What the scheduler lends the gate: the store, the run and a way to call a profile. */
export interface AcceptanceHost {
  store: WorkflowStore;
  runId: string;
  state: RuntimeState;
  policy: RunPolicy;
  transitionId: string | null;
  signal: AbortSignal;
  profile(id: string): AgentProfile | undefined;
  callAgent(
    profile: AgentProfile,
    extra: unknown,
    validate: (output: unknown) => string[],
    tools: (attemptId: string) => Record<string, HostTool>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

const statusOf = (entry: AcceptanceEntry): AcceptanceGateResult["status"] =>
  entry.phase === "skipped"
    ? "skipped"
    : entry.verdict === "passed"
      ? "passed"
      : entry.verdict === "failed"
        ? "failed"
        : "inconclusive";

const AcceptanceRequestBody = z
  .object({
    gateId: z.string(),
    sourceGateHash: z.string(),
    transitionId: z.string().nullable(),
    walkAttemptId: z.string(),
    verdict: z.enum(["passed", "failed"]),
    scenario: z.string(),
    expectations: AcceptanceWalkSchema.shape.expectations,
    steps: z.array(z.unknown()),
    testPath: z.string(),
    testHash: z.string(),
    testArtifactId: z.string(),
    baseTestHash: z.string().nullable(),
    assertions: AcceptanceDraftSchema.shape.assertions,
    commandGateId: z.string(),
    stableRuns: z.number(),
    runs: z.array(z.unknown()),
  })
  .strict();
type AcceptanceRequestBody = z.infer<typeof AcceptanceRequestBody>;

/**
 * Runs one AI acceptance gate on the current snapshot, or returns the result it already has for
 * that snapshot. Returns the advisory gate result; the lifecycle is kept in `state.acceptance`.
 */
export async function runAcceptanceGate(
  host: AcceptanceHost,
  gate: AcceptanceGateDefinition,
): Promise<AcceptanceGateResult> {
  const { store, runId, state } = host;
  const workspace = store.workspace;
  const previous = state.acceptance[gate.id];
  if (previous && previous.snapshotId === state.snapshotId)
    return { status: statusOf(previous), evidenceId: previous.evidenceId };
  // A new snapshot is walked again; an open decision on the earlier test no longer applies.
  store.transaction(() => {
    for (const request of store.requests(runId))
      if (
        request.status === "pending" &&
        isAcceptanceRequest(request) &&
        (JSON.parse(request.body_json) as { acceptance: { gateId: string } }).acceptance.gateId ===
          gate.id
      )
        store.decideRequest(runId, request.id, "superseded", { snapshotId: state.snapshotId });
  });
  const phase = (name: PhaseName, detail: string | null = null): void => {
    store.transaction(() =>
      store.emit(runId, {
        type: "acceptance.phase",
        payload: { gateId: gate.id, phase: name, detail: detail ? detail.slice(0, 2000) : null },
      }),
    );
  };
  const entry: AcceptanceEntry = {
    phase: "inconclusive",
    snapshotId: state.snapshotId,
    attemptId: null,
    verdict: null,
    reason: null,
    evidenceId: null,
    requestId: null,
    testArtifactId: null,
    testHash: null,
    baseTestHash: null,
    rewrites: 0,
  };
  const finish = (
    fields: Partial<AcceptanceEntry> & Pick<AcceptanceEntry, "phase">,
  ): AcceptanceGateResult => {
    Object.assign(entry, fields);
    state.acceptance[gate.id] = { ...entry };
    store.transaction(() => store.saveState(runId, state));
    phase(entry.phase, entry.reason);
    return { status: statusOf(entry), evidenceId: entry.evidenceId };
  };

  if (gate.acceptance.driver === "browser")
    return finish({
      phase: "skipped",
      reason:
        "The browser driver is not implemented in this version; only terminal walk-throughs run.",
    });
  if (!gate.acceptance.capabilities.spawnApp)
    return finish({
      phase: "inconclusive",
      reason:
        "spawnApp is not granted, so the terminal driver cannot start the application; the walk-through did not run.",
    });
  const walker = host.profile("acceptance-walker");
  const writer = host.profile("acceptance-writer");
  if (!walker || !writer)
    return finish({ phase: "inconclusive", reason: "The acceptance profiles are not available." });

  // --- Walk ----------------------------------------------------------------------------------
  phase("walking", gate.acceptance.scenario.title);
  const excluded = generatedPaths(host.policy);
  const before = await sourceManifest(workspace, excluded, host.signal);
  const deadline = AbortSignal.any([host.signal, AbortSignal.timeout(gate.timeoutMs)]);
  const current: { session: WalkSession | null } = { session: null };
  let walk: AcceptanceWalk | null = null;
  let failure: string | null = null;
  try {
    const output = await host.callAgent(
      walker,
      { acceptance: walkBrief(gate) },
      (value) => walkProblems(gate, value as AcceptanceWalk, current.session?.stepIds ?? new Set()),
      (attemptId) => {
        void current.session?.close();
        current.session = new WalkSession(store, runId, attemptId, gate, workspace, deadline);
        return current.session.tools();
      },
      deadline,
    );
    walk = AcceptanceWalkSchema.parse(output);
  } catch (error) {
    if (host.signal.aborted) throw error;
    failure = deadline.aborted
      ? `the walk-through exceeded its timeout of ${gate.timeoutMs} ms`
      : message(error);
  } finally {
    await current.session?.close();
  }
  const session = current.session as WalkSession | null;
  const attemptId = session?.attemptId ?? null;
  const after = await sourceManifest(workspace, excluded, host.signal);
  const outside = changedPaths(before, after);
  const violations = [
    ...(session?.violations ?? []),
    ...(outside.length
      ? [`the application changed ${outside.join(", ")} outside the granted write paths`]
      : []),
  ];
  // The host checks the cited steps itself: they must be stored steps of this very attempt.
  const steps = attemptId ? recordedSteps(store, runId, gate.id, attemptId) : [];
  const problems = walk ? walkProblems(gate, walk, new Set(steps.map((s) => s.stepId))) : [];
  const verdict = walk && !problems.length && !violations.length ? walkVerdict(walk) : null;
  const evidenceId = store.transaction(() => {
    const artifact = store.artifact(
      runId,
      "acceptance",
      `acceptance/${gate.id}/${attemptId ?? "none"}/walk.json`,
      canonical({
        gateId: gate.id,
        attemptId,
        walk,
        steps,
        violations,
        problems,
        failure,
        verdict,
      }),
    );
    return state.snapshotId
      ? store.addEvidence(runId, "review", state.snapshotId, artifact.id, attemptId)
      : null;
  });
  Object.assign(entry, { attemptId, evidenceId });
  if (!walk || !verdict || verdict === "inconclusive") {
    const reason = failure
      ? `The walk-through did not finish: ${failure}`
      : violations.length
        ? `Capability violation: ${violations.join("; ")}`
        : problems.length
          ? `The walk-through result was rejected: ${problems.join("; ")}`
          : "Some expectations could not be observed.";
    return finish({ phase: "inconclusive", verdict: "inconclusive", reason });
  }
  const failing = walk.expectations.filter((e) => e.verdict === "fail");
  const summary =
    verdict === "passed"
      ? "every expectation was observed"
      : failing
          .map((e) => `${e.expectationId} failed (steps ${e.stepIds.join(", ")}): ${e.explanation}`)
          .join("; ");
  entry.verdict = verdict;
  phase("walked", `${verdict}: ${summary}`);

  // --- Draft and verify ----------------------------------------------------------------------
  const testPath = gate.acceptance.promote.testPath;
  const testFile = workspacePath(workspace, testPath);
  const baseContent = existsSync(testFile) ? readFileSync(testFile) : null;
  const baseTestHash = fileHash(testFile);
  entry.baseTestHash = baseTestHash;
  const failingIds = failing.map((e) => e.expectationId);
  let feedback: string[] = [];
  let accepted: { draft: AcceptanceDraft; content: string; runs: TestRun[] } | null = null;
  try {
    for (let round = 0; round <= MAX_REWRITES && !accepted; round++) {
      entry.rewrites = round;
      phase("drafting", round ? `rewrite ${round}: ${feedback.join("; ")}` : null);
      let written = false;
      let draft: AcceptanceDraft;
      try {
        draft = AcceptanceDraftSchema.parse(
          await host.callAgent(
            writer,
            { acceptance: draftBrief(gate, walk, steps, feedback) },
            (value) => [
              ...draftProblems(gate, value as AcceptanceDraft),
              ...(written ? [] : [`Write the test with write_test at ${testPath} first`]),
            ],
            () => writerTools(gate, workspace, () => (written = true)),
            host.signal,
          ),
        );
      } catch (error) {
        if (host.signal.aborted) throw error;
        feedback = [`The writer did not return a valid draft: ${message(error)}`];
        continue;
      }
      const content = existsSync(testFile) ? readFileSync(testFile, "utf8") : null;
      const refused = [
        ...draftProblems(gate, draft),
        ...(content === null || !written
          ? ["no test file was written"]
          : forbiddenConstructs(content, testPath).map((r) => `The test is refused: ${r}`)),
      ];
      if (refused.length || content === null) {
        feedback = refused;
        continue;
      }
      phase("verifying", `${gate.acceptance.promote.stableRuns} runs without a model`);
      const runs: TestRun[] = [];
      for (let i = 0; i < gate.acceptance.promote.stableRuns; i++)
        runs.push(await runTestOnce(workspace, gate, host.policy, host.signal));
      const mapped = draft.assertions
        .filter((a) => failingIds.includes(a.expectationId))
        .map((a) => a.assertionId);
      const unstable = stabilityProblems(verdict, runs, mapped);
      if (unstable.length) {
        feedback = unstable;
        continue;
      }
      accepted = { draft, content, runs };
    }
  } finally {
    // Until a person accepts it, the test is an artifact, not a file of the workspace.
    if (baseContent === null) {
      if (existsSync(testFile)) unlinkSync(testFile);
    } else if (fileHash(testFile) !== baseTestHash) writeFileSync(testFile, baseContent);
  }
  if (!accepted)
    return finish({
      phase: "unstable",
      reason: `No stable test after ${MAX_REWRITES} rewrites: ${feedback.join("; ")}`,
    });

  const testHash = hashBytes(accepted.content);
  const body: AcceptanceRequestBody = {
    gateId: gate.id,
    sourceGateHash: hashJson(gate),
    transitionId: host.transitionId,
    walkAttemptId: attemptId ?? "",
    verdict,
    scenario: gate.acceptance.scenario.title,
    expectations: walk.expectations,
    steps,
    testPath,
    testHash,
    testArtifactId: "",
    baseTestHash,
    assertions: accepted.draft.assertions,
    commandGateId: gate.acceptance.promote.commandGateId,
    stableRuns: gate.acceptance.promote.stableRuns,
    runs: accepted.runs.map((r) => ({ exitCode: r.exitCode, failed: r.failed })),
  };
  const requestId = store.transaction(() => {
    const artifact = store.artifact(
      runId,
      "acceptance-test",
      `acceptance/${gate.id}/${attemptId}/test/${testPath.split("/").at(-1)}`,
      accepted.content,
    );
    body.testArtifactId = artifact.id;
    store.artifact(
      runId,
      "acceptance",
      `acceptance/${gate.id}/${attemptId}/draft.json`,
      canonical({ draft: accepted.draft, testHash, runs: accepted.runs }),
    );
    return store.request(runId, "approval", hashJson(body), { acceptance: body });
  });
  return finish({
    phase: "awaiting_approval",
    requestId,
    testArtifactId: body.testArtifactId,
    testHash,
    reason: `The test reproduces the walk-through in ${gate.acceptance.promote.stableRuns} of ${gate.acceptance.promote.stableRuns} runs; a person decides whether it becomes the command gate ${gate.acceptance.promote.commandGateId}.`,
  });
}

/** What the walk-through model is told: the scenario with expectation IDs and its grants. */
function walkBrief(gate: AcceptanceGateDefinition): unknown {
  const { scenario, start, capabilities, driver } = gate.acceptance;
  return {
    gateId: gate.id,
    title: scenario.title,
    steps: scenario.steps,
    expectations: scenario.expectations.map((text, i) => ({ id: `E${i + 1}`, text })),
    driver,
    application: { command: [start.executable, ...start.args], cwd: start.cwd },
    capabilities,
    rules:
      "Every pass or fail must cite steps you recorded in this attempt. The host stops the application when you finish.",
  };
}

/** What the test writer is told: the scenario, the observed steps and why an earlier test failed. */
function draftBrief(
  gate: AcceptanceGateDefinition,
  walk: AcceptanceWalk,
  steps: WalkStep[],
  feedback: string[],
): unknown {
  const { scenario, start, promote } = gate.acceptance;
  return {
    gateId: gate.id,
    title: scenario.title,
    expectations: scenario.expectations.map((text, i) => ({ id: `E${i + 1}`, text })),
    verdicts: walk.expectations,
    steps: steps.map((s) => ({
      stepId: s.stepId,
      action: s.action,
      observation: s.observation,
      expectationIds: s.expectationIds,
      frame: s.frame,
    })),
    application: { command: [start.executable, ...start.args], cwd: start.cwd },
    testPath: promote.testPath,
    framework: promote.framework,
    runsWith: [testCommand(promote.testPath).executable, ...testCommand(promote.testPath).args],
    assertionMarker: `${ASSERTION_MARKER} <assertion ID>`,
    expectedOutcome: walk.expectations.some((e) => e.verdict === "fail")
      ? "The application is broken: the test must fail on the assertion mapped to each failed expectation, every time."
      : "The application works: the test must pass every time.",
    previousProblems: feedback,
  };
}

/**
 * Records a person's decision on a verified acceptance test, inside the caller's command
 * transaction. Accepting writes the test at its path and the command gate with its provenance
 * into the project gate library, and records the user's confirmation of that gate. The run's
 * state is not otherwise changed.
 */
export function decideAcceptance(
  store: WorkflowStore,
  runId: string,
  request: RequestRow,
  decision: Decision,
): void {
  const workspace = store.workspace;
  if (request.status !== "pending")
    throw new WorkflowFault("STALE_DECISION", `Request is ${request.status}, not pending`);
  const body = AcceptanceRequestBody.parse(
    (JSON.parse(request.body_json) as { acceptance: unknown }).acceptance,
  );
  const state = store.state(runId);
  const entry = state.acceptance[body.gateId];
  const settle = (phase: "promoted" | "discarded", reason: string): void => {
    if (entry?.requestId === request.id) {
      entry.phase = phase;
      entry.reason = reason;
    }
    store.emit(runId, {
      type: "acceptance.phase",
      payload: { gateId: body.gateId, phase, detail: reason },
    });
  };
  if (decision.kind === "reject") {
    store.decideRequest(runId, request.id, "rejected", decision);
    settle("discarded", `Rejected: ${decision.explanation}`);
    store.saveState(runId, state);
    return;
  }
  if (decision.kind !== "approve" || decision.digest !== request.digest)
    throw new WorkflowFault(
      "STALE_DECISION",
      "An acceptance test is approved with the digest of its request, or rejected",
    );
  if (store.run(runId).status === "running")
    throw new WorkflowFault("WORKSPACE_BUSY", "Promote the test while the run is not executing");
  for (const resource of ["execution", "mutation"] as const) {
    const lease = store.lease(resource);
    if (lease && leaseOwnerAlive(lease) !== false)
      throw new WorkflowFault("WORKSPACE_BUSY", "A workflow run holds the workspace");
  }
  const content = store.readArtifact(runId, body.testArtifactId);
  if (hashBytes(content) !== body.testHash)
    throw new WorkflowFault("STALE_DECISION", "The stored test does not match its hash");
  const testFile = workspacePath(workspace, body.testPath);
  const present = fileHash(testFile);
  if (present !== body.baseTestHash && present !== body.testHash)
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `${body.testPath} changed since the walk-through; walk the scenario again`,
    );
  const frozen = store.artifacts(runId).filter((a) => a.logical_path === "definition/gates.json");
  const source = GateSchema.array()
    .parse(JSON.parse(store.readArtifact(runId, frozen.at(-1)?.id ?? "")))
    .find((g) => g.id === body.gateId);
  if (source?.type !== "ai-acceptance" || hashJson(source) !== body.sourceGateHash)
    throw new WorkflowFault(
      "STALE_DECISION",
      `The source gate ${body.gateId} is not the walked one`,
    );
  const approvedAt = new Date().toISOString();
  const promoted = promotedGate(source, body.testHash, approvedAt);
  const gatePath = join(workspace, "baked", "gates", `${promoted.id}.json`);
  if (existsSync(gatePath)) {
    const existing = GateSchema.safeParse(JSON.parse(readFileSync(gatePath, "utf8")));
    if (
      !existing.success ||
      existing.data.type !== "command" ||
      existing.data.provenance?.generatedFrom !== source.id
    )
      throw new WorkflowFault(
        "STALE_DECISION",
        `The project already has a gate ${promoted.id} that this walk-through did not write`,
      );
  }
  const gateText = `${JSON.stringify(promoted, null, 2)}\n`;
  store.decideRequest(runId, request.id, "accepted", { ...decision, approvedAt });
  if (entry?.requestId === request.id) {
    // The host wrote these files on the person's decision; they are not outside changes.
    if (state.expectedFiles) {
      state.expectedFiles[body.testPath] = body.testHash;
      state.expectedFiles[`baked/gates/${promoted.id}.json`] = hashBytes(gateText);
    }
  }
  settle(
    "promoted",
    `${body.testPath} (${body.testHash.slice(0, 12)}) is the command gate ${promoted.id}`,
  );
  store.saveState(runId, state);
  // Files last: a refused decision above leaves the workspace unchanged.
  mkdirSync(dirname(testFile), { recursive: true });
  writeFileSync(testFile, content);
  mkdirSync(dirname(gatePath), { recursive: true });
  writeFileSync(gatePath, gateText);
  const policy = PolicySchema.parse(JSON.parse(store.run(runId).policy_json));
  confirmGates(workspace, loadGateLibrary(workspace, policy), [promoted.id]);
}

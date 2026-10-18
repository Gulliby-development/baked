import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import { getCwd } from "../core/cwd.js";
import { IS_WIN, killTree } from "../core/platform/index.js";
import { getRestartSpec } from "../core/restart.js";
import { workspacePath } from "../core/specs/validate.js";
import { InitiativeStore } from "../core/workflows/initiatives/store.js";
import { NativeWorkflowService } from "../core/workflows/service.js";
import { stallSettings } from "../core/workflows/stall.js";
import { WorkflowStore } from "../core/workflows/store.js";
import { DEFAULT_SUPERVISOR, StallDetector } from "../core/workflows/supervisor.js";

/** Set in the driver a supervisor starts, so it does not start another one. */
export const SUPERVISED_ENV = "BAKED_WORKFLOW_SUPERVISED";
/** Set in that driver when the supervisor's own output is a terminal. */
export const STDOUT_TTY_ENV = "BAKED_WORKFLOW_STDOUT_TTY";

/** Workflow commands that drive a run until it stops (with `--resume` where they need it). */
const DRIVING = new Set([
  "run",
  "quick",
  "resume",
  "approve",
  "answer",
  "evidence",
  "continue",
  "accept",
  "extend",
  "reroute",
  "revise",
]);
const DRIVING_INITIATIVE = new Set(["start", "approve", "drive", "resume", "reroute"]);

/**
 * Whether `baked workflow ARGV` runs under a supervisor (#1533): a command that drives a run or
 * an initiative, outside a supervised driver, with `workflows.stall.supervisorGraceMs` above 0.
 */
export function supervisedCommand(argv: readonly string[], env = process.env): boolean {
  if (env[SUPERVISED_ENV] === "1" || argv.includes("--help") || argv.includes("-h")) return false;
  if (argv[0] === "initiative") return DRIVING_INITIATIVE.has(argv[1] ?? "");
  return DRIVING.has(argv[0] ?? "");
}

/** The arguments without `--cwd`: the driver starts in the resolved directory instead. */
function withoutCwd(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd") i++;
    else if (!argv[i]?.startsWith("--cwd=")) out.push(argv[i] ?? "");
  }
  return out;
}

/**
 * The command that continues after a takeover: the initiative's drive for an initiative command,
 * otherwise `resume` of the run with the original output flags, events after the last one printed.
 */
export function recoveryArgs(
  argv: readonly string[],
  run: { runId: string; revision: number; initiativeId: string | null },
  lastSeq: number,
): string[] {
  if (argv[0] === "initiative" && run.initiativeId)
    return ["initiative", "drive", run.initiativeId];
  return [
    "resume",
    run.runId,
    "--expected-revision",
    String(run.revision),
    ...(argv.includes("--events") ? ["--events", "--after", String(lastSeq)] : []),
    ...(argv.includes("--json") ? ["--json"] : []),
  ];
}

export interface SupervisorOptions {
  cwd?: string;
  /** The merged configuration; read from the user and project files when left out. */
  config?: ReturnType<typeof mergeConfigs>;
  graceMs?: number;
  pollMs?: number;
  /** Starts a driver for `baked workflow ARGV`; tests replace it. */
  start?: (argv: string[], cwd: string) => ChildProcess;
  /** Lines the supervisor reports on stderr. */
  log?: (line: string) => void;
}

function startDriver(argv: string[], cwd: string): ChildProcess {
  const spec = getRestartSpec({ userArgs: ["workflow", ...argv] });
  // From source, the runtime's own flags (`--preload`) apply to the driver too.
  const runtime = process.argv[1] && spec.args[0] === process.argv[1] ? process.execArgv : [];
  return spawn(spec.command, [...runtime, ...spec.args], {
    cwd,
    env: {
      ...process.env,
      [SUPERVISED_ENV]: "1",
      ...(process.stdout.isTTY ? { [STDOUT_TTY_ENV]: "1" } : {}),
    },
    stdio: ["inherit", "pipe", "inherit"],
    // Its own process group on POSIX, so stopping it stops the commands it started too.
    detached: !IS_WIN,
    windowsHide: true,
  });
}

/**
 * Runs `baked workflow ARGV` in a driver process and watches it from this one, whose thread stays
 * free (#1533). When the driver's leases stay expired for the grace period (its thread stopped:
 * a synchronous call that never returns, or a suspended process), the supervisor stops the driver
 * and its commands, takes the run over (`takeOverStalledDriver`, within `autoResumes`) and starts
 * a new driver that resumes it. Its output is passed through; the exit code is the last driver's.
 */
export async function superviseWorkflowCli(
  argv: readonly string[],
  options: SupervisorOptions = {},
): Promise<number> {
  const cwd = options.cwd ?? getCwd();
  const config = options.config ?? mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd));
  const graceMs = options.graceMs ?? stallSettings(config).supervisorGraceMs;
  const pollMs = options.pollMs ?? DEFAULT_SUPERVISOR.pollMs;
  const start = options.start ?? startDriver;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const args = withoutCwd(argv);
  let lastSeq = 0;
  let pending = "";
  const forward = (chunk: Buffer): void => {
    process.stdout.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("{")) continue;
      try {
        const event = JSON.parse(line) as { seq?: unknown; type?: unknown; runId?: unknown };
        if (typeof event.seq === "number" && typeof event.type === "string" && event.runId)
          lastSeq = event.seq;
      } catch {}
    }
  };
  let driver = start(args, cwd);
  driver.stdout?.on("data", forward);
  const forwardSignal = (signal: NodeJS.Signals) => (): void => {
    // On Windows the console delivers Ctrl+C to the driver itself.
    if (IS_WIN && signal === "SIGINT") return;
    try {
      if (driver.pid) process.kill(driver.pid, signal);
    } catch {}
  };
  const onInt = forwardSignal("SIGINT");
  const onTerm = forwardSignal("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  const path = workspacePath(cwd, ".baked/workflows.sqlite");
  let watched: WorkflowStore | null = null;
  try {
    for (;;) {
      const detector = new StallDetector({ graceMs, pollMs });
      const exited = new Promise<number>((resolve) =>
        driver.once("exit", (code, signal) =>
          resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)),
        ),
      );
      const stuck = await new Promise<string[] | number>((resolve) => {
        const timer = setInterval(() => {
          try {
            if (!watched && existsSync(path)) watched = new WorkflowStore(cwd, true);
            const runs = watched && driver.pid ? detector.check(watched.leases(), driver.pid) : [];
            if (runs.length) {
              clearInterval(timer);
              resolve(runs);
            }
          } catch {
            // A busy or missing database is checked again on the next poll.
          }
        }, pollMs);
        void exited.then((code) => {
          clearInterval(timer);
          resolve(code);
        });
      });
      if (typeof stuck === "number") return stuck;
      const pid = driver.pid ?? 0;
      killTree(pid, "SIGKILL");
      if (IS_WIN) driver.kill("SIGKILL");
      await exited;
      const service = new NativeWorkflowService(cwd, config);
      let next: string[] | null = null;
      try {
        for (const runId of stuck) {
          const resumed = await service.takeOverStalledDriver(runId, pid);
          log(JSON.stringify({ supervisor: "takeover", runId, pid, resumed }));
          if (!resumed || next) continue;
          const initiatives = new InitiativeStore(service.store);
          next = recoveryArgs(
            args,
            {
              runId,
              revision: service.store.run(runId).revision,
              initiativeId: initiatives.available() ? initiatives.initiativeOfRun(runId) : null,
            },
            lastSeq,
          );
        }
      } finally {
        service.close();
      }
      // Past `autoResumes` the run is blocked for a person, as `workflow run` reports it.
      if (!next) return 4;
      driver = start(next, cwd);
      driver.stdout?.on("data", forward);
    }
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    (watched as WorkflowStore | null)?.close();
  }
}

/**
 * In a supervised driver: stops it when its supervisor is gone, so a killed supervisor does not
 * leave a driver running on its own.
 */
export function followSupervisor(intervalMs = 2_000): void {
  if (process.env[SUPERVISED_ENV] !== "1") return;
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parent) process.kill(process.pid, "SIGTERM");
  }, intervalMs);
  timer.unref();
}

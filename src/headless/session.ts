import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import {
  coordinatorId,
  RULES_USAGE,
  runRulesCommand,
} from "../core/chat/approval-rules-command.js";
import { BriefStore, renderBrief } from "../core/chat/coordinator.js";
import {
  closeLaunched,
  type LaunchedRef,
  LaunchedRefSchema,
  stopLaunched,
} from "../core/chat/coordinator-control.js";
import type { ProjectLauncher } from "../core/chat/coordinator-launch.js";
import { ScheduleError, ScheduleStore, scheduleLine } from "../core/chat/coordinator-schedules.js";
import { BakeChatHost } from "../core/chat/host.js";
import { serviceStateSource } from "../core/chat/project-state.js";
import { ChatError, ChatService } from "../core/chat/sessions.js";
import type { RollbackReport } from "../core/checkpoints/fork.js";
import { RollbackError } from "../core/checkpoints/fork.js";
import { SavedCheckpointsError, savedSessionCheckpoints } from "../core/checkpoints/list.js";
import { forkSavedSession, SessionForkError } from "../core/checkpoints/session-fork.js";
import { rewindSavedSession, SessionRewindError } from "../core/checkpoints/session-rewind.js";
import { TurnUndoError } from "../core/checkpoints/undo.js";
import { getCwd } from "../core/cwd.js";
import { exportChat } from "../core/sessions/export.js";
import { type SessionListEntry, SessionManager } from "../core/sessions/manager.js";
import { attentionItems } from "../core/workflows/attention.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import { InitiativeService } from "../core/workflows/initiatives/service.js";
import { NativeWorkflowService } from "../core/workflows/service.js";
import { newId } from "../core/workflows/store.js";
import { coordinatorLaunched, coordinatorSend } from "./coordinator-chat.js";

const help = `Usage: baked session list [--limit N] [--json]
       baked session delete SESSION [--json]
       baked session export SESSION [--format markdown|json] [--output FILE] [--json]
       baked session checkpoints SESSION [--json]
       baked session fork SESSION [options]
       baked session undo SESSION [--to N] [--force] [--json]
       baked session redo SESSION [--force] [--json]
       baked session coordinator [--json]
       baked session coordinator send TEXT [--yes] [--no-follow] [--model MODEL] [--json]
       baked session coordinator launched [--json]
       baked session coordinator schedules [--json]
       baked session coordinator schedule add --name NAME --when WHEN --prompt TEXT [--json]
       baked session coordinator schedule pause|resume|remove ID [--json]
       baked session coordinator rules [on|off|add ...|remove ID]
       baked session coordinator stop run|initiative ID [--json]
       baked session coordinator close session|run|initiative ID [--feature F] [--reopen] [--json]

list prints the saved sessions of this project, most recently updated first (default limit 50);
the project coordinator is not listed.
coordinator prints the project coordinator's session id and its project brief.
coordinator send runs one coordinator turn in this process (creating the coordinator the first
time), prints the reply and answers its approvals and split cards: --yes approves them, a terminal
asks, otherwise they are denied. The sessions and runs it launches run in this process, so send
then follows them until none is active; --no-follow returns after the reply (runs resume later,
launched sessions stop). coordinator launched lists what the coordinator launched with its status.
coordinator schedules lists the coordinator's schedules; schedule adds, pauses, resumes or removes
one. WHEN is "every 30m", "every 6h", "every 1d", a five-field cron expression in local time such
as "0 9 * * 1-5", or @hourly, @daily, @weekly, @monthly. Schedules fire while "baked serve" or the
terminal UI's coordinator runs; one missed meanwhile fires once when it starts.

coordinator rules shows or changes the rules the coordinator answers routine approvals of its
launched work by (off by default):
${RULES_USAGE.replace(/^/gm, "  ")}
coordinator stop cancels a workflow run the coordinator launched (a cancelled run cannot resume)
or pauses an initiative it launched. A launched session's turn runs in the process that hosts the
coordinator, so stop it there: Ctrl+X in the terminal UI or POST /v1/coordinator/launched/stop.
coordinator close marks a finished or paused launched item closed, so the coordinator no longer
follows it or counts it toward coordinator.maxActive; a closed session is archived. --feature
closes one feature of an initiative, --reopen brings a closed item back.
delete removes a saved session and the checkpoint tags it made; the files stay as they are.
export writes the conversation of the session's active tab as Markdown (default) or JSON, to FILE
or to .baked/exports/, as /session export does in the terminal UI.
checkpoints lists the turns of the session's active conversation: undo --to N keeps turns 1 to N.
SESSION is an id or a unique id prefix.

fork saves a new session with the active conversation of SESSION (an id or unique id prefix) up to a
message, and optionally rolls the workspace files back to that point.

Options:
  --at MESSAGE_ID     Keep the messages up to and including this one (default: all)
  --checkpoint N      Keep the conversation up to the end of checkpoint (turn) N
  --rollback-files    Restore the files the agent edited after that point
  --force             With --rollback-files, also overwrite files changed since the last checkpoint
  --json              Print the result as JSON

Continue the fork with "baked --session ID" or "baked --headless --session ID PROMPT".

undo drops the last turn of SESSION (with --to N, every turn after checkpoint N) and restores the
files those turns edited; redo puts the oldest undone turn back and restores its files. Files
changed since the last checkpoint are left in place unless --force is given. A new turn in the
session forgets the undone turns.
`;

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export async function runSessionCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return command ? 0 : 1;
  }
  if (command === "undo" || command === "redo") return rewind(command, rest);
  if (command === "list") return list(rest);
  if (command === "delete") return remove(rest);
  if (command === "export") return exportSession(rest);
  if (command === "coordinator") {
    if (rest[0] === "stop" || rest[0] === "close")
      return coordinatorControl(rest[0], rest.slice(1));
    return coordinator(rest);
  }
  if (command === "checkpoints") return checkpoints(rest);
  if (command !== "fork") {
    process.stderr.write(`Unknown session command: ${command}\n\n${help}`);
    return 1;
  }
  const session = rest.find(
    (a, i) => !a.startsWith("--") && !["--at", "--checkpoint"].includes(rest[i - 1] ?? ""),
  );
  if (!session) {
    process.stderr.write(`Name the session to fork.\n\n${help}`);
    return 1;
  }
  const at = value(rest, "--at");
  const cp = value(rest, "--checkpoint");
  const checkpoint = cp === undefined ? undefined : Number(cp);
  if (checkpoint !== undefined && (!Number.isInteger(checkpoint) || checkpoint < 1)) {
    process.stderr.write("--checkpoint needs a checkpoint number (1 or more)\n");
    return 1;
  }
  if (at !== undefined && checkpoint !== undefined) {
    process.stderr.write("Use either --at or --checkpoint\n");
    return 1;
  }
  const cwd = getCwd();
  const json = rest.includes("--json");
  try {
    const result = await forkSavedSession({
      store: new SessionManager(cwd),
      cwd,
      session,
      ...(at !== undefined ? { atMessageId: at } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      rollbackFiles: rest.includes("--rollback-files"),
      force: rest.includes("--force"),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const out = [
      `Forked into session ${result.sessionId} (${String(result.messageCount)} messages, checkpoint #${String(result.checkpoint)})`,
    ];
    if (result.rollback) out.push(...rollbackLines(result.rollback, cwd));
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  } catch (err) {
    if (err instanceof SessionForkError || err instanceof RollbackError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function rollbackLines(r: RollbackReport, cwd: string): string[] {
  const rel = (p: string) => relative(cwd, p) || p;
  if (r.restored.length + r.removed.length + r.skipped.length === 0)
    return ["No file edits were recorded for these turns; files were left as they are"];
  const out = [
    `Restored ${String(r.restored.length)} file(s), removed ${String(r.removed.length)}`,
  ];
  for (const p of r.restored) out.push(`  restored ${rel(p)}`);
  for (const p of r.removed) out.push(`  removed  ${rel(p)}`);
  for (const s of r.skipped) out.push(`  left     ${rel(s.path)}: ${s.reason}`);
  if (r.backupTag) out.push(`The files before the rollback are in Git tag ${r.backupTag}`);
  return out;
}

async function rewind(action: "undo" | "redo", rest: string[]): Promise<number> {
  const session = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--to");
  if (!session) {
    process.stderr.write(`Name the session to ${action}.\n\n${help}`);
    return 1;
  }
  const to = value(rest, "--to");
  const toCheckpoint = to === undefined ? undefined : Number(to);
  if (
    toCheckpoint !== undefined &&
    (action === "redo" || !Number.isInteger(toCheckpoint) || toCheckpoint < 0)
  ) {
    process.stderr.write(
      action === "redo"
        ? "--to is an undo option\n"
        : "--to needs a checkpoint number (0 or more)\n",
    );
    return 1;
  }
  const cwd = getCwd();
  try {
    const result = await rewindSavedSession({
      store: new SessionManager(cwd),
      cwd,
      session,
      action,
      ...(toCheckpoint !== undefined ? { toCheckpoint } : {}),
      force: rest.includes("--force"),
    });
    if (rest.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const head =
      action === "undo"
        ? `Undone to checkpoint #${String(result.checkpoint)}`
        : `Redid turn #${String(result.checkpoint)}`;
    const out = [
      `${head} (${String(result.messageCount)} messages, ${String(result.redoCount)} turn(s) to redo)`,
      ...rollbackLines(result.rollback, cwd),
    ];
    process.stdout.write(`${out.join("\n")}\n`);
    return 0;
  } catch (err) {
    if (
      err instanceof SessionRewindError ||
      err instanceof TurnUndoError ||
      err instanceof RollbackError
    ) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function checkpoints(rest: string[]): number {
  const ids = rest.filter((a) => !a.startsWith("--"));
  const unknown = rest.find((a) => a.startsWith("--") && a !== "--json");
  if (ids.length !== 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown argument: ${unknown}` : "Name one session."}\n\n${help}`,
    );
    return 1;
  }
  let result: ReturnType<typeof savedSessionCheckpoints>;
  try {
    result = savedSessionCheckpoints(new SessionManager(getCwd()), ids[0] ?? "");
  } catch (err) {
    if (!(err instanceof SavedCheckpointsError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (!result.checkpoints.length && !result.redo.length) {
    process.stdout.write(`Session ${result.sessionId} has no turns yet.\n`);
    return 0;
  }
  const out = result.checkpoints.map((c) => {
    const files = c.filesEdited.length ? `  ${String(c.filesEdited.length)} file(s)` : "";
    return `#${String(c.index).padEnd(3)} ${c.snapshot ? "snapshot" : "        "}${files}  ${c.prompt}`;
  });
  for (const r of result.redo) out.push(`#${String(r.index).padEnd(3)} undone  ${r.prompt}`);
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

function list(rest: string[]): number {
  const unknown = rest.find(
    (a, i) => a !== "--json" && a !== "--limit" && rest[i - 1] !== "--limit",
  );
  if (unknown) {
    process.stderr.write(`Unknown argument: ${unknown}\n\n${help}`);
    return 1;
  }
  const raw = value(rest, "--limit");
  const limit = raw === undefined ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write("--limit needs a number (1 or more)\n");
    return 1;
  }
  const sessions = new SessionManager(getCwd())
    .listSessions()
    .filter((s) => s.kind !== "coordinator" && !s.archived)
    .slice(0, limit);
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ sessions }, null, 2)}\n`);
    return 0;
  }
  if (!sessions.length) {
    process.stdout.write("No saved sessions in this project.\n");
    return 0;
  }
  const out = sessions.map((s) => {
    const updated = new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ");
    return `${s.id}  ${updated}  ${String(s.messageCount).padStart(4)} msg  ${s.title}`;
  });
  process.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

function coordinator(rest: string[]): number | Promise<number> {
  if (rest[0] === "rules") return coordinatorRules(rest.slice(1));
  if (rest[0] === "send") return coordinatorSend(rest.slice(1));
  if (rest[0] === "launched") return coordinatorLaunched(rest.slice(1));
  const [sub] = rest;
  if (sub !== "schedules" && sub !== "schedule") {
    const unknown = rest.find((a) => a !== "--json");
    if (unknown) {
      process.stderr.write(`Unknown argument: ${unknown}\n\n${help}`);
      return 1;
    }
  }
  const cwd = getCwd();
  const session = new SessionManager(cwd).listSessions().find((s) => s.kind === "coordinator");
  if (!session) {
    process.stderr.write(
      "This project has no coordinator yet; the desktop app or POST /v1/coordinator creates it.\n",
    );
    return 1;
  }
  if (sub === "schedules" || sub === "schedule")
    return schedules(new ScheduleStore(cwd, session.id), rest.slice(1), sub === "schedules");
  const brief = new BriefStore(cwd, session.id).read();
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ sessionId: session.id, brief }, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `Coordinator ${session.id} (brief revision ${String(brief.revision)})\n\n${renderBrief(brief)}\n`,
  );
  return 0;
}

/** `baked session coordinator schedules` and `... schedule add|pause|resume|remove`. */
function schedules(store: ScheduleStore, args: string[], listing: boolean): number {
  const json = args.includes("--json");
  const print = (data: unknown, text: string): number => {
    process.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : `${text}\n`);
    return 0;
  };
  const [action, id] = args.filter((a) => a !== "--json");
  try {
    if (listing) {
      if (action) throw new ScheduleError("INVALID_REQUEST", `Unknown argument: ${action}`);
      const all = store.list();
      return print(
        { schedules: all },
        all.length ? all.map(scheduleLine).join("\n") : "No schedules.",
      );
    }
    if (action === "add") {
      const added = store.add({
        name: value(args, "--name") ?? "",
        when: value(args, "--when") ?? "",
        prompt: value(args, "--prompt") ?? "",
      });
      return print(added, `Added ${scheduleLine(added)}`);
    }
    if ((action === "pause" || action === "resume" || action === "remove") && id) {
      if (action === "remove") {
        store.remove(id);
        return print({ removed: id }, `Removed ${id}`);
      }
      const changed = store.setEnabled(id, action === "resume");
      return print(changed, scheduleLine(changed));
    }
    throw new ScheduleError("INVALID_REQUEST", "Give add, pause ID, resume ID or remove ID");
  } catch (err) {
    if (!(err instanceof ScheduleError)) throw err;
    process.stderr.write(`${err.message}\n${err.code === "INVALID_REQUEST" ? `\n${help}` : ""}`);
    return 1;
  }
}

function coordinatorRules(args: string[]): number {
  const cwd = getCwd();
  const id = coordinatorId(cwd);
  if (!id) {
    process.stderr.write(
      "This project has no coordinator yet; the desktop app or POST /v1/coordinator creates it.\n",
    );
    return 1;
  }
  try {
    process.stdout.write(`${runRulesCommand(cwd, id, args)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** `baked session coordinator stop|close KIND ID`, through the same core as the coordinator's tools. */
async function coordinatorControl(action: "stop" | "close", args: string[]): Promise<number> {
  const json = args.includes("--json");
  const reopen = args.includes("--reopen");
  const feature = value(args, "--feature");
  const [kind, id, extra] = args.filter(
    (a, i) => !a.startsWith("--") && args[i - 1] !== "--feature",
  );
  const unknown = args.find(
    (a) => a.startsWith("--") && !["--json", "--reopen", "--feature"].includes(a),
  );
  const parsed = LaunchedRefSchema.safeParse({ kind, id, ...(feature ? { feature } : {}) });
  if (!parsed.success || extra || unknown || (action === "stop" && reopen)) {
    process.stderr.write(
      `${unknown ? `Unknown argument: ${unknown}` : `Give ${action} KIND ID, where KIND is session, run or initiative`}\n\n${help}`,
    );
    return 1;
  }
  const ref: LaunchedRef = parsed.data;
  if (action === "stop" && ref.kind === "session") {
    process.stderr.write(
      `Session ${ref.id} runs in the process that hosts the coordinator; stop its turn there (Ctrl+X in the terminal UI, or POST /v1/coordinator/launched/stop on baked serve).\n`,
    );
    return 1;
  }
  const cwd = getCwd();
  const coordinator = coordinatorId(cwd);
  if (!coordinator) {
    process.stderr.write(
      "This project has no coordinator yet; the desktop app or POST /v1/coordinator creates it.\n",
    );
    return 1;
  }
  const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd));
  const chat = new ChatService({ workspace: cwd, config, host: new BakeChatHost(cwd, config) });
  // Runs and initiatives live in the workflow database, which exists once the first one started.
  const service = existsSync(join(cwd, ".baked", "workflows.sqlite"))
    ? new NativeWorkflowService(cwd, config, undefined, false)
    : null;
  try {
    const initiatives = service ? new InitiativeService(service) : null;
    const state =
      service && initiatives
        ? serviceStateSource(service, initiatives, () =>
            attentionItems(service.store, initiatives.store),
          )
        : null;
    const launcher: Pick<ProjectLauncher, "cancelRun" | "pauseInitiative"> | null =
      service && initiatives
        ? {
            cancelRun: async (runId) => {
              await service.cancel(runId, {
                commandId: newId(),
                expectedRevision: service.store.run(runId).revision,
              });
            },
            pauseInitiative: async (initiativeId) => {
              await initiatives.pause(initiativeId, {
                commandId: newId(),
                expectedRevision: initiatives.view(initiativeId).revision,
              });
            },
          }
        : null;
    if (action === "stop") {
      const message = await stopLaunched(chat, coordinator, state, launcher, ref);
      process.stdout.write(
        json ? `${JSON.stringify({ stopped: ref, message }, null, 2)}\n` : `${message}\n`,
      );
      return 0;
    }
    const entries = await closeLaunched(chat, coordinator, state, ref, reopen);
    process.stdout.write(
      json
        ? `${JSON.stringify({ launched: entries }, null, 2)}\n`
        : `${reopen ? "Reopened" : "Closed"} ${ref.feature ? `feature ${ref.feature} of initiative ${ref.id}` : `${ref.kind} ${ref.id}`}\n`,
    );
    return 0;
  } catch (err) {
    if (!(err instanceof ChatError || err instanceof WorkflowFault)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 1;
  } finally {
    service?.close();
    await chat.host.dispose();
  }
}

/** The saved session with this id, or the only one it is a prefix of; prints why not otherwise. */
function uniqueSession(store: SessionManager, idOrPrefix: string): SessionListEntry | undefined {
  const prefix = idOrPrefix.toLowerCase();
  const matches = store.listSessions().filter((s) => s.id.toLowerCase().startsWith(prefix));
  const target =
    matches.find((s) => s.id.toLowerCase() === prefix) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (!target)
    process.stderr.write(
      matches.length
        ? `${idOrPrefix} matches ${String(matches.length)} sessions; give more of the id\n`
        : `No session ${idOrPrefix}\n`,
    );
  return target;
}

function remove(rest: string[]): number {
  const ids = rest.filter((a) => !a.startsWith("--"));
  const unknown = rest.find((a) => a.startsWith("--") && a !== "--json");
  if (ids.length !== 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown argument: ${unknown}` : "Name one session to delete."}\n\n${help}`,
    );
    return 1;
  }
  const store = new SessionManager(getCwd());
  const target = uniqueSession(store, ids[0] ?? "");
  if (!target) return 1;
  store.deleteSession(target.id);
  process.stdout.write(
    rest.includes("--json")
      ? `${JSON.stringify({ deleted: target.id, title: target.title })}\n`
      : `Deleted session ${target.id} (${target.title})\n`,
  );
  return 0;
}

function exportSession(rest: string[]): number {
  const valued = ["--format", "--output"];
  const ids = rest.filter((a, i) => !a.startsWith("--") && !valued.includes(rest[i - 1] ?? ""));
  const unknown = rest.find((a) => a.startsWith("--") && a !== "--json" && !valued.includes(a));
  if (ids.length !== 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown argument: ${unknown}` : "Name one session to export."}\n\n${help}`,
    );
    return 1;
  }
  const format = value(rest, "--format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    process.stderr.write("--format is markdown or json\n");
    return 1;
  }
  const output = value(rest, "--output");
  if (rest.includes("--output") && !output) {
    process.stderr.write("--output needs a file path\n");
    return 1;
  }
  const cwd = getCwd();
  const store = new SessionManager(cwd);
  const target = uniqueSession(store, ids[0] ?? "");
  const data = target ? store.loadSession(target.id) : null;
  if (!target || !data) {
    if (target) process.stderr.write(`Session ${target.id} could not be read\n`);
    return 1;
  }
  // The tab that was active when the session was saved, as the terminal UI exports it.
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  const result = exportChat(tab ? (data.tabMessages.get(tab.id) ?? []) : [], {
    format,
    title: target.title,
    cwd,
    ...(output ? { outPath: resolve(cwd, output) } : {}),
  });
  process.stdout.write(
    rest.includes("--json")
      ? `${JSON.stringify({ sessionId: target.id, ...result })}\n`
      : `Exported ${String(result.messageCount)} messages of ${target.id} to ${relative(cwd, result.path) || result.path}\n`,
  );
  return 0;
}

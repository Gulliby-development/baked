import { relative, resolve } from "node:path";
import { BriefStore, renderBrief } from "../core/chat/coordinator.js";
import type { RollbackReport } from "../core/checkpoints/fork.js";
import { RollbackError } from "../core/checkpoints/fork.js";
import { SavedCheckpointsError, savedSessionCheckpoints } from "../core/checkpoints/list.js";
import { forkSavedSession, SessionForkError } from "../core/checkpoints/session-fork.js";
import { rewindSavedSession, SessionRewindError } from "../core/checkpoints/session-rewind.js";
import { TurnUndoError } from "../core/checkpoints/undo.js";
import { getCwd } from "../core/cwd.js";
import { exportChat } from "../core/sessions/export.js";
import { type SessionListEntry, SessionManager } from "../core/sessions/manager.js";

const help = `Usage: baked session list [--limit N] [--json]
       baked session delete SESSION [--json]
       baked session export SESSION [--format markdown|json] [--output FILE] [--json]
       baked session checkpoints SESSION [--json]
       baked session fork SESSION [options]
       baked session undo SESSION [--to N] [--force] [--json]
       baked session redo SESSION [--force] [--json]
       baked session coordinator [--json]

list prints the saved sessions of this project, most recently updated first (default limit 50);
the project coordinator is not listed.
coordinator prints the project coordinator's session id and its project brief.
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
  if (command === "coordinator") return coordinator(rest);
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
    .filter((s) => s.kind !== "coordinator")
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

function coordinator(rest: string[]): number {
  const unknown = rest.find((a) => a !== "--json");
  if (unknown) {
    process.stderr.write(`Unknown argument: ${unknown}\n\n${help}`);
    return 1;
  }
  const cwd = getCwd();
  const session = new SessionManager(cwd).listSessions().find((s) => s.kind === "coordinator");
  if (!session) {
    process.stderr.write(
      "This project has no coordinator yet; the desktop app or POST /v1/coordinator creates it.\n",
    );
    return 1;
  }
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

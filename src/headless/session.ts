import { relative } from "node:path";
import type { RollbackReport } from "../core/checkpoints/fork.js";
import { RollbackError } from "../core/checkpoints/fork.js";
import { forkSavedSession, SessionForkError } from "../core/checkpoints/session-fork.js";
import { rewindSavedSession, SessionRewindError } from "../core/checkpoints/session-rewind.js";
import { TurnUndoError } from "../core/checkpoints/undo.js";
import { getCwd } from "../core/cwd.js";
import { SessionManager } from "../core/sessions/manager.js";

const help = `Usage: baked session list [--limit N] [--json]
       baked session delete SESSION [--json]
       baked session fork SESSION [options]
       baked session undo SESSION [--to N] [--force] [--json]
       baked session redo SESSION [--force] [--json]

list prints the saved sessions of this project, most recently updated first (default limit 50).
delete removes a saved session and the checkpoint tags it made; the files stay as they are.
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
  const sessions = new SessionManager(getCwd()).listSessions().slice(0, limit);
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

function remove(rest: string[]): number {
  const ids = rest.filter((a) => !a.startsWith("--"));
  const unknown = rest.find((a) => a.startsWith("--") && a !== "--json");
  if (ids.length !== 1 || unknown) {
    process.stderr.write(
      `${unknown ? `Unknown argument: ${unknown}` : "Name one session to delete."}\n\n${help}`,
    );
    return 1;
  }
  const prefix = (ids[0] ?? "").toLowerCase();
  const store = new SessionManager(getCwd());
  const matches = store.listSessions().filter((s) => s.id.toLowerCase().startsWith(prefix));
  const exact = matches.find((s) => s.id.toLowerCase() === prefix);
  const target = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!target) {
    process.stderr.write(
      matches.length
        ? `${ids[0]} matches ${String(matches.length)} sessions; give more of the id\n`
        : `No session ${ids[0]}\n`,
    );
    return 1;
  }
  store.deleteSession(target.id);
  process.stdout.write(
    rest.includes("--json")
      ? `${JSON.stringify({ deleted: target.id, title: target.title })}\n`
      : `Deleted session ${target.id} (${target.title})\n`,
  );
  return 0;
}

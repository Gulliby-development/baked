import { relative } from "node:path";
import { RollbackError, type RollbackReport } from "../core/checkpoints/fork.js";
import { RewindError } from "../core/checkpoints/rewind.js";
import { forkSavedSession, SessionForkError } from "../core/checkpoints/session-fork.js";
import {
  listSavedCheckpoints,
  type RedoSummary,
  redoSavedSession,
  rewindSavedSession,
  SessionRewindError,
} from "../core/checkpoints/session-rewind.js";
import { getCwd } from "../core/cwd.js";
import { SessionManager } from "../core/sessions/manager.js";

const help = `Usage: baked session <command> SESSION [options]

SESSION is a saved session id or a unique id prefix; the commands work on its active conversation.

Commands:
  fork          Save a new session with the conversation up to a message
  checkpoints   List the checkpoints (turns) and the turns a redo can bring back
  rewind        Drop the turns after a checkpoint from the session itself
  redo          Bring back the oldest turn a rewind dropped

fork options:
  --at MESSAGE_ID     Keep the messages up to and including this one (default: all)
  --checkpoint N      Keep the conversation up to the end of checkpoint (turn) N

rewind options:
  --checkpoint N      Keep the turns up to and including N (0 keeps none); required

fork, rewind and redo options:
  --rollback-files    Restore the files the agent edited after that point (fork, rewind)
  --force             With file changes, also overwrite files changed outside the agent

Every command takes --json to print the result as JSON.

Continue a session with "baked --session ID" or "baked --headless --session ID PROMPT".
`;

function value(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const COMMANDS = ["fork", "checkpoints", "rewind", "redo"];

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

function redoLine(redo: RedoSummary[]): string[] {
  if (redo.length === 0) return [];
  const list = redo.map((r) => `#${String(r.index)}`).join(", ");
  return [`baked session redo brings back: ${list}`];
}

export async function runSessionCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return command ? 0 : 1;
  }
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`Unknown session command: ${command}\n\n${help}`);
    return 1;
  }
  const session = rest.find(
    (a, i) => !a.startsWith("--") && !["--at", "--checkpoint"].includes(rest[i - 1] ?? ""),
  );
  if (!session) {
    process.stderr.write(
      `Name the session to ${command === "checkpoints" ? "list" : command}.\n\n${help}`,
    );
    return 1;
  }
  const at = value(rest, "--at");
  const cp = value(rest, "--checkpoint");
  const checkpoint = cp === undefined ? undefined : Number(cp);
  const min = command === "rewind" ? 0 : 1;
  if (checkpoint !== undefined && (!Number.isInteger(checkpoint) || checkpoint < min)) {
    process.stderr.write(`--checkpoint needs a checkpoint number (${String(min)} or more)\n`);
    return 1;
  }
  if (at !== undefined && command !== "fork") {
    process.stderr.write("--at works only with fork\n");
    return 1;
  }
  if (at !== undefined && checkpoint !== undefined) {
    process.stderr.write("Use either --at or --checkpoint\n");
    return 1;
  }
  if (command === "rewind" && checkpoint === undefined) {
    process.stderr.write("rewind needs --checkpoint N\n");
    return 1;
  }
  const cwd = getCwd();
  const store = new SessionManager(cwd);
  const json = rest.includes("--json");
  const force = rest.includes("--force");
  const rollbackFiles = rest.includes("--rollback-files");
  const print = (result: unknown, lines: string[]) => {
    process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${lines.join("\n")}\n`);
  };
  try {
    if (command === "checkpoints") {
      const result = listSavedCheckpoints(store, session);
      const lines = result.checkpoints.map(
        (c) =>
          `#${String(c.index)} ${c.prompt}  (${String(c.filesEdited.length)} edits${c.snapshot ? "" : ", no snapshot"})`,
      );
      if (lines.length === 0) lines.push("No checkpoints yet.");
      print(result, [...lines, ...redoLine(result.redo)]);
      return 0;
    }
    if (command === "rewind" || command === "redo") {
      const result =
        command === "rewind"
          ? await rewindSavedSession({
              store,
              cwd,
              session,
              checkpoint: checkpoint ?? 0,
              rollbackFiles,
              force,
            })
          : await redoSavedSession({ store, cwd, session, force });
      const head =
        command === "rewind"
          ? `Rewound session ${result.sessionId} to checkpoint #${String(result.checkpoint)} (${String(result.messageCount)} messages)`
          : `Brought back checkpoint #${String(result.checkpoint)} in session ${result.sessionId} (${String(result.messageCount)} messages)`;
      print(result, [
        head,
        ...(result.rollback ? rollbackLines(result.rollback, cwd) : []),
        ...redoLine(result.redo),
      ]);
      return 0;
    }
    const result = await forkSavedSession({
      store,
      cwd,
      session,
      ...(at !== undefined ? { atMessageId: at } : {}),
      ...(checkpoint !== undefined ? { checkpoint } : {}),
      rollbackFiles,
      force,
    });
    print(result, [
      `Forked into session ${result.sessionId} (${String(result.messageCount)} messages, checkpoint #${String(result.checkpoint)})`,
      ...(result.rollback ? rollbackLines(result.rollback, cwd) : []),
    ]);
    return 0;
  } catch (err) {
    if (
      err instanceof SessionForkError ||
      err instanceof SessionRewindError ||
      err instanceof RewindError ||
      err instanceof RollbackError
    ) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

import { relative } from "node:path";
import { RollbackError } from "../core/checkpoints/fork.js";
import { forkSavedSession, SessionForkError } from "../core/checkpoints/session-fork.js";
import { getCwd } from "../core/cwd.js";
import { SessionManager } from "../core/sessions/manager.js";

const help = `Usage: baked session fork SESSION [options]

Saves a new session with the active conversation of SESSION (an id or unique id prefix) up to a
message, and optionally rolls the workspace files back to that point.

Options:
  --at MESSAGE_ID     Keep the messages up to and including this one (default: all)
  --checkpoint N      Keep the conversation up to the end of checkpoint (turn) N
  --rollback-files    Restore the files the agent edited after that point
  --force             With --rollback-files, also overwrite files changed since the last checkpoint
  --json              Print the result as JSON

Continue the fork with "baked --session ID" or "baked --headless --session ID PROMPT".
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
    const rel = (p: string) => relative(cwd, p) || p;
    const out = [
      `Forked into session ${result.sessionId} (${String(result.messageCount)} messages, checkpoint #${String(result.checkpoint)})`,
    ];
    const r = result.rollback;
    if (r) {
      out.push(
        `Restored ${String(r.restored.length)} file(s), removed ${String(r.removed.length)}`,
      );
      for (const p of r.restored) out.push(`  restored ${rel(p)}`);
      for (const p of r.removed) out.push(`  removed  ${rel(p)}`);
      for (const s of r.skipped) out.push(`  left     ${rel(s.path)}: ${s.reason}`);
      if (r.backupTag) out.push(`The files before the rollback are in Git tag ${r.backupTag}`);
    }
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

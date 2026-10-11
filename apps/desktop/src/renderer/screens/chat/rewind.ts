import type { RewindResult } from "../../client/chat.js";

/** The lines that tell what a rewind or redo did to the chat and the files. */
export function rewindReportLines(action: "rewind" | "redo", result: RewindResult): string[] {
  const name = (path: string) => path.split(/[\\/]/).slice(-2).join("/");
  const { rollback } = result;
  const head =
    action === "rewind"
      ? `Rewound the chat to checkpoint #${result.checkpoint}.`
      : `Brought back turn #${result.checkpoint}.`;
  if (!rollback) return [`${head} Files were left as they are.`];
  const lines = [
    `${head} Restored ${rollback.restored.length} file(s)` +
      (rollback.removed.length > 0 ? `, removed ${rollback.removed.length}.` : "."),
  ];
  for (const skip of rollback.skipped)
    lines.push(`Left ${name(skip.path)} as it is: ${skip.reason}.`);
  if (rollback.backupTag)
    lines.push(`The files from before the ${action} are in Git tag ${rollback.backupTag}.`);
  return lines;
}

/** The checkpoint (turn) each message belongs to; 0 before the first prompt. */
export function turnIndexes(
  messages: readonly { id: string; role: string; isSteering?: boolean }[],
): Map<string, number> {
  const out = new Map<string, number>();
  let turn = 0;
  for (const m of messages) {
    if (m.role === "user" && !m.isSteering) turn++;
    out.set(m.id, turn);
  }
  return out;
}

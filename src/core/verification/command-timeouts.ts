import { isAbsolute, relative, sep } from "node:path";
import { realPath } from "../projects/paths.js";

/**
 * The host runs that time out without a check result (#2358): the baseline measurement, the
 * edge-input probe and `run_repro` (both through `runRepro`), `run_probe`, and documented
 * examples. Each said only that it ran too long; now each names the command and file and records
 * the timeout here, the way the edit tools record a formatter's (`recordFormatTimeout`, #2242).
 */
export type TimeoutSource = "measure" | "repro" | "probe" | "doc-example";

export interface CommandTimeout {
  source: TimeoutSource;
  /** The command as run, program first. */
  command: string;
  /** The files it ran on, relative to `root`; empty when the command names none. */
  files: string[];
  root: string;
  timeoutMs: number;
  /** Timeouts of this command on these files in this process. */
  count: number;
  /** One sentence for the result: what did not finish, on which file, within how long. */
  note: string;
}

const timeouts = new Map<string, CommandTimeout>();

/** The arguments of a command that look like files: a separator or an extension. */
export function fileArgs(args: readonly string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-") && /[/\\]|\.\w+$/.test(arg));
}

/** Records a command that did not finish within `timeoutMs`; returns the record and its note. */
export function recordCommandTimeout(input: {
  source: TimeoutSource;
  command: readonly string[];
  files: readonly string[];
  root: string;
  timeoutMs: number;
}): CommandTimeout {
  const root = realPath(input.root);
  const command = input.command.join(" ");
  const files = [...new Set(input.files)];
  const key = [input.source, root, command, ...files].join("\0");
  const count = (timeouts.get(key)?.count ?? 0) + 1;
  const on = files.length ? ` on ${files.join(", ")}` : "";
  const again = count > 1 ? ` (timeout ${String(count)} for this command)` : "";
  const record: CommandTimeout = {
    source: input.source,
    command,
    files,
    root,
    timeoutMs: input.timeoutMs,
    count,
    note: `\`${command}\`${on} did not finish within ${String(input.timeoutMs)} ms${again}`,
  };
  timeouts.set(key, record);
  return record;
}

/** The recorded timeouts of commands run in `dir` or below it: the host fact a later step reads. */
export function commandTimeoutsUnder(dir: string): CommandTimeout[] {
  const root = realPath(dir);
  return [...timeouts.values()].filter((t) => {
    const rel = relative(root, t.root);
    return !rel || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
  });
}

/** Forgets every recorded timeout (tests). */
export function resetCommandTimeouts(): void {
  timeouts.clear();
}

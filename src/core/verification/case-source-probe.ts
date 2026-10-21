import { rmSync } from "node:fs";
import type { SandboxRequest } from "../security/sandbox.js";
import type { ProcessScope } from "../workflows/process-scope.js";
import { normalizeLiteral, quotedSpans } from "./criteria-cases.js";
import {
  commandArgv,
  copyWorkspace,
  linkInto,
  missingBuildOutput,
  missingInput,
} from "./doc-examples.js";
import { entryPointCommand } from "./entry-points.js";
import { REPRO_TIMEOUT_MS, reproEnv } from "./repro.js";

/**
 * The command a criterion quotes as its input, when `literal` is an expected output it states
 * (#1836): the first code span of its When, then its Given, that is a plain command line. Null
 * when the literal is not in the Then or the criterion quotes no command.
 */
export function caseCommand(
  criterion: { given: string; when: string; then: string },
  literal: string,
): { command: string; argv: string[] } | null {
  if (!quotedSpans(criterion.then).some((span) => span.literal === literal)) return null;
  for (const text of [criterion.when, criterion.given])
    for (const span of quotedSpans(text)) {
      if (!span.code) continue;
      const argv = commandArgv(span.literal);
      if (argv && argv.length > 1 && !/[\\/]/.test(argv[0] as string))
        return { command: span.literal, argv };
    }
  return null;
}

/**
 * Runs a criterion's command through the project's entry point in a copy of the workspace and
 * returns what it printed when no line of it is `literal`, the criterion's expected output; null
 * when a line is or the command cannot say (not the project's program, not built, an input
 * file nobody supplies, a timeout). hdrlens negotiate (bench round 56): the case walk refused
 * test task T004 for `invalid offer "text/*"`, which T002's `cmd.go` printed with an `"a.txt": `
 * prefix; the test task could not change the source, looped, and the review's corrective cost
 * 1.0M tokens.
 */
export async function probeCase(
  processes: ProcessScope,
  argv: readonly string[],
  literal: string,
  options: {
    root: string;
    /** The files of the workspace's source manifest. */
    files: readonly string[];
    executables: readonly string[];
    signal: AbortSignal;
    sandbox: (root: string) => SandboxRequest | null;
  },
): Promise<{ printed: string; exitCode: number | null } | null> {
  const entry = entryPointCommand(options.root, argv, options.executables);
  if (!entry) return null;
  const [program, ...args] = entry.argv as [string, ...string[]];
  if (!options.executables.includes(program)) return null;
  const copy = copyWorkspace(options.root, options.files);
  if (!copy) return null;
  try {
    for (const dir of entry.entry.link ?? []) linkInto(options.root, copy, dir);
    if (missingBuildOutput([program, ...args], copy)) return null;
    let result: Awaited<ReturnType<ProcessScope["execute"]>>;
    try {
      result = await processes.execute(program === "bun" ? process.execPath : program, args, {
        cwd: copy,
        env: reproEnv(copy),
        timeoutMs: REPRO_TIMEOUT_MS,
        signal: options.signal,
        sandbox: options.sandbox(copy),
      });
    } catch {
      options.signal.throwIfAborted();
      return null;
    }
    if (result.timedOut || result.cancelled) return null;
    if (missingInput(args, copy, result.output)) return null;
    // The criterion states the line the program prints: R56's code printed the expected error
    // after a file prefix, which a substring match would have passed.
    const wanted = new Set([literal.trim(), normalizeLiteral(literal).trim()]);
    const output = result.output.replace(/\r\n/g, "\n");
    if (output.split("\n").some((line) => wanted.has(line.trim()))) return null;
    return { printed: output.trim().slice(0, 500), exitCode: result.exitCode };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

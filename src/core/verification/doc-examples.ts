import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxRequest } from "../security/sandbox.js";
import type { ProcessScope } from "../workflows/process-scope.js";
import { REPRO_TIMEOUT_MS, reproEnv } from "./repro.js";

/** Examples the host runs per review stage; each runs for up to REPRO_TIMEOUT_MS. */
export const DOC_EXAMPLE_LIMIT = 8;
/** Bytes of workspace files the host copies to run the examples in; a larger workspace runs none. */
export const DOC_EXAMPLE_COPY_BYTES = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 2000;
/** Directories a copy links instead of copying: installed dependencies a program imports. */
const LINKED = ["node_modules", ".venv", "venv"];
const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh", "terminal"]);
const OUTPUT_LANGS = new Set(["", "text", "txt", "output", "plaintext", "console"]);

export interface DocExample {
  file: string;
  /** 1-based line of the command in the file. */
  line: number;
  command: string;
  /** The program and its arguments, or null when the line needs a shell (pipes, redirects, variables). */
  argv: string[] | null;
  /** The output the document shows for the command. */
  documented: string;
}

export interface DocExampleResult {
  file: string;
  line: number;
  command: string;
  /**
   * `match` when the printed output is the documented output; `mismatch` when a line differs;
   * `not_run` when the host could not run the command (see reason).
   */
  status: "match" | "mismatch" | "not_run";
  reason?: string;
  exitCode?: number | null;
  documented: string;
  printed?: string;
  /** The first documented line that differs and the line printed in its place. */
  firstDifference?: { line: number; expected: string; actual: string };
}

/** Whether a changed file is documentation whose examples the host runs: Markdown, or a README. */
export function isDocFile(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  return /\.(md|markdown)$/i.test(name) || /^readme(\.txt)?$/i.test(name);
}

/**
 * Splits a command line into a program and its arguments the way a POSIX shell would for plain
 * words and quotes; null when it needs anything else a shell does.
 */
export function commandArgv(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "$" || c === "`") return null;
      else if (c === "\\" && /["\\$`]/.test(command[i + 1] ?? "")) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else if (/[|&;<>()`$*?~#{}[\]]/.test(c)) {
      // A # inside a word is literal; one that starts a word starts a comment.
      if (c === "#" && started) {
        word += c;
        continue;
      }
      if (c === "#") break;
      return null;
    } else if (c === "\\") {
      word += command[++i] ?? "";
      started = true;
    } else {
      word += c;
      started = true;
    }
  }
  if (quote) return null;
  if (started) words.push(word);
  if (!words.length || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] as string)) return null;
  return words;
}

interface Fence {
  lang: string;
  /** 1-based line of the first content line. */
  start: number;
  lines: string[];
  /** Non-empty lines of prose between the previous fence and this one. */
  proseBefore: number;
}

function fences(text: string): Fence[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Fence[] = [];
  let prose = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/.exec(lines[i] as string);
    if (!open) {
      if ((lines[i] as string).trim()) prose++;
      continue;
    }
    const marker = open[1] as string;
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !(lines[j] as string).trim().startsWith(marker))
      body.push(lines[j++] as string);
    out.push({
      lang: (open[2] ?? "").toLowerCase(),
      start: i + 2,
      lines: body,
      proseBefore: prose,
    });
    prose = 0;
    i = j;
  }
  return out;
}

/** Joins lines that end with a backslash continuation. */
function joined(lines: string[], from: number): { text: string; next: number } {
  let text = (lines[from] as string).trimEnd();
  let next = from + 1;
  while (text.endsWith("\\") && next < lines.length) {
    text = `${text.slice(0, -1).trimEnd()} ${(lines[next] as string).trim()}`;
    next++;
  }
  return { text, next };
}

/**
 * The command examples of a document that show their output: a fenced block whose `$ ` lines are
 * commands followed by their output, or a shell block of one command followed, after at most two
 * lines of prose, by a plain block of its output.
 */
export function extractExamples(file: string, text: string): DocExample[] {
  const examples: DocExample[] = [];
  const blocks = fences(text);
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b] as Fence;
    const prompted = block.lines.some((l) => /^\s*\$ /.test(l));
    if (prompted) {
      for (let i = 0; i < block.lines.length; ) {
        if (!/^\s*\$ /.test(block.lines[i] as string)) {
          i++;
          continue;
        }
        const { text: line, next } = joined(block.lines, i);
        const command = line.replace(/^\s*\$ /, "").trim();
        let end = next;
        while (end < block.lines.length && !/^\s*\$ /.test(block.lines[end] as string)) end++;
        examples.push({
          file,
          line: block.start + i,
          command,
          argv: commandArgv(command),
          documented: block.lines.slice(next, end).join("\n"),
        });
        i = end;
      }
      continue;
    }
    const output = blocks[b + 1];
    if (!SHELL_LANGS.has(block.lang) || !output || !OUTPUT_LANGS.has(output.lang)) continue;
    if (output.proseBefore > 2 || output.lines.some((l) => /^\s*\$ /.test(l))) continue;
    const commands = block.lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (commands.length !== 1) continue;
    const index = block.lines.indexOf(commands[0] as string);
    const command = joined(block.lines, index).text.trim();
    examples.push({
      file,
      line: block.start + index,
      command,
      argv: commandArgv(command),
      documented: output.lines.join("\n"),
    });
    b++;
  }
  return examples;
}

const outputLines = (text: string) => {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  while (lines.length && !lines[0]) lines.shift();
  return lines;
};

/** The first documented line the printed output does not reproduce, or null when they agree. */
export function firstDifference(
  documented: string,
  printed: string,
): DocExampleResult["firstDifference"] | null {
  const want = outputLines(documented);
  const got = outputLines(printed);
  for (let i = 0; i < Math.max(want.length, got.length); i++)
    if (want[i] !== got[i])
      return {
        line: i + 1,
        expected: want[i] ?? "(no more lines)",
        actual: got[i] ?? "(no more lines)",
      };
  return null;
}

/**
 * Copies the workspace's files (those of its source manifest) to a temporary directory and links
 * its installed dependencies, so examples that write data files leave the workspace unchanged.
 */
function copyWorkspace(root: string, files: readonly string[]): string | null {
  let bytes = 0;
  for (const path of files) {
    bytes += statSync(join(root, path)).size;
    if (bytes > DOC_EXAMPLE_COPY_BYTES) return null;
  }
  const copy = mkdtempSync(join(tmpdir(), "baked-examples-"));
  for (const path of files) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(root, path), join(copy, path));
  }
  for (const name of LINKED)
    if (existsSync(join(root, name)) && !existsSync(join(copy, name)))
      symlinkSync(
        join(root, name),
        join(copy, name),
        process.platform === "win32" ? "junction" : "dir",
      );
  return copy;
}

/**
 * Runs the command examples of the changed documents, the way a reader would run them in order,
 * in a copy of the workspace, and compares what they print with what the documents show (#750).
 * Reviewers used to run them one by one with run_repro, which cost them model steps.
 */
export async function runDocExamples(
  processes: ProcessScope,
  docs: readonly { path: string; text: string }[],
  options: {
    root: string;
    /** The files of the workspace's source manifest. */
    files: readonly string[];
    executables: readonly string[];
    signal: AbortSignal;
    /** The sandbox of a run in the given directory, or null. */
    sandbox: (root: string) => SandboxRequest | null;
  },
): Promise<DocExampleResult[]> {
  const results: DocExampleResult[] = [];
  let ran = 0;
  for (const doc of docs) {
    const examples = extractExamples(doc.path, doc.text);
    if (!examples.length) continue;
    // Each document starts from the workspace as the change left it, as its reader would.
    let copy: string | null | undefined;
    try {
      for (const example of examples) {
        const base = {
          file: example.file,
          line: example.line,
          command: example.command,
          documented: example.documented.slice(0, OUTPUT_LIMIT),
        };
        const skip = (reason: string) => results.push({ ...base, status: "not_run", reason });
        if (!example.argv) {
          skip("The command needs a shell (a pipe, redirect, variable or glob)");
          continue;
        }
        const [program, ...args] = example.argv as [string, ...string[]];
        if (!options.executables.includes(program)) {
          skip(
            `${program} is not a program the run's checks start (${options.executables.join(", ") || "none"})`,
          );
          continue;
        }
        if (ran >= DOC_EXAMPLE_LIMIT) {
          skip(`Only ${DOC_EXAMPLE_LIMIT} examples run per review`);
          continue;
        }
        if (copy === undefined) copy = copyWorkspace(options.root, options.files);
        if (copy === null) {
          skip(`The workspace is larger than ${DOC_EXAMPLE_COPY_BYTES / 1024 / 1024} MiB`);
          continue;
        }
        ran++;
        let result: Awaited<ReturnType<ProcessScope["execute"]>>;
        try {
          result = await processes.execute(program === "bun" ? process.execPath : program, args, {
            cwd: copy,
            env: reproEnv(copy),
            timeoutMs: REPRO_TIMEOUT_MS,
            signal: options.signal,
            sandbox: options.sandbox(copy),
          });
        } catch (error) {
          options.signal.throwIfAborted();
          skip(
            `The command did not start: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (result.timedOut || result.cancelled) {
          skip(
            result.timedOut
              ? `The command ran longer than ${REPRO_TIMEOUT_MS} ms`
              : "The command was cancelled",
          );
          continue;
        }
        const difference = firstDifference(example.documented, result.output);
        results.push({
          ...base,
          status: difference ? "mismatch" : "match",
          exitCode: result.exitCode,
          printed: result.output.slice(0, OUTPUT_LIMIT),
          ...(difference ? { firstDifference: difference } : {}),
        });
      }
    } finally {
      if (copy) rmSync(copy, { recursive: true, force: true });
    }
  }
  return results;
}

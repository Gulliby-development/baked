import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpDir } from "../platform/index.js";
import type { SandboxRequest } from "../security/sandbox.js";
import type { ProcessScope } from "../workflows/process-scope.js";
import { entryPointCommand } from "./entry-points.js";
import { REPRO_TIMEOUT_MS, removeScratch, reproEnv } from "./repro.js";

/** Examples the host runs per review stage; each runs for up to REPRO_TIMEOUT_MS. */
export const DOC_EXAMPLE_LIMIT = 8;
/** Bytes of workspace files the host copies to run the examples in; a larger workspace runs none. */
export const DOC_EXAMPLE_COPY_BYTES = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 2000;
/** Directories a copy links instead of copying: installed dependencies a program imports. */
const LINKED = ["node_modules", ".venv", "venv"];
/** Directories compilers and bundlers write their output to; a source manifest never lists them. */
const BUILD_DIRS = new Set(["bin", "obj", "target", "dist", "build", "out"]);
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

/** A file the document shows as a block and tells its reader to save (#1849). */
export interface DocFixture {
  /** Relative path the reader saves it under. */
  path: string;
  /** 1-based line of the block's first content line. */
  line: number;
  content: string;
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

/**
 * All-caps words that are values, not placeholders: HTTP methods (`routeshadow match app.txt GET
 * /users/42`, bench round 55, #1821) and common digest and encoding names.
 */
const LITERAL_CAPS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  "MD5",
  "SHA1",
  "SHA256",
  "SHA384",
  "SHA512",
  "UTF8",
  "UTF16",
  "ASCII",
  "JSON",
  "CSV",
  "XML",
  "YAML",
  "TOML",
]);

/**
 * The first placeholder argument of a command line (`FILE`, `<file>`, `[options]`, `--out=PATH`),
 * or null. A line with one is a usage line, and the block after it is not what it prints (#1014).
 */
export function placeholderOf(command: string): string | null {
  const bracketed = /(?:^|\s)(<[^<>\s]+>|\[[^[\]\s]+\])(?=\s|$)/.exec(command);
  if (bracketed) return bracketed[1] as string;
  const [, ...args] = commandArgv(command) ?? [];
  for (const arg of args) {
    // An option's own name is not a placeholder; the value after its = may be.
    const value = arg.startsWith("-") ? (arg.split("=")[1] ?? "") : arg;
    if (/^[A-Z][A-Z0-9_]*[A-Z0-9](\.\.\.)?$/.test(value) && !LITERAL_CAPS.has(value)) return value;
  }
  return null;
}

/**
 * The first argument of a command that is a path under a build output directory (`bin/`,
 * `target/`, `dist/`, `build/`) and does not exist in `root`, or null. A README documents the
 * build before such a run line, and the host runs examples without building (#1035).
 */
export function missingBuildOutput(argv: readonly string[], root: string): string | null {
  for (const arg of argv) {
    if (arg.startsWith("-") || !/[\\/]/.test(arg)) continue;
    const segments = arg.split(/[\\/]+/).filter((s) => s && s !== ".");
    if (!segments.slice(0, -1).some((s) => BUILD_DIRS.has(s))) continue;
    if (!existsSync(join(root, ...segments))) return arg;
  }
  return null;
}

export interface Fence {
  lang: string;
  /** 1-based line of the first content line. */
  start: number;
  lines: string[];
  /** Non-empty lines of prose between the previous fence and this one. */
  proseBefore: number;
  /** That prose. */
  prose: string;
  /** A unified diff (`diff`/`patch`, or a first line such as `--- a/x`): a change, not a program's text. */
  diff: boolean;
}

/** A first block line that starts a unified diff: `--- a/x`, `diff --git`, `Index:` or a hunk. */
const DIFF_START = /^(?:--- \S|diff --git |Index: |@@ -\d)/;

/**
 * Whether `line` closes a block opened by `marker` with `indent` leading spaces. A closing fence
 * is the same character, at least as long, with nothing after it but spaces (CommonMark): a
 * "```bash" line inside a block is content. In a diff block a fence indented further than the
 * opening one is a context line of the diff (" ```", the README's own fence after the diff's
 * leading space), never the end: R65 seqmill-update and aclvet-update lost their README hunks
 * there, and sizing priced those tasks from history (#2018).
 */
function closesFence(line: string, marker: string, indent: number, diff: boolean): boolean {
  const close = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  if (!close) return false;
  const fence = close[2] as string;
  if (fence[0] !== marker[0] || fence.length < marker.length) return false;
  return !diff || (close[1] as string).length <= indent;
}

/**
 * The fenced code blocks of a Markdown text, with the prose before each; plan sizing reads a
 * request's too. The one reader of fenced blocks: where a block ends is decided by `closesFence`.
 */
export function fences(text: string): Fence[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Fence[] = [];
  let prose = 0;
  let proseText = "";
  for (let i = 0; i < lines.length; i++) {
    const open = /^( {0,3})(`{3,}|~{3,})\s*([\w+-]*)/.exec(lines[i] as string);
    if (!open) {
      if ((lines[i] as string).trim()) {
        prose++;
        proseText += `${(lines[i] as string).trim()}\n`;
      }
      continue;
    }
    const indent = (open[1] as string).length;
    const marker = open[2] as string;
    const lang = (open[3] ?? "").toLowerCase();
    const diff = lang === "diff" || lang === "patch" || DIFF_START.test(lines[i + 1] ?? "");
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closesFence(lines[j] as string, marker, indent, diff))
      body.push(lines[j++] as string);
    out.push({
      lang,
      start: i + 2,
      lines: body,
      proseBefore: prose,
      diff,
      prose: proseText,
    });
    prose = 0;
    proseText = "";
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
 * Whether the prose before a block introduces it as a file rather than as output: it ends with a
 * colon after naming a file (`An example `net.sp`:`, `Given this input file:`). structpad's
 * README followed `python -m structpad --help` with a sample struct file, and the host compared
 * the usage text with it (bench round 55, #1821).
 */
function introducesFile(prose: string): boolean {
  const last = prose.trim().split("\n").at(-1) ?? "";
  return (
    /:\s*$/.test(last) &&
    /\b(?:file|input|sample|config(?:uration)?|schema|definition)s?\b|`[^`\s]+\.\w{1,5}`|\b[\w-]+\.[a-z]{1,5}\b/i.test(
      last,
    ) &&
    !/\b(?:prints?|outputs?|shows?|returns?|writes?|gives?|reports?|displays?)\b/i.test(last)
  );
}

/** A relative path a fixture may be written to: plain segments, no `..`, no root. */
const FIXTURE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[\w.-]+(?:\/[\w.-]+)*\.\w{1,8}$/;

/**
 * The name a block introduced as a file is saved under: a code span or bare file name in the last
 * line of the prose before it (`save the following response fields as `resp.txt`:`), or a first
 * line that names it (`# resp.txt`). hdrlens-update (bench round 57) showed two inputs that way and
 * the host ran `hdrlens check resp.txt` without them, reporting both examples as mismatches.
 */
function fixtureName(block: Fence): string | null {
  if (!introducesFile(block.prose)) return null;
  const last = block.prose.trim().split("\n").at(-1) ?? "";
  const spans = [...last.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] as string);
  const bare = [...last.matchAll(/(?:^|\s)([\w./-]+\.[a-z]{1,8})(?=[\s:,]|$)/gi)].map(
    (m) => m[1] as string,
  );
  const header = /^\s*(?:#|\/\/)\s*([\w./-]+\.\w{1,8})\s*$/.exec(block.lines[0] ?? "")?.[1];
  return (
    [...spans, ...bare, ...(header ? [header] : [])].find((name) => FIXTURE_PATH.test(name)) ?? null
  );
}

/** The files a document tells its reader to save from its blocks, in document order (#1849). */
export function extractFixtures(text: string): DocFixture[] {
  return fences(text).flatMap((block) => {
    if (block.diff || block.lines.some((l) => /^\s*\$ /.test(l))) return [];
    const path = fixtureName(block);
    return path ? [{ path, line: block.start, content: `${block.lines.join("\n")}\n` }] : [];
  });
}

/**
 * An example introduced in a sentence: an inline command, then its output block (`For example,
 * `modeplan apply 0644 u+x,go-r` shows each step of the change:`). modeplan's README (bench round
 * 57) printed all seven examples this way and the host extracted none (#1849).
 */
function proseCommand(prose: string): string | null {
  const last = prose.trim().split("\n").at(-1) ?? "";
  if (!/:\s*$/.test(last)) return null;
  if (
    !/\b(?:prints?|outputs?|shows?|returns?|writes?|gives?|reports?|displays?|answers?)\b/i.test(
      last,
    )
  )
    return null;
  const spans = [...last.matchAll(/`([^`]+)`/g)].map((m) => (m[1] as string).trim());
  const commands = spans.filter((span) => /^[a-z][\w.-]*\s+\S/.test(span));
  return commands.length === 1 ? (commands[0] as string) : null;
}

/** A block that opens with a source comment (`// wire structs`) is a file, never a program's output. */
const isSourceText = (lines: readonly string[]): boolean =>
  /^\s*(?:\/\/|\/\*)/.test(lines.find((l) => l.trim()) ?? "");

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
    // A diff shows a change; its context lines (" $ tool --version") are not a session (#2018).
    if (block.diff) continue;
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
    const inline = OUTPUT_LANGS.has(block.lang) ? proseCommand(block.prose) : null;
    if (inline && !isSourceText(block.lines)) {
      examples.push({
        file,
        line: block.start - 1,
        command: inline,
        argv: commandArgv(inline),
        documented: block.lines.join("\n"),
      });
      continue;
    }
    const output = blocks[b + 1];
    if (!SHELL_LANGS.has(block.lang) || !output || output.diff || !OUTPUT_LANGS.has(output.lang))
      continue;
    if (output.proseBefore > 2 || output.lines.some((l) => /^\s*\$ /.test(l))) continue;
    const commands = block.lines.filter((l) => l.trim() && !l.trim().startsWith("#"));
    if (commands.length !== 1) continue;
    const index = block.lines.indexOf(commands[0] as string);
    const command = joined(block.lines, index).text.trim();
    if (introducesFile(output.prose) || isSourceText(output.lines)) continue;
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
export function copyWorkspace(root: string, files: readonly string[]): string | null {
  let bytes = 0;
  for (const path of files) {
    bytes += statSync(join(root, path)).size;
    if (bytes > DOC_EXAMPLE_COPY_BYTES) return null;
  }
  const copy = mkdtempSync(join(tmpDir(), "baked-examples-"));
  for (const path of files) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(root, path), join(copy, path));
  }
  for (const name of LINKED) linkInto(root, copy, name);
  return copy;
}

/** Writes a fixture into the copy unless the workspace already has a file there. */
function writeFixture(copy: string, fixture: DocFixture): void {
  const target = join(copy, ...fixture.path.split("/"));
  if (existsSync(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fixture.content);
}

/**
 * An argument that names a file the copy lacks and the program's output names, or null: the
 * example reads an input its reader must supply, so its output says nothing about the program.
 */
export function missingInput(args: readonly string[], copy: string, output: string): string | null {
  for (const arg of args) {
    if (arg.startsWith("-") || !/\.\w{1,8}$/.test(arg) || !FIXTURE_PATH.test(arg)) continue;
    if (!existsSync(join(copy, ...arg.split("/"))) && output.includes(arg)) return arg;
  }
  return null;
}

/** Links a directory of the workspace into its copy, when it exists and the copy has none. */
export function linkInto(root: string, copy: string, name: string): void {
  if (existsSync(join(root, name)) && !existsSync(join(copy, name)))
    symlinkSync(
      join(root, name),
      join(copy, name),
      process.platform === "win32" ? "junction" : "dir",
    );
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
    const fixtures = extractFixtures(doc.text);
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
        const placeholder = placeholderOf(example.command);
        if (placeholder) {
          skip(
            `placeholder: ${placeholder} stands for a value the reader supplies, so the block after the command is not its output`,
          );
          continue;
        }
        if (!example.argv) {
          skip("The command needs a shell (a pipe, redirect, variable or glob)");
          continue;
        }
        // The project's own command runs through its toolchain (`routeshadow ...` as `cargo run
        // --bin routeshadow -- ...`, #1821).
        const entry = options.executables.includes(example.argv[0] as string)
          ? null
          : entryPointCommand(options.root, example.argv, options.executables);
        const [program, ...args] = (entry?.argv ?? example.argv) as [string, ...string[]];
        if (!options.executables.includes(program)) {
          skip(
            `${program} is not a program the run's checks or their toolchains start (${options.executables.join(", ") || "none"})`,
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
        for (const dir of entry?.entry.link ?? []) linkInto(options.root, copy, dir);
        // The files the document tells its reader to save before this example (#1849).
        for (const fixture of fixtures)
          if (fixture.line < example.line) writeFixture(copy, fixture);
        const unbuilt = missingBuildOutput([program, ...args], copy);
        if (unbuilt) {
          skip(
            `needs build: ${unbuilt} is a build output that does not exist, and the host runs examples without building`,
          );
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
        // A program that exits 0 and prints nothing where the document shows output most likely
        // never reached its main (a Bun `import.meta.main` guard under a short Windows path,
        // #1999): the host's launch is suspect, not the documentation.
        if (
          difference &&
          result.exitCode === 0 &&
          !result.output.trim() &&
          example.documented.trim()
        ) {
          results.push({
            ...base,
            status: "not_run",
            reason:
              "The command exited 0 and printed nothing where the document shows output; launcher problem suspected",
            exitCode: result.exitCode,
            printed: "",
          });
          continue;
        }
        const absent = difference ? missingInput(args, copy, result.output) : null;
        if (absent) {
          skip(
            `input file ${absent} is not in the repository or the document's own blocks, so the program could not read it`,
          );
          continue;
        }
        results.push({
          ...base,
          status: difference ? "mismatch" : "match",
          exitCode: result.exitCode,
          printed: result.output.slice(0, OUTPUT_LIMIT),
          ...(difference ? { firstDifference: difference } : {}),
        });
      }
    } finally {
      if (copy) removeScratch(copy);
    }
  }
  return results;
}

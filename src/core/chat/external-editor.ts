import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findOnPath, IS_DARWIN, IS_WIN, tmpDir } from "../platform/index.js";

/** The editor to run and where the choice came from, for messages. */
export interface EditorChoice {
  /** A command line: a program and optional arguments, as `$EDITOR` holds it. */
  command: string;
  source: "VISUAL" | "EDITOR" | "fallback";
}

export interface ResolveEditorOptions {
  env?: Record<string, string | undefined>;
  platform?: "win32" | "darwin" | "linux";
  /** PATH lookup, replaceable in tests. */
  exists?: (bin: string) => boolean;
}

function currentPlatform(): "win32" | "darwin" | "linux" {
  return IS_WIN ? "win32" : IS_DARWIN ? "darwin" : "linux";
}

/** Editors tried in order when neither `$VISUAL` nor `$EDITOR` is set. */
export function fallbackEditors(platform: "win32" | "darwin" | "linux"): string[] {
  return platform === "win32" ? ["notepad"] : ["nano", "vim", "vi"];
}

/**
 * `$VISUAL`, then `$EDITOR`, then the first fallback on PATH. Notepad ships with
 * every Windows install, so it is returned there without a lookup.
 */
export function resolveEditor(opts: ResolveEditorOptions = {}): EditorChoice | null {
  const env = opts.env ?? process.env;
  const visual = env.VISUAL?.trim();
  if (visual) return { command: visual, source: "VISUAL" };
  const editor = env.EDITOR?.trim();
  if (editor) return { command: editor, source: "EDITOR" };
  const platform = opts.platform ?? currentPlatform();
  if (platform === "win32") return { command: "notepad", source: "fallback" };
  const exists = opts.exists ?? ((bin: string) => findOnPath(bin) !== null);
  const found = fallbackEditors(platform).find((bin) => exists(bin));
  return found ? { command: found, source: "fallback" } : null;
}

/**
 * The process to start for `command` on `file`. The command goes through the
 * system shell, like Git runs `core.editor`, so values such as `code --wait`
 * or a quoted path with spaces work. On POSIX the file is passed as `$1`
 * rather than spliced into the command line.
 */
export function editorInvocation(
  command: string,
  file: string,
  platform: "win32" | "darwin" | "linux" = currentPlatform(),
): { cmd: string; args: string[]; shell: boolean } {
  if (platform === "win32") return { cmd: `${command} "${file}"`, args: [], shell: true };
  return { cmd: "sh", args: ["-c", `${command} "$1"`, "sh", file], shell: false };
}

export type EditorResult =
  | { status: "saved"; text: string }
  | { status: "cancelled"; reason: string }
  | { status: "error"; message: string };

export interface EditTextOptions extends ResolveEditorOptions {
  /** Hand the terminal to the editor (stop drawing, leave raw mode). */
  suspend?: () => void;
  /** Take the terminal back after the editor exits. */
  resume?: () => void;
  /** Runs the editor and resolves with its exit code; replaceable in tests. */
  run?: (invocation: { cmd: string; args: string[]; shell: boolean }) => Promise<number | null>;
}

function runInherited(invocation: {
  cmd: string;
  args: string[];
  shell: boolean;
}): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.cmd, invocation.args, {
      stdio: "inherit",
      shell: invocation.shell,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

/**
 * Open `text` in the user's editor and return what they saved. A non-zero exit
 * (`:cq` in Vim) or an empty file cancels, so the caller keeps its draft.
 */
export async function editTextInEditor(
  text: string,
  opts: EditTextOptions = {},
): Promise<EditorResult> {
  const editor = resolveEditor(opts);
  if (!editor) {
    return {
      status: "error",
      message: "No editor found. Set $EDITOR (or $VISUAL) to the editor you want to use.",
    };
  }
  const dir = await mkdtemp(join(tmpDir(), "baked-input-"));
  const file = join(dir, "prompt.md");
  let suspended = false;
  try {
    await writeFile(file, text, "utf8");
    const invocation = editorInvocation(editor.command, file, opts.platform);
    opts.suspend?.();
    suspended = true;
    let code: number | null;
    try {
      code = await (opts.run ?? runInherited)(invocation);
    } finally {
      opts.resume?.();
      suspended = false;
    }
    if (code !== 0) {
      return {
        status: "cancelled",
        reason: `${editor.command} exited with code ${String(code)}; the input was not sent.`,
      };
    }
    const saved = (await readFile(file, "utf8")).replace(/\r\n/g, "\n").replace(/\n$/, "");
    if (saved.trim() === "") return { status: "cancelled", reason: "The file was empty." };
    return { status: "saved", text: saved };
  } catch (err) {
    if (suspended) opts.resume?.();
    const message = err instanceof Error ? err.message : String(err);
    return { status: "error", message: `Could not run ${editor.command}: ${message}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface EditorRequest {
  /** Start from an empty file instead of the current input (`/editor`, whose own text is still there). */
  fresh?: boolean;
}

type EditorRequestListener = (request: EditorRequest) => void;
const editorListeners = new Set<EditorRequestListener>();

/** Subscribe the focused chat input to "compose in editor" requests (Ctrl+X E, /editor). */
export function onInputEditorRequest(fn: EditorRequestListener): () => void {
  editorListeners.add(fn);
  return () => editorListeners.delete(fn);
}

export function requestInputEditor(request: EditorRequest = {}): void {
  for (const fn of editorListeners) {
    try {
      fn(request);
    } catch {}
  }
}

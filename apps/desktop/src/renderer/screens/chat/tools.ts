/**
 * Readable one-line titles and inline diffs for the raw tool calls of a chat session. Session
 * events carry only the tool name, its input and its output, so the screen derives both here.
 */

import type { IconName } from "../../components/Icon.js";

export interface ToolTitle {
  /** The plain part, e.g. "Read". */
  verb: string;
  /** The subject, shown in monospace when `code` is set, e.g. a path or a command. */
  subject?: string;
  code?: boolean;
}

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export interface ToolDiff {
  path: string;
  added: number;
  removed: number;
  created: boolean;
  lines: DiffLine[];
}

type Args = Record<string, unknown>;

const SUBJECT_CHARS = 80;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function shorten(text: string, max = SUBJECT_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function readPaths(args: Args): string[] {
  const files = Array.isArray(args.files) ? args.files : [];
  const paths = files
    .map((f) => (f && typeof f === "object" ? str((f as Args).path) : str(f)))
    .filter((p): p is string => p !== undefined);
  const single = str(args.path);
  return paths.length > 0 ? paths : single ? [single] : [];
}

function humanize(name: string): string {
  const words = name
    .replace(/^bake_/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TOOL_ICON: Record<string, IconName> = {
  read: "read",
  fetch_page: "read",
  edit_file: "edit",
  multi_edit: "edit",
  write_file: "edit",
  create_file: "edit",
  ast_edit: "edit",
  structural_edit: "edit",
  rename_file: "edit",
  rename_symbol: "edit",
  move_symbol: "edit",
  refactor: "edit",
  undo_edit: "undo",
  shell: "shell",
  project: "shell",
  grep: "search",
  bake_grep: "search",
  glob: "search",
  bake_find: "search",
  bake_query: "search",
  list_dir: "search",
  navigate: "search",
  web_search: "search",
  git: "git",
  bake_vision: "image",
  task_list: "plan",
};

/** The icon for a tool call; tools without one of their own show the model chip. */
export function toolIcon(name: string): IconName {
  return TOOL_ICON[name] ?? "model";
}

/** A one-line title for a tool call from its name and input. */
export function toolTitle(name: string, args: Args): ToolTitle {
  const path = str(args.path);
  switch (name) {
    case "read": {
      const paths = readPaths(args);
      if (paths.length === 1) return { verb: "Read", subject: paths[0], code: true };
      return { verb: paths.length > 1 ? `Read ${paths.length} files` : "Read files" };
    }
    case "edit_file":
      return {
        verb: args.oldString === "" ? "Created" : "Edited",
        subject: path,
        code: true,
      };
    case "multi_edit": {
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      return {
        verb: count > 1 ? `Made ${count} edits in` : "Edited",
        subject: path,
        code: true,
      };
    }
    case "write_file":
    case "create_file":
      return { verb: "Wrote", subject: path, code: true };
    case "ast_edit":
    case "structural_edit":
      return {
        verb: args.action === "create_file" ? "Created" : "Edited",
        subject: path,
        code: true,
      };
    case "shell":
      return { verb: "Ran", subject: shorten(str(args.command) ?? ""), code: true };
    case "grep":
    case "bake_grep":
      return { verb: "Searched for", subject: shorten(str(args.pattern) ?? ""), code: true };
    case "glob":
      return { verb: "Listed files matching", subject: str(args.pattern), code: true };
    case "bake_find":
      return {
        verb: "Found",
        subject: shorten(str(args.query) ?? str(args.name) ?? ""),
        code: true,
      };
    case "list_dir":
      return { verb: "Listed", subject: path ?? ".", code: true };
    case "navigate": {
      const target = str(args.symbol) ?? str(args.name) ?? path;
      return {
        verb: `Looked up ${str(args.action) ?? "symbol"}`,
        ...(target ? { subject: target, code: true } : {}),
      };
    }
    case "web_search":
      return { verb: "Searched the web for", subject: shorten(str(args.query) ?? "") };
    case "fetch_page":
      return { verb: "Fetched", subject: str(args.url), code: true };
    case "git":
      return { verb: "Git", subject: str(args.action) ?? str(args.command), code: true };
    case "project":
      return { verb: "Ran project", subject: str(args.action), code: true };
    case "rename_file":
      return {
        verb: "Renamed",
        subject: `${str(args.from) ?? str(args.path) ?? ""} → ${str(args.to) ?? ""}`,
        code: true,
      };
    case "rename_symbol":
      return { verb: "Renamed", subject: str(args.symbol) ?? str(args.name), code: true };
    case "task_list":
      return { verb: "Updated the task list" };
    case "undo_edit":
      return { verb: "Undid the last edit", ...(path ? { subject: path, code: true } : {}) };
    default: {
      const subject =
        path ??
        str(args.query) ??
        str(args.pattern) ??
        str(args.name) ??
        Object.values(args).find((v): v is string => typeof v === "string");
      return {
        verb: humanize(name),
        ...(subject ? { subject: shorten(subject), code: true } : {}),
      };
    }
  }
}

function lines(text: string): string[] {
  if (text === "") return [];
  const split = text.split("\n");
  return split.at(-1) === "" ? split.slice(0, -1) : split;
}

function replacement(oldText: string, newText: string): DiffLine[] {
  return [
    ...lines(oldText).map((text) => ({ kind: "del" as const, text })),
    ...lines(newText).map((text) => ({ kind: "add" as const, text })),
  ];
}

function diff(path: string, created: boolean, body: DiffLine[]): ToolDiff | null {
  if (body.length === 0) return null;
  return {
    path,
    created,
    added: body.filter((l) => l.kind === "add").length,
    removed: body.filter((l) => l.kind === "del").length,
    lines: body,
  };
}

/** The edit a tool call made, when its input carries the old and new text; null otherwise. */
export function toolDiff(name: string, args: Args): ToolDiff | null {
  const path = str(args.path);
  if (!path) return null;
  switch (name) {
    case "edit_file": {
      if (typeof args.oldString !== "string" || typeof args.newString !== "string") return null;
      return diff(path, args.oldString === "", replacement(args.oldString, args.newString));
    }
    case "multi_edit": {
      if (!Array.isArray(args.edits)) return null;
      const body: DiffLine[] = [];
      for (const edit of args.edits) {
        if (!edit || typeof edit !== "object") continue;
        const { oldString, newString } = edit as Args;
        if (typeof oldString !== "string" || typeof newString !== "string") continue;
        if (body.length > 0) body.push({ kind: "hunk", text: "…" });
        body.push(...replacement(oldString, newString));
      }
      return diff(path, false, body);
    }
    case "write_file":
    case "create_file": {
      const content = str(args.content) ?? str(args.newCode);
      return content ? diff(path, true, replacement("", content)) : null;
    }
    case "ast_edit": {
      const code = str(args.newCode);
      return args.action === "create_file" && code ? diff(path, true, replacement("", code)) : null;
    }
    default:
      return null;
  }
}

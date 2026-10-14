import { isAbsolute, resolve } from "node:path";
import { runWithCwd } from "../cwd.js";
import { deriveTool } from "./tool-utils.js";

/**
 * Tools resolve relative paths against the process directory, which inside `baked serve` is the
 * project. An agent that works elsewhere (a chat session's own worktree, #1135) gets its tools
 * wrapped here: relative path arguments become absolute under its directory, a missing search or
 * shell directory defaults to it, and the call runs with `getCwd()` returning it.
 */

/** Arguments that name a file or directory, per tool; other tools' arguments are left alone. */
const PATH_KEYS: Record<string, string[]> = {
  read: ["files"],
  edit_file: ["path"],
  undo_edit: ["path"],
  multi_edit: ["path"],
  ast_edit: ["path"],
  structural_edit: ["file"],
  list_dir: ["path"],
  bake_grep: ["path"],
  bake_vision: ["path"],
  shell: ["cwd"],
  grep: ["path"],
  glob: ["path"],
  navigate: ["file"],
  rename_symbol: ["file"],
  move_symbol: ["from", "to"],
  rename_file: ["from", "to"],
  refactor: ["file"],
  analyze: ["file"],
  discover_pattern: ["file"],
  project: ["cwd"],
};

/** Arguments that default to the agent's directory when left out. */
const DEFAULT_TO_CWD: Record<string, string> = {
  list_dir: "path",
  bake_grep: "path",
  shell: "cwd",
  grep: "path",
  glob: "path",
  project: "cwd",
};

function absolute(value: unknown, cwd: string): unknown {
  if (typeof value === "string") {
    // read's `files` may come JSON-encoded; the tool accepts the parsed list as well.
    if (/^[[{]/.test(value)) {
      try {
        return absolute(JSON.parse(value), cwd);
      } catch {
        return value;
      }
    }
    if (
      !value ||
      isAbsolute(value) ||
      value.startsWith("~") ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    )
      return value;
    return resolve(cwd, value);
  }
  if (Array.isArray(value)) return value.map((item) => absolute(item, cwd));
  if (value && typeof value === "object" && "path" in value) {
    const spec = value as { path: unknown };
    return { ...spec, path: absolute(spec.path, cwd) };
  }
  return value;
}

/** The arguments of a call to `name` with their paths made absolute under `cwd`. */
export function scopeToolArgs(name: string, args: unknown, cwd: string): unknown {
  const keys = PATH_KEYS[name];
  if (!keys || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of keys)
    if (next[key] !== undefined && next[key] !== null) next[key] = absolute(next[key], cwd);
  const fallback = DEFAULT_TO_CWD[name];
  if (
    fallback &&
    (next[fallback] === undefined || next[fallback] === null || next[fallback] === "")
  )
    next[fallback] = cwd;
  return next;
}

/** `tools` working in `cwd`: see the module comment. */
export function scopeToolsToCwd<T extends Record<string, unknown>>(tools: T, cwd: string): T {
  const dir = resolve(cwd);
  const result = { ...tools };
  for (const [name, value] of Object.entries(tools)) {
    const definition = value as { execute?: (...args: unknown[]) => unknown };
    const execute = definition.execute;
    if (!execute) continue;
    (result as Record<string, unknown>)[name] = deriveTool(definition, {
      execute: (args: unknown, ...rest: unknown[]) =>
        runWithCwd(dir, () => execute(scopeToolArgs(name, args, dir), ...rest)),
    });
  }
  return result;
}

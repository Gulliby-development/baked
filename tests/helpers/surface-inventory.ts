/**
 * What each surface offers, read from the source: the TUI's slash commands, the `/v1` routes the
 * local API serves and the desktop app's screens. The feature parity test checks these against
 * `src/core/features/registry.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCommandDefs } from "../../src/core/commands/registry.js";

const root = join(import.meta.dir, "..", "..");

export function tuiCommands(): string[] {
  return getCommandDefs().map((def) => def.cmd);
}

/** Desktop screens as `projects`, `attention`, `project/<section>` and `settings/<section>`. */
export function desktopScreens(): string[] {
  const text = readFileSync(join(root, "apps/desktop/src/renderer/router.ts"), "utf8");
  const list = (name: string): string[] => {
    const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(text)?.[1];
    if (!body) throw new Error(`router.ts has no ${name}`);
    return [...body.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] ?? "");
  };
  return [
    "projects",
    "attention",
    ...list("PROJECT_SECTIONS").map((s) => `project/${s}`),
    ...list("SETTINGS_SECTIONS").map((s) => `settings/${s}`),
  ];
}

/** Drops comment lines so paths quoted in doc comments do not count as routes. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

function matchingParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return i;
  }
  throw new Error(`Unbalanced group in ${src}`);
}

function splitTop(src: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") i++;
    else if (ch === "[") while (i < src.length && src[i] !== "]") i += src[i] === "\\" ? 2 : 1;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

/**
 * Expands a route regex into path templates: a group of plain words becomes each word, an
 * upper-case-or-digit class (an ID) becomes `:id`, a lower-case-only class (an action name) becomes
 * `:action`, and an optional group yields paths with and without it.
 */
function expand(src: string): string[] {
  let out = [""];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (ch === "^" || ch === "$") continue;
    if (ch === "\\") {
      out = out.map((p) => p + (src[i + 1] ?? ""));
      i++;
      continue;
    }
    if (ch !== "(") {
      out = out.map((p) => p + ch);
      continue;
    }
    const close = matchingParen(src, i);
    let inner = src.slice(i + 1, close);
    const capturing = !inner.startsWith("?:");
    if (!capturing) inner = inner.slice(2);
    const optional = src[close + 1] === "?";
    let options: string[];
    const words = splitTop(inner);
    if (!capturing) options = words.flatMap(expand);
    else if (words.every((w) => /^[a-z-]+$/.test(w))) options = words;
    else options = [/^\[a-z-?\]\+/.test(inner) ? ":action" : ":id"];
    if (optional) options = ["", ...options];
    out = out.flatMap((p) => options.map((o) => p + o));
    i = close + (optional ? 1 : 0);
  }
  return out;
}

/** Action names a route file dispatches on: comparisons, `switch (action)` cases and action lists. */
function actions(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/action\s*[!=]==\s*"([a-z/-]+)"/g)) found.add(m[1] ?? "");
  for (const m of text.matchAll(/switch \(action\) \{([\s\S]*?)\n {2}\}/g))
    for (const c of (m[1] ?? "").matchAll(/case "([a-z/-]+)":/g)) found.add(c[1] ?? "");
  for (const m of text.matchAll(/const (?:MUTATIONS|ACTIONS) = (?:new Set\()?\[([\s\S]*?)\]/g))
    for (const s of (m[1] ?? "").matchAll(/"([a-z/-]+)"/g)) found.add(s[1] ?? "");
  return [...found];
}

/** Every `/v1` path template served by `src/core/api`, without methods. */
export function apiRoutes(): string[] {
  const dir = join(root, "src/core/api");
  const routes = new Set<string>();
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = code(readFileSync(join(dir, name), "utf8"));
    const fileActions = actions(text);
    const templates: string[] = [];
    for (const m of text.matchAll(/"(\/v1\/[a-z0-9/_-]*)"/g)) templates.push(m[1] ?? "");
    for (const m of text.matchAll(/\/(\^\\\/v1\\\/[^\n]*?\$)\//g)) templates.push(...expand(m[1] ?? ""));
    for (const m of text.matchAll(/`(\^\/v1\/[^`]*\$)`/g))
      templates.push(...expand((m[1] ?? "").replace(/\$\{ID\}/g, "[A-Za-z0-9-]+")));
    for (const template of templates) {
      if (template.endsWith("/")) continue;
      const expanded = template.includes(":action")
        ? fileActions.map((a) => template.replace(":action", a))
        : [template];
      for (const route of expanded) routes.add(route);
    }
  }
  return [...routes].sort();
}

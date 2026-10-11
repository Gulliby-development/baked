import type { McpScope, McpServerConfig, McpStatus, McpTransport } from "../../client/mcp.js";
import type { DotTone } from "../../components/ui/dot.js";

/** The add and edit form: text fields as typed, turned into a config entry on save. */
export interface McpDraft {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command: string;
  /** Arguments on one line; quote one that holds spaces. */
  args: string;
  url: string;
  /** `KEY=value`, one per line. */
  env: string;
  headers: string;
  /** Seconds per tool call; empty keeps the default. */
  timeout: string;
}

export const EMPTY_DRAFT: McpDraft = {
  name: "",
  scope: "project",
  transport: "stdio",
  command: "",
  args: "",
  url: "",
  env: "",
  headers: "",
  timeout: "",
};

export const STATUS_LABEL: Record<McpStatus, string> = {
  idle: "Not connected yet",
  disconnected: "Disconnected",
  connecting: "Connecting…",
  ready: "Connected",
  error: "Failed",
  disabled: "Off",
};

export const STATUS_TONE: Record<McpStatus, DotTone> = {
  idle: "",
  disconnected: "warn",
  connecting: "busy",
  ready: "ok",
  error: "err",
  disabled: "",
};

/** Splits a command line into arguments; single or double quotes keep spaces. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(pattern)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function joinArgs(args: string[]): string {
  return args
    .map((a) => (a === "" || /\s/.test(a) ? (a.includes('"') ? `'${a}'` : `"${a}"`) : a))
    .join(" ");
}

/** `KEY=value` lines into a record; a line without `=` is reported by `pairsProblem`. */
export function parsePairs(text: string): Record<string, string> | undefined {
  const pairs: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq > 0) pairs[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return Object.keys(pairs).length ? pairs : undefined;
}

export function pairsProblem(text: string, what: string): string | null {
  const bad = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && l.indexOf("=") <= 0);
  return bad ? `${what}: write each one as KEY=value ("${bad}")` : null;
}

export function formatPairs(pairs?: Record<string, string>): string {
  return Object.entries(pairs ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function draftFrom(config: McpServerConfig, scope: McpScope): McpDraft {
  return {
    name: config.name,
    scope,
    transport: config.transport ?? "stdio",
    command: config.command ?? "",
    args: joinArgs(config.args ?? []),
    url: config.url ?? "",
    env: formatPairs(config.env),
    headers: formatPairs(config.headers),
    timeout: config.timeout ? String(config.timeout / 1000) : "",
  };
}

/** What stops the draft from saving, checked before the backend checks it again. */
export function draftProblem(draft: McpDraft): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(draft.name.trim()))
    return "Name: 1-64 letters, digits, dots, dashes or underscores, starting with one";
  if (draft.transport === "stdio" && !draft.command.trim()) return "A stdio server needs a command";
  if (draft.transport !== "stdio" && !/^https?:\/\/\S+$/.test(draft.url.trim()))
    return "Enter the server's http(s) URL";
  const timeout = draft.timeout.trim();
  if (timeout && !(Number(timeout) >= 1 && Number(timeout) <= 3600))
    return "Timeout: seconds from 1 to 3600";
  return (
    pairsProblem(draft.env, "Environment") ??
    (draft.transport === "stdio" ? null : pairsProblem(draft.headers, "Headers"))
  );
}

/** The config entry of a draft that passed `draftProblem`; `disabled` stays with the backend. */
export function draftServer(draft: McpDraft): McpServerConfig {
  const server: McpServerConfig = { name: draft.name.trim() };
  if (draft.transport === "stdio") {
    server.command = draft.command.trim();
    const args = splitArgs(draft.args);
    if (args.length) server.args = args;
  } else {
    server.transport = draft.transport;
    server.url = draft.url.trim();
    const headers = parsePairs(draft.headers);
    if (headers) server.headers = headers;
  }
  const env = parsePairs(draft.env);
  if (env) server.env = env;
  if (draft.timeout.trim()) server.timeout = Math.round(Number(draft.timeout) * 1000);
  return server;
}

/** "github · 4 tools" style summary of where the server runs. */
export function serverTarget(config: McpServerConfig): string {
  if ((config.transport ?? "stdio") !== "stdio") return config.url ?? "";
  return [config.command ?? "", joinArgs(config.args ?? [])].filter(Boolean).join(" ");
}

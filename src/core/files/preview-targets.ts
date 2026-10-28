/**
 * The documents a chat session produced, for every surface that previews them: Markdown and HTML
 * files it wrote or edited in the project, and the HTML artifacts it saved or deployed. Derived
 * from the session's tool calls only, so no surface needs state of its own on the server. Pure and
 * typed structurally, so the desktop renderer, the terminal UI and `baked preview list` share it.
 *
 * A tool that writes files joins `WRITE_PATHS`; document kinds come from ./preview-kinds.ts.
 * `apps/desktop/tests/chat-preview.test.ts` covers each.
 */
import { type PreviewKind, previewKind } from "./preview-kinds.js";

/** The fields of a tool call this module reads; the desktop and terminal tool calls both fit. */
export interface PreviewToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: { success: boolean; output?: string };
}

export type PreviewSource = { type: "file"; path: string } | { type: "artifact"; id: string };

export interface PreviewTarget {
  /** Stable across turns: `file:<path>` or `artifact:<id>`. */
  key: string;
  source: PreviewSource;
  kind: PreviewKind;
  /** The file name or the artifact's title. */
  title: string;
  /** The folder of a file, or "Artifact vN". */
  where: string;
  /** How many tool calls changed it; the panel reloads when it grows. */
  changes: number;
  /** The tool call that changed it last. */
  lastCallId: string;
  /** The position of that call among the session's document changes; later is larger. */
  lastSeq: number;
  /** Whether the session created it rather than editing a file that was there. */
  created: boolean;
  /** The URL of its latest Vercel deploy, for artifacts. */
  deployUrl: string | null;
}

type Args = Record<string, unknown>;
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The path a writing tool call changed, or undefined when the call writes nothing. */
const WRITE_PATHS: Record<string, (args: Args) => string | undefined> = {
  edit_file: (a) => str(a.path),
  multi_edit: (a) => str(a.path),
  write_file: (a) => str(a.path),
  create_file: (a) => str(a.path),
  ast_edit: (a) => str(a.path),
  structural_edit: (a) => str(a.path),
  rename_file: (a) => str(a.to),
};

const CREATES = (name: string, args: Args): boolean =>
  name === "write_file" ||
  name === "create_file" ||
  (name === "edit_file" && args.oldString === "") ||
  ((name === "ast_edit" || name === "structural_edit") && args.action === "create_file");

const SAVED = /Saved artifact (\S+) v(\d+) "([^"]*)"/;
const DEPLOYED = /Deployed (\S+) v(\d+) as a \w+ deployment: (\S+)/;

/** Forward slashes and no leading `./`, so one file has one key. */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(\.\/)+/, "");
}

function split(path: string): { name: string; folder: string } {
  const at = path.lastIndexOf("/");
  return at < 0
    ? { name: path, folder: "" }
    : { name: path.slice(at + 1), folder: path.slice(0, at) };
}

/** The file or artifact a finished tool call produced for the preview, if any. */
export function previewOf(call: PreviewToolCall): {
  source: PreviewSource;
  kind: PreviewKind;
  title: string;
  where: string;
  created: boolean;
  deployUrl: string | null;
} | null {
  if (!call.result?.success) return null;
  const path = WRITE_PATHS[call.name]?.(call.args);
  if (path) {
    const kind = previewKind(path);
    if (!kind) return null;
    const file = normalizePath(path);
    const { name, folder } = split(file);
    return {
      source: { type: "file", path: file },
      kind,
      title: name,
      where: folder || "Project root",
      created: CREATES(call.name, call.args),
      deployUrl: null,
    };
  }
  if (call.name !== "artifact") return null;
  const output = call.result.output ?? "";
  const saved = SAVED.exec(output);
  if (saved?.[1])
    return {
      source: { type: "artifact", id: saved[1] },
      kind: "html",
      title: saved[3] || saved[1],
      where: `Artifact v${saved[2]}`,
      created: saved[2] === "1",
      deployUrl: null,
    };
  const deployed = DEPLOYED.exec(output);
  if (deployed?.[1])
    return {
      source: { type: "artifact", id: deployed[1] },
      kind: "html",
      title: deployed[1],
      where: `Artifact v${deployed[2]}`,
      created: false,
      deployUrl: deployed[3] ?? null,
    };
  return null;
}

/** The key of a document: `file:<path>` or `artifact:<id>`. */
export const previewKey = (source: PreviewSource): string =>
  source.type === "file" ? `file:${source.path}` : `artifact:${source.id}`;

/** Every document of the session in the order it first appeared. */
export function previewTargets(
  messages: readonly { toolCalls?: readonly PreviewToolCall[] }[],
): PreviewTarget[] {
  const byKey = new Map<string, PreviewTarget>();
  let seq = 0;
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      const found = previewOf(call);
      if (!found) continue;
      seq += 1;
      const key = previewKey(found.source);
      const seen = byKey.get(key);
      if (!seen) {
        byKey.set(key, { key, ...found, changes: 1, lastCallId: call.id, lastSeq: seq });
        continue;
      }
      seen.changes += 1;
      seen.lastCallId = call.id;
      seen.lastSeq = seq;
      // A deploy names only the id: keep the title the save gave it.
      if (found.deployUrl) seen.deployUrl = found.deployUrl;
      else seen.title = found.title;
      if (found.source.type === "artifact") seen.where = found.where;
    }
  }
  return [...byKey.values()];
}

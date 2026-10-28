/**
 * `baked preview`: the Markdown and HTML documents of the project from a script or a terminal
 * without the UI (#2299). A Markdown file prints; an HTML file opens in the browser. `list` names
 * the documents a saved session wrote and the artifacts it saved, as the desktop chat's preview
 * panel and the TUI's `/preview` show them. Kinds, size limit and project confinement come from
 * src/core/files/preview.ts, the same as `GET /v1/files/preview`.
 */
import { ArtifactStore } from "../core/artifacts/store.js";
import { getCwd } from "../core/cwd.js";
import { openablePreview, PreviewError, readPreview } from "../core/files/preview.js";
import { type PreviewTarget, previewTargets } from "../core/files/preview-targets.js";
import { SessionManager } from "../core/sessions/manager.js";
import { openPath } from "../core/utils/open-path.js";

const help = `Usage: baked preview PATH [--print] [--json]
       baked preview list [--session SESSION] [--json]

PATH is a Markdown (.md, .markdown, .mdx) or HTML (.html, .htm) file inside the project, at most
2 MB. Markdown prints to stdout; HTML opens in the default browser, or prints its source with
--print. --json prints the document as GET /v1/files/preview answers it.

list prints the Markdown and HTML files a saved session wrote and the artifacts it saved, the
latest change first. It reads the most recently updated session of this project unless --session
names one by id or unique prefix.

Exit codes: 1 a file too large, an unreadable session or no browser, 2 bad arguments or a path
that is missing, outside the project or not Markdown or HTML.
`;

export interface PreviewCliDeps {
  cwd: () => string;
  out: (text: string) => void;
  err: (text: string) => void;
  open: (path: string) => boolean;
  sessions: (cwd: string) => SessionManager;
  store: () => ArtifactStore;
}

const defaults: PreviewCliDeps = {
  cwd: getCwd,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  open: openPath,
  sessions: (cwd) => new SessionManager(cwd),
  store: () => new ArtifactStore(),
};

const value = (args: string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

function line(target: PreviewTarget, store: ArtifactStore): string {
  const what = target.source.type === "file" ? target.source.path : `artifact ${target.source.id}`;
  const page = target.source.type === "artifact" ? safePage(store, target.source.id) : null;
  return [
    target.kind.padEnd(8),
    what,
    target.source.type === "artifact" ? `"${target.title}" ${target.where}` : "",
    target.changes > 1 ? `(${target.changes} changes)` : "",
    target.deployUrl ? `→ ${target.deployUrl}` : page ? `→ ${page}` : "",
  ]
    .filter(Boolean)
    .join("  ");
}

/** The page of an artifact still in the store; null when it was removed since. */
function safePage(store: ArtifactStore, id: string): string | null {
  try {
    return store.pagePath(id);
  } catch {
    return null;
  }
}

function list(rest: string[], deps: PreviewCliDeps): number {
  const unknown = rest.find(
    (a, i) => a !== "--json" && a !== "--session" && rest[i - 1] !== "--session",
  );
  if (unknown || (rest.includes("--session") && !value(rest, "--session"))) {
    deps.err(`${unknown ? `Unknown argument: ${unknown}` : "--session needs an id"}\n\n${help}`);
    return 2;
  }
  const store = deps.sessions(deps.cwd());
  const wanted = value(rest, "--session");
  const sessions = store.listSessions().filter((s) => s.kind !== "coordinator" && !s.archived);
  const id = wanted ? store.findByPrefix(wanted) : sessions[0]?.id;
  if (!id) {
    deps.err(wanted ? `No session ${wanted}\n` : "No saved sessions in this project.\n");
    return wanted ? 2 : 0;
  }
  const data = store.loadSession(id);
  if (!data) {
    deps.err(`Session ${id} could not be read\n`);
    return 1;
  }
  // The conversation the session was saved on, as `baked session export` reads it.
  const tab = data.meta.tabs.find((t) => t.id === data.meta.activeTabId) ?? data.meta.tabs[0];
  const targets = previewTargets(tab ? (data.tabMessages.get(tab.id) ?? []) : []).sort(
    (a, b) => b.lastSeq - a.lastSeq,
  );
  if (rest.includes("--json")) {
    deps.out(`${JSON.stringify({ session: id, documents: targets }, null, 2)}\n`);
    return 0;
  }
  if (!targets.length) {
    deps.out(`Session ${id} wrote no Markdown or HTML document and saved no artifact.\n`);
    return 0;
  }
  const artifacts = deps.store();
  deps.out(`${targets.map((t) => line(t, artifacts)).join("\n")}\n`);
  return 0;
}

export async function runPreviewCli(
  argv: string[],
  deps: PreviewCliDeps = defaults,
): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    (first ? deps.out : deps.err)(help);
    return first ? 0 : 2;
  }
  if (first === "list") return list(rest, deps);
  const unknown = rest.find((a) => a !== "--json" && a !== "--print");
  if (unknown || first.startsWith("--")) {
    deps.err(`Unknown argument: ${unknown ?? first}\n\n${help}`);
    return 2;
  }
  const cwd = deps.cwd();
  try {
    const doc = readPreview(cwd, first);
    if (rest.includes("--json")) {
      deps.out(`${JSON.stringify(doc, null, 2)}\n`);
      return 0;
    }
    if (doc.kind === "markdown" || rest.includes("--print")) {
      deps.out(doc.text.endsWith("\n") ? doc.text : `${doc.text}\n`);
      return 0;
    }
    const file = openablePreview(cwd, first);
    if (!deps.open(file)) {
      deps.err(`Could not open a browser. The page is ${file}\n`);
      return 1;
    }
    deps.out(`Opened ${doc.path} in the browser.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof PreviewError)) throw error;
    deps.err(`${error.message}\n`);
    return error.code === "TOO_LARGE" ? 1 : 2;
  }
}

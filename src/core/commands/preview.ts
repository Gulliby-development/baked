import { markdownLines } from "../../components/coordinator/markdown-lines.js";
import { toneColor, wrap } from "../../components/coordinator/model.js";
import { infoPopupContentWidth } from "../../components/modals/InfoPopup.js";
import { ArtifactStore } from "../artifacts/store.js";
import { openablePreview, PreviewError, readPreview } from "../files/preview.js";
import { normalizePath, type PreviewTarget, previewTargets } from "../files/preview-targets.js";
import { icon } from "../icons.js";
import { getThemeTokens } from "../theme/index.js";
import { openPath } from "../utils/open-path.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/**
 * `/preview`: the Markdown and HTML documents this chat wrote and the artifacts it saved, as the
 * desktop chat's preview panel shows them (#2299). Markdown opens in a popup drawn like assistant
 * text; HTML and artifacts open in the browser, where their scripts run. `/preview PATH` previews
 * any document of the project. Kinds, size limit and project confinement come from
 * src/core/files/preview.ts; which tool calls made a document, from preview-targets.ts.
 */

const USAGE = "Usage: /preview | /preview PATH";
const POPUP_WIDTH = 100;

export interface PreviewDeps {
  open: (path: string) => boolean;
  store: () => ArtifactStore;
  /** Terminal width in cells, to wrap Markdown to the popup. */
  columns: () => number;
}

const defaults: PreviewDeps = {
  open: openPath,
  store: () => new ArtifactStore(),
  columns: () => process.stdout.columns || 100,
};

function showMarkdown(ctx: CommandContext, path: string, deps: PreviewDeps): void {
  const doc = readPreview(ctx.cwd, path);
  const t = getThemeTokens();
  const width = infoPopupContentWidth(POPUP_WIDTH, deps.columns());
  const lines = markdownLines(doc.text, width, wrap);
  ctx.openInfoPopup({
    title: doc.path,
    icon: icon("file"),
    width: POPUP_WIDTH,
    lines: (lines.length ? lines : [{ text: "(empty)", tone: "muted" as const }]).map((line) => ({
      type: "text" as const,
      label: line.text || " ",
      color: toneColor(t, line.tone),
    })),
  });
}

function openFile(ctx: CommandContext, path: string, deps: PreviewDeps): void {
  const file = openablePreview(ctx.cwd, path);
  sysMsg(
    ctx,
    deps.open(file)
      ? `Opened ${normalizePath(path)} in the browser.`
      : `Could not open a browser. The page is ${file}`,
  );
}

function openArtifact(ctx: CommandContext, id: string, deps: PreviewDeps): void {
  const file = deps.store().pagePath(id);
  sysMsg(
    ctx,
    deps.open(file)
      ? `Opened the artifact ${id} in the browser.`
      : `Could not open a browser. The page is ${file}`,
  );
}

/** Opens one document: a popup for Markdown, the browser for HTML. */
function show(ctx: CommandContext, target: PreviewTarget, deps: PreviewDeps): void {
  try {
    if (target.source.type === "artifact") openArtifact(ctx, target.source.id, deps);
    else if (target.kind === "markdown") showMarkdown(ctx, target.source.path, deps);
    else openFile(ctx, target.source.path, deps);
  } catch (error) {
    sysMsg(ctx, error instanceof Error ? error.message : String(error));
  }
}

function describe(target: PreviewTarget): string {
  const kind = target.source.type === "artifact" ? "artifact" : target.kind;
  const changes = target.changes > 1 ? ` · changed ${target.changes} times` : "";
  const made = target.created ? " · new" : "";
  return `${target.where} · ${kind}${made}${changes}${target.deployUrl ? ` · ${target.deployUrl}` : ""}`;
}

export function handlePreview(
  input: string,
  ctx: CommandContext,
  deps: PreviewDeps = defaults,
): void {
  const path = input.trim().split(/\s+/).slice(1).join(" ");
  if (path) {
    if (path === "help" || path === "--help") {
      sysMsg(ctx, USAGE);
      return;
    }
    try {
      if (readPreview(ctx.cwd, path).kind === "markdown") showMarkdown(ctx, path, deps);
      else openFile(ctx, path, deps);
    } catch (error) {
      if (!(error instanceof PreviewError)) throw error;
      sysMsg(ctx, error.message);
    }
    return;
  }
  // The latest change first, like the desktop panel brings the latest document forward.
  const targets = previewTargets(ctx.chat.messages).sort((a, b) => b.lastSeq - a.lastSeq);
  if (!targets.length) {
    sysMsg(
      ctx,
      "This chat has not written a Markdown or HTML document or saved an artifact yet. /preview PATH previews any Markdown or HTML file of the project.",
    );
    return;
  }
  ctx.openCommandPicker({
    title: "Preview",
    icon: icon("file"),
    searchable: targets.length > 8,
    options: targets.map((target) => ({
      value: target.key,
      icon: icon(target.kind === "markdown" ? "file" : "globe"),
      label: target.title,
      description: describe(target),
    })),
    onSelect: (value) => {
      const target = targets.find((t) => t.key === value);
      if (target) show(ctx, target, deps);
    },
  });
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/preview", (input, ctx) => handlePreview(input, ctx));
}

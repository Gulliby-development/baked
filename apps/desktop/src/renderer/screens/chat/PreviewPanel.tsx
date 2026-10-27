import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { artifacts } from "../../client/artifacts.js";
import { bridge } from "../../client/bridge.js";
import { files } from "../../client/files.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { scrollbarTokens, withAppScrollbar } from "../../lib/frame-scrollbar.js";
import { Markdown } from "./Markdown.js";
import { CHIP_SMALL } from "./Popover.js";
import type { PreviewTarget } from "./preview-model.js";

/**
 * The right-hand third of the chat: the Markdown and HTML documents the session wrote, and the
 * artifacts it saved, one tab each. Markdown is rendered like assistant text or shown as source;
 * HTML is drawn in a sandboxed frame without scripts (Open runs it in the browser). The panel
 * reloads a document when the chat changes it again.
 */

export const PREVIEW_MIN_WIDTH = 320;
/** The panel never takes more of the chat's row than this. */
const MAX_SHARE = 0.7;
const KEY_STEP = 32;

type View = "rendered" | "source";
type Load =
  | { state: "loading" }
  | { state: "ready"; key: string; text: string }
  | { state: "error"; message: string };

const KIND_LABEL = { markdown: "MD", html: "HTML" } as const;
const KIND_FILL = { markdown: "bg-fill-info", html: "bg-fill-ok" } as const;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The text of a document; keeps the old text on screen while a change reloads it. */
function useDocument(projectKey: string, target: PreviewTarget): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` reloads a document the chat edited again
  useEffect(() => {
    let live = true;
    setLoad((prev) =>
      prev.state === "ready" && prev.key === target.key ? prev : { state: "loading" },
    );
    const read =
      target.source.type === "file"
        ? files.preview(projectKey, target.source.path).then((doc) => doc.text)
        : artifacts.page(projectKey, target.source.id).then((page) => page.html);
    read.then(
      (text) => live && setLoad({ state: "ready", key: target.key, text }),
      (error: unknown) => live && setLoad({ state: "error", message: message(error) }),
    );
    return () => {
      live = false;
    };
  }, [projectKey, target.key, target.changes]);
  return load;
}

function KindBadge({ kind }: { kind: PreviewTarget["kind"] }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] flex-none items-center rounded-[4px] border-2 border-border px-[4px] font-mono text-[10px] leading-none font-bold text-main-foreground",
        KIND_FILL[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}

function Tabs({
  targets,
  selected,
  fresh,
  onSelect,
}: {
  targets: readonly PreviewTarget[];
  selected: string;
  fresh: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Documents"
      className="flex gap-[6px] overflow-x-auto border-b-2 border-b-border bg-sidebar px-3 py-2"
    >
      {targets.map((target) => {
        const active = target.key === selected;
        return (
          <button
            key={target.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={
              target.source.type === "file" ? target.source.path : `Artifact ${target.source.id}`
            }
            onClick={() => onSelect(target.key)}
            className={cn(
              "relative flex max-w-[220px] flex-none cursor-pointer items-center gap-[6px] rounded-base border-2 border-border bg-raised px-[8px] py-[4px] [font-family:inherit] text-[12.5px] font-semibold text-soft-foreground transition-[transform,box-shadow] duration-100 hover:bg-hover hover:text-foreground motion-reduce:transition-none",
              active && "-translate-y-[1px] bg-background text-foreground shadow-sm-hard",
            )}
          >
            <KindBadge kind={target.kind} />
            {target.source.type === "artifact" && (
              <Icon name="artifacts" size={12} className="flex-none text-dim-foreground" />
            )}
            <span className="min-w-0 truncate">{target.title}</span>
            {target.key === fresh && (
              <span
                key={target.changes}
                aria-hidden="true"
                className="pointer-events-none absolute -inset-[2px] rounded-base animate-tab-fresh motion-reduce:animate-none"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function SourceView({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <pre className="m-0 min-h-full bg-[var(--bg-code)] py-3 font-mono text-[12.5px] leading-[1.65] text-muted-foreground">
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: source lines are positional
        <span key={i} className="flex">
          <span className="w-[52px] flex-none pr-3 text-right text-dim-foreground select-none">
            {i + 1}
          </span>
          <span className="min-w-0 pr-4 whitespace-pre-wrap [overflow-wrap:anywhere]">{line}</span>
        </span>
      ))}
    </pre>
  );
}

function HtmlFrame({ target, html }: { target: PreviewTarget; html: string }) {
  // Read at each render, so a theme switch restyles the frame the next time it draws.
  const page = withAppScrollbar(html, scrollbarTokens());
  return (
    <div className="flex h-full flex-col p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-base border-2 border-border bg-background shadow-shadow">
        <div className="flex items-center gap-[6px] border-b-2 border-b-border bg-sidebar px-3 py-[7px]">
          <span className="size-[10px] rounded-full border-2 border-border bg-fill-err" />
          <span className="size-[10px] rounded-full border-2 border-border bg-fill-warn" />
          <span className="size-[10px] rounded-full border-2 border-border bg-fill-ok" />
          <span className="ml-2 min-w-0 truncate rounded-[4px] border-2 border-border bg-background px-2 py-[1px] font-mono text-[11.5px] text-dim-foreground">
            {target.deployUrl ??
              (target.source.type === "file"
                ? target.source.path
                : `artifact://${target.source.id}`)}
          </span>
        </div>
        <iframe
          title={`Preview of ${target.title}`}
          // No same-origin: the page cannot reach this app. The app's policy keeps its scripts
          // off; Open runs them in the browser.
          sandbox=""
          srcDoc={page}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </div>
    </div>
  );
}

function Body({ target, load, view }: { target: PreviewTarget; load: Load; view: View }) {
  if (load.state === "loading")
    return (
      <div className="p-6">
        <Skeleton lines={8} label={`Loading ${target.title}`} />
      </div>
    );
  if (load.state === "error")
    return (
      <div className="p-6">
        <Alert tone="error" role="alert">
          Could not load {target.title}: {load.message}
        </Alert>
      </div>
    );
  if (view === "source") return <SourceView text={load.text} />;
  if (target.kind === "html") return <HtmlFrame target={target} html={load.text} />;
  return (
    <article className="mx-auto w-full max-w-[760px] px-7 py-6 text-[14.5px] leading-[1.7] text-foreground">
      <Markdown text={load.text} />
    </article>
  );
}

/** The drag handle on the panel's left edge; arrow keys move it too. */
function ResizeHandle({ width, onResize }: { width: number; onResize: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (target: HTMLElement, next: number): number => {
    const row = target.parentElement?.parentElement?.getBoundingClientRect().width ?? 0;
    const max = row > 0 ? Math.max(PREVIEW_MIN_WIDTH, row * MAX_SHARE) : next;
    return Math.round(Math.min(max, Math.max(PREVIEW_MIN_WIDTH, next)));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    onResize(clamp(event.currentTarget, start.current.width + start.current.x - event.clientX));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowLeft" ? KEY_STEP : event.key === "ArrowRight" ? -KEY_STEP : 0;
    if (!step) return;
    event.preventDefault();
    onResize(clamp(event.currentTarget, width + step));
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable separator is the ARIA pattern for a splitter
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the preview"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        start.current = null;
      }}
      onKeyDown={onKeyDown}
      className="group/handle absolute inset-y-0 -left-[5px] z-10 flex w-[10px] cursor-col-resize justify-center outline-none"
    >
      <span className="h-full w-[2px] bg-border transition-[width,background-color] duration-100 group-hover/handle:w-[4px] group-hover/handle:bg-main group-focus-visible/handle:w-[4px] group-focus-visible/handle:bg-main motion-reduce:transition-none" />
    </div>
  );
}

export function PreviewPanel({
  projectKey,
  targets,
  selected,
  fresh,
  width,
  onSelect,
  onResize,
  onClose,
}: {
  projectKey: string;
  targets: readonly PreviewTarget[];
  selected: string | null;
  /** The document the chat changed last, whose tab flashes. */
  fresh: string | null;
  width: number;
  onSelect: (key: string) => void;
  onResize: (width: number) => void;
  onClose: () => void;
}) {
  const target = targets.find((t) => t.key === selected) ?? targets.at(-1);
  const [view, setView] = useState<View>("rendered");
  const [note, setNote] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new document starts rendered
  useEffect(() => {
    setView("rendered");
    setNote(null);
  }, [target?.key]);
  if (!target) return null;
  return (
    <aside
      aria-label="Preview"
      style={{ width }}
      className="relative flex min-h-0 flex-none flex-col border-l-2 border-l-border bg-background animate-panel-in motion-reduce:animate-none"
    >
      <ResizeHandle width={width} onResize={onResize} />
      <header className="flex items-center gap-2 border-b-2 border-b-border bg-background px-3 py-[9px]">
        <Icon name="panel-right" size={15} className="flex-none text-dim-foreground" />
        <h2 className="m-0 text-[14px] font-bold">Preview</h2>
        <span className="text-[12px] text-dim-foreground">
          {targets.length} {targets.length === 1 ? "document" : "documents"}
        </span>
        <button
          type="button"
          className={cn(CHIP_SMALL, "ml-auto")}
          aria-label="Close the preview"
          title="Close the preview"
          onClick={onClose}
        >
          <Icon name="close" size={12} />
        </button>
      </header>
      <Tabs targets={targets} selected={target.key} fresh={fresh} onSelect={onSelect} />
      <Document
        projectKey={projectKey}
        target={target}
        view={view}
        onView={setView}
        note={note}
        onNote={setNote}
      />
    </aside>
  );
}

function Document({
  projectKey,
  target,
  view,
  onView,
  note,
  onNote,
}: {
  projectKey: string;
  target: PreviewTarget;
  view: View;
  onView: (view: View) => void;
  note: string | null;
  onNote: (note: string | null) => void;
}) {
  const load = useDocument(projectKey, target);
  const open = async (): Promise<void> => {
    try {
      const opened =
        target.source.type === "file"
          ? await files.open(projectKey, target.source.path)
          : await artifacts.open(projectKey, target.source.id);
      onNote(opened.opened ? null : `Open ${opened.path} yourself.`);
    } catch (error) {
      onNote(message(error));
    }
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b-2 border-b-border px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold text-foreground">{target.title}</span>
          <span className="truncate font-mono text-[11.5px] text-dim-foreground">
            {target.where}
            {target.created ? " · new" : ""}
            {target.changes > 1 ? ` · changed ${target.changes} times` : ""}
          </span>
        </div>
        <SegmentGroup aria-label="View">
          {(["rendered", "source"] as const).map((v) => (
            <Segment
              key={v}
              aria-pressed={view === v}
              className="min-h-[28px] px-[10px] text-[12px]"
              onClick={() => onView(v)}
            >
              <Icon name={v === "rendered" ? "eye" : "code"} size={12} className="mr-1 inline" />
              {v === "rendered" ? "Preview" : "Source"}
            </Segment>
          ))}
        </SegmentGroup>
        <button
          type="button"
          className={CHIP_SMALL}
          title={
            target.kind === "html"
              ? "Open the page in your browser, with its scripts"
              : "Open the file in its default app"
          }
          onClick={() => void open()}
        >
          <Icon name="external" size={12} />
          Open
        </button>
        {target.deployUrl && (
          <button
            type="button"
            className={CHIP_SMALL}
            title={target.deployUrl}
            onClick={() => void bridge.openExternal(target.deployUrl as string)}
          >
            <Icon name="globe" size={12} />
            Vercel
          </button>
        )}
      </div>
      {note && (
        <p
          className="m-0 border-b-2 border-b-border px-3 py-[6px] text-[12px] text-dim-foreground"
          role="status"
        >
          {note}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          key={`${target.key}:${view}`}
          className="h-full animate-doc-in motion-reduce:animate-none"
        >
          <Body target={target} load={load} view={view} />
        </div>
      </div>
    </>
  );
}

const PREFS_KEY = "baked.chat.preview";
export const PREVIEW_DEFAULT_WIDTH = 520;

/** Whether the panel was left open and its width; per viewer, so only a convenience. */
export interface PreviewPrefs {
  open: boolean;
  width: number;
}

export function loadPreviewPrefs(): PreviewPrefs {
  const fallback = { open: false, width: PREVIEW_DEFAULT_WIDTH };
  try {
    if (typeof localStorage === "undefined") return fallback;
    const saved = JSON.parse(
      localStorage.getItem(PREFS_KEY) ?? "null",
    ) as Partial<PreviewPrefs> | null;
    return {
      open: saved?.open === true,
      width:
        typeof saved?.width === "number" && saved.width >= PREVIEW_MIN_WIDTH
          ? saved.width
          : PREVIEW_DEFAULT_WIDTH,
    };
  } catch {
    return fallback;
  }
}

export function savePreviewPrefs(prefs: PreviewPrefs): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage can be off; the panel still works, it just forgets.
  }
}

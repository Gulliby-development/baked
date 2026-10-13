import { useEffect, useId, useRef, useState } from "react";
import type { DesktopProject } from "../../../shared/api.js";
import type { ChatExportFormat } from "../../../shared/bridge.js";
import {
  type ContextFill,
  chat,
  type SessionDiffStats,
  type SessionState,
  type SessionSummary,
  type Usage,
} from "../../client/chat.js";
import { chatSessionsChanged } from "../../client/chat-sessions.js";
import { Icon } from "../../components/Icon.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Dot, type DotTone } from "../../components/ui/dot.js";
import { ago, tokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import { shortModel } from "./Composer.js";
import {
  CHIP,
  MENU_ITEM,
  MENU_LIST,
  MENU_NOTE,
  POPOVER,
  POPOVER_ROOT,
  Popover,
} from "./Popover.js";

const SESSION_TITLE =
  "inline-flex items-center gap-[6px] min-h-[30px] max-w-[420px] px-2 py-0 border-2 border-transparent rounded-base bg-transparent text-foreground font-[inherit] text-[length:inherit] leading-[inherit] cursor-pointer hover:border-border hover:bg-hover aria-expanded:border-border aria-expanded:bg-hover";
const KV = "flex justify-between gap-3";

const STATE_TONE: Record<SessionState, DotTone> = { idle: "", working: "busy", waiting: "warn" };

/** Export and Delete for the open chat; each `…Disabled` says why the action cannot run, if it cannot. */
export interface ChatManageControl {
  canExport: boolean;
  deleteDisabled: string | null;
  /** Sends the chat's request to the project coordinator; absent when the backend has none. */
  handOff?: () => Promise<void>;
}

function SessionMenu({
  project,
  title,
  currentId,
  manage,
}: {
  project: DesktopProject;
  title: string;
  currentId: string | null;
  manage?: ChatManageControl | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const remove = (): void => {
    if (currentId === null) return;
    setDeleting(true);
    setDeleteError(null);
    chat.remove(project.key, currentId).then(
      () => {
        setDeleting(false);
        setConfirming(false);
        chatSessionsChanged();
        window.location.hash = projectHref(project.key, "chat");
      },
      (e: unknown) => {
        setDeleting(false);
        setDeleteError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  return (
    <>
      <Popover
        label="Chats"
        className={SESSION_TITLE}
        buttonLabel={`${title}, switch chat`}
        button={
          <>
            <h1 className="m-0 text-[15px] font-bold truncate">{title}</h1>
            <Icon name="chevron-down" size={12} />
          </>
        }
      >
        {(close) => (
          <>
            <SessionList project={project} currentId={currentId} close={close} />
            {manage && currentId !== null && (
              <ChatActions
                project={project}
                sessionId={currentId}
                manage={manage}
                onDelete={() => {
                  close();
                  setDeleteError(null);
                  setConfirming(true);
                }}
              />
            )}
          </>
        )}
      </Popover>
      <ConfirmDialog
        open={confirming}
        title="Delete this chat?"
        confirmLabel="Delete chat"
        danger
        busy={deleting}
        error={deleteError}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      >
        “{title}” and its messages are removed from this project. Files the chat edited stay as they
        are. This cannot be undone; export the chat first to keep a copy.
      </ConfirmDialog>
    </>
  );
}

const EXPORTS: { format: ChatExportFormat; label: string }[] = [
  { format: "markdown", label: "Export as Markdown…" },
  { format: "json", label: "Export as JSON…" },
];

function ChatActions({
  project,
  sessionId,
  manage,
  onDelete,
}: {
  project: DesktopProject;
  sessionId: string;
  manage: ChatManageControl;
  onDelete: () => void;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const handOff = (run: () => Promise<void>): void => {
    setSaving(true);
    setNote(null);
    run().then(
      () => setSaving(false),
      (e: unknown) => {
        setSaving(false);
        setNote(`Hand-off failed: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };
  const save = (format: ChatExportFormat): void => {
    setSaving(true);
    setNote(null);
    chat.exportTo(project.key, sessionId, format).then(
      (path) => {
        setSaving(false);
        if (path) setNote(`Saved to ${path}`);
      },
      (e: unknown) => {
        setSaving(false);
        setNote(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };
  return (
    <div className={`${MENU_LIST} w-[320px] mt-1 pt-1 border-t-2 border-t-border`}>
      <p className={LABEL} style={{ padding: "6px 4px 2px" }}>
        This chat
      </p>
      {manage.canExport &&
        EXPORTS.map(({ format, label }) => (
          <button
            key={format}
            type="button"
            className={MENU_ITEM}
            disabled={saving}
            onClick={() => save(format)}
          >
            <Icon name="export" size={13} />
            {label}
          </button>
        ))}
      {manage.handOff && (
        <button
          type="button"
          className={MENU_ITEM}
          disabled={saving}
          title="Send this chat's request to the project coordinator and open it"
          onClick={() => manage.handOff && handOff(manage.handOff)}
        >
          <Icon name="coordinator" size={13} />
          Hand to coordinator
        </button>
      )}
      {note && (
        <p className={cn(MENU_NOTE, "break-all")} role="status">
          {note}
        </p>
      )}
      <button
        type="button"
        className={cn(MENU_ITEM, "disabled:cursor-default disabled:opacity-50")}
        disabled={manage.deleteDisabled !== null}
        title={manage.deleteDisabled ?? undefined}
        onClick={onDelete}
      >
        <Icon name="delete" size={13} />
        Delete chat…
      </button>
    </div>
  );
}

function SessionList({
  project,
  currentId,
  close,
}: {
  project: DesktopProject;
  currentId: string | null;
  close: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    chat.list(project.key, 20).then(
      (list) => live && setSessions(list.sessions),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [project.key]);
  return (
    <div className={`${MENU_LIST} w-[320px]`}>
      <a
        className={buttonVariants({ variant: "primary", size: "md" })}
        href={projectHref(project.key, "chat", "new")}
        onClick={close}
      >
        New chat
      </a>
      <p className={LABEL} style={{ padding: "6px 4px 2px" }}>
        Recent
      </p>
      {error && <p className={MENU_NOTE}>{error}</p>}
      {!sessions && !error && <p className={MENU_NOTE}>Loading…</p>}
      {sessions?.length === 0 && <p className={MENU_NOTE}>No chats yet.</p>}
      {sessions?.map((s) => (
        <a
          key={s.id}
          className={MENU_ITEM}
          href={projectHref(project.key, "chat", s.id)}
          aria-current={s.id === currentId ? "page" : undefined}
          onClick={close}
        >
          <Dot tone={STATE_TONE[s.state]} />
          <span className="flex-1 min-w-0 truncate">{s.title}</span>
          <span className="flex-none text-[12px] text-dim-foreground">{ago(s.updatedAt)}</span>
        </a>
      ))}
    </div>
  );
}

function Ring({ percent }: { percent: number }) {
  const r = 6;
  const length = 2 * Math.PI * r;
  const filled = Math.min(1, Math.max(0, percent / 100)) * length;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="stroke-[var(--line)]" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2.5"
        className={percent >= 80 ? "stroke-[var(--warn)]" : "stroke-[var(--accent)]"}
        strokeDasharray={`${filled} ${length}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

/** "Compact now" in the context panel; `disabled` says why it cannot run, if it cannot. */
export interface CompactControl {
  run: () => void;
  disabled: string | null;
}

/** Watch files in the header: saved `baked!` and `baked?` comments start turns in this chat. */
export interface WatchControl {
  on: boolean;
  toggle: () => void;
  /** The tooltip: what watching does, or where the watch is now. */
  title: string;
  disabled: boolean;
}

function WatchChip({ watch }: { watch: WatchControl }) {
  return (
    <button
      type="button"
      className={cn(
        REWIND_CHIP,
        watch.on && "bg-main text-main-foreground hover:bg-main hover:text-main-foreground",
      )}
      aria-pressed={watch.on}
      disabled={watch.disabled}
      title={watch.title}
      onClick={watch.toggle}
    >
      <Icon name="eye" size={13} />
      {watch.on ? "Watching files" : "Watch files"}
    </button>
  );
}

/** Undo and Redo in the header; each `disabled` says why the action cannot run, if it cannot. */
export interface RewindControl {
  undo: () => void;
  redo: () => void;
  undoDisabled: string | null;
  redoDisabled: string | null;
  /** The prompt of the turn Redo puts back. */
  redoPrompt: string | null;
}

const REWIND_CHIP = `${CHIP} disabled:cursor-default disabled:bg-raised disabled:text-soft-foreground disabled:opacity-50 disabled:shadow-none disabled:hover:bg-raised disabled:hover:text-soft-foreground disabled:hover:shadow-none`;

function RewindChips({ rewind }: { rewind: RewindControl }) {
  return (
    <>
      <button
        type="button"
        className={REWIND_CHIP}
        disabled={rewind.undoDisabled !== null}
        title={rewind.undoDisabled ?? "Undo the last turn: drop it and restore the files it edited"}
        onClick={rewind.undo}
      >
        <Icon name="undo" size={13} />
        Undo
      </button>
      <button
        type="button"
        className={REWIND_CHIP}
        disabled={rewind.redoDisabled !== null}
        title={
          rewind.redoDisabled ??
          `Redo${rewind.redoPrompt ? ` "${rewind.redoPrompt}"` : " the undone turn"} and its file edits`
        }
        onClick={rewind.redo}
      >
        <Icon name="redo" size={13} />
        Redo
      </button>
    </>
  );
}

/** Context fill; expands on hover or focus with the breakdown the API gives. */
function ContextChip({
  context,
  usage,
  model,
  compact,
}: {
  context: ContextFill | null;
  usage: Usage;
  model: string | null;
  compact?: CompactControl | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = (): void => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(true);
  };
  // A short delay lets the pointer cross the gap between the chip and its panel.
  const hide = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 150);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <div className={POPOVER_ROOT}>
      <button
        type="button"
        className={CHIP}
        aria-expanded={open}
        aria-controls={id}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <Ring percent={context?.percent ?? 0} />
        {context ? `${context.percent}% context` : "Context"}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label="Context"
          className={`${POPOVER} top-[calc(100%+6px)] right-0 w-[280px] p-[14px]`}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <p className={LABEL}>Context</p>
          {context ? (
            <div className={KV}>
              <span>Used</span>
              <span className="font-mono">
                {tokens(context.usedTokens)} of {tokens(context.windowTokens)}
              </span>
            </div>
          ) : (
            <p className={MENU_NOTE}>Known after the next turn.</p>
          )}
          <p className={LABEL}>Session tokens</p>
          <div className={KV}>
            <span>Input</span>
            <span className="font-mono">{tokens(usage.input)}</span>
          </div>
          <div className={KV}>
            <span>Cache read</span>
            <span className="font-mono">{tokens(usage.cacheRead)}</span>
          </div>
          <div className={KV}>
            <span>Output</span>
            <span className="font-mono">{tokens(usage.output)}</span>
          </div>
          <div className={`${KV} border-t-2 border-t-border pt-2 font-bold`}>
            <span className="inline-flex items-center gap-[6px]">
              <Icon name="model" size={13} />
              Model
            </span>
            <span className="font-mono">{shortModel(model)}</span>
          </div>
          {compact && (
            <div className="mt-[10px] flex flex-col items-start gap-1">
              <Button
                size="sm"
                variant="neutral"
                disabled={compact.disabled !== null}
                onClick={compact.run}
              >
                <Icon name="compact" size={13} />
                Compact now
              </Button>
              <p className={cn(MENU_NOTE, "m-0")}>
                {compact.disabled ??
                  "Summarizes the older messages to free context; recent ones stay as they are."}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilesChip({ files }: { files: string[] }) {
  if (files.length === 0) return null;
  return (
    <Popover
      label="Files edited"
      align="right"
      button={`${files.length} file${files.length === 1 ? "" : "s"} changed`}
    >
      {() => (
        <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[12px]">
          {files.map((file) => (
            <li key={file} className="font-mono">
              {file}
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

const STATUS_NOTE: Record<string, string> = {
  added: "new",
  deleted: "deleted",
  unchanged: "no change now",
  outside: "outside the project",
  unknown: "",
};

/** Lines added and removed in the files the chat edited, against the last commit. */
function DiffChip({ diff }: { diff: SessionDiffStats }) {
  if (diff.files.length === 0) return null;
  const { totals } = diff;
  const counted = diff.base !== null;
  return (
    <Popover
      label="Changes"
      align="right"
      buttonLabel={`${totals.files} files changed${counted ? `, ${totals.added} lines added, ${totals.removed} removed` : ""}`}
      button={
        counted ? (
          <>
            <span className="font-mono text-[var(--ok)]">+{totals.added}</span>
            <span className="font-mono text-[var(--err)]">−{totals.removed}</span>
            <span>
              {totals.files} file{totals.files === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          `${totals.files} file${totals.files === 1 ? "" : "s"} changed`
        )
      }
    >
      {() => (
        <>
          <p className={LABEL}>{counted ? "Changes since the last commit" : "Files edited"}</p>
          <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[12px] min-w-[300px] max-w-[460px]">
            {diff.files.map((file) => (
              <li
                key={file.path}
                className={cn(
                  "flex items-baseline gap-2",
                  (file.status === "unchanged" || file.status === "outside") &&
                    "text-dim-foreground",
                )}
              >
                <span className="font-mono flex-1 min-w-0 truncate" title={file.path}>
                  {file.path}
                </span>
                {STATUS_NOTE[file.status] ? (
                  <span className="text-dim-foreground">{STATUS_NOTE[file.status]}</span>
                ) : null}
                {counted && file.status !== "unchanged" && file.status !== "outside" && (
                  <span className="font-mono">
                    {file.binary ? (
                      "binary"
                    ) : (
                      <>
                        <span className="text-[var(--ok)]">+{file.added}</span>{" "}
                        <span className="text-[var(--err)]">−{file.removed}</span>
                      </>
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}

function WorkingSetChip({ project }: { project: DesktopProject }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    chat.project(project.key).then(
      (summary) => live && setCount(summary.workingSet.files.length),
      () => live && setCount(null),
    );
    return () => {
      live = false;
    };
  }, [project.key]);
  if (count === null) return null;
  return (
    <a className={CHIP} href={projectHref(project.key, "context", "files")}>
      working set · {count}
    </a>
  );
}

export function ChatHeader({
  project,
  title,
  sessionId,
  context,
  usage,
  model,
  filesEdited,
  diff,
  compact,
  rewind,
  watch,
  manage,
  coordinator = false,
}: {
  project: DesktopProject;
  title: string;
  sessionId: string | null;
  /** The project coordinator: one conversation, so no chat switcher and no New chat. */
  coordinator?: boolean;
  context?: ContextFill | null;
  usage?: Usage;
  model?: string | null;
  filesEdited?: string[];
  /** Line counts when the server offers them; the edited file names are shown otherwise. */
  diff?: SessionDiffStats | null;
  compact?: CompactControl;
  rewind?: RewindControl;
  watch?: WatchControl;
  manage?: ChatManageControl;
}) {
  return (
    <header className="flex flex-wrap items-center gap-[10px] px-6 py-[10px] border-b-2 border-b-border bg-background">
      <a
        className="text-[13px] text-dim-foreground no-underline max-w-[320px] truncate hover:text-soft-foreground"
        href={projectHref(project.key)}
        title={project.path}
      >
        {project.name} · {project.path}
      </a>
      <span className="text-[var(--line-strong)]" aria-hidden="true">
        /
      </span>
      {coordinator ? (
        <h1 className="m-0 px-2 text-[15px] font-bold truncate">{title}</h1>
      ) : (
        <SessionMenu project={project} title={title} currentId={sessionId} manage={manage} />
      )}
      <div className="ml-auto flex flex-wrap gap-[6px] [@media(max-width:720px)]:ml-0">
        {usage && (
          <ContextChip
            context={context ?? null}
            usage={usage}
            model={model ?? null}
            compact={compact}
          />
        )}
        {diff ? <DiffChip diff={diff} /> : filesEdited && <FilesChip files={filesEdited} />}
        <WorkingSetChip project={project} />
        {rewind && <RewindChips rewind={rewind} />}
        {watch && <WatchChip watch={watch} />}
        {sessionId !== null && !coordinator && (
          <a className={CHIP} href={projectHref(project.key, "chat", "new")}>
            <Icon name="new" size={13} />
            New chat
          </a>
        )}
      </div>
    </header>
  );
}

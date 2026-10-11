import { useEffect, useId, useRef, useState } from "react";
import type { DesktopProject } from "../../../shared/api.js";
import {
  type ContextFill,
  chat,
  type SessionState,
  type SessionSummary,
  type Usage,
} from "../../client/chat.js";
import { Icon } from "../../components/Icon.js";
import { buttonVariants } from "../../components/ui/button.js";
import { Dot, type DotTone } from "../../components/ui/dot.js";
import { ago, tokens } from "../../format.js";
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

function SessionMenu({
  project,
  title,
  currentId,
}: {
  project: DesktopProject;
  title: string;
  currentId: string | null;
}) {
  return (
    <Popover
      label="Chats"
      className={SESSION_TITLE}
      buttonLabel={`${title}, switch chat`}
      button={
        <>
          <h1 className="m-0 text-[15px] font-bold truncate">{title}</h1>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </>
      }
    >
      {(close) => <SessionList project={project} currentId={currentId} close={close} />}
    </Popover>
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
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className="ring">
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

/** Context fill; expands on hover or focus with the breakdown the API gives. */
function ContextChip({
  context,
  usage,
  model,
}: {
  context: ContextFill | null;
  usage: Usage;
  model: string | null;
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
            <span>Model</span>
            <span className="font-mono">{shortModel(model)}</span>
          </div>
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
    <a className={CHIP} href={projectHref(project.key, "working-set")}>
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
}: {
  project: DesktopProject;
  title: string;
  sessionId: string | null;
  context?: ContextFill | null;
  usage?: Usage;
  model?: string | null;
  filesEdited?: string[];
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
      <SessionMenu project={project} title={title} currentId={sessionId} />
      <div className="ml-auto flex flex-wrap gap-[6px] [@media(max-width:720px)]:ml-0">
        {usage && <ContextChip context={context ?? null} usage={usage} model={model ?? null} />}
        {filesEdited && <FilesChip files={filesEdited} />}
        <WorkingSetChip project={project} />
        {sessionId !== null && (
          <a className={CHIP} href={projectHref(project.key, "chat", "new")}>
            <Icon name="plus" size={13} />
            New chat
          </a>
        )}
      </div>
    </header>
  );
}

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
import { setSidebarExpanded, useSidebarExpanded } from "../../components/rail-state.js";
import { ago, tokens } from "../../format.js";
import { projectHref } from "../../router.js";
import { shortModel } from "./Composer.js";
import { Popover } from "./Popover.js";

const STATE_TONE: Record<SessionState, string> = { idle: "", working: "busy", waiting: "warn" };

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
      label="Sessions"
      className="session-title"
      buttonLabel={`${title}, switch session`}
      button={
        <>
          <h1>{title}</h1>
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
    <div className="menu-list sessions">
      <a className="btn-primary" href={projectHref(project.key, "chat", "new")} onClick={close}>
        New session
      </a>
      <p className="label" style={{ padding: "6px 4px 2px" }}>
        Recent
      </p>
      {error && <p className="menu-note">{error}</p>}
      {!sessions && !error && <p className="menu-note">Loading…</p>}
      {sessions?.length === 0 && <p className="menu-note">No sessions yet.</p>}
      {sessions?.map((s) => (
        <a
          key={s.id}
          className="menu-item"
          href={projectHref(project.key, "chat", s.id)}
          aria-current={s.id === currentId ? "page" : undefined}
          onClick={close}
        >
          <span className={`dot ${STATE_TONE[s.state]}`} />
          <span className="menu-item-title">{s.title}</span>
          <span className="muted menu-item-time">{ago(s.updatedAt)}</span>
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
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2.5" className="ring-track" />
      <circle
        cx="8"
        cy="8"
        r={r}
        fill="none"
        strokeWidth="2.5"
        className={`ring-fill${percent >= 80 ? " high" : ""}`}
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
    <div className="popover-root">
      <button
        type="button"
        className="chip"
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
          className="popover context-pop"
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <p className="label">Context</p>
          {context ? (
            <div className="kv">
              <span>Used</span>
              <span className="mono">
                {tokens(context.usedTokens)} of {tokens(context.windowTokens)}
              </span>
            </div>
          ) : (
            <p className="menu-note">Known after the next turn.</p>
          )}
          <p className="label">Session tokens</p>
          <div className="kv">
            <span>Input</span>
            <span className="mono">{tokens(usage.input)}</span>
          </div>
          <div className="kv">
            <span>Cache read</span>
            <span className="mono">{tokens(usage.cacheRead)}</span>
          </div>
          <div className="kv">
            <span>Output</span>
            <span className="mono">{tokens(usage.output)}</span>
          </div>
          <div className="kv total">
            <span>Model</span>
            <span className="mono">{shortModel(model)}</span>
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
        <ul className="file-list">
          {files.map((file) => (
            <li key={file} className="mono">
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
    <a className="chip" href={projectHref(project.key, "working-set")}>
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
  const expanded = useSidebarExpanded();
  return (
    <header className="chat-head">
      {expanded && (
        <button
          type="button"
          className="chip icon"
          aria-label="Collapse the sidebar"
          title="Collapse the sidebar"
          onClick={() => setSidebarExpanded(false)}
        >
          <Icon name="panel" size={14} />
        </button>
      )}
      <a className="crumb" href={projectHref(project.key)} title={project.path}>
        {project.name} · {project.path}
      </a>
      <span className="crumb-sep" aria-hidden="true">
        /
      </span>
      <SessionMenu project={project} title={title} currentId={sessionId} />
      <div className="chat-chips">
        {usage && <ContextChip context={context ?? null} usage={usage} model={model ?? null} />}
        {filesEdited && <FilesChip files={filesEdited} />}
        <WorkingSetChip project={project} />
      </div>
    </header>
  );
}

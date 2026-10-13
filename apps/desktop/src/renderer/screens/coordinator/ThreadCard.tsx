import { useEffect, useReducer, useState } from "react";
import { ApiError } from "../../client/api.js";
import { chat } from "../../client/chat.js";
import { Icon } from "../../components/Icon.js";
import { Badge } from "../../components/ui/badge.js";
import { buttonVariants } from "../../components/ui/button.js";
import { tokens as formatTokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { emptyTranscript, reduceTranscript, type Transcript } from "../chat/transcript.js";
import { type ThreadView, threadView } from "./thread.js";

/**
 * Follows a launched session's events, as its own chat screen does, so the coordinator's card for
 * it is live: no polling, the same stream and replay rules.
 */
function useLiveSession(key: string, id: string): { transcript: Transcript; missing: boolean } {
  const [transcript, dispatch] = useReducer(reduceTranscript, undefined, emptyTranscript);
  const [missing, setMissing] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: needsReset restarts the subscription
  useEffect(() => {
    let live = true;
    let stop = (): void => {};
    chat.get(key, id).then(
      (detail) => {
        if (!live) return;
        dispatch({ type: "snapshot", detail });
        stop = chat.subscribe(key, id, detail.lastSeq, (event) => {
          if (live) dispatch(event);
        });
      },
      (error: unknown) => {
        if (live && error instanceof ApiError && error.status === 404) setMissing(true);
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [key, id, transcript.needsReset]);
  return { transcript, missing };
}

const STATE: Record<
  ThreadView["state"],
  { label: string; tone: "ok" | "warn" | "info" | "neutral" | "err"; fill: string }
> = {
  loading: { label: "loading", tone: "neutral", fill: "bg-background" },
  working: { label: "working", tone: "info", fill: "bg-fill-info" },
  waiting: { label: "waiting for you", tone: "warn", fill: "bg-fill-warn" },
  done: { label: "done", tone: "ok", fill: "bg-fill-ok" },
  idle: { label: "idle", tone: "neutral", fill: "bg-background" },
  gone: { label: "deleted", tone: "err", fill: "bg-fill-err" },
};

const MARKS = { pending: "○", active: "◐", done: "✓", skipped: "–" } as const;
const SPINNER_RING =
  "size-3 flex-none rounded-[50%] border-2 border-[var(--line-strong)] border-t-[var(--accent)] animate-spin [animation-duration:0.8s] motion-reduce:animate-none";

/**
 * A session the coordinator launched, drawn in the coordinator's conversation where it was
 * started: a thread card with its live state, what it is doing, its plan and its latest answer.
 */
export function ThreadCard({
  projectKey,
  sessionId,
  title,
  why,
  href,
}: {
  projectKey: string;
  sessionId: string;
  title: string;
  why: string;
  href: string;
}) {
  const { transcript, missing } = useLiveSession(projectKey, sessionId);
  const view = threadView(transcript, missing);
  const state = STATE[view.state];
  const name = transcript.session?.title ?? title;
  return (
    <article
      className="flex min-w-0 flex-col gap-2 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5 shadow-sm-hard animate-rise motion-reduce:animate-none"
      aria-label={`Thread ${name}: ${state.label}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "flex size-8 flex-none items-center justify-center rounded-base border-2 border-border text-main-foreground",
            state.fill,
          )}
          aria-hidden="true"
        >
          <Icon name="chat" size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
              Thread
            </span>
            <Badge tone={state.tone}>{state.label}</Badge>
            {view.tokens > 0 && (
              <span className="font-mono text-[11px] text-dim-foreground">
                {formatTokens(view.tokens)} tokens
              </span>
            )}
          </div>
          <p className="m-0 truncate text-[14px] font-semibold text-foreground" title={sessionId}>
            {name}
          </p>
          {why && why !== name && (
            <p className="m-0 line-clamp-2 text-[13px] text-soft-foreground">{why}</p>
          )}
        </div>
        <a
          href={href}
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "flex-none self-center no-underline",
          )}
        >
          Open
        </a>
      </div>
      {view.plan && (
        <section className="ml-11 flex flex-col gap-0.5" aria-label="Its plan">
          <p className="m-0 font-mono text-[11px] text-dim-foreground">
            {view.plan.done}/{view.plan.steps.length} · {view.plan.title}
          </p>
          <ol className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px]">
            {view.plan.steps.slice(0, 6).map((step) => (
              <li
                key={step.id}
                className={cn(
                  "truncate",
                  step.status === "done" && "text-muted-foreground",
                  step.status === "active" && "font-semibold",
                )}
              >
                <span className="inline-block w-[1.4em] font-mono" aria-hidden="true">
                  {MARKS[step.status]}
                </span>
                {step.label}
              </li>
            ))}
          </ol>
        </section>
      )}
      {view.activity && (
        <p
          className="m-0 ml-11 flex min-w-0 items-center gap-2 text-[13px] text-dim-foreground"
          aria-live="polite"
        >
          {view.state === "working" && <span className={SPINNER_RING} aria-hidden="true" />}
          <span className="min-w-0 truncate">{view.activity}</span>
        </p>
      )}
      {view.answer && view.state !== "working" && (
        <p className="m-0 ml-11 line-clamp-3 whitespace-pre-wrap border-l-[3px] border-l-border pl-3 text-[13px] leading-[1.5] text-foreground">
          {view.answer}
        </p>
      )}
    </article>
  );
}

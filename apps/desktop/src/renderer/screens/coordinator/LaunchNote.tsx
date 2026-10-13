import type { ReactNode } from "react";
import type { LaunchNote } from "../../client/chat.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { Badge } from "../../components/ui/badge.js";
import { buttonVariants } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import {
  type LaunchTone,
  launchKind,
  launchName,
  launchWhy,
  noteTone,
  taskLabel,
} from "./model.js";

const ICONS: Record<LaunchNote["kind"], IconName> = {
  session: "chat",
  run: "runs",
  initiative: "initiatives",
};

const BADGE: Record<LaunchTone, "ok" | "warn" | "err" | "info" | "neutral"> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  busy: "info",
  "": "neutral",
};

const FILL: Record<LaunchTone, string> = {
  ok: "bg-fill-ok",
  warn: "bg-fill-warn",
  err: "bg-fill-err",
  busy: "bg-fill-info",
  "": "bg-background",
};

/**
 * A coordinator's news about work it launched, as a card in its conversation: what the item is,
 * its new status, why it was started, and a way to open it. Replaces the plain notice line.
 */
export function LaunchNoteCard({
  note,
  href,
  actions,
}: {
  note: LaunchNote;
  href?: string;
  /** Stop or Close for the item, on the newest card about it. */
  actions?: ReactNode;
}) {
  const tone = noteTone(note);
  const closed = note.event === "task-closed";
  const name = launchName(note);
  const why = closed ? "" : launchWhy(note);
  const task = note.task && note.task.state !== "local" ? note.task : null;
  return (
    <article
      className="flex min-w-0 items-start gap-3 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5 shadow-sm-hard animate-rise motion-reduce:animate-none"
      aria-label={`${launchKind(note)} ${name}: ${closed ? "task closed" : note.status}`}
    >
      <span
        className={cn(
          "flex size-8 flex-none items-center justify-center rounded-base border-2 border-border text-main-foreground",
          FILL[tone],
        )}
        aria-hidden="true"
      >
        <Icon name={closed ? "ok" : ICONS[note.kind]} size={16} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
            {launchKind(note)}
          </span>
          <Badge tone={BADGE[tone]}>{closed ? "task closed" : note.status}</Badge>
        </div>
        <p className="m-0 truncate text-[14px] font-semibold text-foreground" title={note.id}>
          {name}
        </p>
        {closed ? (
          <p className="m-0 text-[13px] text-soft-foreground">
            Its pull request merged, so{" "}
            {task?.url ? (
              <a href={task.url} target="_blank" rel="noreferrer">
                {taskLabel(task)}
              </a>
            ) : (
              (note.task?.ref ?? "the task")
            )}{" "}
            is closed.
          </p>
        ) : (
          (why || task) && (
            <p className="m-0 line-clamp-2 text-[13px] leading-[1.45] text-soft-foreground">
              {task && (
                <>
                  {task.url ? (
                    <a href={task.url} target="_blank" rel="noreferrer" className="font-mono">
                      {taskLabel(task)}
                    </a>
                  ) : (
                    <span className="font-mono">{taskLabel(task)}</span>
                  )}
                  {why && " · "}
                </>
              )}
              {why}
            </p>
          )
        )}
      </div>
      {actions}
      {href && (
        <a
          href={href}
          className={cn(
            buttonVariants({ variant: "secondary", size: "sm" }),
            "flex-none self-center no-underline",
          )}
        >
          Open
        </a>
      )}
    </article>
  );
}

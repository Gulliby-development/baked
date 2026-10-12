import type { VariantProps } from "class-variance-authority";
import { type ReactNode, useState } from "react";
import type { AttentionItem, RunSnapshot, RunState } from "../../../shared/api.js";
import { attentionHash, attentionId } from "../../../shared/attention.js";
import { api } from "../../client/api.js";
import { isNoProject } from "../../client/setup.js";
import { type ProjectSummary, start } from "../../client/start.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge, type badgeVariants } from "../../components/ui/badge.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { Empty } from "../../components/ui/empty.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { Textarea } from "../../components/ui/textarea.js";
import { ago, tokens, updated, usd } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { useNow } from "../../lib/now.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import { useDesktop } from "../../store.js";
import type { SectionProps } from "../sections.js";
import { type DraftTarget, putDraft } from "./drafts.js";
import { DoctorChecks, message, NOTE, NOTE_ERR, PANEL, useLoad } from "./panels.js";

type Tone = VariantProps<typeof badgeVariants>["tone"];

const RUN_TONE: Record<RunState, Tone> = {
  created: "neutral",
  running: "accent",
  waiting: "warn",
  paused: "neutral",
  blocked: "err",
  completed: "ok",
  failed: "err",
  cancelled: "neutral",
};

const HINT = "text-xs text-dim-foreground";
const LINK =
  "text-sm font-heading text-foreground underline decoration-2 underline-offset-[3px] hover:text-foreground";

function SectionHead({ id, title, children }: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 id={id} className={LABEL}>
        {title}
      </h2>
      {children}
    </div>
  );
}

const ATTENTION_TEXT: Record<string, [string, string]> = {
  approval: ["Approve the spec, plan and tasks", "Review"],
  clarification: ["Answer the run's questions", "Answer"],
  delivery: ["Deliver: commit, push and open a pull request", "Open plan"],
  acceptance: ["Acceptance check to confirm", "Open"],
};

const kb = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024).toLocaleString("en-US")} KB`;

function TaskBox({ projectKey }: { projectKey: string }) {
  const [text, setText] = useState("");
  const go = (target: DraftTarget): void => {
    putDraft(target, projectKey, text);
    window.location.hash =
      target === "chat"
        ? projectHref(projectKey, "chat", "new")
        : projectHref(projectKey, "runs", target === "quick" ? "new-quick" : "new");
  };
  return (
    <Card className="gap-3 px-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          go("quick");
        }}
      >
        <label htmlFor="home-task" className={LABEL}>
          What should change?
        </label>
        <Textarea
          id="home-task"
          rows={2}
          className="min-h-16 resize-y px-[10px] text-[14px]/[1.45] [font-family:inherit]"
          value={text}
          placeholder="Fix the off-by-one in the usage table header"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              go("quick");
            }
          }}
        />
        <div className="flex flex-wrap items-center gap-2.5">
          <Button type="submit">Quick</Button>
          <Button type="button" variant="neutral" onClick={() => go("run")}>
            Full run
          </Button>
          <Button type="button" variant="neutral" onClick={() => go("chat")}>
            Ask in chat
          </Button>
          <span className={cn(HINT, "ml-auto")}>
            Quick plans the change, waits for your approval, then implements, checks and reviews.
          </span>
        </div>
      </form>
    </Card>
  );
}

function NeedsYou({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="home-needs" className="flex flex-col gap-3">
      <SectionHead id="home-needs" title="Needs you">
        <a className={LINK} href="#/attention">
          All {items.length}
        </a>
      </SectionHead>
      {items.slice(0, 4).map((item) => {
        const [title, action] = ATTENTION_TEXT[item.kind] ?? [item.kind, "Open"];
        return (
          <Card
            key={attentionId(item)}
            className={cn(
              "flex-row items-center gap-3.5 px-3.5 py-3",
              item.blocking && "bg-fill-warn text-main-foreground",
            )}
          >
            <span
              className="grid size-8 flex-none place-items-center rounded-full border-2 border-border bg-secondary-background font-mono font-heading text-foreground"
              aria-hidden="true"
            >
              {item.kind === "clarification" ? "?" : item.kind === "delivery" ? "↗" : "!"}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-heading">{title}</span>
              <span className={cn("text-xs", item.blocking ? "opacity-80" : "text-dim-foreground")}>
                {item.featureId ?? item.title ?? item.source} · {item.kind} · waiting{" "}
                {ago(item.createdAt).replace(" ago", "")}
              </span>
            </span>
            <a
              className={cn(
                buttonVariants({ variant: item.blocking ? "default" : "neutral", size: "sm" }),
                "no-underline",
              )}
              href={attentionHash(item)}
            >
              {action}
            </a>
          </Card>
        );
      })}
    </section>
  );
}

function RunsCard({ projectKey }: { projectKey: string }) {
  const runs = useLoad(projectKey, "runs-8", (key) => api.runs(key, 8), 0);
  return (
    <section aria-labelledby="home-runs" className="flex flex-col gap-3">
      <SectionHead id="home-runs" title="Runs in this project">
        <a className={LINK} href={projectHref(projectKey, "runs")}>
          All runs
        </a>
      </SectionHead>
      {runs.error ? (
        <Alert tone="error">{message(runs.error)}</Alert>
      ) : !runs.value ? (
        <Skeleton label="Loading runs" />
      ) : runs.value.items.length === 0 ? (
        <Empty>No workflow runs yet. Describe a change above and pick Quick or Full run.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Run</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="text-right">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.value.items.map((run: RunSnapshot) => (
              <TableRow key={run.runId}>
                <TableCell>
                  <a
                    className="font-heading text-foreground no-underline hover:underline"
                    href={projectHref(projectKey, "runs", run.runId)}
                  >
                    {run.featureId}
                  </a>
                </TableCell>
                <TableCell>
                  <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
                </TableCell>
                <TableCell className="text-soft-foreground">{run.stageId ?? "–"}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {tokens(run.tokenUsage)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {usd(run.estimatedCostUsd)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function SessionsCard({ projectKey, summary }: { projectKey: string; summary: ProjectSummary }) {
  return (
    <section aria-labelledby="home-sessions" className="flex flex-col gap-3">
      <SectionHead id="home-sessions" title="Recent sessions">
        <a className={LINK} href={projectHref(projectKey, "chat")}>
          Chat
        </a>
      </SectionHead>
      {summary.sessions.length === 0 ? (
        <Empty>No chat sessions in this project yet.</Empty>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="m-0 list-none p-0">
            {summary.sessions.slice(0, 5).map((session) => (
              <li key={session.id} className="border-b border-border/60 last:border-0">
                <a
                  className="flex items-center gap-3 px-3.5 py-2.5 text-foreground no-underline hover:bg-secondary-background"
                  href={projectHref(projectKey, "chat", session.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{session.title || "Untitled"}</span>
                  <span className={cn(HINT, "font-mono")}>
                    {session.messageCount} msg · {ago(session.updatedAt)}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function WorkingSetCard({ projectKey, summary }: { projectKey: string; summary: ProjectSummary }) {
  const { entries, files, skipped } = summary.workingSet;
  const total = files.reduce((n, f) => n + f.bytes, 0);
  return (
    <section aria-labelledby="home-ws" className={PANEL}>
      <SectionHead id="home-ws" title="Working set">
        <a
          className={cn(buttonVariants({ variant: "neutral", size: "sm" }), "no-underline")}
          href={projectHref(projectKey, "working-set")}
        >
          Edit
        </a>
      </SectionHead>
      <p className={NOTE}>
        Sent to every new chat and to the research stage, so the agent does not search for them
        again.
      </p>
      {entries.length === 0 ? (
        <p className={NOTE}>Nothing in the working set yet.</p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px]">
            {files.slice(0, 6).map((file) => (
              <li key={file.path} className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
                <span className={cn(HINT, "font-mono")}>{kb(file.bytes)}</span>
              </li>
            ))}
            {skipped.map((entry) => (
              <li key={entry.path} className="flex items-baseline gap-3 text-dim-foreground">
                <span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
                <span className={HINT}>skipped, {entry.reason}</span>
              </li>
            ))}
          </ul>
          <span className={HINT}>
            {entries.length} entr{entries.length === 1 ? "y" : "ies"}, {files.length} file
            {files.length === 1 ? "" : "s"}, {kb(total)}
            {files.length > 6 ? ` · ${files.length - 6} more files` : ""}
          </span>
        </>
      )}
    </section>
  );
}

function DoctorCard({ projectKey }: { projectKey: string }) {
  const doctor = useLoad(projectKey, "doctor", (key) => start.doctor(key));
  const report = doctor.value;
  const now = useNow(doctor.updatedAt === null ? null : 5_000);
  return (
    <section aria-labelledby="home-doctor" className={PANEL}>
      <SectionHead id="home-doctor" title="Doctor">
        {report && (
          <Badge tone={report.ready ? "ok" : "err"}>{report.ready ? "ready" : "not ready"}</Badge>
        )}
      </SectionHead>
      {doctor.error ? (
        <p className={NOTE_ERR}>{message(doctor.error)}</p>
      ) : report ? (
        <DoctorChecks checks={report.checks} limit={4} />
      ) : (
        <p className={NOTE}>Checking…</p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <a className={LINK} href={projectHref(projectKey, "runs", "new")}>
          Open full report
        </a>
        {report && (
          <span className={cn(HINT, "ml-auto flex items-center gap-2")} aria-live="polite">
            {doctor.fetching ? "Checking…" : updated(doctor.updatedAt, now)}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              disabled={doctor.fetching}
              onClick={doctor.refresh}
            >
              Refresh
            </Button>
          </span>
        )}
      </div>
    </section>
  );
}

/** The project home: a task box, what waits for the person, runs, sessions and project setup. */
export function ProjectHome({ project }: SectionProps) {
  const key = project.key;
  const { attention } = useDesktop();
  const summary = useLoad(key, "project", start.summary);
  const waiting = attention.filter((item) => item.projectKey === key);
  const extraRoots = summary.value
    ? summary.value.roots.filter((root) => root !== summary.value?.root)
    : [];
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        {summary.value?.branch && (
          <a href={projectHref(key, "git")} className="no-underline" title="Git branch: open Git">
            <Badge tone="info" className="normal-case tracking-normal">
              {summary.value.branch}
            </Badge>
          </a>
        )}
        {summary.value && summary.value.id.toLowerCase() !== project.name.toLowerCase() && (
          <Badge className="normal-case tracking-normal" title="Project ID">
            {summary.value.id}
          </Badge>
        )}
        {extraRoots.map((root) => (
          <Badge key={root} className="normal-case tracking-normal text-soft-foreground">
            + {root} as extra root
          </Badge>
        ))}
        <span className={HINT}>own sessions, runs, memory and settings</span>
        <a
          className={cn(buttonVariants({ variant: "neutral", size: "sm" }), "ml-auto no-underline")}
          href={projectHref(key, "gates")}
        >
          Project settings
        </a>
      </div>

      <TaskBox projectKey={key} />

      <div className="grid items-start gap-6 [grid-template-columns:minmax(0,1fr)_300px] max-[980px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-6">
          <NeedsYou items={waiting} />
          <RunsCard projectKey={key} />
          {summary.value && <SessionsCard projectKey={key} summary={summary.value} />}
        </div>
        <aside className="flex min-w-0 flex-col gap-5" aria-label="Project setup">
          {summary.error ? (
            <section className={PANEL}>
              <h2 className={LABEL}>Project</h2>
              <p className={NOTE}>
                {isNoProject(summary.error)
                  ? "This folder has no baked/project.json, so it has no working set or project sessions. Run baked project init in the folder to create one."
                  : message(summary.error)}
              </p>
            </section>
          ) : summary.value ? (
            <WorkingSetCard projectKey={key} summary={summary.value} />
          ) : (
            <Skeleton label="Loading the project" />
          )}
          <DoctorCard projectKey={key} />
        </aside>
      </div>
    </div>
  );
}

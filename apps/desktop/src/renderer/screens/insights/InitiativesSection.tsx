import { useState } from "react";
import type { InitiativeView } from "../../client/insights.js";
import { insights } from "../../client/insights.js";
import { tokens } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import {
  featureCounts,
  featureRow,
  initiativeLine,
  initiativeStatus,
  splitApproval,
  type Tone,
} from "./initiative-model.js";
import { LoadState } from "./LoadState.js";
import { useLoad } from "./useLoad.js";

/** Text color of each status tone. */
const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[color:var(--ok)]",
  warn: "text-[color:var(--warn)]",
  err: "text-[color:var(--err)]",
  busy: "text-[color:var(--info)]",
  muted: "text-dim-foreground",
};

/** Feature rows: warnings get a warning border, running features a raised background. */
const FEATURE_TONE: Record<Tone, string> = {
  ok: "border-border bg-background",
  warn: "border-[color:var(--warn)] bg-background",
  err: "border-border bg-background",
  busy: "border-border bg-raised",
  muted: "border-border bg-background",
};

const PANEL =
  "px-[14px] py-3 rounded-[var(--radius-lg)] border-[length:var(--border-w)] border-solid";

function Detail({ projectKey, id }: { projectKey: string; id: string }) {
  const { state, reload } = useLoad(() => insights.initiative(projectKey, id), [projectKey, id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (state.kind !== "ready")
    return (
      <LoadState
        state={state}
        what="This initiative"
        missing="This initiative is not in the project. Pick another from the list."
      />
    );
  const view = state.data;
  const status = initiativeStatus(view.status);
  const counts = featureCounts(view);
  const split = splitApproval(view);
  const act = (run: (v: InitiativeView) => Promise<InitiativeView>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await run(view);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      reload();
    }
  };
  const share = (n: number): string => `${counts.total ? (n / counts.total) * 100 : 0}%`;
  const parts = [
    counts.done && `${counts.done} done`,
    counts.inProgress && `${counts.inProgress} in progress`,
    counts.needsDecision && `${counts.needsDecision} needs decision`,
    counts.blocked && `${counts.blocked} blocked`,
    counts.waiting && `${counts.waiting} waiting`,
  ].filter((p): p is string => typeof p === "string");
  return (
    <section
      className="flex min-w-0 flex-[999_1_480px] flex-col gap-4"
      aria-label={`${view.title} initiative`}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 text-[22px] font-semibold">{view.title}</h2>
        <span
          className={`rounded-[10px] border border-solid border-current px-[9px] py-px text-[12px] font-medium ${TONE_TEXT[status.tone]}`}
        >
          {status.label}
        </span>
        <div className="ml-auto flex gap-2">
          {split && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={act((v) => insights.approveSplit(projectKey, v, split))}
            >
              Approve split
            </button>
          )}
          {view.status === "paused" && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={act((v) => insights.resumeInitiative(projectKey, v))}
            >
              Resume
            </button>
          )}
          {(view.status === "active" || view.status === "decomposing") && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={act((v) => insights.pauseInitiative(projectKey, v))}
            >
              Pause
            </button>
          )}
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {view.goals.map((goal) => (
        <p key={goal} className="m-0 max-w-[760px] text-muted-foreground leading-[1.6]">
          {goal}
        </p>
      ))}
      {counts.total > 0 && (
        <>
          <p className="m-0 flex flex-wrap gap-x-[10px] gap-y-1 text-[13px] text-muted-foreground">
            {parts.flatMap((part, i) => [
              ...(i > 0
                ? [
                    <span
                      key={`sep-${part}`}
                      className="text-[color:var(--line-strong)]"
                      aria-hidden="true"
                    >
                      ·
                    </span>,
                  ]
                : []),
              <span key={part} className={part.includes("decision") ? TONE_TEXT.warn : undefined}>
                {part}
              </span>,
            ])}
          </p>
          <div
            className="flex h-2 max-w-[760px] overflow-hidden rounded-[4px] bg-hover"
            role="img"
            aria-label={`${counts.done} of ${counts.total} features done`}
          >
            <span className="bg-[var(--ok)]" style={{ width: share(counts.done) }} />
            <span className="bg-[var(--accent)]" style={{ width: share(counts.inProgress) }} />
            <span className="bg-[var(--warn)]" style={{ width: share(counts.needsDecision) }} />
            <span className="bg-[var(--err)]" style={{ width: share(counts.blocked) }} />
          </div>
        </>
      )}
      {counts.total === 0 ? (
        <div className="empty">{view.next.message || "No features yet."}</div>
      ) : (
        <ol className="m-0 flex max-w-[900px] list-none flex-col gap-2 p-0" aria-label="Features">
          {view.features.map((feature) => {
            const row = featureRow(feature);
            return (
              <li
                key={feature.id}
                className={`flex flex-wrap items-center gap-3 shadow-sm-hard ${PANEL} ${TONE_TEXT[row.tone]} ${FEATURE_TONE[row.tone]}`}
              >
                <span
                  className={`mono ${row.tone === "busy" ? "text-[color:var(--accent)]" : ""}`}
                  aria-hidden="true"
                >
                  {row.mark}
                </span>
                <span
                  className={`min-w-[200px] flex-1 ${row.tone === "muted" ? "" : "text-foreground"}`}
                >
                  {feature.title}
                </span>
                <span className="text-[12px]">{row.label}</span>
                {feature.usage.tokens > 0 && (
                  <span className="mono text-[12px] text-dim-foreground">
                    {tokens(feature.usage.tokens)}
                  </span>
                )}
                {row.link && feature.runId && (
                  <a
                    className="text-[13px]"
                    href={projectHref(projectKey, "runs", feature.runId)}
                    aria-label={`${row.link}: ${feature.title}`}
                  >
                    {row.link}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="muted m-0 text-[12px]">
        Shared budget: {tokens(view.budget.used.tokens)} of{" "}
        {tokens(view.budget.limits.maxTotalTokens)} tokens · plan revision {view.planRevision}
        {view.next.message && ` · ${view.next.message}`}
      </p>
    </section>
  );
}

export function InitiativesSection({ project, id }: SectionProps) {
  const { state } = useLoad(() => insights.initiatives(project.key), [project.key]);
  if (state.kind !== "ready") return <LoadState state={state} what="Initiatives" />;
  const items = state.data;
  if (items.length === 0)
    return (
      <div className="empty">
        No initiatives in this project yet. Start one with{" "}
        <code className="mono">baked workflow initiative start</code>.
      </div>
    );
  const selected = id ?? items[0]?.initiativeId ?? null;
  return (
    <div className="flex flex-wrap items-start gap-6">
      <nav
        className="flex max-w-[340px] flex-[1_1_260px] flex-col gap-[10px]"
        aria-label="Initiatives"
      >
        {items.map((item) => {
          const tone = initiativeStatus(item.status).tone;
          return (
            <a
              key={item.initiativeId}
              className={`flex flex-col gap-1 ${PANEL} border-border bg-background text-soft-foreground no-underline hover:bg-hover hover:text-soft-foreground aria-[current=page]:bg-hover aria-[current=page]:shadow-sm-hard`}
              href={projectHref(project.key, "initiatives", item.initiativeId)}
              aria-current={item.initiativeId === selected ? "page" : undefined}
            >
              <span className="font-semibold text-foreground">{item.title}</span>
              <span className={`text-[12px] ${TONE_TEXT[tone]}`}>{initiativeLine(item)}</span>
            </a>
          );
        })}
      </nav>
      {selected && <Detail projectKey={project.key} id={selected} />}
    </div>
  );
}

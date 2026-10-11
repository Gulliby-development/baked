import { useEffect, useState } from "react";
import { chat } from "../../client/chat.js";
import type { InitiativeView } from "../../client/insights.js";
import { insights } from "../../client/insights.js";
import { tokens } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import {
  canSwitchModel,
  featureCounts,
  featureRow,
  initiativeLine,
  initiativeStatus,
  splitApproval,
} from "./initiative-model.js";
import { LoadState } from "./LoadState.js";
import { useLoad } from "./useLoad.js";
import "../../styles/insights.css";

/**
 * The initiative's model and a switch to another one: features started later use it, its stopped
 * runs move to it with finished work kept, and the initiative continues.
 */
function ModelSwitch({
  projectKey,
  view,
  onDone,
}: {
  projectKey: string;
  view: InitiativeView;
  onDone: () => void;
}) {
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = canSwitchModel(view);
  useEffect(() => {
    if (!open) return;
    let live = true;
    chat.models(projectKey).then(
      (result) =>
        live &&
        setModels(
          result.providers.filter((p) => p.configured).flatMap((p) => p.models.map((m) => m.id)),
        ),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [projectKey, open]);
  if (view.model === undefined) return null;
  const listId = `initiative-models-${view.initiativeId}`;
  const inputId = `initiative-model-${view.initiativeId}`;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await insights.rerouteInitiative(projectKey, view, model.trim());
      setModel("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="ins-model">
      <p className="small">
        Model <span className="mono">{view.model ?? "default"}</span>
      </p>
      {open && (
        <form
          className="stack-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) void submit();
          }}
        >
          <label htmlFor={inputId} className="field-label">
            Switch the initiative to model
          </label>
          <input
            id={inputId}
            type="text"
            list={listId}
            value={model}
            placeholder="provider/model"
            onChange={(e) => setModel(e.target.value)}
          />
          <datalist id={listId}>
            {models.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          {error && <div className="banner error">{error}</div>}
          <button
            type="submit"
            className="btn"
            disabled={busy || !model.trim() || model.trim() === view.model}
          >
            Switch model
          </button>
        </form>
      )}
    </div>
  );
}

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
    <section className="ins-detail" aria-label={`${view.title} initiative`}>
      <div className="ins-head">
        <h2>{view.title}</h2>
        <span className={`ins-pill tone-${status.tone}`}>{status.label}</span>
        <div className="ins-actions">
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
        <p key={goal} className="ins-goal">
          {goal}
        </p>
      ))}
      {counts.total > 0 && (
        <>
          <p className="ins-counts">
            {parts.flatMap((part, i) => [
              ...(i > 0
                ? [
                    <span key={`sep-${part}`} className="ins-sep" aria-hidden="true">
                      ·
                    </span>,
                  ]
                : []),
              <span key={part} className={part.includes("decision") ? "tone-warn" : undefined}>
                {part}
              </span>,
            ])}
          </p>
          <div
            className="ins-progress"
            role="img"
            aria-label={`${counts.done} of ${counts.total} features done`}
          >
            <span className="bg-ok" style={{ width: share(counts.done) }} />
            <span className="bg-accent" style={{ width: share(counts.inProgress) }} />
            <span className="bg-warn" style={{ width: share(counts.needsDecision) }} />
            <span className="bg-err" style={{ width: share(counts.blocked) }} />
          </div>
        </>
      )}
      {counts.total === 0 ? (
        <div className="empty">{view.next.message || "No features yet."}</div>
      ) : (
        <ol className="ins-features" aria-label="Features">
          {view.features.map((feature) => {
            const row = featureRow(feature);
            return (
              <li key={feature.id} className={`ins-feature tone-${row.tone}`}>
                <span className="ins-mark mono" aria-hidden="true">
                  {row.mark}
                </span>
                <span className="ins-title">{feature.title}</span>
                <span className="ins-state">{row.label}</span>
                {feature.usage.tokens > 0 && (
                  <span className="ins-tokens mono">{tokens(feature.usage.tokens)}</span>
                )}
                {row.link && feature.runId && (
                  <a
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
      <ModelSwitch projectKey={projectKey} view={view} onDone={reload} />
      <p className="ins-budget muted">
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
    <div className="ins-layout">
      <nav className="ins-list" aria-label="Initiatives">
        {items.map((item) => {
          const tone = initiativeStatus(item.status).tone;
          return (
            <a
              key={item.initiativeId}
              className="ins-item"
              href={projectHref(project.key, "initiatives", item.initiativeId)}
              aria-current={item.initiativeId === selected ? "page" : undefined}
            >
              <span className="ins-item-title">{item.title}</span>
              <span className={`ins-item-line tone-${tone}`}>{initiativeLine(item)}</span>
            </a>
          );
        })}
      </nav>
      {selected && <Detail projectKey={project.key} id={selected} />}
    </div>
  );
}

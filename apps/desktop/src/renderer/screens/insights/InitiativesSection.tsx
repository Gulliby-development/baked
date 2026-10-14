import { useId, useState } from "react";
import { chat } from "../../client/chat.js";
import type { FeatureSize, InitiativeFeature, InitiativeView } from "../../client/insights.js";
import { insights } from "../../client/insights.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { ModelPicker, useModelCatalog } from "../../components/ui/model-picker.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Textarea } from "../../components/ui/textarea.js";
import { tokens } from "../../format.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { putDraft } from "../start/drafts.js";
import {
  ExtendDialog,
  FormDialog,
  MergeDialog,
  RejectDialog,
  RenameDialog,
  SplitDialog,
  WorkflowDialog,
} from "./InitiativeDialogs.js";
import {
  COORDINATOR_INITIATIVE_PREFIX,
  canEditSplit,
  canExtendBudget,
  canRemoveFeature,
  canReplanFeature,
  canSplitFeature,
  canSwitchModel,
  configurableFeatures,
  featureCounts,
  featureRow,
  featureSteps,
  featureWorkflow,
  initiativeLine,
  initiativeStatus,
  splitApproval,
  type Tone,
} from "./initiative-model.js";
import { LoadState } from "./LoadState.js";
import { NewInitiativeDialog } from "./NewInitiativeDialog.js";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = canSwitchModel(view);
  const models = useModelCatalog(open ? projectKey : null, chat.models);
  if (view.model === undefined) return null;
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
    <div className="flex max-w-[360px] flex-col gap-1.5">
      <p className="m-0 text-[12px]">
        Model <span className="font-mono">{view.model ?? "default"}</span>
      </p>
      {open && (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) void submit();
          }}
        >
          <label htmlFor={inputId} className="text-[12px] text-dim-foreground">
            Switch the initiative to model
          </label>
          <ModelPicker
            id={inputId}
            value={model}
            onChange={setModel}
            catalog={models.catalog}
            error={models.error}
          />
          {error && <Alert tone="error">{error}</Alert>}
          <Button
            type="submit"
            variant="secondary"
            size="md"
            disabled={busy || !model.trim() || model.trim() === view.model}
          >
            Switch model
          </Button>
        </form>
      )}
    </div>
  );
}

/** The dialog the initiative detail shows, if any. */
type Open =
  | { kind: "reject" | "merge" | "extend" }
  | { kind: "rename" | "split" | "remove" | "replan" | "workflow"; feature: InitiativeFeature };

/** The actions of one feature row: split edits while the split is editable, then re-plan. */
function FeatureActions({
  view,
  feature,
  open,
}: {
  view: InitiativeView;
  feature: InitiativeFeature;
  open: (dialog: Open) => void;
}) {
  const editable = canEditSplit(view);
  const replan = canReplanFeature(view, feature);
  if (!editable && !replan) return null;
  const action = (kind: "rename" | "split" | "remove" | "replan" | "workflow", label: string) => (
    <Button
      variant="secondary"
      size="sm"
      className="h-7 shadow-none"
      aria-label={`${label}: ${feature.title}`}
      onClick={() => open({ kind, feature })}
    >
      {label}
    </Button>
  );
  return (
    <span className="flex flex-wrap gap-1.5">
      {editable && configurableFeatures(view) && action("workflow", "Workflow")}
      {editable && action("rename", "Rename")}
      {editable && canSplitFeature(view) && action("split", "Split")}
      {editable && canRemoveFeature(view) && action("remove", "Remove")}
      {replan && action("replan", "Re-plan")}
    </span>
  );
}

const SIZES: readonly FeatureSize[] = ["small", "medium", "large"];

/** One feature on the board: what it is, the workflow it runs, where it stands and what to do. */
function FeatureCard({
  projectKey,
  view,
  feature,
  picked,
  busy,
  onPick,
  onSize,
  open,
}: {
  projectKey: string;
  view: InitiativeView;
  feature: InitiativeFeature;
  /** Whether it is selected for a merge; null while the split cannot be edited. */
  picked: boolean | null;
  busy: boolean;
  onPick: (on: boolean) => void;
  onSize: (size: FeatureSize) => void;
  open: (dialog: Open) => void;
}) {
  const row = featureRow(feature);
  const configurable = picked !== null && configurableFeatures(view);
  return (
    <li
      className={`flex flex-col gap-2 shadow-sm-hard ${PANEL} ${TONE_TEXT[row.tone]} ${FEATURE_TONE[row.tone]}`}
      aria-label={feature.title}
    >
      <div className="flex items-start gap-2">
        {picked !== null && (
          <input
            type="checkbox"
            className="mt-[3px] size-4"
            checked={picked}
            aria-label={`Select ${feature.title} to merge`}
            onChange={(e) => onPick(e.target.checked)}
          />
        )}
        <span
          className={`font-mono ${row.tone === "busy" ? "text-[color:var(--accent)]" : ""}`}
          aria-hidden="true"
        >
          {row.mark}
        </span>
        <span className={`min-w-0 flex-1 ${row.tone === "muted" ? "" : "text-foreground"}`}>
          {feature.title}
          {!feature.mandatory && <span className="text-dim-foreground"> (optional)</span>}
          <span className="block font-mono text-[12px] text-dim-foreground">{feature.id}</span>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={featureWorkflow(view, feature) === "sdd" ? "neutral" : "info"}>
          {featureWorkflow(view, feature)}
        </Badge>
        {feature.size && !configurable && <Badge>{feature.size}</Badge>}
        <span className="text-[12px]">{row.label}</span>
      </div>
      {configurable && feature.size && (
        <SegmentGroup aria-label={`Size of ${feature.title}`}>
          {SIZES.map((size) => (
            <Segment
              key={size}
              className="min-h-[26px] px-[10px] text-[12px]"
              aria-pressed={feature.size === size}
              disabled={busy}
              onClick={() => feature.size !== size && onSize(size)}
            >
              {size}
            </Segment>
          ))}
        </SegmentGroup>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {feature.usage.tokens > 0 && (
          <span className="font-mono text-dim-foreground">{tokens(feature.usage.tokens)} used</span>
        )}
        {feature.share && feature.usage.tokens === 0 && (
          <span className="font-mono text-dim-foreground">
            starts with {tokens(feature.share.tokens)}
          </span>
        )}
        {feature.issue && (
          <a
            className="font-mono"
            href={feature.issue.url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Issue of ${feature.title}`}
          >
            {`${feature.issue.repository}#${feature.issue.number}`}
          </a>
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
      </div>
      <FeatureActions view={view} feature={feature} open={open} />
    </li>
  );
}

/**
 * The features as a board: one column per step of the dependency graph, so a column starts once
 * the columns to its left are done, and features in one column can run side by side.
 */
function FeatureBoard({
  projectKey,
  view,
  selected,
  busy,
  onPick,
  onSize,
  open,
}: {
  projectKey: string;
  view: InitiativeView;
  /** Features selected for a merge; null while the split cannot be edited. */
  selected: readonly string[] | null;
  busy: boolean;
  onPick: (featureId: string, on: boolean) => void;
  onSize: (feature: InitiativeFeature, size: FeatureSize) => void;
  open: (dialog: Open) => void;
}) {
  const steps = featureSteps(view.features);
  return (
    <section
      className="grid auto-cols-[minmax(240px,1fr)] grid-flow-col gap-4 overflow-x-auto pb-2"
      aria-label="Features"
    >
      {steps.map((column, index) => (
        <section key={column[0]?.id ?? index} className="flex min-w-0 flex-col gap-2">
          <h3 className="m-0 font-mono text-[11px] font-semibold uppercase tracking-wider text-dim-foreground">
            {index === 0 ? "Step 1 · starts first" : `Step ${index + 1} · after step ${index}`}
          </h3>
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {column.map((feature) => (
              <FeatureCard
                key={feature.id}
                projectKey={projectKey}
                view={view}
                feature={feature}
                picked={selected ? selected.includes(feature.id) : null}
                busy={busy}
                onPick={(on) => onPick(feature.id, on)}
                onSize={(size) => onSize(feature, size)}
                open={open}
              />
            ))}
          </ol>
        </section>
      ))}
    </section>
  );
}

function Detail({ projectKey, id }: { projectKey: string; id: string }) {
  const { state, reload } = useLoad(
    () => insights.initiative(projectKey, id),
    [projectKey, "initiative", id],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Open | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
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
  const editable = canEditSplit(view);
  // In split order, so a merge without an ID keeps the first feature's ID.
  const selected = editable
    ? view.features.map((f) => f.id).filter((fid) => picked.includes(fid))
    : [];
  const close = (done: boolean): void => {
    setDialog(null);
    if (done) {
      setPicked([]);
      reload();
    }
  };
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
            <Button
              variant="primary"
              size="md"
              disabled={busy}
              onClick={act((v) => insights.approveSplit(projectKey, v, split))}
            >
              Approve split
            </Button>
          )}
          {split && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => setDialog({ kind: "reject" })}
            >
              Reject split
            </Button>
          )}
          {view.status === "paused" && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={act((v) => insights.resumeInitiative(projectKey, v))}
            >
              Resume
            </Button>
          )}
          {(view.status === "active" || view.status === "decomposing") && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={act((v) => insights.pauseInitiative(projectKey, v))}
            >
              Pause
            </Button>
          )}
        </div>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
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
      {editable && counts.total > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            disabled={busy || selected.length < 2}
            onClick={() => setDialog({ kind: "merge" })}
          >
            Merge selected{selected.length > 0 ? ` (${selected.length})` : ""}
          </Button>
          <span className="text-[12px] text-dim-foreground">
            {view.status === "awaiting_approval"
              ? "Edit the split before you approve it; each edit makes a new plan revision to approve."
              : "The initiative is paused, so its split can be edited; started features keep their runs."}
          </span>
        </div>
      )}
      {counts.total === 0 ? (
        <Empty>{view.next.message || "No features yet."}</Empty>
      ) : (
        <FeatureBoard
          projectKey={projectKey}
          view={view}
          selected={editable ? selected : null}
          busy={busy}
          onPick={(fid, on) =>
            setPicked(on ? [...selected, fid] : selected.filter((other) => other !== fid))
          }
          onSize={(feature, size) =>
            void act((v) => insights.configureFeature(projectKey, v, feature.id, { size }))()
          }
          open={setDialog}
        />
      )}
      <ModelSwitch projectKey={projectKey} view={view} onDone={reload} />
      <div className="flex flex-wrap items-center gap-3">
        <p className="m-0 text-[12px] text-dim-foreground">
          Shared budget: {tokens(view.budget.used.tokens)} of{" "}
          {tokens(view.budget.limits.maxTotalTokens)} tokens · plan revision {view.planRevision}
          {(view.parallelRuns ?? 1) > 1 && ` · up to ${view.parallelRuns} features at once`}
          {view.next.message && ` · ${view.next.message}`}
        </p>
        {canExtendBudget(view) && (
          <Button
            variant="secondary"
            size="sm"
            className="h-7 shadow-none"
            disabled={busy}
            onClick={() => setDialog({ kind: "extend" })}
          >
            Extend budget
          </Button>
        )}
      </div>
      {dialog?.kind === "reject" && split && (
        <RejectDialog projectKey={projectKey} view={view} decision={split} onClose={close} />
      )}
      {dialog?.kind === "merge" && (
        <MergeDialog projectKey={projectKey} view={view} selected={selected} onClose={close} />
      )}
      {dialog?.kind === "extend" && (
        <ExtendDialog projectKey={projectKey} view={view} onClose={close} />
      )}
      {dialog?.kind === "rename" && (
        <RenameDialog
          projectKey={projectKey}
          view={view}
          feature={dialog.feature}
          onClose={close}
        />
      )}
      {dialog?.kind === "workflow" && (
        <WorkflowDialog
          projectKey={projectKey}
          view={view}
          feature={dialog.feature}
          onClose={close}
        />
      )}
      {dialog?.kind === "split" && (
        <SplitDialog projectKey={projectKey} view={view} feature={dialog.feature} onClose={close} />
      )}
      {dialog?.kind === "remove" && (
        <FormDialog
          title="Remove feature"
          description={
            <>
              Removes <span className="font-mono">{dialog.feature.id}</span> ({dialog.feature.title}
              ) from the split. Features that depended on it lose that dependency.
            </>
          }
          submitLabel="Remove"
          danger
          onSubmit={() => insights.removeFeature(projectKey, view, dialog.feature.id)}
          onClose={close}
        />
      )}
      {dialog?.kind === "replan" && (
        <FormDialog
          title="Re-plan feature"
          description={
            <>
              Supersedes the run of <span className="font-mono">{dialog.feature.id}</span> with a
              new one under the approved plan. The new run starts from its plan again.
            </>
          }
          submitLabel="Re-plan"
          onSubmit={() => insights.replanFeature(projectKey, view, dialog.feature.id)}
          onClose={close}
        />
      )}
    </section>
  );
}

/**
 * Where an initiative starts: the person describes the big idea and the coordinator plans it as
 * an initiative, so it can ask what is unclear first. Starting without the coordinator opens the
 * full form (workflow, model, budget, tiered approval).
 */
function IdeaBox({
  projectKey,
  onDirect,
  onCancel,
}: {
  projectKey: string;
  onDirect: () => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const [idea, setIdea] = useState("");
  const plan = (): void => {
    putDraft("coordinator", projectKey, `${COORDINATOR_INITIATIVE_PREFIX}${idea.trim()}`);
    window.location.hash = projectHref(projectKey, "coordinator");
  };
  return (
    <form
      className={`flex max-w-[760px] flex-col gap-3 shadow-sm-hard ${PANEL} border-border bg-background`}
      onSubmit={(e) => {
        e.preventDefault();
        if (idea.trim()) plan();
      }}
    >
      <label htmlFor={id} className="text-[15px] font-semibold text-foreground">
        What is the big idea?
      </label>
      <p className="m-0 text-[13px] text-muted-foreground leading-[1.6]">
        An initiative takes one large goal, splits it into features of a good size, and runs each
        under the workflow that fits it: a light one for small changes, a thorough one for risky
        work. Independent features run side by side. You approve the split before anything runs.
      </p>
      <Textarea
        id={id}
        rows={4}
        value={idea}
        placeholder="Describe the outcome and how you will know it works."
        onChange={(e) => setIdea(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="md" disabled={!idea.trim()}>
          Plan it with the coordinator
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onDirect}>
          Start without the coordinator
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" size="md" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

export function InitiativesSection({ project, id }: SectionProps) {
  const { state, reload } = useLoad(
    () => insights.initiatives(project.key),
    [project.key, "initiatives"],
  );
  const [creating, setCreating] = useState(false);
  const [direct, setDirect] = useState(false);
  if (state.kind !== "ready") return <LoadState state={state} what="Initiatives" />;
  const items = state.data;
  const newDialog = direct && (
    <NewInitiativeDialog
      projectKey={project.key}
      onClose={(done) => {
        setDirect(false);
        if (done) reload();
      }}
    />
  );
  if (items.length === 0)
    return (
      <>
        <IdeaBox projectKey={project.key} onDirect={() => setDirect(true)} />
        {newDialog}
      </>
    );
  const selected = id ?? items[0]?.initiativeId ?? null;
  return (
    <div className="flex flex-col gap-6">
      {newDialog}
      {creating && (
        <IdeaBox
          projectKey={project.key}
          onDirect={() => setDirect(true)}
          onCancel={() => setCreating(false)}
        />
      )}
      <div className="flex flex-wrap items-start gap-6">
        <nav
          className="flex max-w-[340px] flex-[1_1_260px] flex-col gap-[10px]"
          aria-label="Initiatives"
        >
          {!creating && (
            <Button
              variant="primary"
              size="md"
              className="self-start"
              onClick={() => setCreating(true)}
            >
              New initiative
            </Button>
          )}
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
    </div>
  );
}

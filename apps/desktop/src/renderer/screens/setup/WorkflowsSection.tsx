import { useEffect, useState } from "react";
import { start } from "../../client/start.js";
import {
  type EditorOp,
  type EditorView,
  type Outcome,
  type SaveReview,
  type StageView,
  type TargetView,
  workflowEditor,
} from "../../client/workflow-editor.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Dot } from "../../components/ui/dot.js";
import { Empty } from "../../components/ui/empty.js";
import { fieldClass, Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL, TABLE } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { AgentsNudge } from "./AgentsSection.js";
import {
  ACTIONS,
  errorText,
  GROW,
  LIST,
  LoadState,
  NOTE,
  ROW,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";
import { outcomeLabel, problemsFor, targetKey } from "./workflow-editor-logic.js";

const SELECT = cn(fieldClass, "h-9 w-auto py-1 pr-8");

/** Every workflow definition of the project, each opening in the editor. */
function WorkflowList({ project }: Pick<SectionProps, "project">) {
  const [list] = useLoad(() => start.definitions(project.key), [project.key, "definitions"]);
  if (list.state !== "ready") return <LoadState value={list} what="workflows" />;
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        The workflows a run can follow. Built-in ones open read only; duplicate one to make a
        project workflow in <span className="font-mono">baked/workflows</span>, then change its
        gates, transitions and stage options. The same editor as{" "}
        <span className="font-mono">/workflow</span> in the terminal.
      </p>
      <AgentsNudge projectKey={project.key} />
      <div className="overflow-x-auto">
        <table className={TABLE}>
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Description</th>
              <th>Source</th>
              <th className="text-right">Stages</th>
              <th>Problems</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id}>
                <td className="font-mono">
                  <a href={projectHref(project.key, "workflows", d.id)}>{d.id}</a>
                </td>
                <td className="max-w-[360px]">{d.description || "–"}</td>
                <td>
                  <Tag>{d.source === "builtin" ? "built-in" : "project"}</Tag>
                </td>
                <td className="text-right font-mono">{d.stages.length}</td>
                <td>
                  {d.problems.length ? (
                    <Tag tone="warn">
                      {d.problems.length} problem{d.problems.length === 1 ? "" : "s"}
                    </Tag>
                  ) : (
                    "–"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GateList({
  stage,
  target,
  readOnly,
  busy,
  onEdit,
}: {
  stage: StageView;
  target: TargetView;
  readOnly: boolean;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
}) {
  const [pick, setPick] = useState("");
  const usable = target.options.filter((o) => o.disabled === null);
  const choice = pick || usable[0]?.gateId || "";
  const t = target.target;
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 border-t border-[var(--line)] p-0 pt-2"
      aria-label={target.name}
    >
      <div className={ROW}>
        <span className={cn(GROW, "font-mono text-[12px] text-foreground")}>
          {target.transition
            ? `${stage.id} → ${target.transition.to} on ${outcomeLabel(target.transition.on)}${
                target.transition.loop ? ` · up to ${target.transition.loop} rounds` : ""
              }`
            : "Stage gates"}
        </span>
        {target.transition && !readOnly && t.kind === "transition" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onEdit({ op: "removeTransition", id: t.id })}
          >
            Remove transition
          </Button>
        )}
      </div>
      {target.bindings.length === 0 ? (
        <span className={cn("text-dim-foreground", NOTE)}>No gates.</span>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {target.bindings.map((b, index) => (
            <li key={b.gateId} className={cn(ROW, "text-[13px]")}>
              <span className={cn(GROW, "flex flex-col")}>
                <span className="font-mono text-foreground">{b.gateId}</span>
                {b.summary && <span className={cn("text-dim-foreground", NOTE)}>{b.summary}</span>}
              </span>
              <span className="flex items-center gap-2 whitespace-nowrap">
                <Dot tone={b.mode === "required" ? "ok" : b.mode === "advisory" ? "warn" : "err"} />
                {b.mode}
                {b.override && <Tag>set here</Tag>}
              </span>
              {!readOnly && (
                <span className={ACTIONS}>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Move ${b.gateId} up`}
                    disabled={busy || index === 0}
                    onClick={() => onEdit({ op: "moveGate", target: t, index, delta: -1 })}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Move ${b.gateId} down`}
                    disabled={busy || index === target.bindings.length - 1}
                    onClick={() => onEdit({ op: "moveGate", target: t, index, delta: 1 })}
                  >
                    ↓
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => onEdit({ op: "toggleMode", target: t, index })}
                  >
                    {b.mode === "required" ? "Make advisory" : "Make required"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remove ${b.gateId}`}
                    disabled={busy}
                    onClick={() => onEdit({ op: "removeGate", target: t, index })}
                  >
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!readOnly && (
        <div className={ROW}>
          <select
            aria-label={`Gate to add to ${target.name}`}
            className={SELECT}
            value={choice}
            disabled={busy || usable.length === 0}
            onChange={(e) => setPick(e.target.value)}
          >
            {target.options.map((o) => (
              <option key={o.gateId} value={o.gateId} disabled={o.disabled !== null}>
                {o.gateId}
                {o.disabled ? ` (${o.disabled})` : ` · ${o.summary}`}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !choice}
            onClick={() => {
              setPick("");
              onEdit({ op: "addGate", target: t, gateId: choice });
            }}
          >
            Add gate
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function NewTransition({
  stage,
  busy,
  onEdit,
}: {
  stage: StageView;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
}) {
  const choices = stage.transitionChoices;
  const [to, setTo] = useState(choices.to[0] ?? "done");
  const [on, setOn] = useState<Outcome>(choices.on[0] ?? "passed");
  const [loop, setLoop] = useState<string>("");
  return (
    <div className={cn(ROW, "border-t border-[var(--line)] pt-2")}>
      <span className={cn("text-dim-foreground", NOTE)}>New transition to</span>
      <select
        aria-label={`Transition from ${stage.id} to`}
        className={SELECT}
        value={to}
        onChange={(e) => setTo(e.target.value)}
      >
        {choices.to.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      <span className={cn("text-dim-foreground", NOTE)}>on</span>
      <select
        aria-label={`Transition from ${stage.id} on`}
        className={SELECT}
        value={on}
        onChange={(e) => setOn(e.target.value as Outcome)}
      >
        {choices.on.map((o) => (
          <option key={o} value={o}>
            {outcomeLabel(o)}
          </option>
        ))}
      </select>
      <select
        aria-label={`Transition from ${stage.id} loop`}
        className={SELECT}
        value={loop}
        onChange={(e) => setLoop(e.target.value)}
      >
        {choices.loop.map((n) => (
          <option key={String(n)} value={n === null ? "" : String(n)}>
            {n === null ? "not a loop" : `loop, up to ${n} rounds`}
          </option>
        ))}
      </select>
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() =>
          onEdit({ op: "addTransition", from: stage.id, to, on, loop: loop ? Number(loop) : null })
        }
      >
        Add transition
      </Button>
    </div>
  );
}

function StageCard({
  stage,
  view,
  busy,
  onEdit,
}: {
  stage: StageView;
  view: EditorView;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
}) {
  const readOnly = view.readOnly !== null;
  const problems = problemsFor(view.problems, stage);
  return (
    <li
      className={cn(PANEL, "flex flex-col gap-3", problems.length && "border-[var(--warn)]")}
      aria-label={`Stage ${stage.id}`}
    >
      <div className={ROW}>
        <span className={cn(GROW, "flex flex-wrap items-center gap-2")}>
          <span className="font-mono text-[15px] font-semibold text-foreground">{stage.id}</span>
          <Tag>{stage.type}</Tag>
          <span className={cn("font-mono text-dim-foreground", NOTE)}>makes {stage.produces}</span>
        </span>
        {!readOnly && (
          <span className={ACTIONS}>
            {stage.type === "wait" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                aria-label={`Remove wait stage ${stage.id}`}
                onClick={() => onEdit({ op: "removeWaitStage", stageId: stage.id })}
              >
                Remove
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                title="Insert a stage that runs command gates every interval until they pass, with no model calls"
                aria-label={`Add a wait stage after ${stage.id}`}
                onClick={() => onEdit({ op: "addWaitStage", after: stage.id })}
              >
                Wait after
              </Button>
            )}
          </span>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px] text-[var(--warn)]">
          {problems.map((m) => (
            <li key={m} className={WRAP}>
              {m}
            </li>
          ))}
        </ul>
      )}
      {stage.fields.length > 0 && (
        <div className="flex flex-col gap-1">
          {stage.fields.map((f) => (
            <div key={f.key} className={cn(ROW, "text-[13px]")}>
              <span className="min-w-[140px] text-dim-foreground">{f.label}</span>
              <span className={cn(GROW, "font-mono text-foreground")} title={f.hint}>
                {f.value}
              </span>
              {!readOnly && (
                <span className={ACTIONS}>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Previous ${f.label}`}
                    disabled={busy}
                    onClick={() =>
                      onEdit({ op: "changeField", stageId: stage.id, key: f.key, delta: -1 })
                    }
                  >
                    ‹
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Next ${f.label}`}
                    disabled={busy}
                    onClick={() =>
                      onEdit({ op: "changeField", stageId: stage.id, key: f.key, delta: 1 })
                    }
                  >
                    ›
                  </Button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {stage.targets.map((target) => (
        <GateList
          key={targetKey(target.target)}
          stage={stage}
          target={target}
          readOnly={readOnly}
          busy={busy}
          onEdit={onEdit}
        />
      ))}
      {!readOnly && <NewTransition stage={stage} busy={busy} onEdit={onEdit} />}
    </li>
  );
}

function SaveDialog({
  review,
  busy,
  error,
  onWrite,
  onClose,
}: {
  review: SaveReview | null;
  busy: boolean;
  error: string | null;
  onWrite: (confirm?: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const open = review !== null;
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const auto = review?.kind === "review" ? review.autoApproval : null;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>
            {review?.kind === "review" ? "Write the workflow file?" : "Nothing to write"}
          </DialogTitle>
          <DialogDescription>
            {review?.kind === "review" ? (
              <>
                Writes <span className="font-mono">{review.path}</span>. New runs use it; runs that
                started keep the definition they froze.
              </>
            ) : review?.kind === "unchanged" ? (
              "The file already holds this workflow."
            ) : review?.kind === "read-only" ? (
              review.message
            ) : (
              "Fix the problems first."
            )}
          </DialogDescription>
        </DialogHeader>
        {review?.kind === "problems" && (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-[var(--warn)]">
            {review.groups.flatMap((g) =>
              g.messages.map((m) => <li key={`${g.owner}:${m}`}>{`${g.owner}: ${m}`}</li>),
            )}
          </ul>
        )}
        {review?.kind === "review" && (
          <>
            <pre
              data-testid="workflow-diff"
              className="m-0 max-h-[280px] overflow-auto rounded-base border-2 border-border bg-secondary-background p-3 font-mono text-[12px]"
            >
              {review.diff.join("\n")}
            </pre>
            {review.gates.length > 0 && (
              <details className="text-[13px]">
                <summary className="cursor-pointer">
                  Gates a run applies ({review.gates.length})
                </summary>
                <ul className="m-0 mt-1 list-none p-0 font-mono text-[12px]">
                  {review.gates.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </details>
            )}
            {auto && (
              <div className="flex flex-col gap-1">
                <Alert>
                  This workflow approves plans on its own within these limits: {auto.limits}. Type{" "}
                  <span className="font-mono">{auto.prefix}</span> to confirm them.
                </Alert>
                <Label htmlFor="auto-confirm">Confirmation</Label>
                <Input
                  id="auto-confirm"
                  value={typed}
                  autoComplete="off"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </div>
            )}
          </>
        )}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
            {review?.kind === "review" ? "Keep editing" : "Close"}
          </Button>
          {review?.kind === "review" && (
            <Button
              variant="primary"
              size="md"
              disabled={busy || (auto !== null && typed.trim().length < auto.prefix.length)}
              onClick={() => onWrite(auto ? typed : undefined)}
            >
              Write file
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One workflow definition in the editor: its stages in order, each with its options, its own
 * gates (check and review stages) and its outgoing transitions with their gates. Every change
 * goes through the backend, which validates it with the terminal editor's rules.
 */
function WorkflowEditor({ project, id }: { project: SectionProps["project"]; id: string }) {
  const [view, setView] = useState<EditorView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [review, setReview] = useState<SaveReview | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setView(null);
    setLoadError(null);
    setNotice(null);
    workflowEditor.open(project.key, id).then(
      (answer) => live && setView(answer.view),
      (e: unknown) => live && setLoadError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [project.key, id]);

  if (loadError) return <Alert tone="error">{loadError}</Alert>;
  if (!view) return <Skeleton label="Loading the workflow" />;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (e) {
      setNotice({ text: errorText(e), failed: true });
    } finally {
      setBusy(false);
    }
  };
  const onEdit = (op: EditorOp) =>
    void run(async () => {
      const answer = await workflowEditor.edit(project.key, view, op);
      setView(answer.view);
      setNotice(answer.error ? { text: answer.error, failed: true } : null);
    });
  const openReview = () =>
    void run(async () => {
      setSaveError(null);
      setReview(await workflowEditor.review(project.key, view));
    });
  const write = (confirm?: string) =>
    void run(async () => {
      const outcome = await workflowEditor.save(project.key, view, confirm);
      if (!outcome.saved) {
        setReview(outcome.review);
        setSaveError(
          outcome.confirmationNeeded
            ? "The confirmation does not match the limits."
            : "The workflow was not written.",
        );
        return;
      }
      setReview(null);
      setView(outcome.view);
      setNotice({ text: `Saved ${outcome.path}` });
      if (outcome.view.id !== id)
        window.location.hash = projectHref(project.key, "workflows", outcome.view.id);
    });
  const problemCount = view.problems.reduce((n, g) => n + g.messages.length, 0);
  const general = view.problems.filter((g) => g.owner === "definition");

  return (
    <div className={SETUP}>
      <div className={ROW}>
        <span className={cn(GROW, "flex flex-wrap items-center gap-2")}>
          <h2 className="m-0 font-mono text-[18px] font-semibold">{view.id}</h2>
          {view.readOnly ? (
            <Tag>read only</Tag>
          ) : view.copy ? (
            <Tag tone="warn">unsaved copy of {view.from}</Tag>
          ) : (
            <Tag>baked/workflows/{view.id}.json</Tag>
          )}
          {view.dirty && !view.readOnly && <Tag tone="warn">unsaved changes</Tag>}
          {problemCount > 0 && (
            <Tag tone="err">
              {problemCount} problem{problemCount === 1 ? "" : "s"}
            </Tag>
          )}
        </span>
        <span className={ACTIONS}>
          {view.readOnly ? (
            <Button
              variant="primary"
              size="md"
              disabled={busy}
              onClick={() => onEdit({ op: "duplicate" })}
            >
              Duplicate as custom
            </Button>
          ) : (
            <Button variant="primary" size="md" disabled={busy} onClick={openReview}>
              Save…
            </Button>
          )}
        </span>
      </div>
      <span className={cn("text-dim-foreground", NOTE)}>{view.estimate}</span>
      {view.readOnly && <Alert>{view.readOnly}</Alert>}
      {notice && (
        <Alert tone={notice.failed ? "error" : undefined} role={notice.failed ? "alert" : "status"}>
          {notice.text}
        </Alert>
      )}
      {general.length > 0 && (
        <Alert tone="error">{general.flatMap((g) => g.messages).join(" ")}</Alert>
      )}
      <section aria-label="Stages" className={STACK}>
        <h3 className={LABEL}>Stages · {view.stages.length}</h3>
        <ol className={cn(LIST, "flex flex-col gap-3")}>
          {view.stages.map((stage) => (
            <StageCard key={stage.id} stage={stage} view={view} busy={busy} onEdit={onEdit} />
          ))}
        </ol>
      </section>
      <SaveDialog
        review={review}
        busy={busy}
        error={saveError}
        onWrite={write}
        onClose={() => setReview(null)}
      />
    </div>
  );
}

/** Workflow definitions: the list, or one definition in the editor (`#/p/KEY/workflows/ID`). */
export function WorkflowsSection({ project, id }: SectionProps) {
  const [offered, setOffered] = useState<boolean | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    workflowEditor.offered(project.key).then((value) => live && setOffered(value));
    return () => {
      live = false;
    };
  }, [project.key]);
  if (offered === undefined) return <Skeleton label="Loading workflows" />;
  if (offered === false)
    return (
      <Empty>
        Needs a newer BAKED: this project's backend has no workflow editor yet. Update BAKED, or
        edit workflows with <span className="font-mono">/workflow</span> in the terminal.
      </Empty>
    );
  return id ? <WorkflowEditor project={project} id={id} /> : <WorkflowList project={project} />;
}

import { useEffect, useState } from "react";
import type { GateDraftKind } from "../../client/setup.js";
import { start } from "../../client/start.js";
import {
  type EditorOp,
  type EditorView,
  type GateTarget,
  type RemovedDefinition,
  type SaveReview,
  workflowEditor,
} from "../../client/workflow-editor.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { AgentsNudge } from "./AgentsSection.js";
import { GateSetupDialog } from "./GateSetupDialog.js";
import { ACTIONS, errorText, GROW, LoadState, NOTE, ROW, SETUP, Tag, useLoad } from "./shared.js";
import { WorkflowFlow } from "./WorkflowFlow.js";
import { type EditorTab, WorkflowGallery } from "./WorkflowGallery.js";
import { WorkflowGraph } from "./WorkflowGraph.js";
import { lineFromView } from "./workflow-studio-model.js";

const TABS: [EditorTab, string, string][] = [
  ["flow", "Watch", "Plays a run along the workflow; nothing changes here"],
  ["graph", "Edit", "The workflow as a graph: set up stations, arrows and gates"],
];

/** The view a gallery link asked for, read once by the editor it opens. */
let requestedTab: EditorTab | null = null;
const takeRequestedTab = (): EditorTab | null => {
  const tab = requestedTab;
  requestedTab = null;
  return tab;
};

/**
 * Asks before deleting a project workflow's file (#1101) and deletes it. Runs that started keep
 * the definition they froze; a file that shadowed a built-in workflow gives it back.
 */
function DeleteWorkflowDialog({
  projectKey,
  id,
  onClose,
  onDeleted,
}: {
  projectKey: string;
  id: string | null;
  onClose: () => void;
  onDeleted: (removed: RemovedDefinition) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (id) setError(null);
  }, [id]);
  const confirm = async () => {
    if (!id) return;
    setBusy(true);
    try {
      onDeleted(await workflowEditor.remove(projectKey, id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open={id !== null}
      title={`Delete workflow ${id ?? ""}?`}
      confirmLabel="Delete"
      danger
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      Deletes <span className="font-mono">baked/workflows/{id}.json</span>. New runs can no longer
      pick it; runs that already started keep the definition they froze.
    </ConfirmDialog>
  );
}

/**
 * The line shown after a delete: whether a built-in workflow of the same ID is back. It names the
 * file as the question did; `removed.path` is absolute.
 */
const deletedText = (removed: RemovedDefinition): string => {
  const file = `baked/workflows/${removed.id}.json`;
  return removed.restores
    ? `Deleted ${file}. New runs use the built-in ${removed.restores} again.`
    : `Deleted ${file}.`;
};

/** Every workflow definition of the project as a gallery, each opening in the editor. */
function WorkflowList({
  project,
  canDelete,
}: Pick<SectionProps, "project"> & { canDelete: boolean }) {
  const [list, refresh] = useLoad(
    () => start.definitions(project.key),
    [project.key, "definitions"],
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if (list.state !== "ready") return <LoadState value={list} what="workflows" />;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AgentsNudge projectKey={project.key} />
      {notice && <Alert role="status">{notice}</Alert>}
      <WorkflowGallery
        definitions={list.data}
        projectKey={project.key}
        onOpen={(tab) => {
          requestedTab = tab;
        }}
        onDelete={canDelete ? setDeleting : undefined}
      />
      <DeleteWorkflowDialog
        projectKey={project.key}
        id={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(removed) => {
          setDeleting(null);
          setNotice(deletedText(removed));
          refresh();
        }}
      />
    </div>
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
 * One workflow definition in the editor, in two views: Watch plays a run along it, and Edit lays
 * its stations and arrows out as a graph with the selected station or arrow set up beside it.
 * Both show the same working copy. Every change goes through the backend, which validates it with
 * the terminal editor's rules.
 */
function WorkflowEditor({
  project,
  id,
  canDelete,
}: {
  project: SectionProps["project"];
  id: string;
  canDelete: boolean;
}) {
  const [tab, setTab] = useState<EditorTab>(() => takeRequestedTab() ?? "flow");
  const [definitions, refreshDefinitions] = useLoad(
    () => start.definitions(project.key),
    [project.key, "definitions"],
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [view, setView] = useState<EditorView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [review, setReview] = useState<SaveReview | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [creating, setCreating] = useState<GateTarget | null>(null);

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
      if (op.op === "duplicate" && !answer.error && tab === "flow") setTab("graph");
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
  const summaries = definitions.state === "ready" ? definitions.data : [];
  const known = (
    summaries.find((d) => d.id === view.id) ?? summaries.find((d) => d.id === view.from)
  )?.line;
  const line = lineFromView(view, known);

  return (
    <div className={SETUP}>
      <div className={ROW}>
        <span className={cn(GROW, "flex flex-wrap items-center gap-2")}>
          <a href={projectHref(project.key, "workflows")} className="text-[13px] font-semibold">
            ← All workflows
          </a>
          <h2 className="m-0 font-mono text-[22px] font-bold">{view.id}</h2>
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
            <>
              {canDelete && !view.copy && (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={busy}
                  onClick={() => setDeleting(view.id)}
                >
                  <Icon name="delete" size={14} />
                  Delete…
                </Button>
              )}
              <Button variant="primary" size="md" disabled={busy} onClick={openReview}>
                Save…
              </Button>
            </>
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
      <div className={ROW}>
        <SegmentGroup aria-label="View">
          {TABS.map(([value, label, title]) => (
            <Segment
              key={value}
              aria-pressed={tab === value}
              title={title}
              className="inline-flex items-center gap-[6px]"
              onClick={() => setTab(value)}
            >
              <Icon name={value === "flow" ? "eye" : "edit"} size={14} />
              {label}
            </Segment>
          ))}
        </SegmentGroup>
        <span className={cn("text-dim-foreground", NOTE, GROW)}>
          {tab === "flow"
            ? "Watch only: it plays a run along the workflow. Set it up in Edit."
            : view.readOnly
              ? "Read only: duplicate it to change it."
              : "Changes here show in Watch at once. Save… writes them to the file."}
        </span>
      </div>
      {tab === "flow" && (
        <WorkflowFlow
          key={view.id}
          line={line}
          onEditStation={(stationId) => {
            setFocus(stationId);
            setTab("graph");
          }}
        />
      )}
      {tab === "graph" && (
        <WorkflowGraph
          projectKey={project.key}
          view={view}
          line={line}
          busy={busy}
          focus={focus}
          onFocus={setFocus}
          onEdit={onEdit}
          onCreateGate={setCreating}
        />
      )}
      <GateSetupDialog
        projectKey={project.key}
        open={creating !== null}
        onOpenChange={(open) => !open && setCreating(null)}
        onSaved={() => undefined}
        kind={creatingKind(view, creating)}
        onCreated={(gateId) => {
          const target = creating;
          setCreating(null);
          if (target) onEdit({ op: "addGate", target, gateId });
        }}
      />
      <DeleteWorkflowDialog
        projectKey={project.key}
        id={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          refreshDefinitions();
          window.location.hash = projectHref(project.key, "workflows");
        }}
      />
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

/** The gate kind a new gate for a target needs: a review stage runs AI reviews, others commands. */
function creatingKind(view: EditorView, target: GateTarget | null): GateDraftKind {
  if (target?.kind !== "stage") return "command";
  return view.stages.find((s) => s.id === target.stageId)?.type === "review"
    ? "ai-review"
    : "command";
}

/** Workflow definitions: the list, or one definition in the editor (`#/p/KEY/workflows/ID`). */
export function WorkflowsSection({ project, id }: SectionProps) {
  const [offered, setOffered] = useState<
    Awaited<ReturnType<typeof workflowEditor.offered>> | undefined
  >(undefined);
  useEffect(() => {
    let live = true;
    workflowEditor.offered(project.key).then((value) => live && setOffered(value));
    return () => {
      live = false;
    };
  }, [project.key]);
  if (offered === undefined) return <Skeleton label="Loading workflows" />;
  if (offered.editor === false)
    return (
      <Empty>
        Needs a newer BAKED: this project's backend has no workflow editor yet. Update BAKED, or
        edit workflows with <span className="font-mono">/workflow</span> in the terminal.
      </Empty>
    );
  // An unreadable health answer still offers Delete; an older backend then answers 404 in the dialog.
  const canDelete = offered.remove !== false;
  return id ? (
    <WorkflowEditor project={project} id={id} canDelete={canDelete} />
  ) : (
    <WorkflowList project={project} canDelete={canDelete} />
  );
}

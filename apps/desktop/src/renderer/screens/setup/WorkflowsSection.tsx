import { useEffect, useState } from "react";
import { start } from "../../client/start.js";
import {
  type EditorOp,
  type EditorView,
  type SaveReview,
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
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
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
} from "./shared.js";
import { WorkflowFlow } from "./WorkflowFlow.js";
import { type EditorTab, WorkflowGallery } from "./WorkflowGallery.js";
import { WorkflowGraph } from "./WorkflowGraph.js";
import { StageCard } from "./WorkflowStages.js";
import { lineFromView } from "./workflow-studio-model.js";

const TABS: [EditorTab, string][] = [
  ["flow", "Flow"],
  ["graph", "Graph"],
  ["stages", "Stages"],
];

/** The view a gallery link asked for, read once by the editor it opens. */
let requestedTab: EditorTab | null = null;
const takeRequestedTab = (): EditorTab | null => {
  const tab = requestedTab;
  requestedTab = null;
  return tab;
};

/** Every workflow definition of the project as a gallery, each opening in the editor. */
function WorkflowList({ project }: Pick<SectionProps, "project">) {
  const [list] = useLoad(() => start.definitions(project.key), [project.key, "definitions"]);
  if (list.state !== "ready") return <LoadState value={list} what="workflows" />;
  return (
    <WorkflowGallery
      definitions={list.data}
      projectKey={project.key}
      onOpen={(tab) => {
        requestedTab = tab;
      }}
    />
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
 * One workflow definition in the editor, in three views: Flow plays a run along it, Graph lays
 * its stations and transitions out to rearrange and edit, and Stages lists each stage with its
 * options, its own gates (check and review stages) and its outgoing transitions with their gates.
 * Every change goes through the backend, which validates it with the terminal editor's rules.
 */
function WorkflowEditor({ project, id }: { project: SectionProps["project"]; id: string }) {
  const [tab, setTab] = useState<EditorTab>(() => takeRequestedTab() ?? "flow");
  const [definitions] = useLoad(() => start.definitions(project.key), [project.key, "definitions"]);
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
      <SegmentGroup aria-label="View">
        {TABS.map(([value, label]) => (
          <Segment key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>
            {label}
          </Segment>
        ))}
      </SegmentGroup>
      {tab === "flow" && <WorkflowFlow key={view.id} line={line} />}
      {tab === "graph" && (
        <WorkflowGraph
          projectKey={project.key}
          view={view}
          line={line}
          busy={busy}
          onEdit={onEdit}
        />
      )}
      {tab === "stages" && (
        <section aria-label="Stages" className={STACK}>
          <h3 className={LABEL}>Stages · {view.stages.length}</h3>
          <ol className={cn(LIST, "flex flex-col gap-3")}>
            {view.stages.map((stage) => (
              <StageCard key={stage.id} stage={stage} view={view} busy={busy} onEdit={onEdit} />
            ))}
          </ol>
        </section>
      )}
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

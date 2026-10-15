import { type FormEvent, type ReactNode, useId, useState } from "react";
import type { InitiativeFeature, InitiativeView, PendingDecision } from "../../client/insights.js";
import { insights } from "../../client/insights.js";
import { start } from "../../client/start.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
import { Textarea } from "../../components/ui/textarea.js";
import { HINT, HINT_ERR } from "../start/form.js";
import { RecipeChoice } from "../start/NewRunScreen.js";
import { message, useLoad } from "../start/panels.js";
import {
  type BudgetFields,
  budgetExtension,
  budgetFields,
  featureWorkflow,
  featureWorkflowChoices,
  hasDependents,
  mergeProblem,
  type SplitRow,
  splitProblem,
} from "./initiative-model.js";

const FIELD = "flex min-w-0 flex-col gap-1.5";

/**
 * A dialog around one form: the submit button stays disabled while `problem` names what is wrong,
 * and the server's refusal shows in an alert inside it. A successful submit closes it.
 */
export function FormDialog({
  title,
  description,
  submitLabel,
  danger,
  problem,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  submitLabel: string;
  danger?: boolean;
  /** Why the form cannot be sent yet; shown under the fields. */
  problem?: string | null;
  onSubmit: () => Promise<unknown>;
  /** Called after the dialog closes, with true when the submit went through. */
  onClose: (done: boolean) => void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          {children}
          {problem && <span className={HINT_ERR}>{problem}</span>}
          {error && <Alert tone="error">{error}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="md"
              disabled={busy}
              onClick={() => onClose(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant={danger ? "danger" : "primary"}
              size="md"
              className={danger ? "shadow-sm-hard" : undefined}
              disabled={busy || Boolean(problem)}
            >
              {busy ? "Working…" : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface Props {
  projectKey: string;
  view: InitiativeView;
  onClose: (done: boolean) => void;
}

export function RejectDialog({
  projectKey,
  view,
  decision,
  onClose,
}: Props & { decision: Pick<PendingDecision, "requestId"> }) {
  const id = useId();
  const [reason, setReason] = useState("");
  return (
    <FormDialog
      title="Reject the split"
      description="The split comes back to you with this reason. Edit it to propose a new revision, which waits for approval again."
      submitLabel="Reject split"
      danger
      problem={reason.trim() ? null : "Give a reason."}
      onSubmit={() => insights.rejectSplit(projectKey, view, decision, reason.trim())}
      onClose={onClose}
    >
      <div className={FIELD}>
        <Label htmlFor={id}>Reason</Label>
        <Textarea
          id={id}
          rows={3}
          value={reason}
          placeholder="Why this split does not work"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </FormDialog>
  );
}

/**
 * Picks the workflow a feature's runs use. A feature other features build on needs one that writes
 * a spec, since its accepted spec is their contract; the core refuses others with that reason.
 */
export function WorkflowDialog({
  projectKey,
  view,
  feature,
  onClose,
}: Props & { feature: InitiativeFeature }) {
  const current = featureWorkflow(view, feature);
  const [workflow, setWorkflow] = useState(current);
  const definitions = useLoad(projectKey, "definitions", start.definitions);
  const choices = featureWorkflowChoices(definitions.value ?? []);
  return (
    <FormDialog
      title="Feature workflow"
      description={
        <>
          The workflow <span className="font-mono">{feature.id}</span> runs under.
          {hasDependents(view, feature)
            ? " Other features build on its spec, so pick one that writes a spec, such as sdd."
            : " Pick a light one for a small, low-risk change and a thorough one for risky work."}
        </>
      }
      submitLabel="Use workflow"
      problem={workflow === current ? "Pick another workflow to change it." : null}
      onSubmit={() => insights.configureFeature(projectKey, view, feature.id, { workflow })}
      onClose={onClose}
    >
      {definitions.error ? (
        <span className={HINT_ERR}>Workflows: {message(definitions.error)}</span>
      ) : definitions.value ? (
        <RecipeChoice definitions={choices} value={workflow} onChange={(d) => setWorkflow(d.id)} />
      ) : (
        <span className={HINT}>Loading workflows…</span>
      )}
    </FormDialog>
  );
}

export function RenameDialog({
  projectKey,
  view,
  feature,
  onClose,
}: Props & { feature: InitiativeFeature }) {
  const id = useId();
  const [title, setTitle] = useState(feature.title);
  const trimmed = title.trim();
  return (
    <FormDialog
      title="Rename feature"
      description={
        <>
          Changes the title of <span className="font-mono">{feature.id}</span>; its ID stays.
        </>
      }
      submitLabel="Rename"
      problem={
        !trimmed
          ? "Give a title."
          : trimmed.length > 200
            ? "At most 200 characters."
            : trimmed === feature.title
              ? "Change the title to rename."
              : null
      }
      onSubmit={() => insights.renameFeature(projectKey, view, feature.id, trimmed)}
      onClose={onClose}
    >
      <div className={FIELD}>
        <Label htmlFor={id}>Title</Label>
        <Input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
    </FormDialog>
  );
}

const partId = (base: string, n: number): string => `${base.slice(0, 37)}-${n}`;

export function SplitDialog({
  projectKey,
  view,
  feature,
  onClose,
}: Props & { feature: InitiativeFeature }) {
  const [rows, setRows] = useState<SplitRow[]>([
    { id: partId(feature.id, 1), title: "" },
    { id: partId(feature.id, 2), title: "" },
  ]);
  const set = (index: number, patch: Partial<SplitRow>): void =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <FormDialog
      title="Split feature"
      description={
        <>
          Replaces <span className="font-mono">{feature.id}</span> with two or more features. Each
          part takes over its scope, paths and contract; features that depended on it depend on
          every part.
        </>
      }
      submitLabel="Split"
      problem={splitProblem(view, feature.id, rows)}
      onSubmit={() =>
        insights.splitFeature(
          projectKey,
          view,
          feature.id,
          rows.map((row) => ({ id: row.id.trim(), title: row.title.trim() })),
        )
      }
      onClose={onClose}
    >
      <ol className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Parts">
        {rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place by position.
          <li key={i} className="flex flex-wrap items-end gap-2">
            <div className={`${FIELD} w-[180px]`}>
              <Label htmlFor={`split-id-${i}`} className="text-[12px]">
                Part {i + 1} ID
              </Label>
              <Input
                id={`split-id-${i}`}
                className="font-mono"
                value={row.id}
                onChange={(e) => set(i, { id: e.target.value })}
              />
            </div>
            <div className={`${FIELD} min-w-[180px] flex-1`}>
              <Label htmlFor={`split-title-${i}`} className="text-[12px]">
                Title
              </Label>
              <Input
                id={`split-title-${i}`}
                value={row.title}
                onChange={(e) => set(i, { title: e.target.value })}
              />
            </div>
            <Button
              variant="secondary"
              size="md"
              className="min-h-10"
              disabled={rows.length <= 2}
              aria-label={`Remove part ${i + 1}`}
              onClick={() => setRows(rows.filter((_, j) => j !== i))}
            >
              ×
            </Button>
          </li>
        ))}
      </ol>
      <Button
        variant="secondary"
        size="md"
        className="self-start"
        onClick={() => setRows([...rows, { id: partId(feature.id, rows.length + 1), title: "" }])}
      >
        Add part
      </Button>
    </FormDialog>
  );
}

export function MergeDialog({
  projectKey,
  view,
  selected,
  onClose,
}: Props & { selected: readonly string[] }) {
  const idField = useId();
  const titleField = useId();
  const [id, setId] = useState("");
  const [title, setTitle] = useState("");
  const titles = view.features.filter((f) => selected.includes(f.id));
  return (
    <FormDialog
      title={`Merge ${selected.length} features`}
      description="The merged feature joins their scopes, paths, contracts and dependencies."
      submitLabel="Merge"
      problem={mergeProblem(view, selected, { id, title })}
      onSubmit={() =>
        insights.mergeFeatures(projectKey, view, selected, {
          ...(id.trim() ? { id: id.trim() } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
        })
      }
      onClose={onClose}
    >
      <ul className="m-0 flex flex-col gap-1 pl-5 text-[13px]">
        {titles.map((f) => (
          <li key={f.id}>
            {f.title} <span className="font-mono text-dim-foreground">{f.id}</span>
          </li>
        ))}
      </ul>
      <div className={FIELD}>
        <Label htmlFor={idField}>ID</Label>
        <Input
          id={idField}
          className="font-mono"
          value={id}
          placeholder={selected[0] ?? ""}
          onChange={(e) => setId(e.target.value)}
        />
        <span className={HINT}>Optional; the first feature's ID by default.</span>
      </div>
      <div className={FIELD}>
        <Label htmlFor={titleField}>Title</Label>
        <Input
          id={titleField}
          value={title}
          placeholder={titles.map((f) => f.title).join(" + ")}
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className={HINT}>Optional; the titles joined by default.</span>
      </div>
    </FormDialog>
  );
}

const BUDGET_FIELDS: [keyof BudgetFields, string, string][] = [
  ["tokens", "Tokens", "like 6000000 or 6M"],
  ["calls", "Agent calls", "like 400"],
  ["minutes", "Active time, minutes", "like 480"],
];

/** The three limits of a shared budget as one row of fields. */
export function BudgetInputs({
  value,
  onChange,
  idPrefix,
}: {
  value: BudgetFields;
  onChange: (value: BudgetFields) => void;
  idPrefix: string;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      {BUDGET_FIELDS.map(([key, label, placeholder]) => (
        <div key={key} className={FIELD}>
          <Label htmlFor={`${idPrefix}-${key}`} className="text-[12px]">
            {label}
          </Label>
          <Input
            id={`${idPrefix}-${key}`}
            inputMode="numeric"
            className="font-mono"
            value={value[key]}
            placeholder={placeholder}
            onChange={(e) => onChange({ ...value, [key]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

export function ExtendDialog({ projectKey, view, onClose }: Props) {
  const id = useId();
  const [fields, setFields] = useState(() => budgetFields(view));
  const extension = budgetExtension(view, fields);
  return (
    <FormDialog
      title="Extend budget"
      description="Raises the shared budget's limits; a limit can only go up. Features started later get a share of what remains, weighted by their size."
      submitLabel="Extend"
      problem={extension.ok ? null : extension.error}
      onSubmit={() =>
        extension.ok
          ? insights.extendBudget(projectKey, view, extension.limits)
          : Promise.resolve(null)
      }
      onClose={onClose}
    >
      <BudgetInputs value={fields} onChange={setFields} idPrefix={id} />
    </FormDialog>
  );
}

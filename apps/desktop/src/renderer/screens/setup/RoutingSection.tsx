import { type FormEvent, useMemo, useState } from "react";
import type { ModelCatalog } from "../../../../../../src/core/llm/model-choices.js";
import { ApiError } from "../../client/api.js";
import { chat } from "../../client/chat.js";
import {
  type CriticMode,
  type Effort,
  type IndependentReview,
  type RoutingChange,
  type RoutingOverview,
  type RoutingRow,
  type RoutingScope,
  type RoutingTarget,
  setup,
} from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
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
import { ModelListPicker, ModelPicker, useModelCatalog } from "../../components/ui/model-picker.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { Hint } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { STACK as COLUMN, LABEL, LEDE, PANEL } from "../../lib/styles.js";
import {
  CLASS_HINTS,
  classSuggestions,
  describeResolved,
  describeRoute,
  draftOf,
  EFFORT_CHOICES,
  effortLabel,
  layerValue,
  plainName,
  type RoutingGroup,
  routeActionLabel,
  routingGroups,
  unresolvedText,
} from "./routing-logic.js";
import { errorText, GROW, LoadState, NOTE, OK, ROW, STACK, useLoad, WARN } from "./shared.js";

type Models = { catalog: ModelCatalog | null; error: string | null };

export interface RoutingProject {
  key: string;
  name: string;
}

/** The form's subject: an existing route, or a new class. */
type Editing = { row: RoutingRow } | { newClass: true };

const LAYERS: { scope: RoutingScope; label: string }[] = [
  { scope: "global", label: "All projects" },
  { scope: "project", label: "This project" },
];
const REVIEW_MODES: (IndependentReview | null)[] = [null, "off", "warn", "require", "provider"];
const CONFIDENCE_CHOICES: (number | null)[] = [null, 0.5, 0.6, 0.7, 0.8, 0.9];
const CRITIC_CHOICES: (CriticMode | null)[] = [null, "off", "advise", "select", "earlyStop"];

const LAYER_HINT =
  "All projects writes ~/.baked/config.json and applies everywhere. This project writes the project's own .baked/config.json, which wins over All projects for that project, route by route.";

/**
 * Settings > Model routing: every route of `modelRouting` (classes, roles, a workflow's stages,
 * profiles) and `independentReview`, edited in the global or one project's layer. The backend
 * checks each change as a run start would and refuses it with the problems to fix.
 */
export function RoutingSection({ projects }: { projects: RoutingProject[] }) {
  const [projectKey, setProjectKey] = useState(projects[0]?.key ?? "");
  const project = projects.find((p) => p.key === projectKey) ?? projects[0];
  const [scope, setScope] = useState<RoutingScope>("global");
  const [workflow, setWorkflow] = useState<string | null>(null);
  const key = project?.key ?? "";
  const [view, , setView] = useLoad(() => setup.routing(key, workflow), [key, "routing", workflow]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const models = useModelCatalog(key || null, chat.models);

  const change = async (next: RoutingChange, what: string): Promise<boolean> => {
    setBusy(true);
    setProblems([]);
    setError(null);
    setSaved(null);
    try {
      setView(await setup.changeRouting(key, scope, workflow, next));
      setSaved(what);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.problems.length) setProblems(e.problems);
      else setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const file = scope === "global" ? "~/.baked/config.json" : ".baked/config.json";
  const layerName = scope === "global" ? "All projects" : (project?.name ?? "this project");

  return (
    <section className={STACK} aria-label="Model routing">
      <p className={LEDE}>
        New runs use a change; runs already started keep the models they began with.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className={cn(LABEL, "flex items-center")}>
            Save changes to
            <Hint label="where changes are saved">{LAYER_HINT}</Hint>
          </span>
          <Tabs
            value={scope}
            onValueChange={(value) => {
              setScope(value as RoutingScope);
              setEditing(null);
              setProblems([]);
              setSaved(null);
            }}
          >
            <TabsList aria-label="Layer">
              {LAYERS.map((layer) => (
                <TabsTrigger key={layer.scope} value={layer.scope}>
                  {layer.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        {projects.length > 1 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="routing-project" className={LABEL}>
              Project
            </label>
            <select
              id="routing-project"
              value={key}
              onChange={(e) => {
                setProjectKey(e.target.value);
                setEditing(null);
              }}
            >
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {view.state === "ready" && view.data.workflows.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor="routing-workflow" className={LABEL}>
              Workflow
            </label>
            <select
              id="routing-workflow"
              value={view.data.workflowId ?? ""}
              onChange={(e) => {
                setWorkflow(e.target.value);
                setEditing(null);
              }}
            >
              {view.data.workflows.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <span className={cn("text-dim-foreground", NOTE)}>
        Editing <strong>{layerName}</strong> in <span className="font-mono">{file}</span>
        {view.state === "ready" && (
          <>
            {" "}
            · routes resolve for {project?.name} with run model{" "}
            <span className="font-mono">{view.data.runModel ?? "none"}</span>
          </>
        )}
      </span>
      {error && <Alert tone="error">{error}</Alert>}
      {saved && (
        <output className={cn(OK, NOTE)}>
          ✓ {saved} in {layerName}.
        </output>
      )}
      {view.state === "ready" ? (
        <RoutingTables
          view={view.data}
          projectKey={key}
          scope={scope}
          busy={busy}
          models={models}
          editing={editing}
          problems={problems}
          onEdit={(next) => {
            setEditing(next);
            setProblems([]);
            setSaved(null);
          }}
          onChange={async (next, what) => {
            if (await change(next, what)) setEditing(null);
          }}
        />
      ) : (
        <LoadState value={view} what="model routing" />
      )}
    </section>
  );
}

function RoutingTables({
  view,
  projectKey,
  scope,
  busy,
  models,
  editing,
  problems,
  onEdit,
  onChange,
}: {
  view: RoutingOverview;
  projectKey: string;
  scope: RoutingScope;
  busy: boolean;
  models: Models;
  editing: Editing | null;
  problems: string[];
  onEdit: (editing: Editing | null) => void;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
}) {
  const editingPath = editing && "row" in editing ? editing.row.path : null;
  const row = editing && "row" in editing ? editing.row : null;
  return (
    <>
      {view.error && <Alert tone="error">{view.error}</Alert>}
      {!editing && problems.length > 0 && <Refused problems={problems} />}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && onEdit(null)}>
        {editing && (
          <RouteForm
            key={row?.path ?? "new-class"}
            view={view}
            row={row}
            target={row?.target ?? { kind: "class", name: "" }}
            scope={scope}
            busy={busy}
            models={models}
            problems={problems}
            onCancel={() => onEdit(null)}
            onSave={({ name, ...route }, create) =>
              void onChange(
                {
                  target: create || !row ? { kind: "class", name } : row.target,
                  route,
                  create,
                },
                `Saved ${create ? `$${name}` : row ? plainName(row) : ""}`,
              )
            }
          />
        )}
      </Dialog>
      {routingGroups(view).map((group) => (
        <div key={group.id} className="flex flex-col gap-2">
          <div className="flex flex-col">
            <h3 className="m-0 flex items-center gap-1 text-[15px] font-semibold">
              {group.title}
              <Hint label={group.title}>{group.hint}</Hint>
              <span className="font-mono text-[11px] font-normal text-dim-foreground">
                {group.term}
              </span>
            </h3>
            <span className={cn("text-dim-foreground", NOTE)}>{group.note}</span>
          </div>
          {group.rows.length === 0 ? (
            <Empty>
              {group.id === "profiles" ? "No profiles in this workflow." : "Nothing to route."}
            </Empty>
          ) : (
            <Table aria-label={group.title}>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className={cn(scope === "global" && "text-foreground")}>
                    All projects
                  </TableHead>
                  <TableHead className={cn(scope === "project" && "text-foreground")}>
                    This project
                  </TableHead>
                  <TableHead>
                    <span className="inline-flex items-center">
                      New runs use
                      <Hint label="what new runs use">
                        The model a new run picks for this entry once both files and the fallbacks
                        are combined, with the setting that chose it underneath.
                      </Hint>
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map((row) => (
                  <RouteRow
                    key={row.path}
                    view={view}
                    row={row}
                    group={group.id}
                    scope={scope}
                    busy={busy}
                    selected={row.path === editingPath}
                    onEdit={() => onEdit({ row })}
                    onClear={() =>
                      void onChange({ target: row.target, route: null }, `Cleared ${row.path}`)
                    }
                  />
                ))}
              </TableBody>
            </Table>
          )}
          {group.id === "classes" && (
            <div>
              <Button
                variant="neutral"
                size="sm"
                disabled={busy}
                onClick={() => onEdit({ newClass: true })}
              >
                Add model name
              </Button>
            </div>
          )}
        </div>
      ))}
      <IndependentReviewRow view={view} scope={scope} busy={busy} onChange={onChange} />
      <ReviewConfidenceRow view={view} scope={scope} busy={busy} onChange={onChange} />
      <CriticRow
        view={view}
        scope={scope}
        busy={busy}
        onChange={onChange}
        projectKey={projectKey}
      />
      <SpecifySonnetRow view={view} scope={scope} busy={busy} onChange={onChange} />
      {view.warnings.length > 0 && (
        <ul className={cn("m-0 list-none p-0", WARN, NOTE)}>
          {view.warnings.map((w) => (
            <li key={w}>! {w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function RouteCell({ value, active }: { value: string; active: boolean }) {
  return (
    <TableCell
      className={cn(
        "font-mono text-xs whitespace-normal [overflow-wrap:anywhere]",
        !active && "text-muted-foreground",
      )}
    >
      {value || <span className="text-muted-foreground">–</span>}
    </TableCell>
  );
}

function RouteRow({
  view,
  row,
  group,
  scope,
  busy,
  selected,
  onEdit,
  onClear,
}: {
  view: RoutingOverview;
  row: RoutingRow;
  group: RoutingGroup["id"];
  scope: RoutingScope;
  busy: boolean;
  selected: boolean;
  onEdit: () => void;
  onClear: () => void;
}) {
  const own = layerValue(row, scope);
  return (
    <TableRow
      aria-current={selected ? "true" : undefined}
      className={cn(selected && "bg-secondary-background shadow-[inset_4px_0_0_var(--color-main)]")}
    >
      <TableCell>
        {row.target.kind === "class" ? (
          <span className="inline-flex items-center font-mono">
            {row.label}
            {CLASS_HINTS[row.label] && <Hint label={row.label}>{CLASS_HINTS[row.label]}</Hint>}
          </span>
        ) : (
          <span className="flex flex-col">
            <span>{plainName(row)}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{row.label}</span>
          </span>
        )}
      </TableCell>
      <RouteCell value={describeRoute(row.global)} active={scope === "global"} />
      <RouteCell value={describeRoute(row.project)} active={scope === "project"} />
      <TableCell className="font-mono text-xs whitespace-normal [overflow-wrap:anywhere]">
        {row.resolved ? (
          <span className="flex flex-col">
            <span>{describeResolved(row.resolved)}</span>
            <span className="text-muted-foreground">{row.resolved.source}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{unresolvedText(row, view) || "–"}</span>
        )}
      </TableCell>
      <TableCell className="w-px">
        <span className="flex justify-end gap-2">
          <Button
            variant="neutral"
            size="sm"
            disabled={busy}
            onClick={onEdit}
            aria-label={routeActionLabel("Edit", row, group)}
          >
            Edit
          </Button>
          {own !== null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClear}
              aria-label={routeActionLabel("Clear", row, group)}
            >
              Clear
            </Button>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}

function RouteForm({
  view,
  row,
  target,
  scope,
  busy,
  models,
  problems,
  onSave,
  onCancel,
}: {
  view: RoutingOverview;
  row: RoutingRow | null;
  target: RoutingTarget;
  scope: RoutingScope;
  busy: boolean;
  models: Models;
  problems: string[];
  onSave: (
    draft: { name: string; model: string; effort: Effort | null; fallback: string[] },
    create: boolean,
  ) => void;
  onCancel: () => void;
}) {
  const initial = draftOf(row ? layerValue(row, scope) : null);
  const [name, setName] = useState("");
  const [model, setModel] = useState(initial.model);
  const [effort, setEffort] = useState<Effort | null>(initial.effort);
  const [fallback, setFallback] = useState(initial.fallback);
  const create = row === null;
  const isClass = target.kind === "class";
  // A class names a model, so only other routes offer the model names.
  const classes = useMemo(
    () => (isClass ? [] : classSuggestions(view).map((c) => c.slice(1))),
    [isClass, view],
  );
  const classDetails = useMemo(() => {
    const out: Record<string, string> = {};
    for (const c of view.classes)
      if (c.resolved) out[c.label.slice(1)] = describeResolved(c.resolved);
    return out;
  }, [view]);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSave({ name: name.trim(), model, effort, fallback }, create);
  };
  const id = (field: string) => `route-${field}`;
  const layer = scope === "global" ? "All projects" : "This project";
  const file = scope === "global" ? "~/.baked/config.json" : ".baked/config.json";
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{row ? `Model for ${plainName(row)}` : "New model name"}</DialogTitle>
        <DialogDescription>
          Saved to{" "}
          <Badge tone={scope === "global" ? "info" : "accent"} className="align-middle">
            {layer}
          </Badge>{" "}
          in <span className="font-mono">{file}</span>
          {row && (
            <>
              {" "}
              as <span className="font-mono whitespace-nowrap">modelRouting.{row.path}</span>
            </>
          )}
          .
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        onSubmit={submit}
        aria-label={row ? `Route ${row.path}` : "New class"}
      >
        {create && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("name")} className="flex items-center">
              Name
              <Hint label="the name">
                Used as $name by roles, steps and profiles. Letters, digits and dashes.
              </Hint>
            </Label>
            <Input
              id={id("name")}
              className="font-mono"
              value={name}
              placeholder="deep"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("model")} className="flex items-center">
              Model
              <Hint label="the model">
                A model ID as provider/model, such as anthropic/claude-sonnet-5-5
                {isClass ? "." : ", or a model name ($fast, $review…) from the first table."}
              </Hint>
            </Label>
            <ModelPicker
              id={id("model")}
              value={model}
              onChange={setModel}
              catalog={models.catalog}
              error={models.error}
              classes={classes}
              classDetails={classDetails}
              placeholder={isClass ? "provider/model" : "provider/model or $name"}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("effort")} className="flex items-center">
              Effort
              <Hint label="effort">
                How hard the model thinks before answering: low is fastest and cheapest, max is the
                most thorough. Inherit leaves it to the next setting (the class or the profile);
                model default uses the model's own setting.
              </Hint>
            </Label>
            <select
              id={id("effort")}
              value={effort ?? ""}
              onChange={(e) => setEffort((e.target.value || null) as Effort | null)}
            >
              {EFFORT_CHOICES.map((value) => (
                <option key={value ?? "unset"} value={value ?? ""}>
                  {effortLabel(value)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={id("fallback")} className="flex items-center">
            Fallback models
            <Hint label="fallback models">
              Up to three models, tried in order when the main model fails or its provider runs out
              of credits. Choose them from the list or type an ID and press Enter.
            </Hint>
          </Label>
          <ModelListPicker
            id={id("fallback")}
            value={fallback}
            onChange={setFallback}
            catalog={models.catalog}
            error={models.error}
          />
        </div>
        {problems.length > 0 && <Refused problems={problems} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="neutral" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

function Refused({ problems }: { problems: string[] }) {
  return (
    <Alert tone="error" role="alert">
      <span className="font-heading">Not saved: a run would refuse to start with this.</span>
      <ul className="m-0 list-none p-0">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Alert>
  );
}

function IndependentReviewRow({
  view,
  scope,
  busy,
  onChange,
}: {
  view: RoutingOverview;
  scope: RoutingScope;
  busy: boolean;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
}) {
  const own = view.independentReview[scope];
  return (
    <div className={cn(PANEL, ROW)}>
      <span className={cn(GROW, COLUMN)}>
        <span className="flex items-center">
          Independent review
          <Hint label="independent review">
            A second model catches mistakes the first one is blind to. This decides what happens
            when a reviewer would use the same model as the code it reviews: off allows it, warn
            records a warning, require refuses to start the run, provider moves the reviewers to a
            model of another vendor (Codex reviews Claude Code and back) and warns when none is set
            up. Inherit uses the other file's choice.
          </Hint>
        </span>
        <span className={cn("text-dim-foreground", NOTE)}>
          Reviewers should use a different model than the work they review. In effect:{" "}
          <span className="font-mono">{view.independentReview.effective}</span>.
        </span>
      </span>
      <SegmentGroup aria-label="Independent review">
        {REVIEW_MODES.map((mode) => (
          <Segment
            key={mode ?? "unset"}
            aria-pressed={own === mode}
            disabled={busy}
            onClick={() =>
              void onChange(
                { independentReview: mode },
                mode ? `Set independentReview to ${mode}` : "Cleared independentReview",
              )
            }
          >
            {mode ?? "inherit"}
          </Segment>
        ))}
      </SegmentGroup>
    </div>
  );
}

function ReviewConfidenceRow({
  view,
  scope,
  busy,
  onChange,
}: {
  view: RoutingOverview;
  scope: RoutingScope;
  busy: boolean;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
}) {
  const own = view.reviewMinConfidence?.[scope] ?? null;
  return (
    <div className={cn(PANEL, ROW)}>
      <span className={cn(GROW, COLUMN)}>
        <span className="flex items-center">
          Review confidence
          <Hint label="review confidence">
            Every review finding carries the reviewer's confidence that it is real and caused by the
            change. Findings below this threshold stay notes and start no correction. Inherit uses
            the other file's choice, or 0.8.
          </Hint>
        </span>
        <span className={cn("text-dim-foreground", NOTE)}>
          Findings below this confidence stay notes. In effect:{" "}
          <span className="font-mono">{view.reviewMinConfidence?.effective ?? 0.8}</span>.
        </span>
      </span>
      <SegmentGroup aria-label="Review confidence">
        {CONFIDENCE_CHOICES.map((value) => (
          <Segment
            key={value ?? "unset"}
            aria-pressed={own === value}
            disabled={busy}
            onClick={() =>
              void onChange(
                { reviewMinConfidence: value },
                value === null
                  ? "Cleared reviewMinConfidence"
                  : `Set reviewMinConfidence to ${value}`,
              )
            }
          >
            {value ?? "inherit"}
          </Segment>
        ))}
      </SegmentGroup>
    </div>
  );
}

const SPECIFY_SONNET_CHOICES: { value: boolean | null; label: string }[] = [
  { value: null, label: "inherit" },
  { value: false, label: "off" },
  { value: true, label: "on" },
];

function SpecifySonnetRow({
  view,
  scope,
  busy,
  onChange,
}: {
  view: RoutingOverview;
  scope: RoutingScope;
  busy: boolean;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
}) {
  const own = view.specifyOnSonnet?.[scope] ?? null;
  return (
    <div className={cn(PANEL, ROW)}>
      <span className={cn(GROW, COLUMN)}>
        <span className="flex items-center">
          Specify on Sonnet
          <Hint label="specify on Sonnet">
            When the run model is a Claude Code Opus model, the specify stage writes the spec on
            claude-code/sonnet and every other stage keeps Opus. A stage route or a route given for
            the run still decides the specify model. Off by default while the bench loop measures
            whether specs stay as good.
          </Hint>
        </span>
        <span className={cn("text-dim-foreground", NOTE)}>
          Opus runs write their spec on Sonnet. In effect:{" "}
          <span className="font-mono">{view.specifyOnSonnet?.effective ? "on" : "off"}</span>.
        </span>
      </span>
      <SegmentGroup aria-label="Specify on Sonnet">
        {SPECIFY_SONNET_CHOICES.map(({ value, label }) => (
          <Segment
            key={label}
            aria-pressed={own === value}
            disabled={busy}
            onClick={() =>
              void onChange(
                { specifyOnSonnet: value },
                value === null ? "Cleared specify on Sonnet" : `Set specify on Sonnet ${label}`,
              )
            }
          >
            {label}
          </Segment>
        ))}
      </SegmentGroup>
    </div>
  );
}

function CriticRow({
  view,
  scope,
  busy,
  onChange,
  projectKey,
}: {
  view: RoutingOverview;
  scope: RoutingScope;
  busy: boolean;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
  projectKey: string;
}) {
  const own = view.critic?.[scope] ?? null;
  const [outcomes] = useLoad(() => setup.criticOutcomes(projectKey), [projectKey, "critic"]);
  const calibration = outcomes.state === "ready" ? outcomes.data.calibration : null;
  return (
    <div className={cn(PANEL, ROW)}>
      <span className={cn(GROW, COLUMN)}>
        <span className="flex items-center">
          Critic
          <Hint label="critic">
            A second model scores every task attempt on intent, instructions, scope, test integrity
            and completeness. Advise shows the score in the run and the run report and decides
            nothing. Select keeps the best-scored attempt when a task has several; earlyStop ends a
            correction loop when every task scores above the calibrated threshold and the required
            checks pass. Both act like advise until the project's outcome log calibrates the critic.
            Inherit runs it only when the critic's model is from another vendor than the
            implementation's; off never runs it.
          </Hint>
        </span>
        <span className={cn("text-dim-foreground", NOTE)}>
          Scores each task attempt. In effect:{" "}
          <span className="font-mono">{view.critic?.effective ?? "on another vendor"}</span>.
        </span>
        {calibration && (
          <span className={cn("text-dim-foreground", NOTE)}>
            {calibration.calibrated
              ? `Calibrated on ${calibration.samples} attempts of this project (AUC ${(calibration.auc ?? 0).toFixed(2)}): select and earlyStop decide at score ${(calibration.threshold ?? 0).toFixed(2)}.`
              : `Not calibrated yet (${calibration.reason ?? "no outcomes"}): select and earlyStop act like advise.`}
          </span>
        )}
      </span>
      <SegmentGroup aria-label="Critic">
        {CRITIC_CHOICES.map((mode) => (
          <Segment
            key={mode ?? "unset"}
            aria-pressed={own === mode}
            disabled={busy}
            onClick={() =>
              void onChange({ critic: mode }, mode ? `Set critic to ${mode}` : "Cleared critic")
            }
          >
            {mode ?? "inherit"}
          </Segment>
        ))}
      </SegmentGroup>
    </div>
  );
}

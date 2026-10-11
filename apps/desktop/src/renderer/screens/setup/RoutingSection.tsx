import { type FormEvent, useState } from "react";
import { ApiError } from "../../client/api.js";
import {
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
import { Card, CardContent } from "../../components/ui/card.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Label } from "../../components/ui/label.js";
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
import { cn } from "../../lib/cn.js";
import { STACK as COLUMN, LABEL, LEDE, PANEL } from "../../lib/styles.js";
import {
  classSuggestions,
  describeResolved,
  describeRoute,
  draftOf,
  EFFORT_CHOICES,
  layerValue,
  parseFallback,
  routingGroups,
  unresolvedText,
} from "./routing-logic.js";
import { errorText, GROW, H2, LoadState, NOTE, OK, ROW, STACK, useLoad, WARN } from "./shared.js";

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
const REVIEW_MODES: (IndependentReview | null)[] = [null, "off", "warn", "require"];

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
  const [view, , setView] = useLoad(() => setup.routing(key, workflow), [key, workflow]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

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
    <section className={STACK} aria-labelledby="routing">
      <h2 id="routing" className={H2}>
        Model routing
      </h2>
      <p className={LEDE}>
        Which model each class, role, stage and profile uses. All projects share{" "}
        <span className="font-mono">~/.baked/config.json</span>; a project's own{" "}
        <span className="font-mono">.baked/config.json</span> overrides it route by route. New runs
        use the change; started runs keep their routing.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className={LABEL}>Layer</span>
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
          scope={scope}
          busy={busy}
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
  scope,
  busy,
  editing,
  problems,
  onEdit,
  onChange,
}: {
  view: RoutingOverview;
  scope: RoutingScope;
  busy: boolean;
  editing: Editing | null;
  problems: string[];
  onEdit: (editing: Editing | null) => void;
  onChange: (change: RoutingChange, what: string) => Promise<void>;
}) {
  const editingPath = editing && "row" in editing ? editing.row.path : null;
  const form = (target: RoutingTarget, row: RoutingRow | null) => (
    <RouteForm
      key={row?.path ?? "new-class"}
      view={view}
      row={row}
      target={target}
      scope={scope}
      busy={busy}
      problems={problems}
      onCancel={() => onEdit(null)}
      onSave={({ name, ...route }, create) =>
        void onChange(
          { target: create ? { kind: "class", name } : target, route, create },
          `Saved ${create ? `classes.${name}` : (row?.path ?? "")}`,
        )
      }
    />
  );
  return (
    <>
      {view.error && <Alert tone="error">{view.error}</Alert>}
      {!editing && problems.length > 0 && <Refused problems={problems} />}
      {routingGroups(view).map((group) => (
        <div key={group.id} className="flex flex-col gap-2">
          <div className="flex flex-col">
            <h3 className={LABEL}>{group.title}</h3>
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
                  <TableHead>{group.id === "classes" ? "Class" : "Name"}</TableHead>
                  <TableHead className={cn(scope === "global" && "text-foreground")}>
                    All projects
                  </TableHead>
                  <TableHead className={cn(scope === "project" && "text-foreground")}>
                    This project
                  </TableHead>
                  <TableHead>Resolves to</TableHead>
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
          {editing && "row" in editing && group.rows.includes(editing.row)
            ? form(editing.row.target, editing.row)
            : null}
          {group.id === "classes" &&
            (editing && "newClass" in editing ? (
              form({ kind: "class", name: "" }, null)
            ) : (
              <div>
                <Button
                  variant="neutral"
                  size="sm"
                  disabled={busy}
                  onClick={() => onEdit({ newClass: true })}
                >
                  Add class
                </Button>
              </div>
            ))}
        </div>
      ))}
      <IndependentReviewRow view={view} scope={scope} busy={busy} onChange={onChange} />
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
  scope,
  busy,
  selected,
  onEdit,
  onClear,
}: {
  view: RoutingOverview;
  row: RoutingRow;
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
      <TableCell className="font-mono">{row.label}</TableCell>
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
            aria-label={`Edit ${row.target.kind} ${row.label}`}
          >
            Edit
          </Button>
          {own !== null && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={onClear}
              aria-label={`Clear ${row.target.kind} ${row.label}`}
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
  problems,
  onSave,
  onCancel,
}: {
  view: RoutingOverview;
  row: RoutingRow | null;
  target: RoutingTarget;
  scope: RoutingScope;
  busy: boolean;
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
  const [fallback, setFallback] = useState(initial.fallback.join(", "));
  const create = row === null;
  const isClass = target.kind === "class";
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSave({ name: name.trim(), model, effort, fallback: parseFallback(fallback) }, create);
  };
  const id = (field: string) => `route-${field}`;
  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={submit}
          aria-label={row ? `Route ${row.path}` : "New class"}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-heading">
              {row ? <span className="font-mono">modelRouting.{row.path}</span> : "New class"}
            </span>
            <Badge tone={scope === "global" ? "info" : "accent"}>
              {scope === "global" ? "All projects" : "This project"}
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
            {create && (
              <div className="flex flex-col gap-1">
                <Label htmlFor={id("name")}>Class name</Label>
                <Input
                  id={id("name")}
                  className="font-mono"
                  value={name}
                  placeholder="deep"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}
            <div className={cn("flex flex-col gap-1", !create && "sm:col-span-2")}>
              <Label htmlFor={id("model")}>Model</Label>
              <Input
                id={id("model")}
                className="font-mono"
                value={model}
                list={isClass ? undefined : id("classes")}
                placeholder={isClass ? "provider/model" : "provider/model or $class"}
                onChange={(e) => setModel(e.target.value)}
              />
              {!isClass && (
                <datalist id={id("classes")}>
                  {classSuggestions(view).map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={id("effort")}>Effort</Label>
              <select
                id={id("effort")}
                value={effort ?? ""}
                onChange={(e) => setEffort((e.target.value || null) as Effort | null)}
              >
                {EFFORT_CHOICES.map((value) => (
                  <option key={value ?? "unset"} value={value ?? ""}>
                    {value ?? "inherit"}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={id("fallback")}>Fallback models, in order (up to 3)</Label>
            <Input
              id={id("fallback")}
              className="font-mono"
              value={fallback}
              placeholder="none"
              onChange={(e) => setFallback(e.target.value)}
            />
          </div>
          {problems.length > 0 && <Refused problems={problems} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              Save
            </Button>
            <Button type="button" variant="neutral" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
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
        <span>Independent review</span>
        <span className={cn("text-dim-foreground", NOTE)}>
          When a reviewer would use a model the implementation also uses: off ignores it, warn
          records a warning, require refuses the start. In effect:{" "}
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

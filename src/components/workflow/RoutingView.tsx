import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { ModelCatalog } from "../../core/llm/model-choices.js";
import {
  type ModelRouting,
  mergeModelRouting,
  ROUTED_ROLES,
  type RouteContext,
  type RoutingInputs,
} from "../../core/llm/model-routing.js";
import { useTheme } from "../../core/theme/index.js";
import type { RouteExplanation } from "../../core/workflows/routing.js";
import {
  applyRoutingChange,
  CONTEXT_CHOICES,
  describeRoute,
  draftOf,
  EFFORT_CHOICES,
  formatRouteContext,
  type IndependentReviewMode,
  parseFallback,
  type RoutingScope,
  type RoutingTarget,
  resolveTarget,
  routeAt,
  routingClasses,
  setCodeWebSearch,
  setCritic,
  setIndependentReview,
  setReviewMinConfidence,
  setRoutingContext,
  setSpecifyOnSonnet,
  targetPath,
} from "../../core/workflows/routing-edit.js";
import { DEFAULT_REVIEW_MIN_CONFIDENCE } from "../../core/workflows/schemas.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { PremiumPopup } from "../ui/index.js";
import { PopupViewport } from "../ui/PopupViewport.js";
import { ModelPickList } from "./ModelPickList.js";

export type { RoutingScope };

/** Everything the routing screen needs from the outside, so it renders the same in tests. */
export interface RoutingApi {
  /** `modelRouting` of each configuration layer as written, and the workflows a run can use. */
  load(): {
    global: ModelRouting | undefined;
    project: ModelRouting | undefined;
    workflows: string[];
    /** The legacy `/router` Code and Review slots that `$coding` and `$review` fall back to. */
    legacy?: RoutingInputs["legacy"];
    /** The independent-review mode a run uses when no layer sets one. */
    reviewMode?: IndependentReviewMode;
  };
  /** The models a run of this workflow would use with the saved configuration. */
  explain(workflowId: string, model: string | null): RouteExplanation;
  /** Writes one layer's `modelRouting`; undefined removes the section. */
  save(scope: RoutingScope, routing: ModelRouting | undefined): void;
  /** The models of each provider for the model list; without it the fields only take typed IDs. */
  models?(): Promise<ModelCatalog>;
}

export type RoutingMode = "browse" | "edit" | "pick";

export const ROUTING_HINTS: Record<RoutingMode, { key: string; label: string }[]> = {
  browse: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "edit" },
    { key: "D", label: "clear" },
    { key: "Tab", label: "scope" },
    { key: "W", label: "workflow" },
    { key: "←→", label: "review mode" },
    { key: "Esc", label: "back" },
  ],
  edit: [
    { key: "↑↓/Tab", label: "field" },
    { key: "Enter", label: "model list" },
    { key: "←→", label: "effort, context" },
    { key: "Ctrl+S", label: "save" },
    { key: "Esc", label: "cancel" },
  ],
  pick: [
    { key: "type", label: "filter" },
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "choose" },
    { key: "Esc", label: "back" },
  ],
};

type Row =
  | { kind: "header"; title: string }
  | { kind: "route"; target: RoutingTarget; label: string }
  | { kind: "new-class" }
  | { kind: "review" }
  | { kind: "confidence" }
  | { kind: "critic" }
  | { kind: "specify" }
  | { kind: "search" }
  | { kind: "context" }
  | { kind: "note"; text: string; tone: "muted" | "error" };

type Field = "name" | "model" | "effort" | "context" | "fallback";
interface Form {
  target: RoutingTarget;
  isNew: boolean;
  name: string;
  model: string;
  effort: (typeof EFFORT_CHOICES)[number];
  context: RouteContext | null;
  fallback: string;
  field: Field;
}

/** A resolved route as the screen shows it. */
interface Shown {
  model: string;
  source: string;
  effort?: string | null | undefined;
  fallback?: string[] | undefined;
  context?: RouteContext | null | undefined;
}

/** The context choices a form cycles through, with a window the route already names. */
function contextChoices(current: RouteContext | null): (RouteContext | null)[] {
  return typeof current === "number" ? [...CONTEXT_CHOICES, current] : [...CONTEXT_CHOICES];
}

const REVIEW_MODES = [null, "off", "warn", "require", "provider"] as const;
const CONFIDENCE_STEP = 0.05;
const CRITIC_MODES = [null, "off", "advise", "select", "earlyStop"] as const;
const clip = (text: string, width: number): string =>
  width <= 0 ? "" : text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;
const pad = (text: string, width: number): string => clip(text, width).padEnd(width);

function selectable(row: Row | undefined): boolean {
  return (
    !!row &&
    (row.kind === "route" ||
      row.kind === "new-class" ||
      row.kind === "review" ||
      row.kind === "confidence" ||
      row.kind === "critic" ||
      row.kind === "specify" ||
      row.kind === "search" ||
      row.kind === "context")
  );
}

function initialScope(api: RoutingApi): RoutingScope {
  try {
    return api.load().project ? "project" : "global";
  } catch {
    return "global";
  }
}

export function RoutingView({
  active,
  api,
  model,
  width: maxWidth,
  height,
  onBack,
  onMode,
  onSaved,
  notify,
}: {
  active: boolean;
  api: RoutingApi;
  /** The run model routes resolve against: the chat tab's model. */
  model: string | null;
  width: number;
  height: number;
  onBack: () => void;
  onMode?: (mode: RoutingMode) => void;
  onSaved?: () => void;
  notify: (kind: "ok" | "err" | "info", message: string) => void;
}) {
  const t = useTheme();
  // The popup body's size: rows for the list, and columns inside the padding and scrollbar.
  const viewport = useContext(PopupViewport);
  const width = viewport ? Math.max(10, Math.min(maxWidth, viewport.width - 3)) : maxWidth;
  const bodyRows = viewport?.height ?? height - 10;
  const [generation, setGeneration] = useState(0);
  const [scope, setScope] = useState<RoutingScope>(() => initialScope(api));
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [form, setForm] = useState<Form | null>(null);
  const [formProblems, setFormProblems] = useState<string[]>([]);
  const [picking, setPicking] = useState<"model" | "fallback" | null>(null);
  const [catalog, setCatalog] = useState<{ data: ModelCatalog | null; error: string | null }>({
    data: null,
    error: null,
  });
  const mode: RoutingMode = picking ? "pick" : form ? "edit" : "browse";
  useEffect(() => onMode?.(mode), [mode, onMode]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation re-reads the saved files
  const loaded = useMemo(() => {
    try {
      return { data: api.load(), error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [api, generation]);
  const layers = { global: loaded.data?.global, project: loaded.data?.project };
  const workflows = loaded.data?.workflows ?? [];
  const workflow = workflowId ?? (workflows.includes("sdd") ? "sdd" : (workflows[0] ?? null));
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation re-reads the saved files
  const explained = useMemo(() => {
    if (!workflow) return { data: null, error: "No workflow definitions found" };
    try {
      return { data: api.explain(workflow, model), error: null };
    } catch (err) {
      return { data: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [api, workflow, model, generation]);
  const effective = mergeModelRouting(layers.global, layers.project);
  const confidence = effective?.reviewMinConfidence ?? DEFAULT_REVIEW_MIN_CONFIDENCE;
  const wantsModels = picking !== null && catalog.data === null && catalog.error === null;
  useEffect(() => {
    if (!wantsModels) return;
    if (!api.models) {
      setCatalog({ data: { providers: [] }, error: null });
      return;
    }
    let live = true;
    api.models().then(
      (data) => live && setCatalog({ data, error: null }),
      (err: unknown) =>
        live && setCatalog({ data: null, error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [api, wantsModels]);
  const runModel = explained.data?.runModel ?? model ?? null;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [{ kind: "header", title: "Classes" }];
    for (const name of routingClasses(layers.global, layers.project))
      out.push({ kind: "route", target: { kind: "class", name }, label: `$${name}` });
    out.push({ kind: "new-class" });
    out.push({ kind: "header", title: "Roles" });
    for (const role of ROUTED_ROLES)
      out.push({ kind: "route", target: { kind: "role", role }, label: role });
    out.push({ kind: "header", title: `Stages of ${workflow ?? "—"}` });
    if (explained.error) out.push({ kind: "note", text: explained.error, tone: "error" });
    if (workflow)
      for (const stage of explained.data?.stages ?? [])
        out.push({
          kind: "route",
          target: { kind: "stage", workflowId: workflow, stageId: stage.stageId },
          label: stage.stageId,
        });
    out.push({ kind: "specify" });
    out.push({ kind: "header", title: "Profiles" });
    for (const id of Object.keys(explained.data?.profiles ?? {}).sort())
      out.push({ kind: "route", target: { kind: "profile", id }, label: id });
    out.push({ kind: "search" });
    out.push({ kind: "context" });
    out.push({ kind: "header", title: "Independent review" });
    out.push({ kind: "review" });
    out.push({ kind: "confidence" });
    out.push({ kind: "critic" });
    return out;
  }, [layers.global, layers.project, workflow, explained]);

  // Keep the cursor on a selectable row when rows change.
  useEffect(() => {
    if (selectable(rows[cursor])) return;
    const next = rows.findIndex((row, i) => i >= cursor && selectable(row));
    const fallback = rows.findIndex(selectable);
    setCursor(next >= 0 ? next : Math.max(0, fallback));
  }, [rows, cursor]);

  const other: RoutingScope = scope === "global" ? "project" : "global";
  const current = rows[cursor];

  const resolved = (target: RoutingTarget): Shown | null =>
    resolveTarget(target, {
      routing: effective,
      runModel,
      legacy: loaded.data?.legacy,
      explanation: explained.data,
    });
  const resolvedText = (r: Shown): string =>
    [
      r.model,
      ...(r.effort ? [r.effort] : []),
      ...(r.context ? [`context ${formatRouteContext(r.context)}`] : []),
      ...(r.fallback?.length ? [`→ ${r.fallback.join(", ")}`] : []),
    ].join(" · ");

  const save = (next: ModelRouting | undefined, what: string): boolean => {
    try {
      api.save(scope, next);
    } catch (err) {
      notify("err", err instanceof Error ? err.message : String(err));
      return false;
    }
    setGeneration((g) => g + 1);
    onSaved?.();
    notify(
      "ok",
      `${what} in the ${scope} config. New runs use it; started runs keep their routing.`,
    );
    return true;
  };

  const openForm = (target: RoutingTarget, isNew: boolean): void => {
    const draft = draftOf(routeAt(layers[scope], target));
    setForm({
      target,
      isNew,
      name: "",
      model: draft.model,
      effort: draft.effort,
      context: draft.context ?? null,
      fallback: draft.fallback.join(", "),
      field: isNew ? "name" : "model",
    });
    setFormProblems([]);
  };

  const submit = (f: Form): void => {
    const target: RoutingTarget = f.isNew ? { kind: "class", name: f.name.trim() } : f.target;
    const draft = {
      model: f.model,
      effort: f.effort,
      context: f.context,
      fallback: parseFallback(f.fallback),
    };
    const { routing: next, problems } = applyRoutingChange(layers, scope, {
      target,
      route: draft,
      create: f.isNew,
    });
    if (problems.length) {
      setFormProblems(problems);
      return;
    }
    if (save(next, `Saved modelRouting.${targetPath(target)}`)) setForm(null);
  };

  const clear = (target: RoutingTarget): void => {
    if (routeAt(layers[scope], target) === undefined) {
      notify("info", `modelRouting.${targetPath(target)} is not set in the ${scope} config`);
      return;
    }
    const { routing: next, problems } = applyRoutingChange(layers, scope, { target, route: null });
    if (problems.length) {
      notify("err", `Not cleared: ${problems[0]}`);
      return;
    }
    save(next, `Cleared modelRouting.${targetPath(target)}`);
  };

  const fields: Field[] = form?.isNew
    ? ["name", "model", "effort", "context", "fallback"]
    : ["model", "effort", "context", "fallback"];

  const pick = (id: string): void => {
    setPicking(null);
    setForm((f) => {
      if (!f) return f;
      if (picking === "model") return { ...f, model: id, field: "effort" };
      const list = parseFallback(f.fallback);
      const next = list.includes(id) ? list : [...list, id].slice(-3);
      return { ...f, fallback: next.join(", ") };
    });
  };

  useKeyboard((evt) => {
    if (!active || picking) return;
    const key = evt.name.toLowerCase();
    if (form) {
      if (key === "escape") {
        evt.preventDefault();
        setForm(null);
        return;
      }
      if (key === "up" || key === "down" || key === "tab") {
        evt.preventDefault();
        const i = fields.indexOf(form.field);
        const step = key === "up" || (key === "tab" && evt.shift) ? fields.length - 1 : 1;
        setForm({ ...form, field: fields[(i + step) % fields.length] ?? "model" });
        return;
      }
      if (form.field === "effort" && (key === "left" || key === "right" || key === "space")) {
        evt.preventDefault();
        const i = EFFORT_CHOICES.indexOf(form.effort);
        const step = key === "left" ? EFFORT_CHOICES.length - 1 : 1;
        setForm({ ...form, effort: EFFORT_CHOICES[(i + step) % EFFORT_CHOICES.length] ?? null });
        return;
      }
      if (form.field === "context" && (key === "left" || key === "right" || key === "space")) {
        evt.preventDefault();
        const choices = contextChoices(form.context);
        const i = choices.indexOf(form.context);
        const step = key === "left" ? choices.length - 1 : 1;
        setForm({ ...form, context: choices[(i + step) % choices.length] ?? null });
        return;
      }
      if (key === "return" && (form.field === "model" || form.field === "fallback")) {
        evt.preventDefault();
        setPicking(form.field);
        return;
      }
      if (key === "return" || (evt.ctrl && key === "s")) {
        evt.preventDefault();
        submit(form);
      }
      return;
    }
    if (key === "escape") {
      evt.preventDefault();
      onBack();
      return;
    }
    if (key === "up" || key === "down" || key === "k" || key === "j") {
      evt.preventDefault();
      const dir = key === "up" || key === "k" ? -1 : 1;
      for (let i = 1; i <= rows.length; i++) {
        const next = (cursor + dir * i + rows.length * 2) % rows.length;
        if (selectable(rows[next])) {
          setCursor(next);
          break;
        }
      }
      return;
    }
    if (key === "tab") {
      evt.preventDefault();
      setScope(other);
      return;
    }
    if (key === "w") {
      evt.preventDefault();
      if (workflows.length < 2 || !workflow) return;
      const i = workflows.indexOf(workflow);
      setWorkflowId(
        workflows[(i + (evt.shift ? workflows.length - 1 : 1)) % workflows.length] ?? null,
      );
      return;
    }
    if (!current) return;
    if (current.kind === "review" && (key === "left" || key === "right" || key === "space")) {
      evt.preventDefault();
      const i = REVIEW_MODES.indexOf(layers[scope]?.independentReview ?? null);
      const step = key === "left" ? REVIEW_MODES.length - 1 : 1;
      const next = REVIEW_MODES[(i + step) % REVIEW_MODES.length] ?? null;
      const routing = setIndependentReview(layers[scope], next);
      save(routing, next ? `Set independentReview to ${next}` : "Cleared independentReview");
      return;
    }
    if (key === "return") {
      evt.preventDefault();
      if (current.kind === "route") openForm(current.target, false);
      else if (current.kind === "new-class") openForm({ kind: "class", name: "" }, true);
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "route") {
      evt.preventDefault();
      clear(current.target);
      return;
    }
    if (current.kind === "confidence" && (key === "left" || key === "right")) {
      evt.preventDefault();
      const own = layers[scope]?.reviewMinConfidence ?? confidence;
      const next = Math.min(1, Math.max(0, own + (key === "left" ? -1 : 1) * CONFIDENCE_STEP));
      const rounded = Math.round(next * 100) / 100;
      save(setReviewMinConfidence(layers[scope], rounded), `Set reviewMinConfidence to ${rounded}`);
      return;
    }
    if (current.kind === "critic" && (key === "left" || key === "right" || key === "space")) {
      evt.preventDefault();
      const i = CRITIC_MODES.indexOf(layers[scope]?.critic ?? null);
      const step = key === "left" ? CRITIC_MODES.length - 1 : 1;
      const next = CRITIC_MODES[(i + step) % CRITIC_MODES.length] ?? null;
      save(setCritic(layers[scope], next), next ? `Set critic to ${next}` : "Cleared critic");
      return;
    }
    if (current.kind === "specify" && (key === "left" || key === "right" || key === "space")) {
      evt.preventDefault();
      const values = [null, true, false] as const;
      const i = values.indexOf(layers[scope]?.specifyOnSonnet ?? null);
      const next = values[(i + (key === "left" ? values.length - 1 : 1)) % values.length] ?? null;
      save(
        setSpecifyOnSonnet(layers[scope], next),
        next === null ? "Cleared specifyOnSonnet" : `Set specifyOnSonnet to ${next ? "on" : "off"}`,
      );
      return;
    }
    if (current.kind === "search" && (key === "left" || key === "right" || key === "space")) {
      evt.preventDefault();
      const values = [null, true, false] as const;
      const i = values.indexOf(layers[scope]?.codeWebSearch ?? null);
      const next = values[(i + (key === "left" ? values.length - 1 : 1)) % values.length] ?? null;
      save(
        setCodeWebSearch(layers[scope], next),
        next === null ? "Cleared codeWebSearch" : `Set codeWebSearch to ${next ? "on" : "off"}`,
      );
      return;
    }
    if (current.kind === "context" && (key === "left" || key === "right" || key === "space")) {
      evt.preventDefault();
      const choices = contextChoices(layers[scope]?.context ?? null);
      const i = choices.indexOf(layers[scope]?.context ?? null);
      const next =
        choices[(i + (key === "left" ? choices.length - 1 : 1)) % choices.length] ?? null;
      save(
        setRoutingContext(layers[scope], next),
        next === null ? "Cleared context" : `Set context to ${formatRouteContext(next)}`,
      );
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "context") {
      evt.preventDefault();
      if (layers[scope]?.context === undefined) return;
      save(setRoutingContext(layers[scope], null), "Cleared context");
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "search") {
      evt.preventDefault();
      if (layers[scope]?.codeWebSearch === undefined) return;
      save(setCodeWebSearch(layers[scope], null), "Cleared codeWebSearch");
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "specify") {
      evt.preventDefault();
      if (layers[scope]?.specifyOnSonnet === undefined) return;
      save(setSpecifyOnSonnet(layers[scope], null), "Cleared specifyOnSonnet");
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "critic") {
      evt.preventDefault();
      if (!layers[scope]?.critic) return;
      save(setCritic(layers[scope], null), "Cleared critic");
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "confidence") {
      evt.preventDefault();
      if (layers[scope]?.reviewMinConfidence === undefined) return;
      save(setReviewMinConfidence(layers[scope], null), "Cleared reviewMinConfidence");
      return;
    }
    if ((key === "d" || key === "delete" || key === "backspace") && current.kind === "review") {
      evt.preventDefault();
      if (!layers[scope]?.independentReview) return;
      save(setIndependentReview(layers[scope], null), "Cleared independentReview");
    }
  });

  const compact = bodyRows < 16;
  const narrow = width < 70;
  const file = scope === "global" ? "~/.baked/config.json" : ".baked/config.json";
  const scopeLine = (
    <text>
      {compact ? null : <span fg={t.textMuted}>Scope </span>}
      {(["global", "project"] as const).map((s) => (
        <span key={s} fg={s === scope ? t.brand : t.textFaint}>
          {s === scope ? `[${s}] ` : `${s} `}
        </span>
      ))}
      <span fg={t.textMuted}>
        {clip(
          compact
            ? `· ${workflow ?? "—"} · ${runModel ?? "no run model"}`
            : narrow
              ? ""
              : ` · Workflow ‹ ${workflow ?? "—"} ›`,
          Math.max(0, width - 18),
        )}
      </span>
    </text>
  );
  const header = compact ? (
    scopeLine
  ) : (
    <box flexDirection="column">
      {scopeLine}
      {narrow ? (
        <text fg={t.textMuted}>{clip(`Workflow ‹ ${workflow ?? "—"} ›`, width)}</text>
      ) : null}
      <text fg={t.textFaint}>
        {clip(`Run model: ${runModel ?? "none (pick one with Ctrl+L)"} · ${file}`, width)}
      </text>
    </box>
  );
  const headerRows = compact ? 1 : narrow ? 3 : 2;

  if (loaded.error)
    return (
      <box flexDirection="column">
        <text fg={t.error}>{clip(`✗ ${loaded.error}`, width)}</text>
      </box>
    );

  if (form && picking) {
    const target: RoutingTarget = form.isNew
      ? { kind: "class", name: form.name.trim() || "NAME" }
      : form.target;
    // A class names a model, and fallback models are models, so only a route's model takes $class.
    const withClasses = picking === "model" && target.kind !== "class";
    const classes = withClasses ? routingClasses(layers.global, layers.project) : [];
    const classDetails: Record<string, string> = {};
    for (const name of classes) {
      const r = resolved({ kind: "class", name });
      if (r) classDetails[name] = resolvedText(r);
    }
    return (
      <box flexDirection="column">
        {header}
        <ModelPickList
          active={active}
          catalog={catalog.data}
          error={catalog.error}
          classes={classes}
          classDetails={classDetails}
          title={
            picking === "model"
              ? `Model for modelRouting.${targetPath(target)}`
              : `Add a fallback model (${parseFallback(form.fallback).length} of 3)`
          }
          width={width}
          rows={bodyRows - headerRows}
          onPick={pick}
          onCancel={() => setPicking(null)}
        />
      </box>
    );
  }

  if (form) {
    const target: RoutingTarget = form.isNew
      ? { kind: "class", name: form.name.trim() || "NAME" }
      : form.target;
    const inputW = Math.max(12, Math.min(width - 14, 60));
    const line = (field: Field, label: string, body: ReactNode) => (
      <box flexDirection="row" key={field}>
        <text fg={form.field === field ? t.brand : t.textMuted}>
          {pad(`${form.field === field ? "▸" : " "} ${label}`, 12)}
        </text>
        {body}
      </box>
    );
    const input = (
      field: Field,
      value: string,
      placeholder: string,
      onInput: (v: string) => void,
    ) => (
      <box width={inputW} backgroundColor={t.bgPopupHighlight}>
        <input
          value={value}
          onInput={onInput}
          placeholder={placeholder}
          focused={active && form.field === field}
          backgroundColor={t.bgPopupHighlight}
        />
      </box>
    );
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>
          {clip(
            form.isNew
              ? `New class in the ${scope} config`
              : `modelRouting.${targetPath(target)} (${scope})`,
            width,
          )}
        </text>
        {form.isNew
          ? line(
              "name",
              "Name",
              input("name", form.name, "deep", (v) => setForm((f) => (f ? { ...f, name: v } : f))),
            )
          : null}
        {line(
          "model",
          "Model",
          input(
            "model",
            form.model,
            target.kind === "class" ? "provider/model" : "provider/model or $class",
            (v) => setForm((f) => (f ? { ...f, model: v } : f)),
          ),
        )}
        {line(
          "effort",
          "Effort",
          <text fg={form.field === "effort" ? t.brand : t.textPrimary}>
            {`‹ ${form.effort ?? "unset"} ›`}
          </text>,
        )}
        {line(
          "context",
          "Context",
          <text fg={form.field === "context" ? t.brand : t.textPrimary}>
            {`‹ ${form.context === null ? "unset" : formatRouteContext(form.context)} ›`}
          </text>,
        )}
        {line(
          "fallback",
          "Fallback",
          input("fallback", form.fallback, "up to 3 model IDs, comma separated", (v) =>
            setForm((f) => (f ? { ...f, fallback: v } : f)),
          ),
        )}
        <text fg={t.textFaint}>
          {clip(
            form.field === "context"
              ? "Context: max runs the largest window the model offers; auto moves a step that does not fit to it."
              : form.effort === null
                ? "Effort unset: a class reference brings its class's effort, otherwise the provider setting applies."
                : "Effort replaces performance.effort for these agents' calls; default sends none.",
            width,
          )}
        </text>
        {compact ? null : (
          <text fg={t.textFaint}>
            {clip(
              api.models
                ? "Enter on Model or Fallback opens the list of available models; you can also type an ID."
                : "Type a model ID as provider/model.",
              width,
            )}
          </text>
        )}
        {formProblems.map((problem) => (
          <text key={problem} fg={t.error}>
            {`✗ ${problem}`}
          </text>
        ))}
      </box>
    );
  }

  // Browse: one scrolling list with a detail block for the selected row.
  const warnings = (explained.data?.warnings ?? []).slice(0, compact ? 0 : narrow ? 1 : 2);
  const detailRows = compact ? 2 : 3;
  // Header, list, then the detail block; the normal layout adds two spacer rows and a counter.
  const listRows = Math.max(
    3,
    bodyRows - headerRows - detailRows - warnings.length - (compact ? 0 : 3),
  );
  const start = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), rows.length - listRows));
  const labelW = Math.min(20, Math.max(10, Math.floor(width * 0.3)));
  const valueW = Math.max(4, width - labelW - 3);
  const reviewMode =
    effective?.independentReview ?? loaded.data?.reviewMode ?? (effective ? "warn" : "off");
  const rowText = (row: Row): { value: string; tone: "set" | "inherited" | "default" } => {
    if (row.kind === "review") {
      const own = layers[scope]?.independentReview;
      return own
        ? { value: `‹ ${own} ›`, tone: "set" }
        : { value: `‹ unset › = ${reviewMode}`, tone: "default" };
    }
    if (row.kind === "critic") {
      const own = layers[scope]?.critic;
      return own
        ? { value: `‹ ${own} ›`, tone: "set" }
        : { value: `‹ unset › = ${effective?.critic ?? "on another vendor"}`, tone: "default" };
    }
    if (row.kind === "specify") {
      const own = layers[scope]?.specifyOnSonnet;
      return own !== undefined
        ? { value: `‹ ${own ? "on" : "off"} ›`, tone: "set" }
        : { value: `‹ unset › = ${effective?.specifyOnSonnet ? "on" : "off"}`, tone: "default" };
    }
    if (row.kind === "search") {
      const own = layers[scope]?.codeWebSearch;
      return own !== undefined
        ? { value: `‹ ${own ? "on" : "off"} ›`, tone: "set" }
        : { value: `‹ unset › = ${effective?.codeWebSearch ? "on" : "off"}`, tone: "default" };
    }
    if (row.kind === "context") {
      const own = layers[scope]?.context;
      return own !== undefined
        ? { value: `‹ ${formatRouteContext(own)} ›`, tone: "set" }
        : {
            value: `‹ unset › = ${effective?.context ? formatRouteContext(effective.context) : "default"}`,
            tone: "default",
          };
    }
    if (row.kind === "confidence") {
      const own = layers[scope]?.reviewMinConfidence;
      return own !== undefined
        ? { value: `‹ ${own} ›`, tone: "set" }
        : { value: `‹ unset › = ${confidence}`, tone: "default" };
    }
    if (row.kind !== "route") return { value: "", tone: "default" };
    const own = routeAt(layers[scope], row.target);
    if (own !== undefined) return { value: describeRoute(own), tone: "set" };
    const theirs = routeAt(layers[other], row.target);
    if (theirs !== undefined)
      return { value: `${other}: ${describeRoute(theirs)}`, tone: "inherited" };
    const r = resolved(row.target);
    if (row.target.kind === "stage")
      return { value: r ? `= ${resolvedText(r)}` : "each agent's profile", tone: "default" };
    if (row.target.kind === "role") return { value: "profile's own", tone: "default" };
    return { value: r ? `= ${resolvedText(r)}` : "—", tone: "default" };
  };
  const detail: string[] = [];
  if (current?.kind === "route") {
    const own = routeAt(layers[scope], current.target);
    const theirs = routeAt(layers[other], current.target);
    detail.push(`modelRouting.${targetPath(current.target)}`);
    detail.push(
      `${scope}: ${own === undefined ? "unset" : describeRoute(own)}   ${other}: ${theirs === undefined ? "unset" : describeRoute(theirs)}`,
    );
    const r = resolved(current.target);
    if (r) detail.push(`Resolves to ${resolvedText(r)} (${r.source})`);
    else if (current.target.kind === "stage")
      detail.push("No stage route: each agent uses its profile's model");
    else if (current.target.kind === "role")
      detail.push("No role route: each profile of this role keeps its own model or class");
  } else if (current?.kind === "new-class") {
    detail.push("Enter adds a class; routes name it as $NAME.");
  } else if (current?.kind === "review") {
    detail.push(`Effective: ${reviewMode}. warn records a warning, require refuses the start`);
    detail.push("when a reviewer shares the implementation's model; provider moves reviewers");
    detail.push("to another vendor's model (Codex reviews Claude Code and back).");
  } else if (current?.kind === "critic") {
    detail.push("The critic scores every task attempt. advise only shows the score; select");
    detail.push("keeps the best attempt and earlyStop ends a passing correction loop, once");
    detail.push("/workflow outcomes calibrates it. Unset runs it on another vendor; off never.");
  } else if (current?.kind === "specify") {
    detail.push("On: a run on a Claude Code Opus model writes its spec on claude-code/sonnet,");
    detail.push("unless a stage route or --route names the specify model. Off by default.");
    detail.push("←→ or Space switch it, D clears it.");
  } else if (current?.kind === "search") {
    detail.push("On: implementer and acceptance-writer attempts on a Codex model may use Codex's");
    detail.push("web search. Checks, tests and linters keep the policy's network. Off by default.");
    detail.push("←→ or Space switch it, D clears it.");
  } else if (current?.kind === "context") {
    detail.push("The context window of routes without their own: max runs the largest window");
    detail.push("a model offers (Claude Code [1m]); auto keeps the model as named and moves a");
    detail.push("step whose context does not fit to it. ←→ or Space switch it, D clears it.");
  } else if (current?.kind === "confidence") {
    detail.push(`Effective: ${confidence}. Review findings below this confidence stay notes`);
    detail.push("and start no correction. ←→ change it by 0.05, D clears it.");
  }
  while (detail.length < 3) detail.push("");
  const shownDetail = compact
    ? [detail[0] ?? "", detail[2] || detail[1] || ""]
    : detail.slice(0, 3);
  return (
    <box flexDirection="column">
      {header}
      <box flexDirection="column" marginTop={compact ? 0 : 1}>
        {rows.slice(start, start + listRows).map((row, n) => {
          const index = start + n;
          if (row.kind === "header")
            return (
              <text key={`h-${row.title}`} fg={t.brandAlt} attributes={1}>
                {clip(row.title, width)}
              </text>
            );
          if (row.kind === "note")
            return (
              <text key={`n-${index}`} fg={row.tone === "error" ? t.error : t.textMuted}>
                {clip(`  ${row.text}`, width)}
              </text>
            );
          const selected = index === cursor;
          const bg = selected ? t.bgPopupHighlight : t.bgPopup;
          const label =
            row.kind === "route"
              ? row.label
              : row.kind === "new-class"
                ? "+ new class"
                : row.kind === "confidence"
                  ? "reviewMinConfidence"
                  : row.kind === "critic"
                    ? "critic"
                    : row.kind === "specify"
                      ? "specify on Sonnet"
                      : row.kind === "search"
                        ? "code web search"
                        : row.kind === "context"
                          ? "context window"
                          : "independentReview";
          const { value, tone } = rowText(row);
          return (
            <text key={`r-${index}`} bg={bg}>
              <span fg={selected ? t.brand : t.textFaint}>{selected ? "▸ " : "  "}</span>
              <span fg={row.kind === "new-class" ? t.textMuted : t.textPrimary}>
                {pad(label, labelW)}
              </span>
              <span
                fg={
                  tone === "set" ? t.brandAlt : tone === "inherited" ? t.textSecondary : t.textFaint
                }
              >
                {` ${clip(value, valueW)}`}
              </span>
            </text>
          );
        })}
        {compact ? null : (
          <text fg={t.textFaint}>
            {rows.length > listRows
              ? clip(
                  `  ${start + 1}-${Math.min(rows.length, start + listRows)} of ${rows.length}`,
                  width,
                )
              : " "}
          </text>
        )}
      </box>
      <box flexDirection="column" marginTop={compact ? 0 : 1}>
        {shownDetail.map((text, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed detail lines
          <text key={`d-${n}`} fg={n === 0 ? t.textSecondary : t.textMuted}>
            {clip(text || " ", width)}
          </text>
        ))}
        {warnings.map((w) => (
          <text key={w} fg={t.warning}>
            {clip(`! ${w}`, width)}
          </text>
        ))}
      </box>
    </box>
  );
}

/** The routing screen in the workflow popup, as the panel shows it. */
export function RoutingPopup({
  api,
  model,
  width,
  height,
  onBack,
  onSaved,
}: {
  api: RoutingApi;
  model: string | null;
  width: number;
  height: number;
  onBack: () => void;
  onSaved?: () => void;
}) {
  const [mode, setMode] = useState<RoutingMode>("browse");
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);
  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb="Model routing: which model runs each class, role, stage and profile"
      width={width}
      height={height}
      footerHints={ROUTING_HINTS[mode]}
      flash={flash}
    >
      <box flexDirection="column" paddingX={1}>
        <RoutingView
          active
          api={api}
          model={model}
          width={width - 6}
          height={height}
          onBack={onBack}
          onMode={setMode}
          {...(onSaved ? { onSaved } : {})}
          notify={(kind, message) => setFlash({ kind, message })}
        />
      </box>
    </PremiumPopup>
  );
}

import { type PointerEvent, useEffect, useState } from "react";
import {
  type EditorOp,
  type EditorView,
  type GateTarget,
  type InsertableStage,
  MAX_LOOP_ROUNDS,
  type Outcome,
  RECOMMENDED_LOOP_ROUNDS,
  type StageView,
  type TargetView,
} from "../../client/workflow-editor.js";
import { Icon } from "../../components/Icon.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Dot } from "../../components/ui/dot.js";
import { fieldClass } from "../../components/ui/input.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { FINISH, stageIcon } from "../runs/line-model.js";
import { ACTIONS, GROW, NOTE, ROW, WRAP } from "./shared.js";
import { TYPE_FILL } from "./WorkflowGallery.js";
import { problemsFor } from "./workflow-editor-logic.js";
import { type ArrowDraft, NEW_STATIONS, OUTCOME_WHEN } from "./workflow-studio-model.js";

/**
 * The panel beside the workflow graph: the selected station or arrow in words, with the station
 * names in the colours of the graph. A station shows its settings, the gates it runs and where
 * the line goes from it; ‹ and › walk the stations in order, as the walkthrough does. Every
 * change is an editor op.
 */

const SELECT = cn(fieldClass, "h-9 w-auto min-w-[140px] max-w-full flex-1 py-1 pr-8");

const TYPE_WORDS: Record<StageView["type"], string> = {
  agent: "An agent writes a document",
  tasks: "Writers change the code, task by task",
  check: "Runs commands; passes when they do",
  wait: "Polls commands until they pass or it times out",
  approval: "Waits for an approval",
  review: "AI reviewers read the change",
  reflection: "Reflects on the work and asks for another round or not",
  learn: "Writes down what the run learned",
};

/** A station's name in the colour and icon it has on the graph. */
export function StationChip({
  id,
  stage,
  size = "sm",
}: {
  id: string;
  stage: Pick<StageView, "type" | "produces"> | undefined;
  size?: "sm" | "lg";
}) {
  const finish = id === FINISH;
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-[5px] rounded-[5px] border-2 border-border align-middle font-mono font-bold whitespace-nowrap",
        finish ? "border-dashed bg-secondary-background text-foreground" : "text-main-foreground",
        !finish && stage ? TYPE_FILL[stage.type] : null,
        size === "lg" ? "px-[9px] py-[3px] text-[16px]" : "px-[6px] py-0 text-[12.5px]",
      )}
    >
      <Icon
        name={
          finish
            ? "accept"
            : stageIcon({ id, type: stage?.type ?? "agent", produces: stage?.produces ?? null })
        }
        size={size === "lg" ? 15 : 11}
      />
      <span className="truncate">{finish ? "done" : id}</span>
    </span>
  );
}

/** The number of rounds of a loop: steps, a typed number, and a note past the recommendation. */
export function RoundsField({
  value,
  label,
  disabled,
  onChange,
}: {
  value: number;
  label: string;
  disabled: boolean;
  onChange: (rounds: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (Number.isInteger(n) && n >= 1 && n <= MAX_LOOP_ROUNDS && n !== value) onChange(n);
    else setText(String(value));
  };
  return (
    <div className="flex flex-col gap-1">
      <div className={cn(ROW, "gap-x-2")}>
        <span className="min-w-[72px] text-[13px] text-dim-foreground">Rounds</span>
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Fewer rounds for ${label}`}
          disabled={disabled || value <= 1}
          onClick={() => onChange(value - 1)}
        >
          ‹
        </Button>
        <input
          aria-label={`Rounds of ${label}`}
          inputMode="numeric"
          className={cn(fieldClass, "h-9 w-[64px] px-2 py-1 text-center font-mono")}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          aria-label={`More rounds for ${label}`}
          disabled={disabled || value >= MAX_LOOP_ROUNDS}
          onClick={() => onChange(value + 1)}
        >
          ›
        </Button>
      </div>
      <span
        className={cn(
          NOTE,
          WRAP,
          value > RECOMMENDED_LOOP_ROUNDS ? "text-[var(--warn)]" : "text-dim-foreground",
        )}
      >
        {value > RECOMMENDED_LOOP_ROUNDS
          ? `More than ${RECOMMENDED_LOOP_ROUNDS}: every round runs the stations of the loop again, so a run that cannot fix it spends more before it stops.`
          : `1 to ${MAX_LOOP_ROUNDS}; ${RECOMMENDED_LOOP_ROUNDS} or fewer recommended.`}
      </span>
    </div>
  );
}

const ownGates = (stage: StageView): TargetView | undefined =>
  stage.targets.find((t) => t.target.kind === "stage");

/**
 * The gates on a station or an arrow: each with its mode, order and removal; an empty list says
 * what that means there; the picker adds a library gate and Create a gate… drafts a new one.
 */
export function GateBlock({
  stage,
  target,
  readOnly,
  busy,
  onEdit,
  onCreate,
}: {
  stage: StageView;
  target: TargetView;
  readOnly: boolean;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
  onCreate: (target: GateTarget) => void;
}) {
  const [pick, setPick] = useState("");
  const usable = target.options.filter((o) => o.disabled === null);
  const bound = new Set(target.bindings.map((b) => b.gateId));
  const unfit = [
    ...new Set(
      target.options.flatMap((o) => (o.disabled && !bound.has(o.gateId) ? [o.disabled] : [])),
    ),
  ];
  const choice = usable.some((o) => o.gateId === pick) ? pick : (usable[0]?.gateId ?? "");
  const t = target.target;
  const own = t.kind === "stage";
  const empty = own
    ? `No gates yet. A ${stage.type} station needs at least one to run.`
    : "No gates: the line moves on as soon as the station ends this way.";
  return (
    <fieldset
      className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
      aria-label={`Gates of ${target.name}`}
    >
      {target.bindings.length === 0 ? (
        <span className={cn(NOTE, WRAP, own ? "text-[var(--warn)]" : "text-dim-foreground")}>
          {empty}
        </span>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-[6px] p-0">
          {target.bindings.map((b, index) => (
            <li
              key={b.gateId}
              className="flex flex-wrap items-center gap-2 rounded-base border-2 border-border bg-secondary-background px-2 py-[6px]"
            >
              <span className="size-[9px] flex-none rotate-45 rounded-[2px] border-2 border-border bg-fill-ok" />
              <span className="flex min-w-[150px] flex-1 flex-col">
                <span className="truncate font-mono text-[12.5px] font-semibold text-foreground">
                  {b.gateId}
                </span>
                {b.summary && (
                  <span className="truncate text-[11.5px] text-dim-foreground" title={b.summary}>
                    {b.summary}
                  </span>
                )}
              </span>
              {readOnly ? (
                <span className="flex items-center gap-1 text-[12px]">
                  <Dot tone={b.mode === "required" ? "ok" : "warn"} />
                  {b.mode === "required" ? "blocks" : "advises"}
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    title={
                      b.mode === "required"
                        ? "Required: the line stops until it passes. Click to make it advisory."
                        : "Advisory: it reports, the line goes on. Click to make it required."
                    }
                    aria-label={`${b.gateId} is ${b.mode}; switch`}
                    onClick={() => onEdit({ op: "toggleMode", target: t, index })}
                  >
                    <Dot tone={b.mode === "required" ? "ok" : "warn"} />
                    {b.mode === "required" ? "blocks" : "advises"}
                  </Button>
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
                    aria-label={`Remove ${b.gateId}`}
                    disabled={busy}
                    onClick={() => onEdit({ op: "removeGate", target: t, index })}
                  >
                    ×
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      {!readOnly && (
        <div className={cn(ROW, "gap-x-2")}>
          {usable.length > 0 && (
            <>
              <select
                aria-label={`Gate to add to ${target.name}`}
                className={SELECT}
                value={choice}
                disabled={busy}
                onChange={(e) => setPick(e.target.value)}
              >
                {usable.map((o) => (
                  <option key={o.gateId} value={o.gateId} title={o.summary}>
                    {o.gateId}
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
            </>
          )}
          <Button
            variant={target.bindings.length === 0 && usable.length === 0 ? "primary" : "secondary"}
            size="sm"
            disabled={busy}
            onClick={() => onCreate(t)}
          >
            Create a gate…
          </Button>
          {usable.length === 0 && (
            <span className={cn(NOTE, WRAP, "basis-full text-dim-foreground")}>
              {target.options.length === 0
                ? "The project's gate library is empty, so there is nothing to pick yet."
                : unfit.length === 0
                  ? "Every gate of the library that fits here is already on it."
                  : `No other gate of the library fits here: ${unfit.join("; ")}.`}
            </span>
          )}
        </div>
      )}
    </fieldset>
  );
}

const sentence = (on: Outcome): string => OUTCOME_WHEN[on];

/** The selected station: where it is on the line, what it does, its settings, gates and arrows. */
export function StationPanel({
  view,
  stage,
  busy,
  onEdit,
  onSelectStation,
  onSelectEdge,
  onCreateGate,
  onDraw,
}: {
  view: EditorView;
  stage: StageView;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
  onSelectStation: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onCreateGate: (target: GateTarget) => void;
  onDraw: (from: string) => void;
}) {
  const readOnly = view.readOnly !== null;
  const index = view.stages.findIndex((s) => s.id === stage.id);
  const prev = view.stages[index - 1];
  const next = view.stages[index + 1];
  const problems = problemsFor(view.problems, stage);
  const own = ownGates(stage);
  const outgoing = stage.targets.filter((t) => t.transition);
  const stageOf = (id: string) => view.stages.find((s) => s.id === id);
  return (
    <section
      aria-label={`Station ${stage.id}`}
      className={cn(PANEL, "flex flex-col gap-4", problems.length && "border-[var(--warn)]")}
    >
      <div className="flex items-center gap-2">
        <span className={cn(LABEL, GROW)}>
          Station {index + 1} of {view.stages.length}
        </span>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Previous station"
          disabled={!prev}
          onClick={() => prev && onSelectStation(prev.id)}
        >
          ‹
        </Button>
        <Button
          variant="secondary"
          size="sm"
          aria-label="Next station"
          disabled={!next}
          onClick={() => next && onSelectStation(next.id)}
        >
          ›
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <span>
          <StationChip id={stage.id} stage={stage} size="lg" />
        </span>
        <span className="text-[13px] text-soft-foreground">
          {TYPE_WORDS[stage.type]}; it makes <span className="font-mono">{stage.produces}</span>.
        </span>
      </div>
      {problems.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px] text-[var(--warn)]">
          {problems.map((m) => (
            <li key={m} className={cn(WRAP, "flex gap-2")}>
              <Icon name="warning" size={13} />
              {m}
            </li>
          ))}
        </ul>
      )}

      {stage.fields.length > 0 && (
        <div className="flex flex-col gap-3 border-t-2 border-[var(--line)] pt-3">
          <h4 className={LABEL}>Settings</h4>
          {stage.fields.map((f) => {
            const loopId = f.key.startsWith("loop:") ? f.key.slice("loop:".length) : null;
            const loop = loopId
              ? outgoing.find((t) => t.target.kind === "transition" && t.target.id === loopId)
              : null;
            if (loopId && loop?.transition)
              return (
                <div key={f.key} className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-1 text-[13px] text-soft-foreground">
                    Back to{" "}
                    <StationChip id={loop.transition.to} stage={stageOf(loop.transition.to)} /> when
                    it {sentence(loop.transition.on)}
                  </span>
                  <RoundsField
                    value={Number(f.value)}
                    label={loopId}
                    disabled={readOnly || busy}
                    onChange={(rounds) => onEdit({ op: "setLoop", id: loopId, rounds })}
                  />
                </div>
              );
            return (
              <div key={f.key} className="flex flex-col gap-[2px]">
                <div className={cn(ROW, "gap-x-2")}>
                  <span className="min-w-[110px] text-[13px] text-dim-foreground">{f.label}</span>
                  <span className={cn(GROW, "font-mono text-[13px] text-foreground")}>
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
                <span className={cn(NOTE, "text-dim-foreground")}>{f.hint}</span>
              </div>
            );
          })}
        </div>
      )}

      {own && (
        <div className="flex flex-col gap-2 border-t-2 border-[var(--line)] pt-3">
          <h4 className={LABEL}>Gates it runs</h4>
          <GateBlock
            stage={stage}
            target={own}
            readOnly={readOnly}
            busy={busy}
            onEdit={onEdit}
            onCreate={onCreateGate}
          />
        </div>
      )}

      <div className="flex flex-col gap-2 border-t-2 border-[var(--line)] pt-3">
        <h4 className={LABEL}>Where the line goes next</h4>
        {outgoing.length === 0 && (
          <span className={cn(NOTE, "text-[var(--warn)]")}>
            Nothing yet: draw an arrow from it.
          </span>
        )}
        <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
          {outgoing.map((t) => {
            const tr = t.transition;
            if (!tr || t.target.kind !== "transition") return null;
            const id = t.target.id;
            return (
              <li key={id} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Arrow: if ${stage.id} ${sentence(tr.on)}, go to ${tr.to}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-[6px] gap-y-1 rounded-base border-2 border-border bg-secondary-background px-2 py-[6px] text-left [font:inherit] text-[13px] text-foreground transition-[transform,box-shadow] duration-100 hover:-translate-x-px hover:-translate-y-px hover:shadow-sm-hard motion-reduce:transition-none"
                  onClick={() => onSelectEdge(id)}
                >
                  If it {sentence(tr.on)}
                  <span aria-hidden="true">→</span>
                  <StationChip id={tr.to} stage={stageOf(tr.to)} />
                  {tr.loop !== null && (
                    <span className="rounded-[4px] border-2 border-border bg-raised px-[5px] font-mono text-[11px] font-bold">
                      up to {tr.loop}×
                    </span>
                  )}
                  {t.bindings.length > 0 && (
                    <span className="inline-flex items-center gap-[2px] rounded-[4px] border-2 border-border bg-fill-ok px-[5px] font-mono text-[11px] font-bold text-main-foreground">
                      <Icon name="gates" size={10} />
                      {t.bindings.length}
                    </span>
                  )}
                </button>
                {!readOnly && (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remove the arrow ${id}`}
                    disabled={busy}
                    onClick={() => onEdit({ op: "removeTransition", id })}
                  >
                    ×
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
        {!readOnly && (
          <div className={ACTIONS}>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDraw(stage.id)}>
              Draw an arrow from {stage.id}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              title="The arrows into it go where it would have passed on to"
              onClick={() => onEdit({ op: "removeStage", stageId: stage.id })}
            >
              Remove station {stage.id}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The selected arrow: the sentence it stands for, its rounds when it is a loop, and its gates. */
export function ArrowPanel({
  view,
  id,
  busy,
  onEdit,
  onSelectStation,
  onCreateGate,
  onAddStation,
}: {
  view: EditorView;
  id: string;
  busy: boolean;
  onEdit: (op: EditorOp) => void;
  onSelectStation: (id: string) => void;
  onCreateGate: (target: GateTarget) => void;
  onAddStation: (type: InsertableStage, transition: string) => void;
}) {
  const readOnly = view.readOnly !== null;
  const stage = view.stages.find((s) =>
    s.targets.some((t) => t.target.kind === "transition" && t.target.id === id),
  );
  const target = stage?.targets.find((t) => t.target.kind === "transition" && t.target.id === id);
  const tr = target?.transition;
  if (!stage || !target || !tr) return null;
  const stageOf = (sid: string) => view.stages.find((s) => s.id === sid);
  return (
    <section aria-label={`Transition ${id}`} className={cn(PANEL, "flex flex-col gap-3")}>
      <div className="flex items-center gap-2">
        <span className={cn(LABEL, GROW)}>{tr.loop !== null ? "Repair loop" : "Arrow"}</span>
        {!readOnly && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onEdit({ op: "removeTransition", id })}
          >
            Remove arrow
          </Button>
        )}
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-[6px] gap-y-1 text-[15px] text-foreground">
        If
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0"
          aria-label={`Open station ${stage.id}`}
          onClick={() => onSelectStation(stage.id)}
        >
          <StationChip id={stage.id} stage={stage} />
        </button>
        {sentence(tr.on)}
        <span aria-hidden="true">→</span>
        {tr.loop !== null ? "back to" : "go to"}
        {tr.to === FINISH ? (
          <StationChip id={FINISH} stage={undefined} />
        ) : (
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0"
            aria-label={`Open station ${tr.to}`}
            onClick={() => onSelectStation(tr.to)}
          >
            <StationChip id={tr.to} stage={stageOf(tr.to)} />
          </button>
        )}
      </p>
      {tr.loop !== null && (
        <RoundsField
          value={tr.loop}
          label={id}
          disabled={readOnly || busy}
          onChange={(rounds) => onEdit({ op: "setLoop", id, rounds })}
        />
      )}
      {!readOnly && tr.loop === null && (
        <div className="flex flex-col gap-2 border-t-2 border-[var(--line)] pt-3">
          <h4 className={LABEL}>Put a station on this arrow</h4>
          <StationPalette disabled={busy} onPick={(type) => onAddStation(type, id)} />
        </div>
      )}
      <div className="flex flex-col gap-2 border-t-2 border-[var(--line)] pt-3">
        <h4 className={LABEL}>Gates on this arrow</h4>
        <span className={cn(NOTE, "text-dim-foreground")}>
          They run after {stage.id} ends; required ones must pass before{" "}
          {tr.to === FINISH ? "the run finishes" : `${tr.to} starts`}.
        </span>
        <GateBlock
          stage={stage}
          target={target}
          readOnly={readOnly}
          busy={busy}
          onEdit={onEdit}
          onCreate={onCreateGate}
        />
      </div>
    </section>
  );
}

/**
 * The stations a custom workflow can add, as tiles in the colours of the graph. A tile is a
 * button; with `onDragStart` it can also be pulled onto an arrow of the graph.
 */
export function StationPalette({
  disabled,
  active,
  onPick,
  onDragStart,
}: {
  disabled: boolean;
  active?: InsertableStage | null;
  onPick: (type: InsertableStage) => void;
  onDragStart?: (type: InsertableStage, e: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <ul className="m-0 grid list-none grid-cols-2 gap-[6px] p-0">
      {NEW_STATIONS.map((s) => (
        <li key={s.type} className="min-w-0">
          <button
            type="button"
            disabled={disabled}
            title={s.what}
            aria-label={`${s.name} station: ${s.what}`}
            className={cn(
              "flex w-full min-w-0 touch-none items-center gap-2 rounded-base border-2 border-border px-2 py-[6px] text-left [font:inherit] text-[13px] font-bold text-main-foreground transition-[transform,box-shadow] duration-100 enabled:cursor-pointer enabled:hover:-translate-x-px enabled:hover:-translate-y-px enabled:hover:shadow-sm-hard disabled:opacity-60 motion-reduce:transition-none",
              TYPE_FILL[s.type],
              onDragStart && "enabled:cursor-grab",
              active === s.type && "-rotate-1 shadow-sm-hard",
            )}
            onPointerDown={(e) => {
              if (!onDragStart || e.button !== 0) return;
              onDragStart(s.type, e);
            }}
            onClick={() => onPick(s.type)}
          >
            <span className="flex size-6 flex-none items-center justify-center rounded-[4px] border-2 border-border bg-secondary-background text-foreground">
              <Icon name={stageIcon({ id: s.type, type: s.type, produces: null })} size={13} />
            </span>
            <span className="truncate">{s.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Confirms a new arrow: the outcome it answers and, for an arrow back, how many rounds. */
export function ArrowDialog({
  from,
  to,
  draft,
  view,
  onAdd,
  onClose,
}: {
  from: string;
  to: string;
  draft: ArrowDraft | null;
  view: EditorView;
  onAdd: (on: Outcome, loop: number | null) => void;
  onClose: () => void;
}) {
  const [on, setOn] = useState<Outcome | null>(draft?.on ?? null);
  const [rounds, setRounds] = useState(draft?.rounds ?? 3);
  useEffect(() => {
    setOn(draft?.on ?? null);
    setRounds(draft?.rounds ?? 3);
  }, [draft]);
  const stageOf = (id: string) => view.stages.find((s) => s.id === id);
  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(520px,calc(100vw-48px))]">
        {draft && (
          <>
            <DialogHeader>
              <DialogTitle>New arrow</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-[6px]">
                <StationChip id={from} stage={stageOf(from)} />
                <span aria-hidden="true">→</span>
                <StationChip id={to} stage={stageOf(to)} />
                {draft.back && <span>· goes back along the line, so it is a loop</span>}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] text-soft-foreground">When {from}…</span>
              <SegmentGroup aria-label="When">
                {draft.outcomes.map((o) => (
                  <Segment
                    key={o.on}
                    aria-pressed={on === o.on}
                    disabled={o.taken !== null}
                    title={o.taken ?? undefined}
                    className="disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => setOn(o.on)}
                  >
                    {sentence(o.on)}
                  </Segment>
                ))}
              </SegmentGroup>
              {draft.outcomes.some((o) => o.taken) && (
                <span className={cn(NOTE, WRAP, "text-dim-foreground")}>
                  {draft.outcomes
                    .filter((o) => o.taken)
                    .map((o) => `When it ${sentence(o.on)} it ${o.taken}.`)
                    .join(" ")}
                </span>
              )}
              {on === null && (
                <span className={cn(NOTE, WRAP, "text-[var(--warn)]")}>
                  Every way {from} can end already has an arrow. Remove one first.
                </span>
              )}
            </div>
            {draft.back && (
              <RoundsField
                value={rounds}
                label="the new loop"
                disabled={false}
                onChange={setRounds}
              />
            )}
            <div className={ACTIONS}>
              <Button
                variant="primary"
                size="md"
                disabled={on === null}
                onClick={() => on && onAdd(on, draft.back ? rounds : null)}
              >
                Add arrow
              </Button>
              <Button variant="secondary" size="md" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

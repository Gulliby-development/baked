import { useState } from "react";
import type {
  EditorOp,
  EditorView,
  Outcome,
  StageView,
  TargetView,
} from "../../client/workflow-editor.js";
import { Button } from "../../components/ui/button.js";
import { Dot } from "../../components/ui/dot.js";
import { fieldClass } from "../../components/ui/input.js";
import { cn } from "../../lib/cn.js";
import { PANEL } from "../../lib/styles.js";
import { ACTIONS, GROW, NOTE, ROW, Tag, WRAP } from "./shared.js";
import { outcomeLabel, problemsFor, targetKey } from "./workflow-editor-logic.js";

/**
 * A stage of a workflow definition in the editor: its options, its own gates and its outgoing
 * transitions with their gates. The Stages view lists one per stage; the graph shows the selected
 * one beside the board.
 */

const SELECT = cn(fieldClass, "h-9 w-auto py-1 pr-8");

export function GateList({
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

export function StageCard({
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

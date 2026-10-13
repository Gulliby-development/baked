import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { WorkflowLine } from "../../client/start.js";
import type {
  EditorOp,
  EditorView,
  GateTarget,
  InsertableStage,
  StageView,
} from "../../client/workflow-editor.js";
import { Icon } from "../../components/Icon.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { FINISH, stageIcon } from "../runs/line-model.js";
import { TYPE_FILL } from "./WorkflowGallery.js";
import { ArrowDialog, ArrowPanel, StationPalette, StationPanel } from "./WorkflowInspector.js";
import { outcomeLabel } from "./workflow-editor-logic.js";
import {
  type ArrowDraft,
  arrowDraft,
  boardSize,
  defaultLayout,
  edgeNear,
  GRID,
  type GraphEdge,
  gateLibrary,
  graphEdges,
  type Layout,
  magnet,
  mergeLayout,
  NEW_STATIONS,
  NODE_H,
  NODE_W,
  newStationId,
  nodeAt,
  type Point,
  snap,
  stationSpot,
} from "./workflow-studio-model.js";

/**
 * The workflow as a graph: stations you drag around (they snap to the grid and pull into line
 * with each other), transitions as arrows with the repair loops dashed under the line, a handle
 * on each station to draw a new transition, new stations that drop onto an arrow, and a gate
 * library whose gates drop onto a station or an arrow. Every change is an editor op the backend validates; the layout is only this
 * computer's and is kept per project and workflow.
 */

type Drag =
  | { kind: "node"; id: string; dx: number; dy: number; from: Point; moved: boolean }
  | { kind: "link"; from: string; at: Point }
  | { kind: "gate"; gateId: string; at: Point }
  | { kind: "station"; type: InsertableStage; at: Point; from: Point };
type Selection = { kind: "stage"; id: string } | { kind: "edge"; id: string };

const layoutKey = (project: string, id: string) => `baked.workflow-layout.${project}.${id}`;

function readLayout(key: string): Layout | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Layout) : null;
  } catch {
    return null;
  }
}
function writeLayout(key: string, layout: Layout): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // The layout is a convenience; without storage it resets on the next visit.
  }
}

function capture(e: PointerEvent<HTMLElement>): void {
  try {
    e.currentTarget.setPointerCapture(e.pointerId);
  } catch {
    // Synthetic pointers (tests, some pens) have no capture; the drag still works inside the board.
  }
}

const NODE_FILL = (type: string) =>
  type in TYPE_FILL ? TYPE_FILL[type as keyof typeof TYPE_FILL] : "bg-background";

function edgeText(edge: GraphEdge): string {
  const gates = edge.bindings.length;
  if (edge.back)
    return `${outcomeLabel(edge.on)}${edge.loop ? ` · ×${edge.loop}` : ""}${gates ? ` · ${gates} gate${gates === 1 ? "" : "s"}` : ""}`;
  return `${gates} gate${gates === 1 ? "" : "s"}`;
}

export function WorkflowGraph({
  projectKey,
  view,
  line,
  busy,
  focus,
  onFocus,
  onEdit,
  onCreateGate,
}: {
  projectKey: string;
  view: EditorView;
  line: WorkflowLine;
  busy: boolean;
  /** The station to select first, e.g. the one Watch was showing. */
  focus: string | null;
  onFocus: (id: string) => void;
  onEdit: (op: EditorOp) => void;
  onCreateGate: (target: GateTarget) => void;
}) {
  const readOnly = view.readOnly !== null;
  const stageIds = useMemo(() => view.stages.map((s) => s.id), [view.stages]);
  const order = useMemo(() => [...stageIds, FINISH], [stageIds]);
  const key = layoutKey(projectKey, view.id);
  const signature = stageIds.join(",");
  const [layout, setLayout] = useState<Layout>(() => mergeLayout(stageIds, readLayout(key)));
  // A new or removed stage (a wait stage) or another workflow re-reads the saved layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature stands for stageIds
  useEffect(() => setLayout(mergeLayout(stageIds, readLayout(key))), [key, signature]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const [selected, setSelectedState] = useState<Selection>({
    kind: "stage",
    id: (focus && stageIds.includes(focus) ? focus : stageIds[0]) ?? "",
  });
  const setSelected = (next: Selection) => {
    setSelectedState(next);
    if (next.kind === "stage") onFocus(next.id);
  };
  // Drawing an arrow by clicks: the first station clicked is its start, the second its end.
  const [drawing, setDrawing] = useState<{ from: string | null } | null>(null);
  const [pending, setPending] = useState<{ from: string; to: string; draft: ArrowDraft } | null>(
    null,
  );
  const [hint, setHint] = useState<{ text: string; bad: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 3600);
    return () => clearTimeout(timer);
  }, [hint]);
  const say = useCallback(
    (text: string, bad = false) => setHint({ text, bad, at: Date.now() }),
    [],
  );

  const board = useRef<HTMLDivElement>(null);
  const point = (e: { clientX: number; clientY: number }): Point => {
    const el = board.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const scale = el.offsetWidth ? r.width / el.offsetWidth : 1;
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const edges = graphEdges(view, layout);
  const size = boardSize(layout);
  const stageOf = (id: string): StageView | undefined => view.stages.find((s) => s.id === id);
  const typeOf = (id: string) => line.stages.find((s) => s.id === id);
  const library = gateLibrary(view);

  const place = (next: Layout) => {
    setLayout(next);
    writeLayout(key, next);
  };

  const dropGate = (gateId: string, at: Point) => {
    const node = nodeAt(layout, at, order);
    let stage: StageView | undefined;
    let target: GateTarget | undefined;
    if (node && node !== FINISH) {
      stage = stageOf(node);
      target = stage?.targets.find((t) => t.target.kind === "stage")?.target;
      if (!target)
        return say(
          `${node} takes no gates of its own. Drop ${gateId} on an arrow leaving it instead.`,
          true,
        );
    } else {
      const edge = edgeNear(edges, at);
      if (!edge)
        return say("Drop the gate on a station or on the dot in the middle of an arrow.", true);
      stage = stageOf(edge.from);
      target = { kind: "transition", id: edge.id };
    }
    const where = stage?.targets.find((t) => JSON.stringify(t.target) === JSON.stringify(target));
    if (!stage || !where || !target) return;
    if (where.bindings.some((b) => b.gateId === gateId))
      return say(`${gateId} is already on ${where.name}.`, true);
    const option = where.options.find((o) => o.gateId === gateId);
    if (!option) return say(`${gateId} cannot be bound on ${where.name}.`, true);
    if (option.disabled) return say(`${gateId}: ${option.disabled}`, true);
    setSelected(
      target.kind === "stage" ? { kind: "stage", id: stage.id } : { kind: "edge", id: target.id },
    );
    onEdit({ op: "addGate", target, gateId });
    say(`${gateId} now guards ${where.name}.`);
  };

  /**
   * Puts a new station on a forward arrow and selects it. A line the person arranged keeps its
   * places and the station lands where it was dropped; an untouched line is laid out again.
   */
  const addStation = (type: InsertableStage, transition: string, at?: Point) => {
    const edge = edges.find((e) => e.id === transition);
    if (!edge) return;
    const why = stationSpot(edge);
    if (why) return say(why, true);
    const id = newStationId(view, type);
    if (readLayout(key)) {
      const spot = at ?? edge.mid;
      place({ ...layout, [id]: snap({ x: spot.x - NODE_W / 2, y: spot.y - NODE_H / 2 }) });
    }
    onEdit({ op: "addStage", stageType: type, transition });
    setSelected({ kind: "stage", id });
    const name = NEW_STATIONS.find((s) => s.type === type)?.name ?? type;
    say(`${name} station ${id} now sits between ${edge.from} and ${edge.to}.`);
  };
  const dropStation = (type: InsertableStage, at: Point) => {
    const edge = edgeNear(edges, at);
    if (!edge) return say("Drop the station on the dot in the middle of an arrow.", true);
    addStation(type, edge.id, at);
  };
  // The tile holds the pointer while it is pulled, so a drop also clicks it; that click is spent.
  const pulled = useRef(false);
  const pickStation = (type: InsertableStage) => {
    if (pulled.current) {
      pulled.current = false;
      return;
    }
    if (selectedEdge) return addStation(type, selectedEdge.id);
    say("Drag it onto an arrow, or click an arrow first and pick the station again.");
  };

  /** Opens the new-arrow dialog for an arrow from one station to another, or says why not. */
  const connect = (from: string, to: string) => {
    const stage = stageOf(from);
    if (!stage) return;
    const result = arrowDraft(stage, to, view);
    if (!result.ok) return say(result.reason, true);
    setPending({ from, to, draft: result.draft });
  };
  const dropLink = (from: string, at: Point) => {
    const to = nodeAt(layout, at, order);
    if (!to) return;
    if (to === from) return say("Pull the handle onto another station.", true);
    connect(from, to);
  };
  const clickStation = (id: string) => {
    if (!drawing) {
      if (id !== FINISH) setSelected({ kind: "stage", id });
      return;
    }
    if (drawing.from === null) {
      if (id === FINISH) return say("An arrow starts at a station; Done ends the line.", true);
      setDrawing({ from: id });
      return say(`From ${id}. Now click the station the arrow goes to.`);
    }
    const from = drawing.from;
    setDrawing(null);
    if (id === from) return say("Click another station for the end of the arrow.", true);
    connect(from, id);
  };
  const startDrawing = (from: string | null) => {
    setDrawing({ from });
    say(
      from
        ? `From ${from}. Click the station the arrow goes to.`
        : "Click the station the arrow starts at, then the one it goes to.",
    );
  };

  useEffect(() => {
    if (!drawing) return;
    const stop = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setDrawing(null);
    };
    window.addEventListener("keydown", stop);
    return () => window.removeEventListener("keydown", stop);
  }, [drawing]);

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const at = point(e);
    if (drag.kind === "node") {
      const raw = { x: at.x - drag.dx, y: at.y - drag.dy };
      const moved = drag.moved || Math.hypot(raw.x - drag.from.x, raw.y - drag.from.y) > 3;
      if (!moved) return;
      const pulled = magnet(drag.id, raw, layout);
      setGuides({ x: pulled.guideX, y: pulled.guideY });
      setLayout({ ...layout, [drag.id]: pulled.point });
      if (!drag.moved) setDrag({ ...drag, moved: true });
    } else setDrag({ ...drag, at });
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag(null);
    setGuides({ x: null, y: null });
    if (drag.kind === "node") {
      const p = layout[drag.id];
      if (drag.moved && p) place({ ...layout, [drag.id]: snap(p) });
    } else if (e.type === "pointerup") {
      if (drag.kind === "link") dropLink(drag.from, point(e));
      else if (drag.kind === "station") {
        // A press without a pull is a click: the tile's own handler takes it.
        const at = point(e);
        if (Math.hypot(at.x - drag.from.x, at.y - drag.from.y) > 6) {
          pulled.current = true;
          dropStation(drag.type, at);
        }
      } else dropGate(drag.gateId, point(e));
    }
  };

  const nudge = (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? GRID * 5 : GRID;
    const delta: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = delta[e.key];
    const p = layout[id];
    if (!d || !p) return;
    e.preventDefault();
    place({ ...layout, [id]: snap({ x: p.x + d.x, y: p.y + d.y }) });
  };

  const selectedEdge =
    selected.kind === "edge" ? edges.find((x) => x.id === selected.id) : undefined;
  const selectedStage =
    selected.kind === "stage"
      ? (stageOf(selected.id) ?? view.stages[0])
      : selectedEdge
        ? undefined
        : view.stages[0];
  const linkTarget = drag && drag.kind !== "node" ? nodeAt(layout, drag.at, order) : null;
  const dropEdges =
    drag?.kind === "gate"
      ? edges
      : drag?.kind === "station"
        ? edges.filter((e) => !stationSpot(e))
        : [];
  const gateEdge =
    drag?.kind === "gate" && !linkTarget
      ? edgeNear(edges, drag.at)
      : drag?.kind === "station"
        ? edgeNear(dropEdges, drag.at)
        : null;

  return (
    <div
      className="flex flex-wrap items-start gap-4"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-0 flex-1 text-[13px] text-muted-foreground">
            {readOnly
              ? "Drag stations to arrange the view. Duplicate the workflow to change its arrows, gates and settings."
              : drawing
                ? drawing.from
                  ? `Click the station the arrow from ${drawing.from} goes to. Esc cancels.`
                  : "Click the station the arrow starts at. Esc cancels."
                : "Click a station to set it up on the right. Drag stations to arrange them; Draw an arrow connects two, new stations drop onto an arrow, and gates drop from the library onto a station or an arrow."}
          </p>
          {!readOnly && (
            <Button
              variant={drawing ? "primary" : "secondary"}
              size="sm"
              aria-pressed={drawing !== null}
              disabled={busy}
              onClick={() => (drawing ? setDrawing(null) : startDrawing(null))}
            >
              {drawing ? "Cancel arrow" : "Draw an arrow"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              place(defaultLayout(stageIds));
              say("Laid the line out again.");
            }}
          >
            Tidy up
          </Button>
        </div>
        <div className="relative">
          <div className="h-[min(620px,70vh)] min-h-[360px] overflow-auto rounded-base border-2 border-border shadow-shadow">
            <div
              ref={board}
              className={cn(
                "relative min-h-full min-w-full bg-secondary-background bg-[radial-gradient(var(--line)_1.4px,transparent_1.4px)] bg-[length:20px_20px] select-none",
                (drag?.kind === "link" || drawing) && "cursor-crosshair",
                (drag?.kind === "gate" || drag?.kind === "station") && "cursor-grabbing",
              )}
              style={{ width: size.width, height: size.height }}
            >
              <svg
                className="pointer-events-none absolute inset-0 overflow-visible"
                width={size.width}
                height={size.height}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="wf-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10z" className="fill-[var(--text)]" />
                  </marker>
                  <marker
                    id="wf-arrow-loop"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10z" className="fill-[var(--accent)]" />
                  </marker>
                </defs>
                {guides.x !== null && (
                  <line
                    x1={guides.x}
                    y1={0}
                    x2={guides.x}
                    y2={size.height}
                    strokeDasharray="4 4"
                    className="stroke-[var(--accent)] stroke-[1.5]"
                  />
                )}
                {guides.y !== null && (
                  <line
                    x1={0}
                    y1={guides.y}
                    x2={size.width}
                    y2={guides.y}
                    strokeDasharray="4 4"
                    className="stroke-[var(--accent)] stroke-[1.5]"
                  />
                )}
                {edges.map((edge) => {
                  const on = selectedEdge?.id === edge.id || gateEdge?.id === edge.id;
                  return (
                    <g key={edge.id}>
                      <path
                        d={edge.d}
                        fill="none"
                        markerEnd={edge.back ? "url(#wf-arrow-loop)" : "url(#wf-arrow)"}
                        strokeDasharray={edge.back ? "6 5" : undefined}
                        className={cn(
                          "transition-[d] duration-300 ease-[cubic-bezier(.3,1.5,.5,1)] motion-reduce:transition-none",
                          edge.back
                            ? "animate-lane stroke-[var(--accent)] motion-reduce:animate-none"
                            : "stroke-[var(--text)]",
                          on ? "stroke-[3.5]" : "stroke-2",
                          drag?.kind === "node" && "transition-none",
                        )}
                      />
                    </g>
                  );
                })}
                {drag?.kind === "link" &&
                  (() => {
                    const a = layout[drag.from];
                    if (!a) return null;
                    const sx = a.x + NODE_W;
                    const sy = a.y + NODE_H / 2;
                    return (
                      <path
                        d={`M ${sx} ${sy} C ${sx + 60} ${sy}, ${drag.at.x - 60} ${drag.at.y}, ${drag.at.x} ${drag.at.y}`}
                        fill="none"
                        strokeDasharray="5 4"
                        markerEnd="url(#wf-arrow-loop)"
                        className="stroke-[var(--accent)] stroke-[2.5]"
                      />
                    );
                  })()}
                {dropEdges.map((edge) => (
                  <circle
                    key={edge.id}
                    cx={edge.mid.x}
                    cy={edge.mid.y}
                    r={gateEdge?.id === edge.id ? 12 : 8}
                    className={cn(
                      "stroke-[var(--ink)] stroke-2 transition-[r] duration-150",
                      gateEdge?.id === edge.id ? "fill-[var(--fill-accent)]" : "fill-[var(--bg)]",
                    )}
                  />
                ))}
              </svg>
              {edges
                .filter((edge) => edge.back || edge.bindings.length > 0)
                .map((edge) => (
                  <button
                    key={edge.id}
                    type="button"
                    aria-label={`Transition ${edge.from} to ${edge.to} on ${outcomeLabel(edge.on)}`}
                    aria-pressed={selectedEdge?.id === edge.id}
                    onClick={() => setSelected({ kind: "edge", id: edge.id })}
                    className={cn(
                      "absolute z-[1] flex -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-[4px] border-2 border-border px-[6px] py-[1px] font-mono text-[10.5px] font-semibold whitespace-nowrap text-main-foreground aria-pressed:bg-main",
                      edge.back ? "bg-raised text-foreground" : "bg-fill-ok",
                    )}
                    style={{ left: edge.mid.x, top: edge.mid.y }}
                  >
                    {edge.bindings.length > 0 && <Icon name="gates" size={10} />}
                    {edgeText(edge)}
                  </button>
                ))}
              {order.map((id) => {
                const p = layout[id];
                if (!p) return null;
                const stage = stageOf(id);
                const entry = typeOf(id);
                const type = id === FINISH ? "finish" : (stage?.type ?? "agent");
                const own = stage?.targets.find((t) => t.target.kind === "stage")?.bindings ?? [];
                const dragging = drag?.kind === "node" && drag.id === id;
                const isSelected = selected.kind === "stage" && selected.id === id && !selectedEdge;
                return (
                  <div
                    key={id}
                    className={cn(
                      "group/node absolute rounded-base border-2 border-border shadow-[3px_3px_0_0_var(--ink)] touch-none",
                      id === FINISH ? "border-dashed bg-secondary-background" : NODE_FILL(type),
                      !dragging &&
                        "transition-[left,top,box-shadow,transform] duration-300 ease-[cubic-bezier(.3,1.5,.5,1)] hover:shadow-[5px_5px_0_0_var(--ink)] motion-reduce:transition-none",
                      dragging && "z-[3] -rotate-1 scale-[1.03] shadow-[8px_8px_0_0_var(--ink)]",
                      isSelected &&
                        !drawing &&
                        "outline-3 outline-offset-3 outline-[var(--accent)]",
                      drawing?.from === id &&
                        "outline-3 outline-offset-4 outline-dashed outline-[var(--accent)]",
                      linkTarget === id &&
                        "scale-[1.04] outline-3 outline-offset-4 outline-dashed outline-[var(--accent)]",
                    )}
                    style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                  >
                    <button
                      type="button"
                      aria-label={`Station ${id}${stage ? `, ${stage.type}` : ""}. Drag or use the arrow keys to move it.`}
                      aria-pressed={isSelected}
                      className={cn(
                        "absolute inset-0 flex items-center gap-2 border-0 bg-transparent px-[9px] text-left [font:inherit]",
                        id === FINISH ? "text-foreground" : "text-main-foreground",
                        drawing ? "cursor-crosshair" : dragging ? "cursor-grabbing" : "cursor-grab",
                        "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      )}
                      onPointerDown={(e) => {
                        if (e.button !== 0 || drawing) return;
                        capture(e);
                        const at = point(e);
                        setDrag({
                          kind: "node",
                          id,
                          dx: at.x - p.x,
                          dy: at.y - p.y,
                          from: p,
                          moved: false,
                        });
                      }}
                      onClick={() => clickStation(id)}
                      onKeyDown={(e) => nudge(id, e)}
                    >
                      <span className="flex size-8 flex-none items-center justify-center rounded-[5px] border-2 border-border bg-secondary-background text-foreground">
                        <Icon
                          name={
                            id === FINISH
                              ? "accept"
                              : stageIcon({
                                  id,
                                  type: stage?.type ?? "agent",
                                  produces: stage?.produces ?? null,
                                })
                          }
                          size={17}
                        />
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-[14px] font-bold">
                          {id === FINISH ? "Done" : id}
                        </span>
                        <span className="truncate font-mono text-[10.5px] opacity-80">
                          {id === FINISH
                            ? "end of the line"
                            : `${entry?.human ? "you · " : ""}makes ${stage?.produces ?? ""}`}
                        </span>
                      </span>
                    </button>
                    {own.length > 0 && (
                      <span
                        className="pointer-events-none absolute -top-[11px] -right-[10px] flex items-center gap-[2px] rounded-full border-2 border-border bg-fill-ok px-[5px] font-mono text-[10.5px] font-bold text-main-foreground"
                        title={own.map((b) => `${b.gateId} (${b.mode})`).join("\n")}
                      >
                        <Icon name="gates" size={10} />
                        {own.length}
                      </span>
                    )}
                    {!readOnly && id !== FINISH && (
                      <button
                        type="button"
                        aria-label={`Add a transition from ${id}: drag onto another station`}
                        className={cn(
                          "absolute top-[22px] -right-[9px] size-4 cursor-crosshair touch-none rounded-full border-2 border-border bg-main p-0 opacity-0 transition-[opacity,transform] duration-150 group-hover/node:opacity-100 hover:scale-125 focus-visible:opacity-100 motion-reduce:transition-none",
                          drag?.kind === "link" && drag.from === id && "opacity-100",
                        )}
                        onPointerDown={(e) => {
                          if (e.button !== 0 || busy) return;
                          e.stopPropagation();
                          capture(e);
                          setDrag({ kind: "link", from: id, at: point(e) });
                        }}
                      />
                    )}
                  </div>
                );
              })}
              {drag?.kind === "station" && (
                <span
                  className={cn(
                    "pointer-events-none absolute z-[4] flex animate-nudge items-center gap-1 rounded-base border-2 border-border px-[10px] py-1 text-[12px] font-bold whitespace-nowrap text-main-foreground shadow-shadow motion-reduce:animate-none",
                    TYPE_FILL[drag.type],
                  )}
                  style={{ left: drag.at.x + 10, top: drag.at.y + 10 }}
                >
                  {NEW_STATIONS.find((s) => s.type === drag.type)?.name} station
                </span>
              )}
              {drag?.kind === "gate" && (
                <span
                  className="pointer-events-none absolute z-[4] flex animate-nudge items-center gap-1 rounded-base border-2 border-border bg-fill-ok px-[10px] py-1 font-mono text-[12px] font-bold whitespace-nowrap text-main-foreground shadow-shadow motion-reduce:animate-none"
                  style={{ left: drag.at.x + 10, top: drag.at.y + 10 }}
                >
                  <Icon name="gates" size={12} />
                  {drag.gateId}
                </span>
              )}
            </div>
          </div>
          {hint && (
            <div
              key={hint.at}
              role={hint.bad ? "alert" : "status"}
              className={cn(
                "pointer-events-none absolute bottom-4 left-1/2 z-[5] w-max max-w-[90%] -translate-x-1/2 rounded-base border-2 border-border px-4 py-2 text-[13px] font-semibold text-main-foreground shadow-shadow",
                hint.bad ? "bg-fill-err" : "bg-fill-ok",
              )}
            >
              {hint.text}
            </div>
          )}
        </div>
      </div>
      <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-4" aria-label="Inspector">
        {selectedEdge ? (
          <ArrowPanel
            view={view}
            id={selectedEdge.id}
            busy={busy}
            onEdit={onEdit}
            onSelectStation={(id) => setSelected({ kind: "stage", id })}
            onCreateGate={onCreateGate}
            onAddStation={(type, transition) => addStation(type, transition)}
          />
        ) : selectedStage ? (
          <StationPanel
            view={view}
            stage={selectedStage}
            busy={busy}
            onEdit={onEdit}
            onSelectStation={(id) => setSelected({ kind: "stage", id })}
            onSelectEdge={(id) => setSelected({ kind: "edge", id })}
            onCreateGate={onCreateGate}
            onDraw={(from) => startDrawing(from)}
          />
        ) : null}
        {!readOnly && (
          <section aria-label="New stations" className={cn(PANEL, "flex flex-col gap-2")}>
            <h3 className={LABEL}>New stations · drag onto an arrow</h3>
            <StationPalette
              disabled={busy}
              active={drag?.kind === "station" ? drag.type : null}
              onPick={pickStation}
              onDragStart={(type, e) => {
                capture(e);
                pulled.current = false;
                const at = point(e);
                setDrag({ kind: "station", type, at, from: at });
              }}
            />
          </section>
        )}
        <section aria-label="Gate library" className={cn(PANEL, "flex flex-col gap-2")}>
          <h3 className={LABEL}>Gate library{readOnly ? "" : " · drag onto the graph"}</h3>
          {library.length === 0 && (
            <span className="text-[12px] text-muted-foreground">
              No gates in this project's library.
            </span>
          )}
          <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
            {library.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  disabled={readOnly || busy}
                  title={g.summary}
                  className={cn(
                    "flex w-full touch-none items-center gap-2 rounded-base border-2 border-border bg-secondary-background px-[10px] py-[6px] text-left [font:inherit] text-foreground transition-[transform,box-shadow] duration-100 enabled:cursor-grab enabled:hover:-translate-x-px enabled:hover:-translate-y-px enabled:hover:shadow-sm-hard disabled:opacity-60 motion-reduce:transition-none",
                    drag?.kind === "gate" &&
                      drag.gateId === g.id &&
                      "bg-fill-warn text-main-foreground",
                  )}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    capture(e);
                    setDrag({ kind: "gate", gateId: g.id, at: point(e) });
                  }}
                >
                  <span className="size-[9px] flex-none rotate-45 rounded-[2px] border-2 border-border bg-fill-ok" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-semibold">
                    {g.id}
                  </span>
                  <span className="max-w-[45%] truncate text-[11px] text-muted-foreground">
                    {g.summary}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!readOnly && (
            <span className="text-[12px] text-muted-foreground">
              Without a mouse, add gates from the station above.
            </span>
          )}
        </section>
      </aside>
      <ArrowDialog
        from={pending?.from ?? ""}
        to={pending?.to ?? ""}
        draft={pending?.draft ?? null}
        view={view}
        onClose={() => setPending(null)}
        onAdd={(on, loop) => {
          if (!pending) return;
          onEdit({ op: "addTransition", from: pending.from, to: pending.to, on, loop });
          say(
            `Added ${pending.from} → ${pending.to} on ${outcomeLabel(on)}${loop ? `, up to ${loop} rounds` : ""}.`,
          );
          setPending(null);
        }}
      />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GraphAnswer, type GraphUnit, type GraphView, graph } from "../../client/graph.js";
import { isMissingEndpoint } from "../../client/insights.js";
import { Alert } from "../../components/ui/alert.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { LoadState } from "../insights/LoadState.js";
import type { SectionProps } from "../sections.js";
import { GraphEngine } from "./engine.js";
import { GraphInspector, type GraphSelection } from "./GraphInspector.js";
import { formatCount, isInside, toneFill } from "./layout.js";

const CHIP =
  "inline-flex cursor-pointer items-center gap-1.5 rounded-base border-2 border-border bg-raised px-2.5 py-[5px] [font:inherit] text-[13px] font-bold shadow-sm-hard transition-[transform,box-shadow] duration-[80ms] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none aria-pressed:bg-fill-info aria-pressed:text-main-foreground motion-reduce:transition-none";
const SQUARE =
  "inline-grid size-8 cursor-pointer place-items-center rounded-base border-2 border-border bg-raised font-mono font-bold shadow-sm-hard transition-[transform,box-shadow] duration-[80ms] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none motion-reduce:transition-none";
const FLOAT =
  "absolute rounded-base border-2 border-border bg-background shadow-sm-hard font-mono text-[12px] text-soft-foreground";

type Loaded =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "answer"; answer: GraphAnswer };

function signature(view: GraphView): string {
  return `${view.stats.files}|${view.stats.links}|${view.units.map((u) => u.id).join(",")}|${view.edges.length}`;
}

export function GraphSection({ project }: SectionProps) {
  const key = project.key;
  const [expanded, setExpanded] = useState<string[]>([]);
  const [tests, setTests] = useState(true);
  const [typeEdges, setTypeEdges] = useState(true);
  const [reveal, setReveal] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [view, setView] = useState<GraphView | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [scale, setScale] = useState(1);
  const [tick, setTick] = useState(0);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const fitRef = useRef<string | null | undefined>(null);
  const shownRef = useRef("");

  const state = useMemo(
    () => ({
      focus,
      selectedUnit: selection?.kind === "unit" ? selection.id : null,
      selectedEdge: selection?.kind === "edge" ? selection.id : null,
    }),
    [focus, selection],
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  // Project change: start over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on the project key only.
  useEffect(() => {
    setExpanded([]);
    setFocus(null);
    setSelection(null);
    setView(null);
    setLoaded({ kind: "loading" });
    fitRef.current = null;
    shownRef.current = "";
  }, [key]);

  // Load the level for the open folders; poll while the index is being built.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` forces the next poll.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    graph
      .view(key, { expanded, tests, typeEdges, ...(reveal ? { reveal } : {}) })
      .then((answer) => {
        if (!live) return;
        setLoaded({ kind: "answer", answer });
        if (answer.state === "ready") {
          const next = answer.view;
          if (reveal) {
            setReveal(null);
            const unit = next.units.find((u) => u.id === next.revealed);
            setFocus(unit?.owner ?? null);
            setSelection(unit ? { kind: "unit", id: unit.id } : null);
            fitRef.current = unit?.owner ?? null;
          }
          if (next.expanded.join("\n") !== expanded.join("\n")) setExpanded(next.expanded);
          const sig = signature(next);
          if (sig !== shownRef.current) {
            shownRef.current = sig;
            setView(next);
          }
        }
        if (answer.indexing)
          timer = setTimeout(
            () => live && setTick((t) => t + 1),
            answer.state === "ready" ? 5000 : 2000,
          );
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoaded(
          isMissingEndpoint(error)
            ? { kind: "missing" }
            : { kind: "error", message: error instanceof Error ? error.message : String(error) },
        );
      });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, expanded, tests, typeEdges, reveal, tick]);

  const onUnit = useCallback((unit: GraphUnit) => {
    if (unit.kind === "file") {
      setSelection({ kind: "unit", id: unit.id });
      return;
    }
    fitRef.current = unit.id;
    setExpanded((list) => (list.includes(unit.id) ? list : [...list, unit.id]));
    setFocus(unit.id);
    setSelection({ kind: "unit", id: unit.id });
  }, []);

  const collapse = useCallback(
    (id: string) => {
      if (!view) return;
      const owner = view.frames.find((f) => f.id === id)?.owner ?? null;
      setExpanded((list) => list.filter((x) => x !== id && !isInside(view, x, id)));
      setFocus(owner);
      setSelection({ kind: "unit", id });
      fitRef.current = undefined;
    },
    [view],
  );

  const handlers = useRef({ onUnit, collapse });
  handlers.current = { onUnit, collapse };

  // The engine lives as long as the canvas.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const engine = new GraphEngine(svg, {
      onUnit: (u) => handlers.current.onUnit(u),
      onCollapse: (id) => handlers.current.collapse(id),
      onEdge: (e) => setSelection({ kind: "edge", id: e.id }),
      onBackground: () => {
        setSelection(null);
        setFocus(null);
      },
      onZoom: setScale,
    });
    engineRef.current = engine;
    return () => {
      engine.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!view || !engineRef.current) return;
    const fit = fitRef.current;
    fitRef.current = undefined;
    engineRef.current.setView(view, stateRef.current, fit);
  }, [view]);

  useEffect(() => {
    engineRef.current?.paint(state);
  }, [state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || !focus) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      handlers.current.collapse(focus);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const crumbs = useMemo(() => {
    if (!view) return [];
    const path: { id: string; label: string }[] = [];
    for (let id = focus; id; id = view.frames.find((f) => f.id === id)?.owner ?? null) {
      const frame = view.frames.find((f) => f.id === id);
      if (!frame) break;
      path.unshift({ id, label: frame.label });
    }
    return path;
  }, [view, focus]);

  const goTo = (id: string | null): void => {
    if (!view) return;
    if (id === null) {
      fitRef.current = null;
      setExpanded([]);
      setFocus(null);
      setSelection(null);
      if (expanded.length === 0) engineRef.current?.fit(null);
      return;
    }
    const inner = expanded.filter((x) => x !== id && isInside(view, x, id));
    setFocus(id);
    if (inner.length) {
      fitRef.current = id;
      setExpanded(expanded.filter((x) => !inner.includes(x)));
    } else engineRef.current?.fit(id);
  };

  if (loaded.kind === "missing" || loaded.kind === "error")
    return <LoadState state={loaded} what="The code graph and its API" />;
  if (loaded.kind === "answer" && loaded.answer.state !== "ready")
    return (
      <Empty className="flex flex-col items-center gap-1.5">
        <strong className="text-foreground">
          {loaded.answer.state === "indexing"
            ? "Indexing the project…"
            : loaded.answer.state === "disabled"
              ? "The code index is turned off"
              : "Nothing to draw yet"}
        </strong>
        <span>
          {loaded.answer.state === "indexing"
            ? "BAKED is reading the code to build its graph. The graph appears here when the first pass is done."
            : loaded.answer.state === "disabled"
              ? "Turn the repository map back on in settings (repoMap) to see the graph."
              : "The index has no code files. Add code to the project and open this page again."}
        </span>
      </Empty>
    );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <nav
          className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-1 font-mono text-[13px]"
          aria-label="Open folders"
        >
          <button
            type="button"
            className={cn(
              "cursor-pointer rounded-[4px] border-0 bg-transparent px-1 py-0.5 [font:inherit] hover:bg-hover",
              crumbs.length ? "text-muted-foreground" : "font-bold text-foreground",
            )}
            onClick={() => goTo(null)}
          >
            {project.name}
          </button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="text-dim-foreground">/</span>
              <button
                type="button"
                className={cn(
                  "cursor-pointer rounded-[4px] border-0 bg-transparent px-1 py-0.5 [font:inherit] hover:bg-hover",
                  i === crumbs.length - 1 ? "font-bold text-foreground" : "text-muted-foreground",
                )}
                onClick={() => goTo(c.id)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        <GraphSearch projectKey={key} onPick={(path) => setReveal(path)} />
        <button
          type="button"
          className={CHIP}
          aria-pressed={tests}
          onClick={() => setTests((v) => !v)}
        >
          Tests
        </button>
        <button
          type="button"
          className={CHIP}
          aria-pressed={typeEdges}
          onClick={() => setTypeEdges((v) => !v)}
        >
          Type edges
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={SQUARE}
            aria-label="Zoom out"
            onClick={() => engineRef.current?.zoomBy(1 / 1.3)}
          >
            −
          </button>
          <output className="w-11 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </output>
          <button
            type="button"
            className={SQUARE}
            aria-label="Zoom in"
            onClick={() => engineRef.current?.zoomBy(1.3)}
          >
            +
          </button>
          <button
            type="button"
            className={SQUARE}
            aria-label="Fit to screen"
            title="Fit"
            onClick={() => engineRef.current?.fit(null)}
          >
            ⤢
          </button>
        </div>
      </div>
      <div className="grid h-[calc(100vh-200px)] min-h-[520px] grid-cols-[minmax(0,1fr)_320px] overflow-hidden rounded-base border-2 border-border shadow-shadow max-[1000px]:h-auto max-[1000px]:grid-cols-1">
        <div
          className="relative min-h-[460px] overflow-hidden bg-secondary-background"
          style={{
            backgroundImage: "radial-gradient(var(--line) 1.4px, transparent 1.4px)",
            backgroundSize: "22px 22px",
          }}
        >
          <svg
            ref={svgRef}
            className="absolute inset-0 block size-full cursor-grab touch-none active:cursor-grabbing"
            role="img"
            aria-label={`Code graph of ${project.name}`}
          />
          {!view && (
            <div className="absolute inset-0 grid place-items-center text-dim-foreground">
              Loading the graph…
            </div>
          )}
          {view && (
            <>
              <div className={cn(FLOAT, "right-3 top-3 px-2.5 py-1.5")}>
                {formatCount(view.stats.files)} files ·{" "}
                {view.flat ? "every file shown" : `${view.units.length} blocks on screen`}
              </div>
              {loaded.kind === "answer" && loaded.answer.indexing && (
                <div
                  className={cn(
                    FLOAT,
                    "left-3 top-3 bg-fill-warn px-2.5 py-1.5 text-main-foreground",
                  )}
                >
                  Refreshing the index…
                </div>
              )}
              <div
                className={cn(
                  FLOAT,
                  "bottom-3 left-3 flex max-w-[calc(100%-24px)] flex-wrap gap-x-3 gap-y-1.5 px-2.5 py-2 font-sans",
                )}
              >
                {view.tones.map((t) => (
                  <span key={`${t.tone}-${t.label}`} className="inline-flex items-center gap-1.5">
                    <i
                      className="inline-block size-3 border-2 border-border"
                      style={{ background: toneFill(t.tone) }}
                    />
                    {t.label}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5">
                  <i className="inline-block size-3 border-2 border-border bg-main" />
                  key file ★
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i className="inline-block w-[22px] border-t-2 border-t-[color:var(--text-3)]" />
                  imports
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i className="inline-block w-[22px] border-t-2 border-dashed border-t-[color:var(--text-3)]" />
                  types only
                </span>
              </div>
            </>
          )}
        </div>
        <aside
          className="grid min-w-0 content-start gap-4 overflow-auto border-l-2 border-border bg-background p-4 max-[1000px]:border-l-0 max-[1000px]:border-t-2"
          aria-live="polite"
        >
          {view ? (
            <GraphInspector
              projectKey={key}
              view={view}
              selection={selection}
              expanded={expanded}
              onReveal={(path) => setReveal(path)}
              onOpen={onUnit}
              onClose={collapse}
              onSelect={setSelection}
            />
          ) : (
            loaded.kind === "loading" && <span className="text-dim-foreground">Loading…</span>
          )}
          {loaded.kind === "answer" &&
            loaded.answer.state === "ready" &&
            loaded.answer.view.stats.files === 0 && <Alert>The index has no code files.</Alert>}
        </aside>
      </div>
    </div>
  );
}

function GraphSearch({
  projectKey,
  onPick,
}: {
  projectKey: string;
  onPick: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const [hits, setHits] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      graph.search(projectKey, q).then(
        (r) => {
          if (!live) return;
          setHits(r.paths);
          setActive(0);
          setOpen(true);
        },
        () => live && setHits([]),
      );
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [projectKey, text]);
  const pick = (path: string): void => {
    onPick(path);
    setOpen(false);
  };
  return (
    <div className="relative">
      <input
        id="graph-search"
        type="search"
        value={text}
        placeholder="Find a file…"
        autoComplete="off"
        aria-label="Find a file"
        className="w-[220px] max-w-full rounded-base border-2 border-border bg-secondary-background px-2.5 py-1.5 font-mono text-[13px] shadow-sm-hard focus-visible:outline-3 focus-visible:outline-ring"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => hits.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !hits.length) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => (a + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length);
          } else if (e.key === "Enter") {
            const hit = hits[active];
            if (hit) pick(hit);
          } else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && text.trim().length >= 2 && (
        <ul className="absolute left-0 top-[calc(100%+6px)] z-10 m-0 w-[340px] max-w-[80vw] list-none rounded-base border-2 border-border bg-background p-1 shadow-shadow">
          {hits.length ? (
            hits.map((path, i) => (
              <li key={path}>
                <button
                  type="button"
                  className={cn(
                    "w-full cursor-pointer truncate rounded-[4px] border-0 bg-transparent px-2 py-[5px] text-left font-mono text-[12px]",
                    i === active
                      ? "bg-main text-main-foreground"
                      : "hover:bg-main hover:text-main-foreground",
                  )}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(path)}
                >
                  {path}
                </button>
              </li>
            ))
          ) : (
            <li className="px-2 py-[5px] font-mono text-[12px] text-muted-foreground">
              No file matches
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

import type { ReactNode } from "react";
import {
  type GraphEdge,
  type GraphFileAnswer,
  type GraphLinkAnswer,
  type GraphUnit,
  type GraphView,
  graph,
} from "../../client/graph.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { useLoad } from "../insights/useLoad.js";
import { baseName, formatCount } from "./layout.js";

export type GraphSelection =
  | { kind: "unit"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "pair"; from: string; to: string; back: string | null };

const KIND = "font-mono text-[11px] uppercase tracking-[0.07em] text-dim-foreground";
const ROW =
  "grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-baseline gap-2 rounded-[5px] border-2 border-transparent bg-secondary-background px-2 py-[5px] text-left [font:inherit] hover:border-border hover:shadow-sm-hard";
const PATH = "truncate font-mono text-[12px] [direction:rtl] text-left";
const NUM = "font-mono text-[11px] text-muted-foreground tabular-nums";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-base border-2 border-border bg-secondary-background px-2 py-1.5">
      <b className="block font-mono text-[16px] tabular-nums">{value}</b>
      <span className="text-[11px] text-muted-foreground">{label}</span>
    </div>
  );
}

function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-3 gap-2">{children}</div>;
}

function FileList({
  title,
  rows,
  onPick,
}: {
  title: string;
  rows: { path: string; note: string }[];
  onPick: (path: string) => void;
}) {
  return (
    <section>
      <h5 className={cn(LABEL, "mb-1.5 text-[11px]")}>{title}</h5>
      {rows.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {rows.map((r) => (
            <li key={r.path}>
              <button type="button" className={ROW} onClick={() => onPick(r.path)} title={r.path}>
                <span className={PATH}>{r.path}</span>
                <span className={NUM}>{r.note}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-muted-foreground">None</p>
      )}
    </section>
  );
}

/** The bun mascot that explains the canvas when nothing is selected. */
function Bun() {
  return (
    <svg viewBox="0 0 72 60" width="72" height="60" aria-hidden="true" className="flex-none">
      <ellipse cx="38" cy="54" rx="28" ry="4" fill="var(--ink)" opacity=".5" />
      <path
        d="M8 44c0-20 13-34 30-34s30 14 30 34c0 6-4 8-10 8H18c-6 0-10-2-10-8z"
        fill="var(--ink)"
      />
      <path
        d="M5 41c0-20 13-34 30-34s30 14 30 34c0 6-4 8-10 8H15c-6 0-10-2-10-8z"
        fill="var(--fill-accent)"
        stroke="var(--ink)"
        strokeWidth="2.5"
      />
      <path
        d="M22 17c3-3 7-4 10-4M40 13c4 0 8 2 10 4"
        stroke="var(--ink)"
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="23" y="27" width="5" height="7" fill="var(--ink)" />
      <rect x="42" y="27" width="5" height="7" fill="var(--ink)" />
      <path
        d="M30 38q5 4 10 0"
        stroke="var(--ink)"
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function WhyRow({ mark, fill, children }: { mark: string; fill: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2">
      <span
        className="grid size-[22px] place-items-center rounded-[4px] border-2 border-border font-mono text-[11px] font-bold text-main-foreground"
        style={{ background: fill }}
      >
        {mark}
      </span>
      <span className="min-w-0 text-[13px]">{children}</span>
    </div>
  );
}

const CODE = "rounded-[3px] bg-raised px-1 font-mono text-[12px] [overflow-wrap:anywhere]";

function Why({ link }: { link: GraphLinkAnswer }) {
  return (
    <div className="grid gap-2 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5 shadow-sm-hard">
      {link.names.length > 0 && (
        <WhyRow mark="I" fill="var(--fill-accent)">
          Imports{" "}
          {link.names.slice(0, 12).map((n, i) => (
            <span key={n}>
              {i > 0 && " "}
              <code className={CODE}>{n}</code>
            </span>
          ))}
          {link.names.length > 12 ? ` and ${link.names.length - 12} more` : ""}.
        </WhyRow>
      )}
      {link.calls > 0 && (
        <WhyRow mark="C" fill="var(--fill-warn)">
          {link.calls} call site{link.calls > 1 ? "s" : ""}.{" "}
          {link.callSites.map((c, i) => (
            <span key={`${c.caller}-${c.line}`}>
              {i > 0 && "; "}
              <code className={CODE}>{c.caller}</code> calls{" "}
              <code className={CODE}>{c.callee}</code> on line {c.line}
            </span>
          ))}
          {link.callSites.length ? "." : ""}
        </WhyRow>
      )}
      {link.typeOnly && (
        <WhyRow mark="T" fill="var(--fill-info)">
          The target is mostly type declarations, so ranking counts this link at 30%.
        </WhyRow>
      )}
      {link.cochanges > 0 && (
        <WhyRow mark="G" fill="var(--fill-ok)">
          Changed together in {link.cochanges} commit{link.cochanges > 1 ? "s" : ""}.
        </WhyRow>
      )}
      <WhyRow mark="W" fill="var(--bg-raised)">
        Link weight {link.weight}. Higher means more of the target is used here.
      </WhyRow>
    </div>
  );
}

function Pair({ from, to }: { from: string; to: string }) {
  return (
    <div className="grid gap-0.5 font-mono text-[12px] [overflow-wrap:anywhere]">
      <span>{from}</span>
      <span className="font-bold text-ring">↓ depends on</span>
      <span>{to}</span>
    </div>
  );
}

function PairView({
  projectKey,
  from,
  to,
  onBack,
}: {
  projectKey: string;
  from: string;
  to: string;
  onBack: (() => void) | null;
}) {
  const { state } = useLoad(() => graph.link(projectKey, from, to), [projectKey, from, to]);
  return (
    <>
      <div className="grid gap-1">
        <div className={KIND}>Link between two files</div>
        <Pair from={from} to={to} />
      </div>
      {state.kind === "ready" ? (
        <>
          <Why link={state.data} />
          {state.data.mutual && (
            <p className="m-0 text-[13px] text-muted-foreground">
              There is a link in the other direction too, so these two depend on each other.
            </p>
          )}
        </>
      ) : state.kind === "loading" ? (
        <p className="m-0 text-[13px] text-muted-foreground">Reading the index…</p>
      ) : (
        <p className="m-0 text-[13px] text-muted-foreground">
          This link is no longer in the index.
        </p>
      )}
      {onBack && (
        <div>
          <Button variant="secondary" size="md" onClick={onBack}>
            Back to group link
          </Button>
        </div>
      )}
    </>
  );
}

function FileView({
  projectKey,
  unit,
  onReveal,
}: {
  projectKey: string;
  unit: GraphUnit;
  onReveal: (path: string) => void;
}) {
  const { state } = useLoad(() => graph.file(projectKey, unit.path), [projectKey, unit.path]);
  const d: GraphFileAnswer | null = state.kind === "ready" ? state.data : null;
  const note = (names: string[]) => names.slice(0, 2).join(", ") || "types";
  return (
    <>
      <div>
        <div className={KIND}>{unit.key ? "Key file" : "File"}</div>
        <h3 className="m-0 text-[16px] font-bold [overflow-wrap:anywhere]">{unit.path}</h3>
      </div>
      <Stats>
        <Stat value={formatCount(unit.lines)} label="lines" />
        <Stat value={String(unit.symbols)} label="symbols" />
        <Stat value={d ? String(d.exported) : "…"} label="exported" />
        <Stat value={d ? String(d.usedByCount) : "…"} label="used by" />
        <Stat value={d ? String(d.importsCount) : "…"} label="imports" />
        <Stat value={`#${unit.rank}`} label="rank" />
      </Stats>
      {d && (
        <>
          <FileList
            title="Used by"
            rows={d.usedBy.map((l) => ({ path: l.path, note: note(l.names) }))}
            onPick={onReveal}
          />
          <FileList
            title="Imports from"
            rows={d.imports.map((l) => ({ path: l.path, note: note(l.names) }))}
            onPick={onReveal}
          />
          {d.packages.length > 0 && (
            <section>
              <h5 className={cn(LABEL, "mb-1.5 text-[11px]")}>Packages</h5>
              <p className="m-0 font-mono text-[12px] text-muted-foreground">
                {d.packages.join(" · ")}
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}

const KIND_NAME: Record<GraphUnit["kind"], string> = {
  dir: "Folder",
  pile: "Small files",
  dirpile: "Folders",
  file: "File",
};

export function GraphInspector({
  projectKey,
  view,
  selection,
  expanded,
  onReveal,
  onOpen,
  onClose,
  onSelect,
}: {
  projectKey: string;
  view: GraphView;
  selection: GraphSelection | null;
  expanded: readonly string[];
  onReveal: (path: string) => void;
  onOpen: (unit: GraphUnit) => void;
  onClose: (id: string) => void;
  onSelect: (selection: GraphSelection | null) => void;
}) {
  if (selection?.kind === "pair")
    return (
      <PairView
        projectKey={projectKey}
        from={selection.from}
        to={selection.to}
        onBack={
          selection.back ? () => onSelect({ kind: "edge", id: selection.back as string }) : null
        }
      />
    );
  if (selection?.kind === "edge") {
    const edge: GraphEdge | undefined = view.edges.find((e) => e.id === selection.id);
    if (edge) {
      const single = edge.pairs === 1 ? edge.top[0] : undefined;
      if (single)
        return <PairView projectKey={projectKey} from={single.from} to={single.to} onBack={null} />;
      const name = (id: string) => {
        const u = view.units.find((x) => x.id === id);
        return u?.path || u?.label || id;
      };
      return (
        <>
          <div className="grid gap-1">
            <div className={KIND}>Link between groups · {edge.pairs} file pairs</div>
            <Pair from={name(edge.from)} to={name(edge.to)} />
          </div>
          <Stats>
            <Stat value={String(edge.pairs)} label="file pairs" />
            <Stat value={formatCount(edge.calls)} label="call sites" />
            <Stat value={String(edge.typeOnly)} label="type only" />
          </Stats>
          <section>
            <h5 className={cn(LABEL, "mb-1.5 text-[11px]")}>Strongest pairs</h5>
            <ul className="m-0 grid list-none gap-1 p-0">
              {edge.top.map((p) => (
                <li key={`${p.from}>${p.to}`}>
                  <button
                    type="button"
                    className={ROW}
                    title={`${p.from} → ${p.to}`}
                    onClick={() =>
                      onSelect({ kind: "pair", from: p.from, to: p.to, back: edge.id })
                    }
                  >
                    <span className="truncate font-mono text-[12px]">
                      {baseName(p.from)} → {baseName(p.to)}
                    </span>
                    <span className={NUM}>{p.names[0] ?? "types"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {edge.mutual && (
            <p className="m-0 text-[13px] text-muted-foreground">
              There is a link in the other direction too, so these two depend on each other.
            </p>
          )}
        </>
      );
    }
  }
  if (selection?.kind === "unit") {
    const unit = view.units.find((u) => u.id === selection.id);
    const frame = view.frames.find((f) => f.id === selection.id);
    if (unit?.kind === "file")
      return <FileView projectKey={projectKey} unit={unit} onReveal={onReveal} />;
    if (unit || frame) {
      const open = expanded.includes(selection.id);
      const kind = unit?.kind ?? frame?.kind ?? "dir";
      const pile = kind === "pile" || kind === "dirpile";
      const label = pile
        ? (unit?.label ?? frame?.label ?? "")
        : unit?.path || frame?.path || unit?.label || frame?.label || "";
      const block = unit ?? frame;
      const links = view.edges.filter(
        (e) => e.from === selection.id || e.to === selection.id,
      ).length;
      return (
        <>
          <div>
            <div className={KIND}>
              {KIND_NAME[kind]}
              {open ? " · open" : ""}
            </div>
            <h3 className="m-0 text-[16px] font-bold [overflow-wrap:anywhere]">
              {label || view.hubs[0]?.path}
            </h3>
          </div>
          {block && (
            <Stats>
              <Stat value={formatCount(block.files)} label="files" />
              <Stat value={formatCount(block.lines)} label="lines" />
              <Stat value={String(block.keys)} label="key files" />
            </Stats>
          )}
          {block && (
            <FileList
              title="Biggest roles inside"
              rows={block.inside.map((f) => ({ path: f.path, note: `${formatCount(f.lines)} ln` }))}
              onPick={onReveal}
            />
          )}
          {!open && (
            <section>
              <h5 className={cn(LABEL, "mb-1.5 text-[11px]")}>Links</h5>
              <p className="m-0 text-[13px] text-muted-foreground">
                {links} lines to other blocks. Click one to see why.
              </p>
            </section>
          )}
          <div>
            {open ? (
              <Button variant="secondary" size="md" onClick={() => onClose(selection.id)}>
                Close folder
              </Button>
            ) : (
              unit && (
                <Button variant="primary" size="md" onClick={() => onOpen(unit)}>
                  Open
                </Button>
              )
            )}
          </div>
        </>
      );
    }
  }
  return (
    <>
      <div className="grid grid-cols-[72px_minmax(0,1fr)] items-center gap-3">
        <Bun />
        <div className="rounded-[8px] border-2 border-border bg-secondary-background px-2.5 py-2 text-[13px] shadow-sm-hard">
          {view.flat
            ? "This project is small, so every file is on the canvas."
            : "Big folders and key files first. Click a block to open it, click a line to see why two files are linked."}
        </div>
      </div>
      <Stats>
        <Stat value={formatCount(view.stats.files)} label="files" />
        <Stat value={formatCount(view.stats.lines)} label="lines" />
        <Stat value={formatCount(view.stats.symbols)} label="symbols" />
        <Stat value={formatCount(view.stats.links)} label="import links" />
        <Stat value={formatCount(view.stats.calls)} label="call sites" />
        <Stat value={String(view.units.length)} label="blocks shown" />
      </Stats>
      <FileList
        title="Most depended-on files"
        rows={view.hubs.map((h) => ({ path: h.path, note: `#${h.rank}` }))}
        onPick={onReveal}
      />
      <p className="m-0 text-[13px] text-muted-foreground">
        Drag to pan, scroll or pinch to zoom, drag a block to move it. Esc closes the open folder.
      </p>
    </>
  );
}

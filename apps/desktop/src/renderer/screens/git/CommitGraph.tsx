import { useState } from "react";
import type { GitGraph, GraphCommit, GraphEdge, GraphRef } from "../../client/git.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { PANEL } from "../../lib/styles.js";
import { NOTE } from "../setup/shared.js";
import { ago, KIND_BG, KIND_COLOR, KIND_LABEL, KINDS } from "./logic.js";

const ROW = 34;
const LANE = 16;
const PAD = 14;
/** Rows past this one appear without the cascade, so a long history is not slow to settle. */
const STAGGER_ROWS = 60;
const STAGGER_MS = 14;

const x = (lane: number): number => PAD + lane * LANE;

/** Half a row of a lane: straight down, or an S-bend to the lane it joins. */
function segment(edge: GraphEdge, top: number, bottom: number): string {
  const x1 = x(edge.from);
  const x2 = x(edge.to);
  if (x1 === x2) return `M${x1} ${top}V${bottom}`;
  const dy = bottom - top;
  return `M${x1} ${top}C${x1} ${top + dy * 0.85} ${x2} ${top + dy * 0.15} ${x2} ${bottom}`;
}

const REF_CHIP =
  "inline-flex max-w-[220px] shrink-0 items-center truncate rounded-[4px] border-2 border-border px-1.5 font-mono text-[11px] leading-[16px] font-bold text-main-foreground";

function RefChip({ value, onPick }: { value: GraphRef; onPick: (branch: string) => void }) {
  if (value.kind === "head")
    return (
      <span className={cn(REF_CHIP, "bg-foreground text-background")} title="Checked out">
        HEAD
      </span>
    );
  if (value.kind === "tag")
    return (
      <span className={cn(REF_CHIP, "bg-background text-foreground")} title="Tag">
        ◆ {value.name}
      </span>
    );
  if (value.kind === "remote")
    return (
      <span
        className={cn(REF_CHIP, "border-dashed bg-transparent text-soft-foreground")}
        title="Remote branch"
      >
        {value.name}
      </span>
    );
  return (
    <button
      type="button"
      className={cn(
        REF_CHIP,
        KIND_BG[value.branchKind],
        "cursor-pointer shadow-[2px_2px_0_0_var(--ink)] transition-transform duration-75 hover:-translate-y-px motion-reduce:transition-none",
      )}
      title={`Show ${value.name} in the graph`}
      onClick={(event) => {
        event.stopPropagation();
        onPick(value.name);
      }}
    >
      {value.name}
    </button>
  );
}

interface Props {
  graph: GitGraph;
  /** The branch whose line is lit; the others fade. */
  focus: string | null;
  lit: Set<string> | null;
  onFocus: (branch: string | null) => void;
  now: number;
  loadingMore: boolean;
  onMore: () => void;
}

/**
 * The commit graph: one SVG of lanes beside a row per commit. Lines draw from the top and nodes pop
 * in after them; with reduced motion everything is simply there. Picking a branch (here, or in the
 * branch list) lights its line and fades the rest.
 */
export function CommitGraph({ graph, focus, lit, onFocus, now, loadingMore, onMore }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = PAD * 2 + Math.max(0, graph.lanes - 1) * LANE;
  const height = graph.commits.length * ROW;
  const chosen = graph.commits.find((commit) => commit.hash === picked) ?? null;
  const faded = (branch: string | null): boolean => focus !== null && branch !== focus;
  const used = KINDS.filter((kind) => graph.branches.some((branch) => branch.kind === kind));

  return (
    <div className={cn(PANEL, "flex min-w-0 flex-col gap-3 p-0")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b-2 border-border px-4 py-3">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {used.map((kind) => (
            <span
              key={kind}
              className={cn(NOTE, "inline-flex items-center gap-1.5 text-soft-foreground")}
            >
              <span className={cn("size-3 rounded-full border-2 border-border", KIND_BG[kind])} />
              {KIND_LABEL[kind]}
            </span>
          ))}
        </span>
        {focus ? (
          <span className="ml-auto inline-flex animate-rise items-center gap-2 motion-reduce:animate-none">
            <span className={cn(NOTE, "text-dim-foreground")}>Showing</span>
            <span className="font-mono text-[12px] font-bold">{focus}</span>
            <Button variant="secondary" size="sm" onClick={() => onFocus(null)}>
              Show all
            </Button>
          </span>
        ) : (
          <span className={cn(NOTE, "ml-auto text-dim-foreground")}>
            {graph.commits.length} commits · {graph.branches.length} branches
          </span>
        )}
      </div>

      {chosen && (
        <CommitDetail commit={chosen} now={now} onClose={() => setPicked(null)} onFocus={onFocus} />
      )}

      <div className="max-h-[68vh] min-h-0 overflow-auto px-2 pb-2">
        <div className="relative flex">
          <svg
            width={width}
            height={height}
            className="shrink-0"
            role="img"
            aria-label={`Commit graph of ${graph.commits.length} commits in ${graph.lanes} lanes`}
          >
            {hover !== null && (
              <rect x={0} y={hover * ROW} width={width} height={ROW} className="fill-hover" />
            )}
            {graph.commits.map((commit, row) => (
              <Lanes key={commit.hash} commit={commit} row={row} faded={faded} />
            ))}
            {graph.commits.map((commit, row) => (
              <Node
                key={commit.hash}
                commit={commit}
                row={row}
                head={commit.refs.some((ref) => ref.kind === "head")}
                dim={lit !== null && !lit.has(commit.hash)}
                selected={commit.hash === picked}
              />
            ))}
          </svg>
          <ol className="m-0 min-w-[360px] flex-1 list-none p-0">
            {graph.commits.map((commit, row) => (
              <li
                key={commit.hash}
                style={{ height: ROW }}
                onMouseEnter={() => setHover(row)}
                onMouseLeave={() => setHover(null)}
                className={cn(
                  "flex min-w-0 items-center gap-1.5 rounded-r-base pl-1 text-[13px] text-soft-foreground transition-opacity duration-200 motion-reduce:transition-none",
                  hover === row && "bg-hover text-foreground",
                  commit.hash === picked && "bg-selected text-foreground",
                  lit !== null && !lit.has(commit.hash) && "opacity-40",
                )}
              >
                {commit.refs.map((ref) => (
                  <RefChip key={`${ref.kind}:${ref.name}`} value={ref} onPick={onFocus} />
                ))}
                <button
                  type="button"
                  aria-pressed={commit.hash === picked}
                  title="Show this commit's details"
                  onFocus={() => setHover(row)}
                  onBlur={() => setHover(null)}
                  onClick={() => setPicked(commit.hash === picked ? null : commit.hash)}
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent pr-3 pl-0.5 text-left [font:inherit] text-inherit"
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      commit.parents.length > 1 && "text-muted-foreground italic",
                    )}
                  >
                    {commit.subject}
                  </span>
                  <span className="hidden shrink-0 text-[12px] text-dim-foreground 2xl:inline">
                    {commit.author}
                  </span>
                  <span className="w-[58px] shrink-0 font-mono text-[12px] text-dim-foreground">
                    {commit.short}
                  </span>
                  <span className="w-[46px] shrink-0 text-right text-[12px] text-dim-foreground">
                    {ago(commit.time, now)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
        {graph.truncated && (
          <div className="flex justify-center pt-3">
            <Button variant="secondary" size="md" disabled={loadingMore} onClick={onMore}>
              {loadingMore ? "Loading…" : "Load older commits"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const delay = (row: number, half: number): string =>
  `${Math.min(row, STAGGER_ROWS) * STAGGER_MS + half * (STAGGER_MS / 2)}ms`;

/** A row's lane segments: an ink casing under the coloured line, so pale fills still read. */
function Lanes({
  commit,
  row,
  faded,
}: {
  commit: GraphCommit;
  row: number;
  faded: (branch: string | null) => boolean;
}) {
  const top = row * ROW;
  const mid = top + ROW / 2;
  const parts = [
    ...commit.up.map((edge) => ({ edge, d: segment(edge, top, mid), half: 0 })),
    ...commit.down.map((edge) => ({ edge, d: segment(edge, mid, top + ROW), half: 1 })),
  ];
  return (
    <g>
      {parts.map(({ edge, d, half }, i) => {
        const style = { animationDelay: delay(row, half) };
        const dim = faded(edge.branch);
        return (
          <g
            // biome-ignore lint/suspicious/noArrayIndexKey: segments of a row have no identity
            key={i}
            className="transition-opacity duration-300 motion-reduce:transition-none"
            opacity={dim ? 0.18 : 1}
          >
            <path
              d={d}
              pathLength={1}
              strokeDasharray="1 1"
              fill="none"
              stroke="var(--ink)"
              strokeWidth={5.5}
              strokeLinecap="round"
              className="animate-draw-line motion-reduce:animate-none"
              style={style}
            />
            <path
              d={d}
              pathLength={1}
              strokeDasharray="1 1"
              fill="none"
              stroke={KIND_COLOR[edge.kind]}
              strokeWidth={3}
              strokeLinecap="round"
              className="animate-draw-line motion-reduce:animate-none"
              style={style}
            />
          </g>
        );
      })}
    </g>
  );
}

function Node({
  commit,
  row,
  head,
  dim,
  selected,
}: {
  commit: GraphCommit;
  row: number;
  head: boolean;
  dim: boolean;
  selected: boolean;
}) {
  const cx = x(commit.lane);
  const cy = row * ROW + ROW / 2;
  const merge = commit.parents.length > 1;
  const color = KIND_COLOR[commit.kind];
  return (
    <g
      className="transition-opacity duration-300 motion-reduce:transition-none"
      opacity={dim ? 0.25 : 1}
    >
      {head && (
        <circle
          cx={cx}
          cy={cy}
          r={7}
          fill="none"
          stroke={color}
          strokeWidth={2}
          className="animate-head-ring [transform-box:fill-box] [transform-origin:center] motion-reduce:animate-none"
        />
      )}
      <g
        className="animate-node-pop [transform-box:fill-box] [transform-origin:center] motion-reduce:animate-none"
        style={{ animationDelay: delay(row, 1) }}
      >
        {merge ? (
          <rect
            x={cx - 6}
            y={cy - 6}
            width={12}
            height={12}
            rx={2}
            transform={`rotate(45 ${cx} ${cy})`}
            fill={color}
            stroke="var(--ink)"
            strokeWidth={2}
          />
        ) : (
          <circle
            cx={cx}
            cy={cy}
            r={head || selected ? 7.5 : 6}
            fill={head ? "var(--bg-panel)" : color}
            stroke="var(--ink)"
            strokeWidth={2}
          />
        )}
        {head && <circle cx={cx} cy={cy} r={3} fill={color} />}
      </g>
    </g>
  );
}

function CommitDetail({
  commit,
  now,
  onClose,
  onFocus,
}: {
  commit: GraphCommit;
  now: number;
  onClose: () => void;
  onFocus: (branch: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(commit.hash).then(() => setCopied(true));
  };
  return (
    <div className="mx-4 flex animate-rise flex-wrap items-center gap-x-4 gap-y-2 rounded-base border-2 border-border bg-raised px-3 py-2.5 shadow-sm-hard motion-reduce:animate-none">
      <span
        className={cn(
          "size-3.5 shrink-0 rounded-full border-2 border-border",
          KIND_BG[commit.kind],
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-bold text-foreground">
          {commit.subject}
        </span>
        <span className={cn(NOTE, "block truncate font-mono text-dim-foreground")}>
          {commit.hash} · {commit.author} · {new Date(commit.time * 1000).toLocaleString()} (
          {ago(commit.time, now)} ago)
          {commit.parents.length > 1 &&
            ` · merge of ${commit.parents.map((p) => p.slice(0, 7)).join(" + ")}`}
        </span>
      </span>
      {commit.branch && (
        <Button variant="secondary" size="sm" onClick={() => onFocus(commit.branch)}>
          Follow {commit.branch}
        </Button>
      )}
      <Button variant="secondary" size="sm" onClick={copy}>
        {copied ? "Copied" : "Copy hash"}
      </Button>
      <Button variant="ghost" size="sm" aria-label="Close commit details" onClick={onClose}>
        ✕
      </Button>
    </div>
  );
}

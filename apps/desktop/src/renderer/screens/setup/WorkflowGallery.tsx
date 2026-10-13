import { type CSSProperties, useState } from "react";
import type { DefinitionSummary, LineStage } from "../../client/start.js";
import { Icon } from "../../components/Icon.js";
import { Input } from "../../components/ui/input.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import { lineOf, stageIcon } from "../runs/line-model.js";
import { Tag } from "./shared.js";
import { WorkflowFlow } from "./WorkflowFlow.js";
import {
  cardFacts,
  FAMILY_LABEL,
  type Family,
  familyOf,
  MINI_SIZE,
  matches,
  miniLine,
} from "./workflow-studio-model.js";

/**
 * The project's workflows as a gallery: a banner that plays a run along one of them, then a card
 * per definition with its family, what it does, its line of stations with the repair loops under
 * it, and links to watch it run or open it in the graph editor.
 */

export type EditorTab = "flow" | "graph";

const FAMILY_FILL: Record<Family, string> = {
  full: "bg-main",
  spec: "bg-fill-warn",
  quick: "bg-fill-ok",
  repair: "bg-fill-err",
  read: "bg-fill-info",
};

/** Station colours by role, shared with the graph editor. */
export const TYPE_FILL: Record<LineStage["type"], string> = {
  agent: "bg-fill-info",
  approval: "bg-fill-warn",
  tasks: "bg-main",
  check: "bg-fill-ok",
  wait: "bg-fill-warn",
  review: "bg-fill-err",
  reflection: "bg-fill-info",
  learn: "bg-fill-info",
};

const LEGEND: [LineStage["type"], string][] = [
  ["agent", "Agent"],
  ["approval", "You approve"],
  ["tasks", "Writers"],
  ["check", "Checks"],
  ["review", "Review"],
];

const LINK_BUTTON =
  "inline-flex h-[34px] flex-1 items-center justify-center gap-[6px] rounded-base border-2 border-border bg-secondary-background px-3 text-[13px] font-semibold text-foreground no-underline transition-[transform,box-shadow] duration-100 hover:-translate-x-px hover:-translate-y-px hover:shadow-sm-hard focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none";

type Source = "all" | "builtin" | "project";

function MiniLine({ definition }: { definition: DefinitionSummary }) {
  const mini = miniLine(lineOf(definition.stages, definition.line));
  return (
    <div
      className="relative h-[46px] max-w-full"
      style={{ width: mini.width }}
      role="img"
      aria-label={`Stations: ${mini.stations.map((s) => s.id).join(", ")}${
        mini.loops.length ? `; ${mini.loops.map((l) => l.title).join("; ")}` : ""
      }`}
    >
      <span
        className="absolute top-[10px] h-[2px] bg-border"
        style={{ left: MINI_SIZE / 2, width: Math.max(0, mini.width - MINI_SIZE) }}
        aria-hidden="true"
      />
      {mini.stations.map((s) => (
        <span
          key={s.id}
          title={`${s.id} · makes ${s.produces}`}
          className={cn(
            "absolute top-0 flex items-center justify-center border-2 border-border text-main-foreground",
            s.human ? "rounded-full" : "rounded-[4px]",
            TYPE_FILL[s.type],
          )}
          style={{ left: s.x, width: MINI_SIZE, height: MINI_SIZE }}
          aria-hidden="true"
        >
          <Icon name={stageIcon(s)} size={12} />
        </span>
      ))}
      <svg
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={mini.width}
        height={46}
        aria-hidden="true"
      >
        {mini.loops.map((l) => (
          <path
            key={l.d}
            d={l.d}
            fill="none"
            strokeDasharray="3 3"
            className="stroke-[var(--accent)] stroke-[1.6]"
          />
        ))}
      </svg>
      <span
        className="absolute top-[30px] left-[6px] size-[10px] rounded-full border-2 border-border bg-main transition-transform duration-[1400ms] ease-in-out group-hover/card:translate-x-[var(--hop)] motion-reduce:transition-none"
        style={{ "--hop": `${Math.max(0, mini.width - MINI_SIZE)}px` } as CSSProperties}
        aria-hidden="true"
      />
    </div>
  );
}

function Card({
  definition,
  projectKey,
  onOpen,
}: {
  definition: DefinitionSummary;
  projectKey: string;
  onOpen: (tab: EditorTab) => void;
}) {
  const family = familyOf(definition);
  const href = projectHref(projectKey, "workflows", definition.id);
  return (
    <article
      aria-label={`Workflow ${definition.id}`}
      className="group/card flex min-w-0 flex-col overflow-hidden rounded-base border-2 border-border bg-secondary-background shadow-shadow transition-[transform,box-shadow] duration-150 hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[6px_6px_0_0_var(--ink)] motion-reduce:transition-none"
    >
      <header
        className={cn(
          "flex items-center gap-2 border-b-2 border-border px-[14px] py-3 text-main-foreground",
          FAMILY_FILL[family],
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <a
            href={href}
            onClick={() => onOpen("flow")}
            className="truncate font-mono text-[18px] font-bold text-main-foreground no-underline hover:underline"
          >
            {definition.id}
          </a>
          <span className="text-[11px] font-bold tracking-[0.06em] uppercase">
            {FAMILY_LABEL[family]}
          </span>
        </span>
        <span className="flex-none rounded-full border-2 border-border bg-secondary-background px-2 py-[1px] font-mono text-[11px] text-foreground">
          {definition.source === "builtin" ? "built-in" : "project"}
        </span>
      </header>
      <div className="flex flex-1 flex-col gap-3 px-[14px] pt-3 pb-[14px]">
        <p
          className="m-0 line-clamp-2 min-h-[38px] text-[13px] leading-[1.45] text-soft-foreground"
          title={definition.description}
        >
          {definition.description || "No description."}
        </p>
        <MiniLine definition={definition} />
        <div className="flex flex-wrap gap-[6px]">
          {cardFacts(definition).map((fact) => (
            <span
              key={fact}
              className="rounded-full border-[1.5px] border-[var(--line-strong)] px-2 py-[1px] font-mono text-[11px] text-soft-foreground"
            >
              {fact}
            </span>
          ))}
          {definition.problems.length > 0 && (
            <Tag tone="warn">
              {definition.problems.length} problem{definition.problems.length === 1 ? "" : "s"}
            </Tag>
          )}
        </div>
        <div className="mt-auto flex gap-2">
          <a
            href={href}
            className={LINK_BUTTON}
            aria-label={`Watch ${definition.id} run`}
            onClick={() => onOpen("flow")}
          >
            <Icon name="runs" size={14} />
            Watch
          </a>
          <a
            href={href}
            className={LINK_BUTTON}
            aria-label={`Open ${definition.id} in the graph`}
            onClick={() => onOpen("graph")}
          >
            <Icon name="graph" size={14} />
            Graph
          </a>
        </div>
      </div>
    </article>
  );
}

export function WorkflowGallery({
  definitions,
  projectKey,
  onOpen,
}: {
  definitions: DefinitionSummary[];
  projectKey: string;
  onOpen: (tab: EditorTab) => void;
}) {
  const [source, setSource] = useState<Source>("all");
  const [query, setQuery] = useState("");
  const counts: Record<Source, number> = {
    all: definitions.length,
    builtin: definitions.filter((d) => d.source === "builtin").length,
    project: definitions.filter((d) => d.source === "project").length,
  };
  const shown = definitions.filter(
    (d) =>
      (source === "all" || (source === "builtin") === (d.source === "builtin")) &&
      matches(d, query),
  );
  const showcase =
    definitions.find((d) => d.id === "sdd") ??
    definitions.find((d) => (d.line?.loops.length ?? 0) > 0) ??
    definitions[0];

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className={LEDE}>
        The recipes a run follows. Watch one to see how work moves through its stations, or open it
        in the graph to reshape it: built-in ones open read only, and duplicating one makes a
        project workflow in <span className="font-mono">baked/workflows</span>. The same editor as{" "}
        <span className="font-mono">/workflow</span> in the terminal.
      </p>
      {showcase && (
        <section
          aria-label="How a run flows"
          className={cn(PANEL, "flex min-w-0 flex-col gap-2 overflow-hidden bg-raised")}
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2 className={LABEL}>How a run flows · {showcase.id}</h2>
            <span className="flex-1" />
            <a
              href={projectHref(projectKey, "workflows", showcase.id)}
              onClick={() => onOpen("flow")}
              className={cn(LINK_BUTTON, "flex-none")}
            >
              <Icon name="runs" size={14} />
              Watch step by step
            </a>
          </div>
          <WorkflowFlow line={lineOf(showcase.stages, showcase.line)} compact />
        </section>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <SegmentGroup aria-label="Source">
          {(
            [
              ["all", "All"],
              ["builtin", "Built-in"],
              ["project", "Project"],
            ] as const
          ).map(([value, label]) => (
            <Segment key={value} aria-pressed={source === value} onClick={() => setSource(value)}>
              {label} <span className="font-mono text-[11px] opacity-75">{counts[value]}</span>
            </Segment>
          ))}
        </SegmentGroup>
        <Input
          type="search"
          aria-label="Find a workflow"
          placeholder="Find a workflow or stage"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 max-w-[320px] min-w-[200px] flex-1"
        />
        <span className="flex-1" />
        <ul className="m-0 flex list-none flex-wrap items-center gap-3 p-0" aria-label="Legend">
          {LEGEND.map(([type, label]) => (
            <li
              key={type}
              className="flex items-center gap-[5px] text-[12px] text-muted-foreground"
            >
              <span
                className={cn(
                  "size-3 border-2 border-border",
                  type === "approval" ? "rounded-full" : "rounded-[3px]",
                  TYPE_FILL[type],
                )}
              />
              {label}
            </li>
          ))}
        </ul>
      </div>
      {shown.length === 0 ? (
        <div className="rounded-base border-2 border-dashed border-[var(--line-strong)] bg-raised p-5 text-[14px] text-soft-foreground">
          {source === "project" && !query
            ? "No project workflows yet. Open a built-in one and Duplicate as custom to make your own in baked/workflows."
            : "No workflow matches."}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-[18px]">
          {shown.map((d) => (
            <Card key={d.id} definition={d} projectKey={projectKey} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}

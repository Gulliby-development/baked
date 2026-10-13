import { type FormEvent, useState } from "react";
import type { GraphBranch } from "../../client/git.js";
import { Icon } from "../../components/Icon.js";
import { Button } from "../../components/ui/button.js";
import { cn } from "../../lib/cn.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { NOTE, STACK } from "../setup/shared.js";
import { ago, BRANCH_PAGE, branchParts, KIND_BG, visibleBranches } from "./logic.js";

const NAME_MAX = 200;

interface Props {
  branches: GraphBranch[];
  base: string | null;
  focus: string | null;
  onFocus: (branch: string | null) => void;
  locked: boolean;
  now: number;
  onSwitch: (name: string) => void;
  onCreate: (name: string) => Promise<boolean>;
}

/**
 * The local branches, current first then by recency: ten at a time with "Show more", a filter for
 * the rest, each with its colour, last commit and distance from the base branch. Picking a row
 * lights the branch in the graph.
 */
export function BranchList({
  branches,
  base,
  focus,
  onFocus,
  locked,
  now,
  onSwitch,
  onCreate,
}: Props) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(BRANCH_PAGE);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const { items, matching } = visibleBranches(branches, filter, shown);
  const hidden = matching - items.length;

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed && (await onCreate(trimmed))) {
      setName("");
      setCreating(false);
    }
  };

  return (
    <section aria-label="Branches" className={cn(STACK, "gap-3")}>
      <div className="flex items-center gap-2">
        <h2 className={LABEL}>Branches</h2>
        <span className="rounded-full border-2 border-border bg-raised px-2 font-mono text-[11px] font-bold">
          {branches.length}
        </span>
        <Button
          variant={creating ? "secondary" : "primary"}
          size="md"
          className="ml-auto"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? "Cancel" : "+ New branch"}
        </Button>
      </div>

      {creating && (
        <form
          className="flex animate-rise items-center gap-2 motion-reduce:animate-none"
          onSubmit={(e) => void create(e)}
        >
          <label htmlFor="git-branch" className="sr-only">
            New branch
          </label>
          <input
            id="git-branch"
            type="text"
            // biome-ignore lint/a11y/noAutofocus: the field opens on the person's click
            autoFocus
            className="min-w-0 flex-1"
            placeholder="New branch from here, e.g. feature/pricing"
            value={name}
            maxLength={NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            disabled={locked}
          />
          <Button type="submit" variant="primary" size="md" disabled={locked || !name.trim()}>
            Create and switch
          </Button>
        </form>
      )}

      <div className="relative">
        <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dim-foreground">
          <Icon name="search" size={14} />
        </span>
        <label htmlFor="git-branch-filter" className="sr-only">
          Filter branches
        </label>
        <input
          id="git-branch-filter"
          type="text"
          className="w-full pl-9"
          placeholder="Filter branches"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setShown(BRANCH_PAGE);
          }}
        />
      </div>

      {items.length === 0 ? (
        <span className={cn(NOTE, "text-dim-foreground")}>
          No branch matches “{filter.trim()}”.
        </span>
      ) : (
        <ul className={cn(PANEL, "m-0 flex list-none flex-col p-0")}>
          {items.map((branch, i) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              index={i}
              isBase={branch.name === base}
              focused={branch.name === focus}
              locked={locked}
              now={now}
              onFocus={() => onFocus(branch.name === focus ? null : branch.name)}
              onSwitch={() => onSwitch(branch.name)}
            />
          ))}
        </ul>
      )}

      {(hidden > 0 || shown > BRANCH_PAGE) && (
        <div className="flex items-center gap-3">
          {hidden > 0 && (
            <Button variant="secondary" size="md" onClick={() => setShown((n) => n + BRANCH_PAGE)}>
              Show {Math.min(BRANCH_PAGE, hidden)} more
            </Button>
          )}
          {shown > BRANCH_PAGE && (
            <Button variant="ghost" size="sm" onClick={() => setShown(BRANCH_PAGE)}>
              Show fewer
            </Button>
          )}
          <span className={cn(NOTE, "ml-auto text-dim-foreground")}>
            {items.length} of {matching}
          </span>
        </div>
      )}
    </section>
  );
}

function BranchRow({
  branch,
  index,
  isBase,
  focused,
  locked,
  now,
  onFocus,
  onSwitch,
}: {
  branch: GraphBranch;
  index: number;
  isBase: boolean;
  focused: boolean;
  locked: boolean;
  now: number;
  onFocus: () => void;
  onSwitch: () => void;
}) {
  const { prefix, rest } = branchParts(branch.name);
  return (
    <li
      className="flex animate-rise items-stretch border-b border-[var(--line)] last:border-b-0 motion-reduce:animate-none"
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
    >
      <button
        type="button"
        aria-pressed={focused}
        title={focused ? "Show every branch in the graph" : "Show this branch in the graph"}
        onClick={onFocus}
        className="group flex min-w-0 flex-1 cursor-pointer items-center gap-3 border-0 bg-transparent py-2.5 pr-2 pl-3 text-left [font:inherit] text-soft-foreground hover:bg-hover aria-pressed:bg-selected aria-pressed:text-foreground"
      >
        <span
          className={cn(
            "h-8 w-1.5 shrink-0 rounded-full border-2 border-border transition-[height] duration-150 group-aria-pressed:h-10 motion-reduce:transition-none",
            KIND_BG[branch.kind],
          )}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-mono text-[13px]" title={branch.name}>
            <span className="text-dim-foreground">{prefix}</span>
            <span className="font-bold text-foreground">{rest}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-dim-foreground">
            <Distance branch={branch} isBase={isBase} />
            {branch.subject && (
              <span className="min-w-0 truncate">
                {ago(branch.time, now)} · {branch.subject}
              </span>
            )}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center pr-3">
        {branch.current ? (
          <span className="rounded-full border-2 border-border bg-main px-2 py-0.5 font-mono text-[11px] font-bold text-main-foreground uppercase">
            current
          </span>
        ) : (
          <Button variant="secondary" size="sm" disabled={locked} onClick={onSwitch}>
            Switch
          </Button>
        )}
      </span>
    </li>
  );
}

/** Commits ahead of and behind the base branch, as two small counters. */
function Distance({ branch, isBase }: { branch: GraphBranch; isBase: boolean }) {
  if (isBase)
    return (
      <span className="shrink-0 font-mono text-[11px] font-bold text-dim-foreground">BASE</span>
    );
  if (branch.ahead === null || branch.behind === null) return null;
  return (
    <span
      className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-bold"
      title={`${branch.ahead} commits ahead of and ${branch.behind} behind the base branch`}
    >
      <span
        className={cn(
          "rounded-[4px] border-2 border-border px-1",
          branch.ahead > 0 ? "bg-fill-ok text-main-foreground" : "text-dim-foreground",
        )}
      >
        ↑{branch.ahead}
      </span>
      <span
        className={cn(
          "rounded-[4px] border-2 border-border px-1",
          branch.behind > 0 ? "bg-fill-warn text-main-foreground" : "text-dim-foreground",
        )}
      >
        ↓{branch.behind}
      </span>
    </span>
  );
}

import type { ReactNode } from "react";
import { isMissingEndpoint, isNoProject } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Empty } from "../../components/ui/empty.js";
import { type Query, type QueryKey, useQuery } from "../../lib/query.js";

/** Class strings the setup screens share (project gates, instructions, working set, settings). */
export const SETUP = "flex min-w-0 flex-col gap-4 [&_input:disabled]:opacity-70";
export const STACK = "flex min-w-0 flex-col gap-[10px]";
export const ROW = "flex flex-wrap items-center gap-x-3 gap-y-[10px]";
export const GROW = "min-w-0 flex-1";
export const NOTE = "text-[12px]";
export const WARN = "text-[var(--warn)]";
export const OK = "text-[var(--ok)]";
export const H = "m-0 text-[14px] font-semibold";
export const H2 = "mt-2 mb-0 scroll-mt-4 text-[16px] font-semibold";
export const FORM = "flex flex-col gap-3";
export const ACTIONS = "flex flex-wrap gap-2";
export const PAIR = "flex flex-wrap gap-3";
const FIELD =
  "flex min-w-0 flex-col gap-[6px] [&_input]:w-full [&_select]:w-full [&>:is(label,span)]:text-[12px] [&>:is(label,span)]:text-dim-foreground";
/** A labelled field; `FIELD_HALF` sits next to another in a `PAIR`. */
export const FL = `${FIELD} flex-1`;
export const FIELD_HALF = `${FIELD} flex-[1_1_140px]`;
export const ADD = "flex items-center gap-2 [&_input]:w-full [&_input]:min-w-0 [&_input]:flex-1";
/** List on the left, editor on the right; stacked when narrow. */
export const SPLIT = "flex flex-wrap items-start gap-4";
export const SPLIT_MAIN = `${STACK} flex-[1_1_420px]`;
export const SIDE = "min-w-0 flex-[1_1_340px]";
/** A list card without padding; its last row drops its rule. */
export const LIST = "m-0 list-none p-0 [&>li:last-child]:border-b-0";
export const FLUSH = "overflow-hidden p-0 [&_tr:last-child_td]:border-b-0";
const LINE_BASE =
  "flex flex-wrap items-center gap-x-3 border-b border-[var(--line)] px-[14px] py-[9px] text-[13px] text-soft-foreground";
export const LINE = `${LINE_BASE} gap-y-2`;
export const LINE_LOOSE = `${LINE_BASE} gap-y-[10px]`;
/** A selectable row of a list: gates, instruction files. */
export const GATE =
  "flex min-h-[44px] w-full cursor-pointer flex-wrap items-center gap-x-[10px] gap-y-2 border-t-0 border-r-0 border-b border-l-[3px] border-b-[var(--line)] border-l-transparent bg-transparent px-[14px] py-[10px] text-left [font-family:inherit] [font-weight:inherit] [line-height:inherit] text-[13px] text-soft-foreground hover:bg-hover aria-pressed:border-l-[var(--fill-accent)] aria-pressed:bg-selected aria-pressed:text-foreground [li:last-child>&]:border-b-0";
export const MARK = "w-[14px] text-center";
export const WRAP = "whitespace-normal wrap-anywhere";
export const NEEDS = "border-[var(--warn)]";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "ready"; data: T }
  | { state: "missing" }
  | { state: "no-project" }
  | { state: "error"; message: string };

export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Reads `key` through the shared query cache: the last answer at once, refreshed in the
 * background; a 404 from an older backend becomes `missing`, and one from a folder without
 * baked/project.json becomes `no-project`. `reload` fetches again while the data stays on screen;
 * `set` stores the view a write returned.
 */
export function useLoad<T>(
  load: () => Promise<T>,
  key: QueryKey,
): [Loaded<T>, () => void, (data: T) => void] {
  const query = useQuery(key, load);
  return [toLoaded(query), query.refresh, query.set];
}

function toLoaded<T>(query: Query<T>): Loaded<T> {
  if (query.hasData) return { state: "ready", data: query.data as T };
  if (query.loading || query.error === null) return { state: "loading" };
  if (isMissingEndpoint(query.error)) return { state: "missing" };
  if (isNoProject(query.error)) return { state: "no-project" };
  return { state: "error", message: errorText(query.error) };
}

export function NeedsNewer({ what }: { what: string }) {
  return (
    <Alert className={NEEDS}>
      Needs a newer BAKED: this project's backend cannot show {what} yet. Update BAKED, or point
      Settings → BAKED executable at a newer one.
    </Alert>
  );
}

/** The non-ready states of a `Loaded`, or null when the data is there. */
export function LoadState({ value, what }: { value: Loaded<unknown>; what: string }) {
  if (value.state === "loading") return <div className="text-dim-foreground">Loading {what}…</div>;
  if (value.state === "missing") return <NeedsNewer what={what} />;
  if (value.state === "no-project")
    return (
      <Empty>
        This folder has no <span className="font-mono">baked/project.json</span> yet. Run{" "}
        <span className="font-mono">baked project init</span> in the folder to create one.
      </Empty>
    );
  if (value.state === "error") return <Alert tone="error">{value.message}</Alert>;
  return null;
}

const TAG_TONE = { warn: "text-[var(--warn)]", err: "text-[var(--err)]" } as const;

export function Tag({ children, tone }: { children: ReactNode; tone?: "warn" | "err" }) {
  return (
    <span
      className={`whitespace-nowrap rounded-[5px] bg-hover px-[7px] py-[2px] text-[11px] ${tone ? TAG_TONE[tone] : "text-muted-foreground"}`}
    >
      {children}
    </span>
  );
}

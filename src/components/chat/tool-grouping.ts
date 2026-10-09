import type { ToolCall } from "../../types/index.js";

const META_TOOLS = new Set(["plan", "update_plan_step", "ask_user"]);
const EDIT_NAMES = new Set(["edit_file", "multi_edit"]);
const READ_NAMES = new Set(["read"]);
const SEARCH_NAMES = new Set([
  "grep",
  "bake_grep",
  "glob",
  "bake_find",
  "navigate",
  "bake_analyze",
  "bake_impact",
]);

type BatchKind = "edits" | "reads" | "search";

type ToolGroup =
  | { type: "normal"; tc: ToolCall }
  | { type: "meta"; calls: ToolCall[] }
  | { type: "batch"; kind: BatchKind; calls: ToolCall[] };

function toolKind(name: string): BatchKind | null {
  if (EDIT_NAMES.has(name)) return "edits";
  if (READ_NAMES.has(name)) return "reads";
  if (SEARCH_NAMES.has(name)) return "search";
  return null;
}

export { EDIT_NAMES };

/**
 * Group consecutive tool calls of the same kind for compact UI display.
 * Rules:
 * - META_TOOLS (plan, update_plan_step, ask_user) → collapsed meta group
 * - Consecutive edits (edit_file, multi_edit) → batch "edits"
 * - Consecutive reads (read) → batch "reads"
 * - Consecutive search (grep, bake_grep, glob, etc.) → batch "search"
 * - Different kinds break the batch (read → edit → read = 3 groups)
 * - Single tool calls stay as "normal" (no batch for 1 item)
 * - Non-groupable tools (shell, dispatch, project) always "normal"
 */
export function groupToolCalls(calls: ToolCall[]): ToolGroup[] {
  const groups: ToolGroup[] = [];
  let metaBuf: ToolCall[] = [];
  let batchBuf: ToolCall[] = [];
  let batchKind: BatchKind | null = null;

  const flushMeta = () => {
    if (metaBuf.length > 0) {
      groups.push({ type: "meta", calls: metaBuf });
      metaBuf = [];
    }
  };
  const flushBatch = () => {
    if (batchBuf.length > 1 && batchKind) {
      groups.push({ type: "batch", kind: batchKind, calls: batchBuf });
    } else if (batchBuf.length === 1) {
      groups.push({ type: "normal", tc: batchBuf[0] as ToolCall });
    }
    batchBuf = [];
    batchKind = null;
  };

  for (const tc of calls) {
    if (META_TOOLS.has(tc.name)) {
      flushBatch();
      metaBuf.push(tc);
    } else {
      const kind = toolKind(tc.name);
      if (kind && kind === batchKind) {
        batchBuf.push(tc);
      } else if (kind) {
        flushMeta();
        flushBatch();
        batchKind = kind;
        batchBuf.push(tc);
      } else {
        flushMeta();
        flushBatch();
        groups.push({ type: "normal", tc });
      }
    }
  }
  flushMeta();
  flushBatch();

  return groups;
}

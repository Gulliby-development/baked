import { canonical } from "../specs/hash.js";
import {
  CONFLICT_ASSUMPTION_PREFIX,
  CONFLICT_DECISION_PREFIX,
  rowClaimOverrides,
} from "./conflict-decisions.js";
import {
  derivationRowConflicts,
  graphPaths,
  ROW_CLAIM_DIR,
  ROW_CLAIM_KIND,
  type RowClaimConflict,
  type RowClaimRecord,
  rowClaimConflicts,
  rowClaimNote,
} from "./row-claims.js";
import type { TaskGraph } from "./schemas.js";
import type { WorkflowStore } from "./store.js";

/** Where a conflict's spec amendment is recorded (`amendments/conflict-<task>.json`). */
const AMENDMENT_PREFIX = "amendments/conflict-";

/** Where the resume records the restatements it checked against the request (#2561). */
export const ROW_CLAIM_RESUME_DIR = `${ROW_CLAIM_DIR}resume-`;

/** One restatement the run already holds: a settled decision, a settled conflict or a finding. */
interface Held {
  ref: string;
  text: string;
  derivations: { row: string; recomputed: string; matches: boolean }[];
  /** The artifact paths the request's rows override when it contradicts them. */
  overrides: string[];
  taskId?: string;
  findingId?: string;
}

const safe = (ref: string) => ref.replace(/[^\w.-]+/g, "_");

function derivationsOf(body: Record<string, unknown>): Held["derivations"] {
  return Array.isArray(body.derivations)
    ? body.derivations.flatMap((d) => {
        const row = (d as { row?: unknown }).row;
        const recomputed = (d as { recomputed?: unknown }).recomputed;
        const matches = (d as { matches?: unknown }).matches;
        return typeof row === "string" && typeof recomputed === "string"
          ? [{ row, recomputed, matches: matches === true }]
          : [];
      })
    : [];
}

/** The decisions, settled conflicts and open findings of a run, as text to check. */
function heldRestatements(store: WorkflowStore, runId: string): Held[] {
  const overridden = rowClaimOverrides(store, runId);
  const artifacts = store.artifacts(runId);
  // Each path at its latest revision only.
  const latest = artifacts.filter(
    (a, i) => !artifacts.slice(i + 1).some((b) => b.logical_path === a.logical_path),
  );
  const held: Held[] = [];
  for (const a of latest) {
    const decision = a.logical_path.startsWith(CONFLICT_DECISION_PREFIX);
    if (
      (!decision &&
        !a.logical_path.startsWith(CONFLICT_ASSUMPTION_PREFIX) &&
        !a.logical_path.startsWith(AMENDMENT_PREFIX)) ||
      overridden.has(a.logical_path) ||
      // A settlement for the request's rows quotes them; it is not a restatement.
      /request-rows/.test(a.logical_path)
    )
      continue;
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(store.readArtifact(runId, a.id)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = [body.answer, body.assumed, body.summary, body.claim, body.suggestedFix]
      .filter((t): t is string => typeof t === "string")
      .join("\n");
    if (!text) continue;
    // A decision names the assumption it settled by: both go when the request's rows win.
    const cited = decision
      ? [...text.matchAll(/\((assumptions\/conflicts\/[\w.-]+\.json)\)/g)].map((m) => m[1] ?? "")
      : [];
    held.push({
      ref: a.logical_path,
      text,
      derivations: derivationsOf(body),
      overrides: [...new Set([a.logical_path, ...cited.filter(Boolean)])],
      ...(typeof body.taskId === "string" ? { taskId: body.taskId } : {}),
    });
  }
  for (const f of store.findings(runId)) {
    if (f.status !== "open" && f.status !== "confirmed") continue;
    try {
      const body = JSON.parse(f.body_json) as { claim?: unknown; suggestedFix?: unknown };
      held.push({
        ref: `finding-${f.id}`,
        text: `${String(body.claim ?? "")}\n${String(body.suggestedFix ?? "")}`,
        derivations: [],
        overrides: [],
        findingId: f.id,
      });
    } catch {}
  }
  return held;
}

/**
 * The repair, on resume of a run blocked `invalid_output`, of restatements the run settled before
 * the request's rows were checked (#2561): R82 tinyflate deflate 82f19908 rev 56 held a decision
 * (`decisions/clarification-reaudited-T009.json`) and settled conflicts that give
 * `tests/deflate_match_test.c` rows 7 and 8 306 and 283 bytes for the request's 300 and 259, and a
 * confirmed finding that says so; T009's every session met them again. Each decision, settled
 * conflict, spec amendment and open or confirmed finding is checked against the request's rows (`suppliedRows`
 * through `rowClaimConflicts` and `derivationRowConflicts`), and each that contradicts them
 * records `conflicts/row-claims/resume-<ref>.json`. With `mode` `on` the record overrides the
 * decision and the assumption it cites (`conflictDecisions` and `settledConflicts` skip them) and
 * the finding is refuted; the note for the run's prompt names each row as the request gives it.
 * The same record is not written again, so a second resume of the same run is a repeat.
 */
export function repairRowClaims(
  store: WorkflowStore,
  runId: string,
  request: string,
  graph: Pick<TaskGraph, "tasks">,
  mode: RowClaimRecord["mode"],
): { written: number; note: string | null } {
  const paths = graphPaths(graph);
  const contradicted: { held: Held; conflicts: RowClaimConflict[] }[] = [];
  for (const held of heldRestatements(store, runId)) {
    const conflicts = [
      ...derivationRowConflicts(request, paths, held.derivations),
      ...rowClaimConflicts(request, paths, held.text),
    ];
    if (conflicts.length) contradicted.push({ held, conflicts });
  }
  let written = 0;
  for (const { held, conflicts } of contradicted) {
    const record: RowClaimRecord = {
      schemaVersion: 1,
      site: "resume",
      ref: held.ref,
      ...(held.taskId ? { taskId: held.taskId } : {}),
      mode,
      conflicts,
      verdict: mode === "on" ? "overridden" : "would_override",
      ...(mode === "on" && held.overrides.length ? { overrides: held.overrides } : {}),
    };
    const path = `${ROW_CLAIM_RESUME_DIR}${safe(held.ref)}.json`;
    const body = canonical(record);
    const last = store.latestArtifact(runId, path);
    if (last && store.readArtifact(runId, last.id) === body) continue;
    store.transaction(() => {
      store.artifact(runId, ROW_CLAIM_KIND, path, body);
      if (mode === "on" && held.findingId) store.findingStatus(runId, held.findingId, "refuted");
    });
    written++;
  }
  if (mode !== "on" || !written) return { written, note: null };
  const all = contradicted.flatMap((c) => c.conflicts);
  const unique = all.filter(
    (c, i) =>
      all.findIndex(
        (d) => d.path === c.path && d.row === c.row && d.kind === c.kind && d.claimed === c.claimed,
      ) === i,
  );
  const sources = contradicted.map((c) => c.held.ref).join(", ");
  return {
    written,
    note: `Row claims overridden on resume (${ROW_CLAIM_DIR}): ${rowClaimNote(request, unique, `What this run settled earlier (${sources})`)}`,
  };
}

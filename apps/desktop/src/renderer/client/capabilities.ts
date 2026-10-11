/**
 * Capability groups of `GET /v1/health` (docs/desktop/api.md, "Health and capabilities"). Kept
 * free of the bridge so tests can import it.
 */

/** `/v1/workflow/checks*`. */
export const CHECKS_CAPABILITY = "checks";
/** `/v1/commands` and `/v1/skills`. */
export const LIBRARY_CAPABILITY = "library";
/** `/v1/workflow/routing`. */
export const ROUTING_CAPABILITY = "routing";
/** `POST /v1/sessions/ID/compact` ("Compact now" in chat). */
export const COMPACTION_CAPABILITY = "compaction";
/** `GET /v1/sessions/ID/diff` (line counts of the files a chat changed). */
export const DIFF_STATS_CAPABILITY = "diff-stats";
/** `/v1/sessions/ID/checkpoints`, `/rewind` and `/redo` (rewinding a chat in place). */
export const CHECKPOINTS_CAPABILITY = "checkpoints";

/**
 * Whether a backend offers a capability: true or false from its health answer, null when the
 * health answer could not be read, so the caller has to try the endpoint and treat 404 as "no".
 */
export function offers(capabilities: readonly string[] | null, name: string): boolean | null {
  return capabilities === null ? null : capabilities.includes(name);
}

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
/** `mode: "plan"` in chat sessions and its `plan-review` prompt. */
export const PLAN_MODE_CAPABILITY = "plan-mode";
/** `POST /v1/sessions/ID/undo` and `/redo` (Undo and Redo in chat). */
export const CHAT_UNDO_CAPABILITY = "chat-undo";
/** `GET|POST /v1/workflow/memory` (the Run memory section). */
export const RUN_MEMORY_CAPABILITY = "run-memory";
/** `images` on chat messages (paste and drop in the composer). */
export const IMAGES_CAPABILITY = "images";

/**
 * Whether a backend offers a capability: true or false from its health answer, null when the
 * health answer could not be read, so the caller has to try the endpoint and treat 404 as "no".
 */
export function offers(capabilities: readonly string[] | null, name: string): boolean | null {
  return capabilities === null ? null : capabilities.includes(name);
}

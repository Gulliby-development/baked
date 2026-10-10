/**
 * Capability groups of `GET /v1/health` (design/desktop-api.md, "Health and capabilities"). Kept
 * free of the bridge so tests can import it.
 */

/** `/v1/workflow/checks*`. */
export const CHECKS_CAPABILITY = "checks";
/** `/v1/commands` and `/v1/skills`. */
export const LIBRARY_CAPABILITY = "library";

/**
 * Whether a backend offers a capability: true or false from its health answer, null when the
 * health answer could not be read, so the caller has to try the endpoint and treat 404 as "no".
 */
export function offers(capabilities: readonly string[] | null, name: string): boolean | null {
  return capabilities === null ? null : capabilities.includes(name);
}

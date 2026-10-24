import { canonical } from "../specs/hash.js";
import type { RequestRow } from "./store.js";
import type { RuntimeState } from "./types.js";

/**
 * The request with the clarification answers a person gave. A bound or an exclusion a person
 * decided ("files up to 100 MiB") is stated, not invented by the spec author (#1413). The host
 * criterion decisions read it too, in the specify stage and when a revised spec is staged (#1964).
 */
export function statedRequest(
  state: Pick<RuntimeState, "requestText" | "prompt">,
  requests: readonly RequestRow[],
): string {
  const answers = requests
    .filter((r) => r.kind === "clarification" && r.status === "accepted" && r.actor === "user")
    // Only the answers: the decision's request id would add stray numbers.
    .map((r) =>
      canonical((JSON.parse(r.answer_json ?? "{}") as { answers?: unknown }).answers ?? ""),
    );
  return [state.requestText || state.prompt, ...answers].join("\n");
}

import { statedRequest } from "./stated-request.js";
import type { RequestRow } from "./store.js";
import type { RuntimeState } from "./types.js";

/**
 * The line of a feature prompt (`featurePrompt` in `initiatives/service.ts`) after which the
 * person's own request of the initiative begins. Everything before it is the host's framing.
 */
export const FEATURE_REQUEST_HEADING = "The original request of the initiative:";

/**
 * A run's request split into the host's framing and the person's words (#2492). A feature of an
 * initiative starts from a prompt the host composes: the feature's place in the split, its goals,
 * boundary, contract, skeleton, amendments, upstream contracts and the scope fence ("Other
 * features of the initiative own this work ..."), then the original request. Only the original
 * request is the person's. A run outside an initiative has no framing.
 */
export interface RequestSections {
  /** The host-composed lines of a feature prompt; empty outside an initiative. */
  framing: string;
  /** The person's words: the original request, with a person's accepted answers when read so. */
  person: string;
}

/**
 * Splits a request text into the host's framing and the person's request. A feature run's text
 * splits at the first line that is exactly `FEATURE_REQUEST_HEADING`: the host writes it once,
 * after every line it composes, so a request that repeats the heading keeps the repeat. Without
 * `feature` (a run outside an initiative) or without the heading, the whole text is the person's.
 */
export function requestSections(text: string, feature: boolean): RequestSections {
  if (!feature) return { framing: "", person: text };
  const lines = text.split("\n");
  const at = lines.indexOf(FEATURE_REQUEST_HEADING);
  if (at < 0) return { framing: "", person: text };
  return { framing: lines.slice(0, at).join("\n"), person: lines.slice(at + 1).join("\n") };
}

/**
 * The person's request with the clarification answers a person gave (`statedRequest`), and the
 * host's framing apart from it. The one source of the person's words for a decision that takes
 * the request as the person's authority over a run's own work (a spec conflict settled for the
 * request, the request re-audit's verified quotes, a documentation example the request gives):
 * a quote from the framing is the host's own wording, not the person's (#2492).
 */
export function personRequest(
  state: Pick<RuntimeState, "requestText" | "prompt" | "initiativeBounds">,
  requests: readonly RequestRow[],
): RequestSections {
  const sections = requestSections(state.requestText || state.prompt, !!state.initiativeBounds);
  return {
    framing: sections.framing,
    person: statedRequest({ requestText: sections.person, prompt: "" }, requests),
  };
}

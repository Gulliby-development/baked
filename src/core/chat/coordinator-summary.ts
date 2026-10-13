/**
 * The one-click "what's happening" digest of the project coordinator: a short coordinator turn
 * that answers in a fixed shape from project state, launched work and the brief. The desktop
 * Summary button, `POST /v1/coordinator/summary` and `/coordinator summary` in the terminal all
 * send the same prompt.
 */
import { ChatError, type ChatSession } from "./sessions.js";

/** The user message the conversation shows for a summary request. */
export const SUMMARY_DISPLAY = "What's happening?";

/** The digest's sections, in order. */
export const SUMMARY_SECTIONS = [
  "Running",
  "Waits for you",
  "Finished since the last summary",
  "Open questions",
] as const;

/** The prompt the coordinator gets for a summary. */
export function summaryPrompt(): string {
  return [
    "Give the user a short digest of what is happening in this project. Check project_state (start with its overview) and the launched work in your brief first; do not launch, split or edit anything in this turn.",
    `Answer with exactly these ${SUMMARY_SECTIONS.length} sections, each a bold heading followed by one line per item with its id and status:`,
    `1. **${SUMMARY_SECTIONS[0]}**: sessions, runs and initiatives still working.`,
    `2. **${SUMMARY_SECTIONS[1]}**: approvals, questions, failed or blocked work the user must act on.`,
    `3. **${SUMMARY_SECTIONS[2]}**: work that finished since your previous summary in this conversation, or recently when there is none.`,
    `4. **${SUMMARY_SECTIONS[3]}**: the open questions in the project brief.`,
    'Write "Nothing." under a section with no items. No other text before or after the sections.',
  ].join("\n");
}

/** Starts a summary turn on the coordinator, or queues it behind the running one. */
export function requestSummary(session: ChatSession): { turnId: string; queued: boolean } {
  if (!session.isCoordinator)
    throw new ChatError("INVALID_REQUEST", "Only the project coordinator gives a summary");
  return session.sendRequest(summaryPrompt(), SUMMARY_DISPLAY);
}

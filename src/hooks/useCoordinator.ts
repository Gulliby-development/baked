import { useEffect, useState } from "react";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import { ApprovalRulesStore } from "../core/chat/approval-rules.js";
import { LocalCoordinator } from "../core/chat/coordinator-host.js";
import type { LaunchedView } from "../core/chat/coordinator-launch.js";
import type { ChatPrompt, ChatSession, SessionState } from "../core/chat/sessions.js";
import type { ChatMessage } from "../types/index.js";
import { workflowSession } from "./useWorkflow.js";

/** The coordinator of each workspace, opened on first use and kept until the TUI exits. */
const opened = new Map<string, Promise<LocalCoordinator>>();

/** Opens the project's coordinator; runs it starts go through the TUI's workflow worker. */
export function coordinatorFor(workspace: string, model: () => string): Promise<LocalCoordinator> {
  let pending = opened.get(workspace);
  if (!pending) {
    pending = LocalCoordinator.open({
      workspace,
      config: mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace)),
      client: workflowSession(workspace),
      model,
    });
    opened.set(workspace, pending);
    // A failed open is tried again next time.
    pending.catch(() => opened.delete(workspace));
  }
  return pending;
}

/** Set by `/coordinator summary`: the view asks for a summary the next time it opens. */
let summaryOnOpen = false;

export function requestSummaryOnOpen(): void {
  summaryOnOpen = true;
}

/** Whether a summary was requested for this opening; clears the request. */
export function takeSummaryOnOpen(): boolean {
  const requested = summaryOnOpen;
  summaryOnOpen = false;
  return requested;
}

/** Interrupts and closes every open coordinator; called on exit. */
export async function stopCoordinators(): Promise<void> {
  const all = [...opened.values()];
  opened.clear();
  await Promise.allSettled(all.map(async (pending) => (await pending).close()));
}

/** What the coordinator view shows; refreshed on every event of the session. */
export interface CoordinatorSnapshot {
  messages: ChatMessage[];
  /** The text the running turn has streamed so far. */
  live: string;
  state: SessionState;
  prompts: ChatPrompt[];
  launched: LaunchedView[];
  /** How many approval rules answer approvals; 0 while the rules are off. */
  rulesOn?: number;
}

function snapshot(
  local: LocalCoordinator,
  session: ChatSession,
  live: string,
): CoordinatorSnapshot {
  return {
    messages: session.messages,
    live,
    state: session.state,
    prompts: session.pendingPrompts,
    launched: local.chat.launched(session.id),
    rulesOn: activeRules(local.chat.workspace, session.id),
  };
}

function activeRules(workspace: string, coordinatorId: string): number {
  const { enabled, rules } = new ApprovalRulesStore(workspace, coordinatorId).read();
  return enabled ? rules.length : 0;
}

/** Follows the coordinator session: its messages, streamed text, prompts and launched work. */
export function useCoordinatorSnapshot(local: LocalCoordinator | null): CoordinatorSnapshot | null {
  const [view, setView] = useState<CoordinatorSnapshot | null>(null);
  useEffect(() => {
    if (!local) {
      setView(null);
      return;
    }
    const session = local.session;
    let live = "";
    const refresh = (): void => setView(snapshot(local, session, live));
    refresh();
    const stop = session.subscribe(session.detail().lastSeq, (event) => {
      if (event.type === "turn-start") live = "";
      else if (event.type === "text") live += event.delta;
      else if (event.type === "turn-done") live = "";
      // A `launched` event carries the new view: statuses, a run's stage and its tasks.
      refresh();
    });
    return () => {
      stop?.();
    };
  }, [local]);
  return view;
}

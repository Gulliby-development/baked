/**
 * Session lifecycle hooks with the inputs Claude Code sends them: SessionStart, SessionEnd,
 * UserPromptSubmit, Stop and Notification. The terminal UI, the headless CLI and `baked serve` call
 * these, so a hook brought from Claude Code runs the same on every surface.
 */

import { hasHooksForEvent } from "./loader.js";
import { runHooks } from "./runner.js";
import type { HookResult } from "./types.js";

export type SessionStartSource = "startup" | "resume" | "clear" | "compact";
export type SessionEndReason = "clear" | "logout" | "prompt_input_exit" | "other";
/**
 * `permission_prompt`: a chat asks before it acts; `question`: a chat waits for an answer (a
 * question, a plan or a split to review); `run_attention`: a workflow run waits.
 */
export type NotificationType = "permission_prompt" | "question" | "run_attention";

/** Sessions this process started hooks for, with their workspace; SessionEnd fires once per start. */
const open = new Map<string, string>();
/** Context SessionStart hooks returned, for the session's next prompt. */
const pending = new Map<string, string[]>();

const OK: HookResult = { ok: true, blocked: false };

/**
 * Fires SessionStart (the matcher is tested against `source`). Context the hooks print is kept for
 * the session's next prompt (`takeHookContext`), as Claude Code adds it to the conversation.
 */
export async function startSessionHooks(
  sessionId: string,
  cwd: string,
  source: SessionStartSource,
): Promise<void> {
  open.set(sessionId, cwd);
  const result = await runHooks({
    event: "SessionStart",
    sessionId,
    cwd,
    matchTarget: source,
    fields: { source },
  });
  if (result.additionalContext)
    pending.set(sessionId, [...(pending.get(sessionId) ?? []), result.additionalContext]);
}

/** Whether SessionStart fired for the session in this process and SessionEnd has not. */
export function sessionHooksStarted(sessionId: string): boolean {
  return open.has(sessionId);
}

/** Fires SessionEnd for a session whose SessionStart fired in this process; once per start. */
export async function endSessionHooks(sessionId: string, reason: SessionEndReason): Promise<void> {
  const cwd = open.get(sessionId);
  if (cwd === undefined) return;
  open.delete(sessionId);
  pending.delete(sessionId);
  await runHooks({ event: "SessionEnd", sessionId, cwd, matchTarget: reason, fields: { reason } });
}

/** Fires SessionEnd for every session this process started, e.g. when it exits. */
export async function endAllSessionHooks(reason: SessionEndReason): Promise<void> {
  await Promise.all([...open.keys()].map((id) => endSessionHooks(id, reason)));
}

/** The context SessionStart hooks returned for the session, once; undefined when there is none. */
export function takeHookContext(sessionId: string): string | undefined {
  const parts = pending.get(sessionId);
  pending.delete(sessionId);
  return parts?.length ? parts.join("\n\n") : undefined;
}

/**
 * Fires UserPromptSubmit for a typed prompt whenever the event has hooks. A blocked result means
 * the prompt is not sent; `additionalContext` goes to the model with it.
 */
export async function userPromptHooks(
  sessionId: string,
  cwd: string,
  prompt: string,
  abortSignal?: AbortSignal,
): Promise<HookResult> {
  if (!hasHooksForEvent("UserPromptSubmit", cwd)) return OK;
  return runHooks({
    event: "UserPromptSubmit",
    sessionId,
    cwd,
    // `tool_input.prompt` is what BAKED sent before; `prompt` is Claude Code's field.
    toolInput: { prompt },
    fields: { prompt },
    ...(abortSignal ? { abortSignal } : {}),
  });
}

/**
 * The text a prompt is sent with: the context SessionStart and UserPromptSubmit hooks returned,
 * then the prompt.
 */
export function withHookContext(text: string, ...context: (string | undefined)[]): string {
  const parts = context.filter((c): c is string => Boolean(c));
  return parts.length ? `${parts.join("\n\n")}\n\n${text}` : text;
}

/** Fires Stop when a turn ends normally, StopFailure when it failed. */
export async function stopHooks(
  sessionId: string,
  cwd: string,
  outcome: { failed: false } | { failed: true; error: string },
): Promise<void> {
  if (outcome.failed)
    await runHooks({ event: "StopFailure", sessionId, cwd, toolInput: { error: outcome.error } });
  else await runHooks({ event: "Stop", sessionId, cwd, toolInput: { stop_hook_active: false } });
}

/** Fires Notification (the matcher is tested against `type`). */
export async function notificationHooks(notice: {
  sessionId?: string;
  cwd: string;
  type: NotificationType;
  message: string;
  title?: string;
}): Promise<void> {
  await runHooks({
    event: "Notification",
    ...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
    cwd: notice.cwd,
    matchTarget: notice.type,
    fields: {
      message: notice.message,
      notification_type: notice.type,
      ...(notice.title ? { title: notice.title } : {}),
    },
  });
}

/** Forgets started sessions; tests use it. */
export function resetSessionHooks(): void {
  open.clear();
  pending.clear();
}

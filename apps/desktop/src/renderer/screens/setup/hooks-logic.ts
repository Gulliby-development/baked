import {
  HOOK_EVENT_INFO,
  HOOK_PHASES,
  type HookEventInfo,
  type HookPhase,
  type HookPlatform,
  type HookTemplate,
  templateCommand,
} from "../../../../../../src/core/hooks/catalog.js";
import type {
  HookCommand,
  HookDraft,
  HookEvent,
  HooksView,
  HookWriteScope,
} from "../../client/setup.js";

/** The New hook / Edit hook form, as typed. */
export interface HookForm {
  event: string;
  matcher: string;
  command: string;
  /** Seconds as typed; empty keeps the default of 10. */
  timeout: string;
  async: boolean;
  once: boolean;
  if: string;
  scope: HookWriteScope;
}

export const BLANK_FORM: HookForm = {
  event: "PreToolUse",
  matcher: "",
  command: "",
  timeout: "",
  async: false,
  once: false,
  if: "",
  scope: "project",
};

export function formFromTemplate(template: HookTemplate, platform: HookPlatform): HookForm {
  return {
    ...BLANK_FORM,
    event: template.event,
    matcher: template.matcher ?? "",
    command: templateCommand(template, platform),
    timeout: template.timeout ? String(template.timeout) : "",
    async: template.async === true,
    if: template.if ?? "",
  };
}

/** The form for a listed hook; an imported one is copied into the project's BAKED file. */
export function formFromHook(event: string, hook: HookCommand): HookForm {
  return {
    event,
    matcher: hook.matcher ?? "",
    command: hook.command,
    timeout: hook.timeout === null ? "" : String(hook.timeout),
    async: hook.async,
    once: hook.once,
    if: hook.if ?? "",
    scope: hook.origin === "baked" && hook.scope !== "local" ? hook.scope : "project",
  };
}

/** Why the form cannot be saved yet, or null. */
export function formProblem(form: HookForm): string | null {
  if (!form.command.trim()) return "Add the command to run.";
  const timeout = form.timeout.trim();
  if (timeout && !/^\d+$/.test(timeout)) return "The timeout is a whole number of seconds.";
  if (timeout && (Number(timeout) < 1 || Number(timeout) > 3600))
    return "The timeout is from 1 to 3600 seconds.";
  const matcher = form.matcher.trim();
  if (matcher && !/^[\w|*]*$/.test(matcher)) {
    try {
      new RegExp(matcher);
    } catch {
      return "The matcher is not a valid regular expression.";
    }
  }
  return null;
}

/**
 * The request body for a form. `keepCommand` leaves the command out so the backend keeps the
 * stored one: an edit of a hook whose command the view shows with a secret redacted.
 */
export function draftOf(form: HookForm, keepCommand = false): HookDraft {
  const info = eventInfo(form.event);
  const text = (value: string) => value.trim() || null;
  return {
    event: form.event,
    matcher: info?.matcher ? text(form.matcher) : null,
    ...(keepCommand ? {} : { command: form.command.trim() }),
    timeout: form.timeout.trim() ? Number(form.timeout) : null,
    async: form.async,
    once: form.once,
    if: info?.matcher?.target === "tool name" ? text(form.if) : null,
    scope: form.scope,
  };
}

/** The entry the form adds to `.baked/config.json`, as the file will hold it. */
export function jsonPreview(form: HookForm): string {
  const draft = draftOf(form);
  const hook: Record<string, unknown> = { type: "command", command: draft.command ?? "" };
  if (draft.timeout !== null) hook.timeout = draft.timeout;
  if (draft.async) hook.async = true;
  if (draft.once) hook.once = true;
  if (draft.if) hook.if = draft.if;
  const rule = draft.matcher ? { matcher: draft.matcher, hooks: [hook] } : { hooks: [hook] };
  return JSON.stringify({ hooks: { [draft.event]: [rule] } }, null, 2);
}

export function eventInfo(event: string): HookEventInfo | undefined {
  return HOOK_EVENT_INFO.find((info) => info.event === event);
}

/** Events a new hook can use: the ones BAKED fires. */
export const PICKABLE_EVENTS = HOOK_EVENT_INFO.filter((info) => info.fires);

export interface TimelineEvent {
  info: HookEventInfo;
  /** The listed event, when it has hooks. */
  view: HookEvent | null;
}

export interface TimelinePhase {
  id: HookPhase;
  title: string;
  events: TimelineEvent[];
}

/**
 * Every event in session order, grouped by phase, with its listed hooks. An event BAKED does not
 * fire is shown only when it has hooks, so its hooks are not hidden; an event the catalog does not
 * know (a typo in a file) is listed last.
 */
export function timeline(view: HooksView): { phases: TimelinePhase[]; unknown: HookEvent[] } {
  const byName = new Map(view.events.map((e) => [e.event, e]));
  const phases = HOOK_PHASES.map(({ id, title }) => ({
    id,
    title,
    events: HOOK_EVENT_INFO.filter((info) => info.phase === id)
      .map((info) => ({ info, view: byName.get(info.event) ?? null }))
      .filter((e) => e.info.fires || (e.view?.hooks.length ?? 0) > 0),
  })).filter((phase) => phase.events.length > 0);
  const unknown = view.events.filter((e) => !eventInfo(e.event));
  return { phases, unknown };
}

/** "3 hooks · 2 in BAKED · 1 imported", for the summary line. */
export function hookCounts(view: HooksView): { total: number; baked: number; imported: number } {
  let baked = 0;
  let imported = 0;
  for (const event of view.events)
    for (const hook of event.hooks) {
      if (hook.origin === "baked") baked++;
      else imported++;
    }
  return { total: baked + imported, baked, imported };
}

/** Stable keys for a hook list; a file may list the same command twice. */
export function keyed(hooks: HookCommand[]): [string, HookCommand][] {
  const seen = new Map<string, number>();
  return hooks.map((hook) => {
    const base = hook.id ?? [hook.source, hook.matcher, hook.if, hook.command].join("\0");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [`${base}\0${count}`, hook];
  });
}

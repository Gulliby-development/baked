/**
 * A read-only view of the configured hooks, per event and per source file, with the events
 * switched off for this process. The local API (`GET /v1/hooks`) serves it to the desktop app;
 * the terminal UI's `/hooks` picker shows the same events. Hooks are only listed here: they are
 * created and edited in their config files, never through this view.
 */
import { redactSecrets } from "../workflows/redaction.js";
import { type HookSourceScope, readHookSources } from "./loader.js";
import { disableHookEvent, enableHookEvent, isHookEventDisabled } from "./runner.js";
import { HOOK_EVENTS, type HookEventName } from "./types.js";

export interface HookCommandView {
  /** The file that defines it. */
  source: string;
  scope: HookSourceScope;
  matcher: string | null;
  /** The command, with the values of secret environment variables redacted. */
  command: string;
  async: boolean;
  once: boolean;
  timeout: number | null;
  if: string | null;
}

export interface HookEventView {
  event: string;
  /** Whether the event is a lifecycle event BAKED fires; unknown names never run. */
  known: boolean;
  /** Switched off for this process only (`/hooks`, or `POST /v1/hooks/session`). */
  disabled: boolean;
  /** Whether a hook of this event waits for its command before the agent continues. */
  blocking: boolean;
  hooks: HookCommandView[];
}

export interface HooksOverview {
  /** The file that sets `disableAllHooks: true`, if any: then no hook runs. */
  disabledBy: string | null;
  sources: { path: string; scope: HookSourceScope; exists: boolean; hooks: number }[];
  events: HookEventView[];
}

export function isHookEventName(name: string): name is HookEventName {
  return (HOOK_EVENTS as readonly string[]).includes(name);
}

/** The hooks configured for `cwd`, grouped by event in lifecycle order. */
export function hooksOverview(cwd: string): HooksOverview {
  const sources = readHookSources(cwd);
  const byEvent = new Map<string, HookCommandView[]>();
  for (const source of sources) {
    for (const [event, rules] of Object.entries(source.hooks)) {
      const list = byEvent.get(event) ?? [];
      for (const rule of rules) {
        for (const hook of rule.hooks) {
          list.push({
            source: source.path,
            scope: source.scope,
            matcher: typeof rule.matcher === "string" && rule.matcher ? rule.matcher : null,
            command: redactSecrets(typeof hook.command === "string" ? hook.command : ""),
            async: hook.async === true,
            once: hook.once === true,
            timeout: typeof hook.timeout === "number" ? hook.timeout : null,
            if: typeof hook.if === "string" ? hook.if : null,
          });
        }
      }
      byEvent.set(event, list);
    }
  }
  const order = (event: string): number => {
    const index = (HOOK_EVENTS as readonly string[]).indexOf(event);
    return index < 0 ? HOOK_EVENTS.length : index;
  };
  const events = [...byEvent.entries()]
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
    .map(([event, hooks]) => ({
      event,
      known: isHookEventName(event),
      disabled: isHookEventDisabled(event),
      blocking: hooks.some((h) => !h.async),
      hooks,
    }));
  return {
    disabledBy: sources.find((s) => s.disablesAll)?.path ?? null,
    sources: sources.map((s) => ({
      path: s.path,
      scope: s.scope,
      exists: s.exists,
      hooks: Object.values(s.hooks).reduce(
        (sum, rules) => sum + rules.reduce((n, rule) => n + rule.hooks.length, 0),
        0,
      ),
    })),
    events,
  };
}

/**
 * Switches an event's hooks on or off for this process only, as `/hooks` does. Nothing is
 * written to a config file; a restart runs every configured hook again.
 */
export function setHookEventEnabled(event: HookEventName, enabled: boolean): void {
  if (enabled) enableHookEvent(event);
  else disableHookEvent(event);
}

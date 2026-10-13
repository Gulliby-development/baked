/**
 * Creates, changes and removes hooks in BAKED's own config files (`.baked/config.json` of the
 * project or the home folder). Claude Code's `.claude/settings*.json` files are read, never
 * written: their hooks stay as the user wrote them. Every other key of a config file is kept.
 *
 * A hook is addressed by an id (`<scope>:<event>:<rule>:<hook>`, its position in its file) and a
 * revision (a hash of its rule's matcher and the hook itself), so a change made against a file
 * that someone edited in the meantime fails with a conflict instead of changing another hook.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { bakedHooksPath, invalidateHooksCache } from "./loader.js";
import { type CommandHook, HOOK_EVENTS, type HookEventName, type HookRule } from "./types.js";

/** The BAKED config a hook is saved to: the project's, or the home folder's for every project. */
export type HookWriteScope = "project" | "user";

/** What a person fills in for a hook. Empty strings and nulls mean "not set". */
export interface HookDraft {
  event: HookEventName;
  matcher?: string | null;
  command: string;
  /** Seconds; null keeps the runner's default. */
  timeout?: number | null;
  async?: boolean;
  once?: boolean;
  if?: string | null;
}

/** A change to an existing hook; `command` left out keeps the stored one (the view redacts it). */
export interface HookChange extends Omit<HookDraft, "command"> {
  command?: string;
  /** Moves the hook to the other BAKED file; left out keeps it where it is. */
  scope?: HookWriteScope;
}

export class HookEditError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "not-found" | "conflict",
  ) {
    super(message);
    this.name = "HookEditError";
  }
}

export const MAX_HOOK_TIMEOUT = 3600;

/** The id of the hook at `rule`/`hook` of `event` in the BAKED file of `scope`. */
export function hookId(scope: HookWriteScope, event: string, rule: number, hook: number): string {
  return `${scope}:${event}:${rule}:${hook}`;
}

/** The revision of a hook: changes whenever its rule's matcher or the hook itself changes. */
export function hookRevision(matcher: unknown, hook: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([matcher ?? null, hook]))
    .digest("hex")
    .slice(0, 16);
}

type ConfigObject = Record<string, unknown> & { hooks?: Record<string, unknown> };

function readConfig(file: string): ConfigObject {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new HookEditError(`${file} is not valid JSON; fix it before saving a hook`, "invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HookEditError(`${file} does not hold a JSON object`, "invalid");
  const config = parsed as ConfigObject;
  if (
    config.hooks !== undefined &&
    (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks))
  )
    throw new HookEditError(`"hooks" in ${file} is not an object`, "invalid");
  return config;
}

function writeConfig(file: string, config: ConfigObject): void {
  if (config.hooks && Object.values(config.hooks).every((rules) => rules === undefined))
    config.hooks = undefined;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  invalidateHooksCache();
}

function rulesOf(config: ConfigObject, event: string): HookRule[] {
  const rules = config.hooks?.[event];
  return Array.isArray(rules) ? (rules as HookRule[]) : [];
}

const text = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function checkMatcher(matcher: string | undefined): void {
  // Matchers with characters other than letters, digits, `_` and `|` run as regular expressions.
  if (!matcher || /^[\w|*]*$/.test(matcher)) return;
  try {
    new RegExp(matcher);
  } catch {
    throw new HookEditError(
      `The matcher "${matcher}" is not a valid regular expression`,
      "invalid",
    );
  }
}

function checkEvent(event: string): asserts event is HookEventName {
  if (!(HOOK_EVENTS as readonly string[]).includes(event))
    throw new HookEditError(`BAKED never fires the event "${event}"`, "invalid");
}

/** The handler a draft describes, on top of `base` so keys the form does not show are kept. */
function handlerOf(draft: Omit<HookDraft, "event">, base: Partial<CommandHook> = {}): CommandHook {
  const command = text(draft.command);
  if (!command) throw new HookEditError("A hook needs a command", "invalid");
  const timeout = draft.timeout ?? undefined;
  if (
    timeout !== undefined &&
    (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_HOOK_TIMEOUT)
  )
    throw new HookEditError(
      `The timeout is a whole number of seconds from 1 to ${MAX_HOOK_TIMEOUT}`,
      "invalid",
    );
  const next: CommandHook = { ...base, type: "command", command };
  next.timeout = undefined;
  next.async = undefined;
  next.once = undefined;
  next.if = undefined;
  if (timeout !== undefined) next.timeout = timeout;
  if (draft.async) next.async = true;
  if (draft.once) next.once = true;
  const condition = text(draft.if);
  if (condition) next.if = condition;
  return next;
}

function appendRule(
  config: ConfigObject,
  event: string,
  matcher: string | undefined,
  hook: CommandHook,
): void {
  const rule: HookRule = matcher ? { matcher, hooks: [hook] } : { hooks: [hook] };
  config.hooks = { ...config.hooks, [event]: [...rulesOf(config, event), rule] };
}

/** Adds a hook to the BAKED config of `scope`. */
export function addHook(cwd: string, scope: HookWriteScope, draft: HookDraft): void {
  checkEvent(draft.event);
  const matcher = text(draft.matcher);
  checkMatcher(matcher);
  const hook = handlerOf(draft);
  const file = bakedHooksPath(cwd, scope);
  const config = readConfig(file);
  appendRule(config, draft.event, matcher, hook);
  writeConfig(file, config);
}

interface Located {
  scope: HookWriteScope;
  file: string;
  config: ConfigObject;
  event: string;
  rule: number;
  hook: number;
  rules: HookRule[];
  handler: CommandHook;
}

function locate(cwd: string, id: string, revision: string): Located {
  const match = /^(project|user):([^:]+):(\d+):(\d+)$/.exec(id);
  if (!match) throw new HookEditError(`"${id}" is not a hook id`, "not-found");
  const [, scope, event, ruleText, hookText] = match as unknown as [
    string,
    HookWriteScope,
    string,
    string,
    string,
  ];
  const file = bakedHooksPath(cwd, scope);
  const config = readConfig(file);
  const rules = rulesOf(config, event);
  const rule = Number(ruleText);
  const hook = Number(hookText);
  const found = rules[rule];
  const handler = Array.isArray(found?.hooks) ? found.hooks[hook] : undefined;
  if (!found || !handler) throw new HookEditError("The hook is no longer in its file", "not-found");
  if (hookRevision(found.matcher, handler) !== revision)
    throw new HookEditError(
      "The hook changed in its file since this view was loaded; reload and try again",
      "conflict",
    );
  return { scope, file, config, event, rule, hook, rules, handler };
}

/** Drops the hook from its rule, the rule when it is left empty, and the event when it has none. */
function removeAt(at: Located): void {
  const rule = at.rules[at.rule] as HookRule;
  rule.hooks.splice(at.hook, 1);
  if (rule.hooks.length === 0) at.rules.splice(at.rule, 1);
  const hooks = at.config.hooks as Record<string, unknown>;
  if (at.rules.length === 0) delete hooks[at.event];
  else hooks[at.event] = at.rules;
}

/** Changes the hook `id`; fails with a conflict when its file changed since `revision`. */
export function updateHook(cwd: string, id: string, revision: string, change: HookChange): void {
  checkEvent(change.event);
  const at = locate(cwd, id, revision);
  const matcher = text(change.matcher);
  checkMatcher(matcher);
  const hook = handlerOf({ ...change, command: change.command ?? at.handler.command }, at.handler);
  const rule = at.rules[at.rule] as HookRule;
  const scope = change.scope ?? at.scope;
  const target = bakedHooksPath(cwd, scope);
  if (
    target === at.file &&
    change.event === at.event &&
    (text(rule.matcher) ?? undefined) === matcher
  ) {
    rule.hooks[at.hook] = hook;
    writeConfig(at.file, at.config);
    return;
  }
  removeAt(at);
  if (target === at.file) {
    appendRule(at.config, change.event, matcher, hook);
    writeConfig(at.file, at.config);
    return;
  }
  const next = readConfig(target);
  appendRule(next, change.event, matcher, hook);
  writeConfig(target, next);
  writeConfig(at.file, at.config);
}

/** Removes the hook `id`; fails with a conflict when its file changed since `revision`. */
export function removeHook(cwd: string, id: string, revision: string): void {
  const at = locate(cwd, id, revision);
  removeAt(at);
  writeConfig(at.file, at.config);
}

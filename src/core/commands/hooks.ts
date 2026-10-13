/**
 * `/hooks`: the hooks of the project on the agent's events, as the desktop Hooks screen shows
 * them. Hooks in BAKED's own config files are added, edited and deleted here; Claude Code's
 * `.claude` files are read-only and their hooks can be copied into BAKED. An event can be paused
 * for this session. The data is src/core/hooks/overview.ts and edit.ts, the words catalog.ts.
 */
import { confirm, openSelect, promptText } from "../../components/ui/dialogs/index.js";
import {
  HOOK_EVENT_INFO,
  HOOK_PHASES,
  HOOK_TEMPLATES,
  type HookPlatform,
  hookEventInfo,
  templateCommand,
} from "../hooks/catalog.js";
import { addHook, type HookDraft, HookEditError, removeHook, updateHook } from "../hooks/edit.js";
import {
  type HookCommandView,
  type HooksOverview,
  hooksOverview,
  setHookEventEnabled,
} from "../hooks/overview.js";
import type { HookEventName } from "../hooks/types.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

type Form = HookDraft & { scope: "project" | "user" };

const SCOPE = { user: "home folder", project: "this project", local: "local" } as const;

const platform: HookPlatform =
  process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux";

export function describeHook(hook: HookCommandView): string {
  const parts = [
    hook.matcher && `for ${hook.matcher}`,
    hook.if && `if ${hook.if}`,
    hook.async ? "background" : `waits up to ${hook.timeout ?? 10}s`,
    hook.once && "once",
    hook.origin === "baked"
      ? `BAKED, ${SCOPE[hook.scope]}`
      : `Claude Code, ${SCOPE[hook.scope]}, read-only`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Asks for each field in turn, starting from `start`; null when a step is cancelled. */
async function askForm(start: Form, fixedEvent: boolean): Promise<Form | null> {
  let event = start.event;
  if (!fixedEvent) {
    const picked = await openSelect<HookEventName>({
      title: "When should it run?",
      current: event,
      options: HOOK_EVENT_INFO.filter((info) => info.fires).map((info) => ({
        value: info.event,
        label: info.title,
        meta: info.event,
        description: info.summary,
        category: HOOK_PHASES.find((p) => p.id === info.phase)?.title,
      })),
    });
    if (!picked) return null;
    event = picked.value;
  }
  const info = hookEventInfo(event);
  let matcher = start.matcher ?? "";
  if (info?.matcher) {
    const typed = await promptText({
      title: `Only for these ${info.matcher.target}s`,
      message: `Empty runs it for every ${info.matcher.target}. For example: ${info.matcher.examples.join(", ")}`,
      placeholder: info.matcher.examples[0],
      initial: matcher,
    });
    if (typed === null) return null;
    matcher = typed.trim();
  } else matcher = "";
  const command = await promptText({
    title: "Command to run",
    message: "Runs in the project folder with the event as JSON on stdin. Exit 2 blocks.",
    initial: start.command,
    validate: (value) => (value.trim() ? null : "Add the command to run."),
  });
  if (command === null) return null;
  const wait = await openSelect<"wait" | "background">({
    title: "Wait for it?",
    skipFilter: true,
    current: start.async ? "background" : "wait",
    options: [
      {
        value: "wait",
        label: "Wait",
        description: info?.blocks ?? "The agent waits until it ends or times out.",
      },
      {
        value: "background",
        label: "Run in the background",
        description: "The agent goes on; the hook cannot stop anything.",
      },
    ],
  });
  if (!wait) return null;
  const scope = await openSelect<"project" | "user">({
    title: "Save to",
    skipFilter: true,
    current: start.scope,
    options: [
      { value: "project", label: "This project", description: ".baked/config.json" },
      { value: "user", label: "All my projects", description: "~/.baked/config.json" },
    ],
  });
  if (!scope) return null;
  return {
    ...start,
    event,
    matcher: matcher || null,
    command: command.trim(),
    async: wait.value === "background",
    if: info?.matcher?.target === "tool name" ? start.if : null,
    scope: scope.value,
  };
}

function formOf(event: HookEventName, hook: HookCommandView): Form {
  return {
    event,
    matcher: hook.matcher,
    command: hook.command,
    timeout: hook.timeout,
    async: hook.async,
    once: hook.once,
    if: hook.if,
    scope: hook.origin === "baked" && hook.scope === "user" ? "user" : "project",
  };
}

const BLANK: Form = {
  event: "PreToolUse",
  matcher: null,
  command: "",
  timeout: null,
  async: false,
  once: false,
  if: null,
  scope: "project",
};

/** Runs a write and reports it; a refused write is shown, not thrown. */
function save(ctx: CommandContext, work: () => void, done: string): void {
  try {
    work();
    sysMsg(ctx, done);
  } catch (error) {
    if (!(error instanceof HookEditError)) throw error;
    sysMsg(ctx, `Hook not saved: ${error.message}`);
  }
}

async function newHook(ctx: CommandContext, event?: HookEventName): Promise<void> {
  let start: Form = event ? { ...BLANK, event } : BLANK;
  if (!event) {
    const picked = await openSelect<string>({
      title: "New hook",
      options: [
        ...HOOK_TEMPLATES.map((t) => ({
          value: t.id,
          label: t.title,
          description: t.description,
          meta: t.event,
          category: "Templates",
        })),
        { value: "", label: "Blank hook", description: "Pick every field yourself." },
      ],
    });
    if (!picked) return;
    const template = HOOK_TEMPLATES.find((t) => t.id === picked.value);
    if (template)
      start = {
        ...BLANK,
        event: template.event,
        matcher: template.matcher ?? null,
        command: templateCommand(template, platform),
        timeout: template.timeout ?? null,
        async: template.async === true,
        if: template.if ?? null,
      };
  }
  const form = await askForm(start, event !== undefined);
  if (!form) return;
  const { scope, ...draft } = form;
  save(ctx, () => addHook(ctx.cwd, scope, draft), `Hook added to ${form.event}.`);
}

async function hookMenu(
  ctx: CommandContext,
  event: HookEventName,
  hook: HookCommandView,
): Promise<void> {
  if (hook.origin !== "baked" || !hook.id || !hook.rev) {
    const copy = await confirm({
      title: "Imported from Claude Code",
      message: `BAKED never changes ${hook.source}. Copy this hook into BAKED's config to edit it?`,
    });
    if (!copy) return;
    const form = await askForm(formOf(event, hook), false);
    if (!form) return;
    const { scope, ...draft } = form;
    save(ctx, () => addHook(ctx.cwd, scope, draft), `Hook copied into BAKED (${form.event}).`);
    return;
  }
  const { id, rev } = hook;
  const action = await openSelect<"edit" | "delete">({
    title: hook.command,
    skipFilter: true,
    options: [
      { value: "edit", label: "Edit", description: describeHook(hook) },
      { value: "delete", label: "Delete", description: hook.source },
    ],
  });
  if (!action) return;
  if (action.value === "delete") {
    const yes = await confirm({
      title: "Delete this hook?",
      message: `${hook.command} stops running at ${event}.`,
      danger: true,
    });
    if (yes) save(ctx, () => removeHook(ctx.cwd, id, rev), "Hook deleted.");
    return;
  }
  const form = await askForm(formOf(event, hook), false);
  if (!form) return;
  // A command shown with a secret redacted and left as it was keeps the stored value.
  const keep = hook.redacted && form.command === hook.command;
  const { command, ...rest } = form;
  save(ctx, () => updateHook(ctx.cwd, id, rev, keep ? rest : { ...rest, command }), "Hook saved.");
}

async function eventMenu(ctx: CommandContext, view: HooksOverview, event: HookEventName) {
  const listed = view.events.find((e) => e.event === event);
  const info = hookEventInfo(event);
  type Pick = { kind: "toggle" } | { kind: "add" } | { kind: "hook"; index: number };
  const picked = await openSelect<Pick>({
    title: info ? `${info.title} (${event})` : event,
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    options: [
      ...(info?.fires && listed?.hooks.length
        ? [
            {
              value: { kind: "toggle" } as Pick,
              label: listed.disabled ? "Resume these hooks" : "Pause for this session",
              description: "Lasts until BAKED restarts; no file changes.",
            },
          ]
        : []),
      ...(info?.fires
        ? [{ value: { kind: "add" } as Pick, label: "Add a hook here", description: info.summary }]
        : []),
      ...(listed?.hooks ?? []).map((hook, index) => ({
        value: { kind: "hook", index } as Pick,
        label: hook.command,
        description: describeHook(hook),
        category: "Hooks",
      })),
    ],
  });
  if (!picked) return;
  if (picked.value.kind === "toggle") {
    setHookEventEnabled(event, listed?.disabled === true);
    sysMsg(ctx, `${event} hooks ${listed?.disabled ? "resumed" : "paused for this session"}.`);
  } else if (picked.value.kind === "add") await newHook(ctx, event);
  else {
    const hook = listed?.hooks[picked.value.index];
    if (hook) await hookMenu(ctx, event, hook);
  }
}

async function hooksMenu(ctx: CommandContext): Promise<void> {
  const view = hooksOverview(ctx.cwd);
  if (view.disabledBy) sysMsg(ctx, `No hook runs: ${view.disabledBy} sets disableAllHooks.`);
  const byEvent = new Map(view.events.map((e) => [e.event, e]));
  const picked = await openSelect<string>({
    title: "Hooks",
    placeholder: "Commands that run at the agent's events",
    options: [
      {
        value: "",
        label: "New hook",
        description: "Start from a template or a blank hook.",
        icon: "+",
      },
      ...HOOK_EVENT_INFO.filter((info) => info.fires || byEvent.has(info.event)).map((info) => {
        const listed = byEvent.get(info.event);
        const count = listed?.hooks.length ?? 0;
        return {
          value: info.event,
          label: info.title,
          meta: info.event,
          description: [
            count ? `${count} ${count === 1 ? "hook" : "hooks"}` : "no hooks",
            listed?.disabled && "paused",
            !info.fires && "runs only in Claude Code",
          ]
            .filter(Boolean)
            .join(" · "),
          category: HOOK_PHASES.find((p) => p.id === info.phase)?.title,
          active: count > 0,
        };
      }),
    ],
  });
  if (!picked) return;
  if (picked.value === "") await newHook(ctx);
  else await eventMenu(ctx, view, picked.value as HookEventName);
}

function handleHooks(_input: string, ctx: CommandContext): void {
  void hooksMenu(ctx);
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/hooks", handleHooks);
}

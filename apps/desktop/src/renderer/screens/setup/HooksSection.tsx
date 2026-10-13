import { useEffect, useRef, useState } from "react";
import type { HookPhase, HookPlatform } from "../../../../../../src/core/hooks/catalog.js";
import { bridge } from "../../client/bridge.js";
import { type HookCommand, type HooksView, setup } from "../../client/setup.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Switch } from "../../components/ui/switch.js";
import { Tooltip } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import { HookDialog, type HookDialogState } from "./HookDialog.js";
import {
  BLANK_FORM,
  draftOf,
  formFromHook,
  type HookForm,
  hookCounts,
  keyed,
  type TimelineEvent,
  timeline,
} from "./hooks-logic.js";
import { errorText, LINE, LIST, LoadState, NOTE, SETUP, useLoad, WRAP } from "./shared.js";

const PHASE_ICON: Record<HookPhase, IconName> = {
  start: "chat",
  tools: "shell",
  subagents: "agents",
  context: "compact",
  finish: "ok",
  runs: "runs",
};

const SCOPE_LABEL = { user: "home folder", project: "this project", local: "local" } as const;
/** A badge that explains itself on hover or focus. */
const TIP =
  "inline-flex cursor-help rounded-full border-0 bg-transparent p-0 focus-visible:outline-2 focus-visible:outline-ring";
const RISE = "animate-rise motion-reduce:animate-none";
const META =
  "inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-background px-2 py-px font-mono text-[11px] text-soft-foreground";

const platform: HookPlatform =
  bridge.platform === "win32" || bridge.platform === "darwin" ? bridge.platform : "linux";

/** What identifies a hook across reloads, to light up the one just saved. */
const signature = (event: string, hook: HookCommand) =>
  [event, hook.source, hook.matcher, hook.command].join("\0");

function signatures(view: HooksView): Set<string> {
  return new Set(view.events.flatMap((e) => e.hooks.map((h) => signature(e.event, h))));
}

function SourceBadge({ hook }: { hook: HookCommand }) {
  const baked = hook.origin === "baked";
  return (
    <Tooltip
      content={
        <span className="flex flex-col gap-1">
          <span className="font-mono wrap-anywhere">{hook.source}</span>
          <span className="text-muted-foreground">
            {baked
              ? "Saved in BAKED's config: edit or delete it here."
              : "Imported from Claude Code. BAKED runs it but never changes .claude files: edit that file, or copy the hook into BAKED."}
          </span>
        </span>
      }
    >
      <button type="button" className={cn(TIP, "ml-auto")}>
        <Badge tone={baked ? "accent" : "neutral"} className="normal-case tracking-normal">
          {baked ? "BAKED" : "Claude Code"} · {SCOPE_LABEL[hook.scope]}
          {!baked && " · read-only"}
        </Badge>
      </button>
    </Tooltip>
  );
}

function HookCard({
  hook,
  index,
  fresh,
  canEdit,
  onEdit,
  onCopy,
  onDelete,
}: {
  hook: HookCommand;
  index: number;
  fresh: boolean;
  canEdit: boolean;
  onEdit: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const baked = hook.origin === "baked" && hook.id !== null;
  return (
    <li
      style={{ animationDelay: fresh ? undefined : `${index * 35}ms` }}
      className={cn(
        "overflow-hidden rounded-base border-2 border-border bg-background shadow-sm-hard",
        fresh ? "animate-station-lit motion-reduce:animate-none" : RISE,
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2.5">
        <code className={cn("min-w-0 flex-1 pt-1 font-mono text-[13px] text-foreground", WRAP)}>
          {hook.command}
        </code>
        {canEdit && baked && (
          <span className="flex shrink-0 gap-1">
            <Tooltip content="Edit">
              <Button variant="ghost" size="icon-sm" aria-label="Edit hook" onClick={onEdit}>
                <Icon name="edit" />
              </Button>
            </Tooltip>
            <Tooltip content="Delete">
              <Button variant="ghost" size="icon-sm" aria-label="Delete hook" onClick={onDelete}>
                <Icon name="delete" />
              </Button>
            </Tooltip>
          </span>
        )}
        {canEdit && !baked && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onCopy}>
            Copy to BAKED
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t-2 border-border bg-secondary-background px-3 py-1.5">
        {hook.matcher && <span className={META}>for {hook.matcher}</span>}
        {hook.if && <span className={META}>if {hook.if}</span>}
        <span className={META}>
          {hook.async ? "background" : `waits up to ${hook.timeout ?? 10}s`}
        </span>
        {hook.async && hook.timeout !== null && (
          <span className={META}>timeout {hook.timeout}s</span>
        )}
        {hook.once && <span className={META}>once per session</span>}
        <SourceBadge hook={hook} />
      </div>
    </li>
  );
}

function EventNode({
  item,
  fresh,
  canEdit,
  busy,
  onAdd,
  onToggle,
  onEdit,
  onCopy,
  onDelete,
}: {
  item: TimelineEvent;
  fresh: Set<string>;
  canEdit: boolean;
  busy: boolean;
  onAdd: () => void;
  onToggle: (enabled: boolean) => void;
  onEdit: (hook: HookCommand) => void;
  onCopy: (hook: HookCommand) => void;
  onDelete: (hook: HookCommand) => void;
}) {
  const { info, view } = item;
  const hooks = view?.hooks ?? [];
  const active = hooks.length > 0;
  const paused = view?.disabled === true;
  const lit = hooks.some((h) => fresh.has(signature(info.event, h)));
  return (
    <li className={cn("group/event relative flex flex-col gap-2", active ? "py-2" : "py-1")}>
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[13px] -left-[27px] size-3 rounded-full border-2 border-border transition-colors duration-200",
          !active && "bg-secondary-background",
          active && !paused && info.fires && "bg-main",
          active && (paused || !info.fires) && "bg-fill-warn",
          lit && "animate-pulse-dot motion-reduce:animate-none",
        )}
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          className={cn(
            "m-0 text-[14px]",
            active ? "font-bold text-foreground" : "font-semibold text-soft-foreground",
          )}
        >
          {info.title}
        </h3>
        <code className="font-mono text-[11px] text-dim-foreground">{info.event}</code>
        {info.blocks && active && (
          <Tooltip content={info.blocks}>
            <button type="button" className={TIP}>
              <Badge tone="info" className="normal-case tracking-normal">
                can block
              </Badge>
            </button>
          </Tooltip>
        )}
        {paused && (
          <Badge tone="warn" className="normal-case tracking-normal">
            paused
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          {active && info.fires && (
            <Tooltip
              content={
                paused
                  ? "Paused until this project's backend restarts. No file changes."
                  : "Pause these hooks until this project's backend restarts. No file changes."
              }
            >
              <Switch
                checked={!paused}
                disabled={busy}
                aria-label={`${paused ? "Resume" : "Pause"} ${info.event} hooks`}
                onCheckedChange={(next) => onToggle(next)}
              />
            </Tooltip>
          )}
          {canEdit && info.fires && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Add a hook to ${info.event}`}
              className={cn(
                "transition-opacity duration-150 motion-reduce:transition-none",
                !active &&
                  "opacity-0 group-focus-within/event:opacity-100 group-hover/event:opacity-100",
              )}
              onClick={onAdd}
            >
              <Icon name="new" size={13} /> Add
            </Button>
          )}
        </span>
      </div>
      <p
        className={cn(
          "m-0 max-w-[760px] text-[12px]",
          active ? "text-muted-foreground" : "text-dim-foreground",
        )}
      >
        {info.summary}
      </p>
      {active && !info.fires && (
        <p className={cn(NOTE, "m-0 text-[var(--warn)]")}>
          BAKED does not fire {info.event}, so these hooks run only in Claude Code.
        </p>
      )}
      {active && (
        <ul className={cn("m-0 flex list-none flex-col gap-2.5 p-0", paused && "opacity-60")}>
          {keyed(hooks).map(([key, hook], index) => (
            <HookCard
              key={key}
              hook={hook}
              index={index}
              fresh={fresh.has(signature(info.event, hook))}
              canEdit={canEdit}
              onEdit={() => onEdit(hook)}
              onCopy={() => onCopy(hook)}
              onDelete={() => onDelete(hook)}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function Sources({ view }: { view: HooksView }) {
  const [open, setOpen] = useState(false);
  const targets = new Set([view.targets.project, view.targets.user]);
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          LABEL,
          "flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 hover:text-foreground",
        )}
      >
        <Icon
          name="chevron-right"
          size={12}
          className={cn("transition-transform duration-150", open && "rotate-90")}
        />
        Where hooks come from
      </button>
      {open && (
        <ul className={cn(PANEL, LIST, RISE, "p-0")}>
          {view.sources.map((s) => (
            <li key={s.path} className={cn(LINE, !s.exists && "text-dim-foreground")}>
              <Badge
                tone={s.origin === "baked" ? "accent" : "neutral"}
                className="normal-case tracking-normal"
              >
                {s.origin === "baked" ? "BAKED" : "Claude Code"}
              </Badge>
              <span className={cn("min-w-0 flex-1 font-mono text-[12px]", WRAP)}>{s.path}</span>
              {targets.has(s.path) && (
                <span className={cn(NOTE, "text-[var(--ok)]")}>saves here</span>
              )}
              <span className={cn(NOTE, "text-dim-foreground")}>
                {!s.exists
                  ? "no file"
                  : `${s.hooks} ${s.hooks === 1 ? "hook" : "hooks"}${s.origin === "claude" ? ", read-only" : ""}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The hooks of a project on a timeline of the agent's events. Hooks in BAKED's own config files
 * are added, edited and removed here; Claude Code's `.claude` files are imported read-only. An
 * event can be paused for the project's backend until it restarts, as `/hooks` does.
 */
export function HooksSection({ project }: SectionProps) {
  const [hooks, , setHooks] = useLoad(() => setup.hooks(project.key), [project.key, "hooks"]);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<HookDialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HookCommand | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    setup.canEditHooks(project.key).then(
      (yes) => live && setCanEdit(yes),
      () => live && setCanEdit(false),
    );
    return () => {
      live = false;
    };
  }, [project.key]);
  useEffect(() => () => void (freshTimer.current && clearTimeout(freshTimer.current)), []);

  const toggle = async (event: string, enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setHooks(await setup.setHookEvent(project.key, event, enabled));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** Runs a write; the hooks it adds light up for a moment. */
  const write = async (work: () => Promise<HooksView>, after: () => void): Promise<void> => {
    const before = hooks.state === "ready" ? signatures(hooks.data) : new Set<string>();
    setBusy(true);
    setDialogError(null);
    try {
      const next = await work();
      setHooks(next);
      after();
      const added = [...signatures(next)].filter((s) => !before.has(s));
      setFresh(new Set(added));
      if (freshTimer.current) clearTimeout(freshTimer.current);
      freshTimer.current = setTimeout(() => setFresh(new Set()), 1400);
    } catch (e) {
      setDialogError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (): void => {
    if (!dialog?.form) return;
    const form = dialog.form;
    if (dialog.kind === "edit") {
      const { hook } = dialog;
      const keepCommand = hook.redacted && form.command === hook.command;
      void write(
        () =>
          setup.updateHook(project.key, hook.id ?? "", hook.rev ?? "", draftOf(form, keepCommand)),
        () => setDialog(null),
      );
    } else
      void write(
        () => setup.addHook(project.key, draftOf(form)),
        () => setDialog(null),
      );
  };

  const open = (state: HookDialogState): void => {
    setDialogError(null);
    setDialog(state);
  };

  if (hooks.state !== "ready") return <LoadState value={hooks} what="hooks" />;
  const view = hooks.data;
  const { phases, unknown } = timeline(view);
  const counts = hookCounts(view);
  const eventOf = (hook: HookCommand) =>
    view.events.find((e) => e.hooks.includes(hook))?.event ?? "PreToolUse";

  return (
    <div className={SETUP}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <div className="flex min-w-[280px] flex-1 flex-col gap-2">
          <p className={LEDE}>
            Hooks run your shell commands at moments in the agent's work: before a tool runs, after
            a file changes, when the agent finishes. Pick a moment below and add a command to it.
          </p>
          <p className={cn(NOTE, "m-0 flex flex-wrap items-center gap-2 text-dim-foreground")}>
            <span>
              {counts.total === 0
                ? "No hooks yet."
                : `${counts.total} ${counts.total === 1 ? "hook" : "hooks"}`}
            </span>
            {counts.baked > 0 && (
              <Badge tone="accent" className="normal-case tracking-normal">
                {counts.baked} in BAKED
              </Badge>
            )}
            {counts.imported > 0 && (
              <Badge className="normal-case tracking-normal">
                {counts.imported} from Claude Code
              </Badge>
            )}
            {!canEdit && (
              <span>This BAKED version only lists hooks; update it to add them here.</span>
            )}
          </p>
        </div>
        {canEdit && (
          <Button variant="primary" size="md" onClick={() => open({ kind: "new", form: null })}>
            <Icon name="new" size={14} /> New hook
          </Button>
        )}
      </div>

      {view.disabledBy && (
        <Alert>
          No hook runs: <span className="font-mono">{view.disabledBy}</span> sets{" "}
          <span className="font-mono">disableAllHooks: true</span>.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}

      <ol aria-label="Agent events" className="relative m-0 flex list-none flex-col gap-5 p-0 pl-8">
        <span
          aria-hidden="true"
          className="absolute top-3 bottom-3 left-[10px] w-0.5 bg-[repeating-linear-gradient(to_bottom,var(--ink)_0_6px,transparent_6px_10px)]"
        />
        {phases.map((phase) => (
          <li key={phase.id} className="relative flex flex-col gap-1">
            <span
              aria-hidden="true"
              className="absolute top-[-2px] -left-8 flex size-[22px] items-center justify-center rounded-base border-2 border-border bg-raised text-foreground shadow-sm-hard"
            >
              <Icon name={PHASE_ICON[phase.id]} size={13} />
            </span>
            <h2 className={cn(LABEL, "leading-[18px]")}>{phase.title}</h2>
            <ol className="m-0 flex list-none flex-col p-0">
              {phase.events.map((item) => (
                <EventNode
                  key={item.info.event}
                  item={item}
                  fresh={fresh}
                  canEdit={canEdit}
                  busy={busy}
                  onAdd={() =>
                    open({
                      kind: "new",
                      form: { ...BLANK_FORM, event: item.info.event },
                    })
                  }
                  onToggle={(enabled) => void toggle(item.info.event, enabled)}
                  onEdit={(hook) =>
                    open({ kind: "edit", hook, form: formFromHook(item.info.event, hook) })
                  }
                  onCopy={(hook) =>
                    open({ kind: "new", form: formFromHook(item.info.event, hook) })
                  }
                  onDelete={(hook) => {
                    setDialogError(null);
                    setRemoving(hook);
                  }}
                />
              ))}
            </ol>
          </li>
        ))}
      </ol>

      {unknown.length > 0 && (
        <Alert>
          BAKED never fires {unknown.map((e) => e.event).join(", ")}: check the event name in{" "}
          <span className="font-mono">
            {[...new Set(unknown.flatMap((e) => e.hooks.map((h) => h.source)))].join(", ")}
          </span>
          .
        </Alert>
      )}

      <Sources view={view} />

      <HookDialog
        state={dialog}
        targets={view.targets}
        platform={platform}
        busy={busy}
        error={dialogError}
        onPickTemplate={(form) => setDialog({ kind: "new", form })}
        onChange={(form: HookForm) => dialog && setDialog({ ...dialog, form } as HookDialogState)}
        onSave={save}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={removing !== null}
        title="Delete this hook?"
        confirmLabel="Delete"
        danger
        busy={busy}
        error={dialogError}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          void write(
            () => setup.removeHook(project.key, removing.id ?? "", removing.rev ?? ""),
            () => setRemoving(null),
          )
        }
      >
        <code className={cn("font-mono", WRAP)}>{removing?.command}</code> stops running at{" "}
        {removing ? eventOf(removing) : ""}. It is removed from{" "}
        <span className="font-mono">{removing?.source}</span>.
      </ConfirmDialog>
    </div>
  );
}

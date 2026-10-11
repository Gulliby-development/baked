import { useState } from "react";
import { type HookCommand, type HookEvent, type HookScope, setup } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  errorText,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  ROW,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

const SCOPE_LABEL: Record<HookScope, string> = {
  user: "your home folder",
  project: "project",
  local: "project, local",
};

/** Keys from what a hook is; a file may list the same command twice. */
function keyed(hooks: HookCommand[]): [string, HookCommand][] {
  const seen = new Map<string, number>();
  return hooks.map((hook) => {
    const base = [hook.source, hook.matcher, hook.if, hook.command].join("\0");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [`${base}\0${count}`, hook];
  });
}

function CommandLine({ hook }: { hook: HookCommand }) {
  const flags = [
    hook.matcher && `matcher ${hook.matcher}`,
    hook.if && `if ${hook.if}`,
    hook.async ? "background" : "waits",
    hook.once && "once per session",
    hook.timeout !== null && `timeout ${hook.timeout}s`,
  ].filter(Boolean);
  return (
    <li className={LINE}>
      <span className={cn(GROW, STACK, "gap-1")}>
        <code className={cn("font-mono", WRAP)}>{hook.command}</code>
        <span className={cn("text-dim-foreground", NOTE, WRAP)}>
          {flags.join(" · ")} · <span className="font-mono">{hook.source}</span>
        </span>
      </span>
      <Tag>{SCOPE_LABEL[hook.scope]}</Tag>
    </li>
  );
}

function EventGroup({
  view,
  busy,
  onToggle,
}: {
  view: HookEvent;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <section aria-label={view.event} className={STACK}>
      <div className={ROW}>
        <h2 className={cn(LABEL, "font-mono")}>{view.event}</h2>
        {view.disabled && <Tag tone="warn">off for this session</Tag>}
        {!view.known && <Tag>BAKED never fires this event</Tag>}
        {view.known && (
          <Button
            variant="secondary"
            size="md"
            className="ml-auto"
            disabled={busy}
            aria-label={`${view.disabled ? "Turn on" : "Turn off"} ${view.event} hooks`}
            onClick={() => onToggle(view.disabled)}
          >
            {view.disabled ? "Turn on" : "Turn off for this session"}
          </Button>
        )}
      </div>
      {view.hooks.length > 0 ? (
        <ul className={cn(PANEL, LIST, "p-0", view.disabled && "opacity-60")}>
          {keyed(view.hooks).map(([key, hook]) => (
            <CommandLine key={key} hook={hook} />
          ))}
        </ul>
      ) : (
        <span className={cn("text-dim-foreground", NOTE)}>No commands.</span>
      )}
    </section>
  );
}

/**
 * The hooks that run at lifecycle events, as `/hooks` shows them in the terminal. An event can be
 * switched off for the project's backend until it restarts; hooks are created and changed only in
 * their config files.
 */
export function HooksSection({ project }: SectionProps) {
  const [hooks, , setHooks] = useLoad(() => setup.hooks(project.key), [project.key]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (hooks.state !== "ready") return <LoadState value={hooks} what="hooks" />;
  const view = hooks.data;
  const files = view.sources.filter((s) => s.exists);

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Shell commands that run at agent events, read from <code>.claude/settings.json</code>,{" "}
        <code>.claude/settings.local.json</code> and <code>.baked/config.json</code> of the project
        and your home folder. Turning an event off lasts until this project's backend restarts and
        changes no file; edit the files to add or change a hook.
      </p>
      {view.disabledBy && (
        <Alert>
          No hook runs: <span className="font-mono">{view.disabledBy}</span> sets{" "}
          <span className="font-mono">disableAllHooks: true</span>.
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {view.events.length === 0 ? (
        <Empty>No hooks configured.</Empty>
      ) : (
        view.events.map((e) => (
          <EventGroup
            key={e.event}
            view={e}
            busy={busy}
            onToggle={(enabled) => void toggle(e.event, enabled)}
          />
        ))
      )}
      {files.length > 0 && (
        <details className={STACK}>
          <summary className={LABEL}>Files read</summary>
          <ul className={cn(PANEL, LIST, "p-0")}>
            {files.map((s) => (
              <li key={s.path} className={LINE}>
                <span className={cn(GROW, "font-mono", WRAP)}>{s.path}</span>
                <span className={cn("text-dim-foreground", NOTE)}>
                  {s.hooks} {s.hooks === 1 ? "command" : "commands"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

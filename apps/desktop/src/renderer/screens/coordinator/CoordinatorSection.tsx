import { useCallback, useEffect, useState } from "react";
import type { DesktopProject } from "../../../shared/api.js";
import { ApiError } from "../../client/api.js";
import {
  COORDINATOR_CAPABILITY,
  COORDINATOR_SCHEDULES_CAPABILITY,
} from "../../client/capabilities.js";
import { chat } from "../../client/chat.js";
import {
  BRIEF_LISTS,
  type BriefList,
  coordinator,
  type LaunchedView,
  type ProjectBrief,
} from "../../client/coordinator.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Dot } from "../../components/ui/dot.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Textarea } from "../../components/ui/textarea.js";
import { tokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PAGE } from "../../lib/styles.js";
import { SessionView } from "../chat/ChatSection.js";
import type { SectionProps } from "../sections.js";
import { NeedsNewer } from "../setup/shared.js";
import { ApprovalRulesSection } from "./ApprovalRules.js";
import {
  BRIEF_TITLES,
  launchedHref,
  launchedTone,
  launchKind,
  launchName,
  launchWhy,
  taskLabel,
  withList,
} from "./model.js";
import { SchedulesPanel } from "./SchedulesPanel.js";

/** How often the panel reads launched work and the brief again. */
const REFRESH_MS = 5000;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const CARD =
  "flex flex-col gap-1 rounded-base border-2 border-border bg-background px-3 py-2.5 shadow-sm-hard animate-rise motion-reduce:animate-none";

const BADGE = { ok: "ok", warn: "warn", err: "err", busy: "info", "": "neutral" } as const;

function LaunchedCard({ project, item }: { project: DesktopProject; item: LaunchedView }) {
  const tone = launchedTone(item);
  const why = launchWhy(item);
  return (
    <li className={CARD}>
      <div className="flex min-w-0 items-center gap-2">
        <Dot tone={tone} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
          {launchKind(item)}
        </span>
        <Badge tone={BADGE[tone]}>{item.status}</Badge>
      </div>
      <a
        className="truncate text-[14px] font-semibold text-foreground no-underline hover:underline"
        href={launchedHref(project.key, item)}
        title={item.id}
      >
        {launchName(item)}
      </a>
      {why && <p className="m-0 line-clamp-3 text-[13px] text-soft-foreground">{why}</p>}
      {(item.tokens > 0 || item.task) && (
        <p className="m-0 flex flex-wrap gap-x-3 font-mono text-[12px] text-dim-foreground">
          {item.tokens > 0 && <span>{tokens(item.tokens)} tokens</span>}
          {item.task &&
            (item.task.url ? (
              <a href={item.task.url} target="_blank" rel="noreferrer">
                {taskLabel(item.task)}
              </a>
            ) : (
              <span>{taskLabel(item.task)}</span>
            ))}
        </p>
      )}
    </li>
  );
}

function BriefSection({
  list,
  brief,
  onSave,
}: {
  list: BriefList;
  brief: ProjectBrief;
  onSave: (list: BriefList, lines: string[]) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const items = brief[list];
  const save = async (): Promise<void> => {
    if (editing === null) return;
    setSaving(true);
    const saved = await onSave(list, editing.split("\n"));
    setSaving(false);
    if (saved) setEditing(null);
  };
  return (
    <section className="flex flex-col gap-1.5" aria-label={BRIEF_TITLES[list]}>
      <div className="flex items-center gap-2">
        <h3 className={cn(LABEL, "flex-1")}>{BRIEF_TITLES[list]}</h3>
        {editing === null && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(items.join("\n"))}>
            Edit
          </Button>
        )}
      </div>
      {editing !== null ? (
        <>
          <Textarea
            aria-label={`${BRIEF_TITLES[list]}, one per line`}
            rows={Math.min(10, Math.max(3, items.length + 1))}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : items.length === 0 ? (
        <p className={LEDE}>None yet.</p>
      ) : (
        <ul className="m-0 flex flex-col gap-1 pl-4 text-[13px] text-soft-foreground">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Launched work and the brief, read again every few seconds. */
function CoordinatorPanel({ project, schedules }: { project: DesktopProject; schedules: boolean }) {
  const key = project.key;
  const [brief, setBrief] = useState<ProjectBrief | null>(null);
  const [launched, setLaunched] = useState<LaunchedView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const reload = useCallback(() => {
    coordinator.brief(key).then(setBrief, (e: unknown) => setError(message(e)));
    // An older backend has the brief but not the live view; the brief's entries stand in.
    coordinator.launched(key).then(
      (view) => setLaunched(view.launched),
      () => setLaunched(null),
    );
  }, [key]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const save = async (list: BriefList, lines: string[]): Promise<boolean> => {
    if (!brief) return false;
    setNote(null);
    try {
      setBrief(await coordinator.saveBrief(key, withList(brief, list, lines), brief.revision));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNote("The coordinator changed the brief meanwhile. It is reloaded; edit it again.");
        reload();
      } else setNote(message(e));
      return false;
    }
  };

  const items: LaunchedView[] =
    launched ?? brief?.launched.map((entry) => ({ ...entry, active: false, tokens: 0 })) ?? [];
  return (
    <aside
      className="flex w-[340px] flex-none flex-col gap-5 overflow-y-auto border-l-2 border-border bg-secondary-background px-4 py-4 [@media(max-width:1000px)]:w-[280px]"
      aria-label="Coordinator brief"
    >
      {schedules && <SchedulesPanel projectKey={key} />}
      <section className="flex flex-col gap-2" aria-label="Launched work">
        <h2 className={LABEL}>Launched work</h2>
        {items.length === 0 ? (
          <p className={LEDE}>
            Nothing yet. Sessions, runs and splits the coordinator starts show here.
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {items.map((item) => (
              <LaunchedCard
                key={`${item.kind}-${item.id}-${item.feature ?? ""}`}
                project={project}
                item={item}
              />
            ))}
          </ul>
        )}
      </section>
      <ApprovalRulesSection projectKey={key} />
      <section className="flex flex-col gap-3" aria-label="Project brief">
        <h2 className={LABEL}>Project brief</h2>
        {error && <Alert tone="error">{error}</Alert>}
        {note && (
          <Alert tone="error" role="status">
            {note}
          </Alert>
        )}
        {brief ? (
          BRIEF_LISTS.map((list) => (
            <BriefSection key={list} list={list} brief={brief} onSave={save} />
          ))
        ) : (
          <Skeleton lines={3} label="Loading the brief" />
        )}
      </section>
    </aside>
  );
}

/**
 * The project coordinator: its conversation, with launched work and the editable brief beside it.
 * Opening it creates the coordinator on first use.
 */
export function CoordinatorSection({ project }: SectionProps) {
  const key = project.key;
  const [state, setState] = useState<
    "loading" | "missing" | { id: string; schedules: boolean } | { error: string }
  >("loading");
  useEffect(() => {
    let live = true;
    (async () => {
      const capabilities = await chat.capabilities(key);
      if (capabilities !== null && !capabilities.includes(COORDINATOR_CAPABILITY))
        return live && setState("missing");
      const session = await coordinator.open(key);
      // An older backend without the capability list is assumed to have no schedules.
      const schedules = capabilities?.includes(COORDINATOR_SCHEDULES_CAPABILITY) ?? false;
      if (live) setState({ id: session.id, schedules });
    })().catch((e: unknown) => {
      if (!live) return;
      setState(e instanceof ApiError && e.status === 404 ? "missing" : { error: message(e) });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (state === "loading" || state === "missing" || "error" in state)
    return (
      <div className={PAGE}>
        <h1>Coordinator</h1>
        {state === "loading" ? (
          <Skeleton label="Opening the coordinator" />
        ) : state === "missing" ? (
          <NeedsNewer what="the project coordinator" />
        ) : (
          <Alert tone="error">{state.error}</Alert>
        )}
      </div>
    );
  return (
    // `data-chat` lets the window's main area give the conversation its full height.
    <div data-chat className="flex min-h-0 flex-1">
      <SessionView key={state.id} project={project} sessionId={state.id} coordinator />
      <CoordinatorPanel project={project} schedules={state.schedules} />
    </div>
  );
}

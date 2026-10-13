import { type ReactNode, useState } from "react";
import {
  type BackgroundError,
  type CleanupAction,
  cleanupActions,
  diagnostics,
  formatBytes,
  type ModelCallSource,
  type ModelEventsView,
  type SandboxStatus,
  type StorageView,
} from "../../client/diagnostics.js";
import { Icon, type IconName } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Switch } from "../../components/ui/switch.js";
import {
  FILL,
  GlanceCard,
  GROW,
  RISE,
  riseDelay,
  Tile,
  type Tone,
  TonePanel,
  useGrown,
} from "../../components/ui/tone.js";
import { ago, tokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LEDE, TABLE } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { errorText, LoadState, ROW, SETUP, useLoad, WRAP } from "./shared.js";

const NUM = "text-right font-mono tabular-nums";

type BadgeTone = "accent" | "ok" | "warn" | "err" | "info" | "neutral";

const SECTIONS = {
  storage: { title: "Storage", icon: "database", tone: "accent" },
  events: { title: "Model events", icon: "model", tone: "warn" },
  errors: { title: "Error log", icon: "warning", tone: "err" },
  sandbox: { title: "Sandbox", icon: "shield", tone: "info" },
} as const satisfies Record<string, { title: string; icon: IconName; tone: Tone }>;
type SectionId = keyof typeof SECTIONS;
const ORDER: SectionId[] = ["storage", "events", "errors", "sandbox"];

const delay = riseDelay;

function ms(value: number): string {
  if (value <= 0) return "–";
  return value < 1000 ? `${String(Math.round(value))} ms` : `${(value / 1000).toFixed(2)} s`;
}

function shortModel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** A section of the screen in its own colour. */
function Panel({
  id,
  about,
  actions,
  children,
}: {
  id: SectionId;
  about: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const s = SECTIONS[id];
  return (
    <TonePanel
      id={`diagnostics-${id}`}
      title={s.title}
      icon={s.icon}
      tone={s.tone}
      about={about}
      actions={actions}
      step={ORDER.indexOf(id) + 1}
    >
      {children}
    </TonePanel>
  );
}

/** One kind of data on disk. Kinds that share a colour hold the same kind of data. */
interface Part {
  key: string;
  label: string;
  icon: IconName;
  tone: Tone;
  bytes: number;
  about: ReactNode;
  note?: string;
  action?: CleanupAction;
}

function projectParts(
  view: StorageView,
  actions: Map<string, CleanupAction>,
  projectKey: string,
): Part[] {
  const p = view.project;
  return [
    {
      key: "repo-map",
      label: "Code map",
      icon: "graph",
      tone: "accent",
      bytes: p.repoMapBytes,
      about:
        "The index of files and symbols the agent searches. Clear deletes it; the next index pass rebuilds it.",
      action: actions.get("repo-map"),
    },
    {
      key: "sessions",
      label: "Chat sessions",
      icon: "chat",
      tone: "ok",
      bytes: p.sessionsBytes,
      note: `${String(p.sessionCount)} saved`,
      about:
        "Saved chats of this project, from the app and the terminal. Clear deletes them for good.",
      action: actions.get("sessions"),
    },
    {
      key: "memory",
      label: "Memory",
      icon: "chat-memory",
      tone: "info",
      bytes: p.memoryBytes,
      about: (
        <>
          What the chat agent remembers about this project. Edit it on the{" "}
          <a href={projectHref(projectKey, "memory")}>Memory</a> page.
        </>
      ),
    },
    {
      key: "plans",
      label: "Plans",
      icon: "plan",
      tone: "warn",
      bytes: p.plansBytes,
      about: "Plans the agent wrote in plan mode. Clear deletes them for good.",
      action: actions.get("plans"),
    },
    {
      key: "config",
      label: "Config",
      icon: "settings",
      tone: "plain",
      bytes: p.configBytes,
      about: "This project's settings and forbidden paths. Kept.",
    },
  ];
}

function globalParts(view: StorageView, actions: Map<string, CleanupAction>): Part[] {
  const g = view.global;
  return [
    {
      key: "history",
      label: "Prompt history",
      icon: "rewind",
      tone: "ok",
      bytes: g.historyBytes,
      about: "Prompts typed in the terminal UI, for every project. Clear deletes them for good.",
      action: actions.get("history"),
    },
    {
      key: "memory",
      label: "Memory",
      icon: "chat-memory",
      tone: "info",
      bytes: g.memoryBytes,
      about: "What the chat agent remembers in every project.",
    },
    {
      key: "config",
      label: "Config",
      icon: "settings",
      tone: "plain",
      bytes: g.configBytes,
      about: "Settings and keys for all projects. Kept.",
    },
    {
      key: "binaries",
      label: "Binaries",
      icon: "packages",
      tone: "accent",
      bytes: g.binariesBytes,
      about: "Tools BAKED downloaded, such as language servers. Kept.",
    },
  ];
}

function share(bytes: number, total: number): number {
  return total > 0 ? (bytes / total) * 100 : 0;
}

function percent(bytes: number, total: number): string {
  const value = share(bytes, total);
  if (value === 0) return "0%";
  return value < 1 ? "<1%" : `${String(Math.round(value))}%`;
}

function StorageGroup({
  title,
  dir,
  total,
  parts,
  busy,
  onClear,
}: {
  title: string;
  dir: string;
  total: number;
  parts: Part[];
  busy: boolean;
  onClear: (action: CleanupAction) => void;
}) {
  const grown = useGrown();
  const filled = parts.filter((p) => p.bytes > 0);
  return (
    <div className="@container flex min-w-0 flex-col gap-3">
      <div className={ROW}>
        <span className="text-[15px] font-bold">{title}</span>
        <span className="min-w-0 truncate font-mono text-[12px] text-dim-foreground" title={dir}>
          {dir}
        </span>
        <span className="ml-auto font-mono text-[15px] font-bold tabular-nums">
          {formatBytes(total)}
        </span>
      </div>
      <div
        role="img"
        aria-label={`${title}: ${filled.map((p) => `${p.label} ${percent(p.bytes, total)}`).join(", ") || "empty"}`}
        className="flex h-6 w-full overflow-hidden rounded-base border-2 border-border bg-secondary-background"
      >
        {filled.map((p) => (
          <span
            key={p.key}
            title={`${p.label}: ${formatBytes(p.bytes)}`}
            className={cn(
              "h-full shrink-0 border-r-2 border-border last:border-r-0",
              GROW,
              FILL[p.tone],
            )}
            style={{ width: grown ? `${String(share(p.bytes, total))}%` : "0%" }}
          />
        ))}
      </div>
      <ul className="m-0 list-none p-0">
        {parts.map((p, i) => (
          <li
            key={p.key}
            className={cn(
              "flex items-center gap-x-4 border-b border-[var(--line)] py-3 last:border-b-0",
              RISE,
              p.bytes === 0 && "[&>:first-child]:opacity-60",
            )}
            style={delay(i, 45)}
          >
            <Tile tone={p.tone} icon={p.icon} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">{p.label}</span>
                {p.note && <Badge>{p.note}</Badge>}
              </div>
              <p className="m-0 text-[12px] leading-snug text-muted-foreground">{p.about}</p>
            </div>
            <div className="flex w-[150px] shrink-0 items-center gap-2 @max-2xl:hidden">
              <span className="h-3 flex-1 overflow-hidden rounded-full border-2 border-border bg-secondary-background">
                <span
                  className={cn(
                    "block h-full",
                    GROW,
                    FILL[p.tone],
                    p.bytes > 0 && p.bytes < total && "border-r-2 border-border",
                  )}
                  style={{ width: grown ? `${String(share(p.bytes, total))}%` : "0%" }}
                />
              </span>
              <span className="w-9 text-right font-mono text-[11px] tabular-nums text-dim-foreground">
                {percent(p.bytes, total)}
              </span>
            </div>
            <span className={cn(NUM, "w-[76px] shrink-0")}>{formatBytes(p.bytes)}</span>
            <span className="flex w-[64px] shrink-0 justify-end">
              {p.action && (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={busy}
                  onClick={() => p.action && onClear(p.action)}
                  aria-label={`Clear ${p.label.toLowerCase()}`}
                >
                  Clear
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StoragePanel({ projectKey }: { projectKey: string }) {
  const [storage, , setStorage] = useLoad(
    () => diagnostics.storage(projectKey),
    [projectKey, "diagnostics-storage"],
  );
  const [asking, setAsking] = useState<CleanupAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (action: CleanupAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await diagnostics.cleanup(projectKey, action.target);
      setStorage(result.storage);
      setNotice(
        action.target === "vacuum"
          ? result.freedBytes > 0
            ? `Compacted the databases and reclaimed ${formatBytes(result.freedBytes)}.`
            : "Compacted the databases; there was no space to reclaim."
          : `Cleared ${action.label.toLowerCase()} and freed about ${formatBytes(result.freedBytes)}.`,
      );
      setAsking(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const about =
    "What BAKED keeps on disk, by kind. Clear deletes one kind; Compact databases reclaims the space SQLite keeps after deleted rows and keeps all data.";
  if (storage.state !== "ready")
    return (
      <Panel id="storage" about={about}>
        <LoadState value={storage} what="storage use" />
      </Panel>
    );
  const view: StorageView = storage.data;
  const actions = new Map(cleanupActions(view).map((a) => [a.target, a]));
  const vacuum = actions.get("vacuum");
  const ask = (action: CleanupAction): void => {
    setNotice(null);
    setError(null);
    setAsking(action);
  };

  return (
    <Panel
      id="storage"
      about={about}
      actions={
        vacuum && (
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void run(vacuum)}>
            <Icon name="compact" />
            Compact databases
          </Button>
        )
      }
    >
      <StorageGroup
        title="This project"
        dir={view.projectDir}
        total={view.project.totalBytes}
        parts={projectParts(view, actions, projectKey)}
        busy={busy}
        onClear={ask}
      />
      <StorageGroup
        title="All projects"
        dir={view.globalDir}
        total={view.global.totalBytes}
        parts={globalParts(view, actions)}
        busy={busy}
        onClear={ask}
      />
      {notice && <Alert>{notice}</Alert>}
      {error && !asking && <Alert tone="error">{error}</Alert>}
      <ConfirmDialog
        open={asking !== null}
        title={`Clear ${asking?.label.toLowerCase() ?? ""}?`}
        confirmLabel="Clear"
        danger
        busy={busy}
        error={asking ? error : null}
        onConfirm={() => asking && void run(asking)}
        onClose={() => {
          setAsking(null);
          setError(null);
        }}
      >
        {asking?.warning}
      </ConfirmDialog>
    </Panel>
  );
}

const SOURCE_TONE: Record<ModelCallSource, BadgeTone> = {
  main: "accent",
  subagent: "info",
  run: "ok",
  compaction: "warn",
  embed: "neutral",
  other: "neutral",
};

function ModelEventsPanel({ projectKey }: { projectKey: string }) {
  const [events, reload, setEvents] = useLoad(
    () => diagnostics.modelEvents(projectKey),
    [projectKey, "diagnostics-modelEvents"],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (action: "enable" | "disable" | "clear"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setEvents(await diagnostics.changeModelEvents(projectKey, action));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const about =
    "Every model call of this project's chats and workflow runs while recording is on. Off by default; kept in memory (the latest 500) until the backend stops, and turning it off drops them.";
  if (events.state !== "ready")
    return (
      <Panel id="events" about={about}>
        <LoadState value={events} what="model events" />
      </Panel>
    );
  const view: ModelEventsView = events.data;
  const recent = view.events.slice(0, 50);
  const busiest = Math.max(1, ...view.models.map((m) => m.calls));
  return (
    <Panel
      id="events"
      about={about}
      actions={
        <>
          <Button variant="secondary" size="md" disabled={busy} onClick={reload}>
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={busy || view.events.length === 0}
            onClick={() => void change("clear")}
          >
            Clear
          </Button>
        </>
      }
    >
      <div
        className={cn(
          "flex items-center gap-3 rounded-base border-2 px-3 py-2.5",
          view.enabled
            ? "border-border bg-fill-warn text-main-foreground"
            : "border-dashed border-[var(--line-strong)] text-soft-foreground",
        )}
      >
        <Switch
          checked={view.enabled}
          disabled={busy}
          onCheckedChange={(on) => void change(on ? "enable" : "disable")}
          aria-label="Record model events"
        />
        <span aria-hidden="true" className="font-semibold">
          Record model calls of this backend
        </span>
        <span className="ml-auto flex items-center gap-2 font-mono text-[11px] font-bold uppercase tracking-wider">
          {view.enabled && (
            <span className="size-2 rounded-full bg-[var(--err)] animate-pulse-dot motion-reduce:animate-none" />
          )}
          {view.enabled ? "Recording" : "Off"}
        </span>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {view.events.length === 0 ? (
        <Empty>
          {view.enabled
            ? "No model calls since recording started."
            : "Turn recording on, then use chat or start a run."}
        </Empty>
      ) : (
        <>
          <table className={TABLE} aria-label="Model totals">
            <thead>
              <tr>
                <th>Model</th>
                <th className="w-[30%]">Calls</th>
                <th className="text-right">Errors</th>
                <th className="text-right">Avg</th>
                <th className="text-right">Input</th>
                <th className="text-right">Output</th>
                <th className="text-right">Cache read</th>
              </tr>
            </thead>
            <tbody>
              {view.models.map((m) => (
                <tr key={m.modelId}>
                  <td className="font-mono" title={m.modelId}>
                    <span className="flex items-center gap-2">
                      <Icon name="model" size={14} className="text-dim-foreground" />
                      {shortModel(m.modelId)}
                    </span>
                  </td>
                  <td>
                    <span className="flex items-center gap-2">
                      <span className="h-3 flex-1 overflow-hidden rounded-full border-2 border-border bg-secondary-background">
                        <span
                          className="block h-full border-r-2 border-border bg-fill-warn"
                          style={{ width: `${String((m.calls / busiest) * 100)}%` }}
                        />
                      </span>
                      <span className="w-8 text-right font-mono tabular-nums">{m.calls}</span>
                    </span>
                  </td>
                  <td className={NUM}>
                    {m.errors > 0 ? <Badge tone="err">{m.errors}</Badge> : "0"}
                  </td>
                  <td className={NUM}>{ms(m.avgMs)}</td>
                  <td className={NUM}>{tokens(m.input)}</td>
                  <td className={NUM}>{tokens(m.output)}</td>
                  <td className={NUM}>{tokens(m.cacheRead)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className={TABLE} aria-label="Recent model calls">
            <thead>
              <tr>
                <th>When</th>
                <th>Model</th>
                <th>Source</th>
                <th className="text-right">Time</th>
                <th className="text-right">In / out</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((ev) => (
                <tr key={ev.id} className={cn(ev.state === "error" && "bg-[var(--diff-del)]")}>
                  <td className="text-dim-foreground">{ago(ev.startedAt)}</td>
                  <td className="font-mono" title={ev.modelId}>
                    {shortModel(ev.modelId)}
                  </td>
                  <td>
                    <Badge tone={SOURCE_TONE[ev.source]}>{ev.source}</Badge>
                    {ev.runId && (
                      <span className="ml-2 font-mono text-[12px] text-dim-foreground">
                        {ev.runId.slice(0, 12)}
                      </span>
                    )}
                  </td>
                  <td className={NUM}>{ms(ev.durationMs)}</td>
                  <td className={NUM}>
                    {ev.state === "ok"
                      ? `${tokens(ev.input ?? 0)} / ${tokens(ev.output ?? 0)}`
                      : "–"}
                  </td>
                  <td className={cn(WRAP, "max-w-[360px] whitespace-normal")}>
                    {ev.state === "ok" ? (
                      <Badge tone="ok">ok</Badge>
                    ) : (
                      <span className="flex items-start gap-2">
                        <Badge tone="err">error</Badge>
                        <span className="text-[12px]">{ev.errorMessage}</span>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}

/** Background error sources are free text; the known families get their own colour. */
function sourceTone(source: string): BadgeTone {
  const s = source.toLowerCase();
  if (s.includes("lsp") || s.includes("language")) return "info";
  if (s.includes("hook")) return "warn";
  if (s.includes("agent")) return "accent";
  if (s.includes("session")) return "ok";
  return "neutral";
}

function ErrorLogPanel({ projectKey }: { projectKey: string }) {
  const [log, reload] = useLoad(
    () => diagnostics.errors(projectKey),
    [projectKey, "diagnostics-errors"],
  );
  const about =
    "Failures off the chat transcript in this backend: hooks, language servers, agents and session saves. Kept in memory (the latest 500) until the backend stops; chat and tool errors stay in their chats.";
  const refresh = (
    <Button variant="secondary" size="md" onClick={reload}>
      Refresh
    </Button>
  );
  if (log.state !== "ready")
    return (
      <Panel id="errors" about={about}>
        <LoadState value={log} what="the error log" />
      </Panel>
    );
  const errors: BackgroundError[] = log.data.errors;
  return (
    <Panel id="errors" about={about} actions={refresh}>
      {errors.length === 0 ? (
        <Empty className="flex items-center justify-center gap-3">
          <Tile tone="ok" icon="ok" />
          No background errors since this backend started.
        </Empty>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {errors.map((e, i) => (
            <li
              key={e.id}
              className={cn(
                "flex flex-wrap items-start gap-x-3 gap-y-1 rounded-base border-2 border-l-[6px] border-border border-l-[var(--fill-err)] bg-secondary-background px-3 py-2.5",
                RISE,
              )}
              style={delay(i, 40)}
            >
              <Badge tone={sourceTone(e.source)}>{e.source}</Badge>
              <span
                className={cn(WRAP, "min-w-0 flex-1 whitespace-pre-wrap font-mono text-[12px]")}
              >
                {e.message}
              </span>
              <span className="text-[12px] text-dim-foreground">{ago(e.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function sandboxSummary(status: SandboxStatus): string {
  if (status.effectiveMode === "off")
    return "Shell, project and check commands run without OS sandbox.";
  if (status.active) return "Shell, project and check commands run in the OS sandbox.";
  return status.effectiveMode === "auto"
    ? "No sandbox backend here, so commands run without OS sandbox."
    : "No sandbox backend here, so sandboxed commands are refused.";
}

/** One fact of the sandbox as a coloured card. */
function Fact({
  tone,
  icon,
  label,
  value,
  children,
}: {
  tone: Tone;
  icon: IconName;
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-base border-2 border-border bg-secondary-background px-3 py-3">
      <Tile tone={tone} icon={icon} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.08em] text-dim-foreground">
          {label}
        </span>
        <span className={cn(WRAP, "font-semibold")}>{value}</span>
        {children && <span className="text-[12px] text-muted-foreground">{children}</span>}
      </div>
    </div>
  );
}

function SandboxPanel({ projectKey }: { projectKey: string }) {
  const [status, reload] = useLoad(
    () => diagnostics.sandbox(projectKey),
    [projectKey, "diagnostics-sandbox"],
  );
  const how =
    "Change the mode on the Tools page of the chat settings; a project config can only raise it.";
  if (status.state !== "ready")
    return (
      <Panel id="sandbox" about={how}>
        <LoadState value={status} what="the sandbox status" />
      </Panel>
    );
  const s = status.data;
  const problem = s.effectiveMode !== "off" && !s.available;
  const modeTone: Tone =
    s.effectiveMode === "off"
      ? "plain"
      : problem
        ? s.effectiveMode === "required"
          ? "err"
          : "warn"
        : "ok";
  return (
    <Panel
      id="sandbox"
      about={`${sandboxSummary(s)} ${how}`}
      actions={
        <Button variant="secondary" size="md" onClick={reload}>
          Refresh
        </Button>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
        <Fact tone={modeTone} icon="shield" label="Mode" value={s.effectiveMode}>
          {s.source === "project"
            ? `Raised by the project config from ${s.mode}.`
            : s.source === "override"
              ? "Command-line override."
              : s.active
                ? "Commands run isolated."
                : "Commands are not isolated."}
        </Fact>
        <Fact
          tone={s.available ? "ok" : "warn"}
          icon="shell"
          label="Backend"
          value={<span className="font-mono text-[13px]">{s.available ? s.backend : "none"}</span>}
        >
          <span className={cn(WRAP, "font-mono")}>
            {s.available ? (s.path ?? "found") : (s.reason ?? "unavailable")}
          </span>
        </Fact>
        <Fact
          tone={s.network === "deny" ? "ok" : "plain"}
          icon="globe"
          label="Chat network"
          value={s.network}
        >
          {s.network === "deny"
            ? "Sandboxed chat commands have no network."
            : "Sandboxed chat commands can reach the network."}
        </Fact>
      </div>
      {problem && s.effectiveMode === "required" ? (
        <Alert tone="error">
          The sandbox is required but this machine has no working backend: shell, project and check
          commands are refused until it is installed or the mode is lowered.
        </Alert>
      ) : null}
    </Panel>
  );
}

/** The four sections at a glance; each card scrolls to its section. */
function Glance({ projectKey }: { projectKey: string }) {
  const [storage] = useLoad(
    () => diagnostics.storage(projectKey),
    [projectKey, "diagnostics-storage"],
  );
  const [events] = useLoad(
    () => diagnostics.modelEvents(projectKey),
    [projectKey, "diagnostics-modelEvents"],
  );
  const [log] = useLoad(() => diagnostics.errors(projectKey), [projectKey, "diagnostics-errors"]);
  const [sandbox] = useLoad(
    () => diagnostics.sandbox(projectKey),
    [projectKey, "diagnostics-sandbox"],
  );

  const failed =
    events.state === "ready" ? events.data.events.filter((e) => e.state === "error").length : 0;
  const glance: Record<SectionId, [string | null, string]> = {
    storage:
      storage.state === "ready"
        ? [
            formatBytes(storage.data.project.totalBytes + storage.data.global.totalBytes),
            `${formatBytes(storage.data.project.totalBytes)} in this project`,
          ]
        : [null, "Disk use"],
    events:
      events.state === "ready"
        ? [
            plural(events.data.events.length, "call"),
            !events.data.enabled
              ? "Not recording"
              : failed > 0
                ? `${plural(failed, "error")} · recording`
                : "Recording",
          ]
        : [null, "Model calls"],
    errors:
      log.state === "ready"
        ? [
            String(log.data.errors.length),
            log.data.errors.length === 0 ? "All clear" : "Since the backend started",
          ]
        : [null, "Background errors"],
    sandbox:
      sandbox.state === "ready"
        ? [sandbox.data.effectiveMode, sandbox.data.active ? "Commands isolated" : "Not isolated"]
        : [null, "OS sandbox"],
  };

  return (
    <nav
      aria-label="Diagnostics sections"
      className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3"
    >
      {ORDER.map((id, i) => {
        const s = SECTIONS[id];
        const [value, sub] = glance[id];
        return (
          <GlanceCard
            key={id}
            tone={s.tone}
            icon={s.icon}
            label={s.title}
            value={value ?? "–"}
            note={sub}
            step={i}
            onClick={() =>
              document
                .getElementById(`diagnostics-${id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        );
      })}
    </nav>
  );
}

export function DiagnosticsSection({ project }: SectionProps) {
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Disk use of BAKED's data, the model calls, the background errors and the OS sandbox of this
        project's backend. The terminal UI shows the same with{" "}
        <span className="font-mono">/storage</span>,{" "}
        <span className="font-mono">/model-events</span>, <span className="font-mono">/errors</span>{" "}
        and <span className="font-mono">/sandbox</span>.
      </p>
      <Glance projectKey={project.key} />
      <StoragePanel projectKey={project.key} />
      <ModelEventsPanel projectKey={project.key} />
      <ErrorLogPanel projectKey={project.key} />
      <SandboxPanel projectKey={project.key} />
    </div>
  );
}

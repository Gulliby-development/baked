import { useState } from "react";
import {
  type CleanupAction,
  cleanupActions,
  diagnostics,
  formatBytes,
  type ModelEventsView,
  type StorageView,
} from "../../client/diagnostics.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Switch } from "../../components/ui/switch.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { ago, tokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LEDE } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  errorText,
  H2,
  LoadState,
  NOTE,
  ROW,
  SETUP,
  STACK,
  useLoad,
  WRAP,
} from "./shared.js";

const NUM = "text-right font-mono tabular-nums";

function ms(value: number): string {
  if (value <= 0) return "–";
  return value < 1000 ? `${String(Math.round(value))} ms` : `${(value / 1000).toFixed(2)} s`;
}

function shortModel(id: string): string {
  return id.slice(id.lastIndexOf("/") + 1);
}

function StoragePanel({ projectKey }: { projectKey: string }) {
  const [storage, , setStorage] = useLoad(() => diagnostics.storage(projectKey), [projectKey]);
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

  if (storage.state !== "ready") return <LoadState value={storage} what="storage use" />;
  const view: StorageView = storage.data;
  const actions = new Map(cleanupActions(view).map((a) => [a.target, a]));
  const rows: [string, number, CleanupAction | undefined, string?][] = [
    ["Code map", view.project.repoMapBytes, actions.get("repo-map")],
    [
      "Chat sessions",
      view.project.sessionsBytes,
      actions.get("sessions"),
      `${String(view.project.sessionCount)} saved`,
    ],
    ["Memory", view.project.memoryBytes, undefined],
    ["Plans", view.project.plansBytes, actions.get("plans")],
    ["Config", view.project.configBytes, undefined],
  ];
  const globalRows: [string, number, CleanupAction | undefined, string?][] = [
    ["Prompt history", view.global.historyBytes, actions.get("history")],
    ["Memory", view.global.memoryBytes, undefined],
    ["Config", view.global.configBytes, undefined],
    ["Binaries", view.global.binariesBytes, undefined],
  ];
  const vacuum = actions.get("vacuum");
  const table = (
    title: string,
    dir: string,
    total: number,
    list: [string, number, CleanupAction | undefined, string?][],
  ) => (
    <div className={STACK}>
      <div className={cn(ROW, "mb-2")}>
        <span className="font-semibold">{title}</span>
        <span className="font-mono text-[12px] text-dim-foreground">{dir}</span>
        <span className="ml-auto font-mono tabular-nums">{formatBytes(total)}</span>
      </div>
      <Table>
        <TableBody>
          {list.map(([label, bytes, action, note]) => (
            <TableRow key={label}>
              <TableCell>
                {label}
                {note && <span className={cn("ml-2 text-dim-foreground", NOTE)}>{note}</span>}
              </TableCell>
              <TableCell className={NUM}>{formatBytes(bytes)}</TableCell>
              <TableCell className="w-[1%] text-right">
                {action && (
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={busy}
                    onClick={() => {
                      setNotice(null);
                      setError(null);
                      setAsking(action);
                    }}
                    aria-label={`Clear ${label.toLowerCase()}`}
                  >
                    Clear
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <section className={SETUP} aria-label="Storage">
      {table("This project", view.projectDir, view.project.totalBytes, rows)}
      {table("All projects", view.globalDir, view.global.totalBytes, globalRows)}
      <div className={ROW}>
        {vacuum && (
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void run(vacuum)}>
            Compact databases
          </Button>
        )}
        <span className={cn(LEDE, NOTE)}>
          Reclaims space SQLite keeps after deleted rows. Keeps all data.
        </span>
      </div>
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
    </section>
  );
}

function ModelEventsPanel({ projectKey }: { projectKey: string }) {
  const [events, reload, setEvents] = useLoad(
    () => diagnostics.modelEvents(projectKey),
    [projectKey],
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

  if (events.state !== "ready") return <LoadState value={events} what="model events" />;
  const view: ModelEventsView = events.data;
  const recent = view.events.slice(0, 50);
  return (
    <section className={SETUP} aria-label="Model events">
      <div className={ROW}>
        <span className="flex items-center gap-2.5">
          <Switch
            checked={view.enabled}
            disabled={busy}
            onCheckedChange={(on) => void change(on ? "enable" : "disable")}
            aria-label="Record model events"
          />
          <span aria-hidden="true">Record model calls of this backend</span>
        </span>
        <span className={cn(ACTIONS, "ml-auto")}>
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
        </span>
      </div>
      <p className={cn(LEDE, NOTE)}>
        Off by default. While on, every model call of this project's chats and workflow runs is kept
        in memory (the latest 500) until the backend stops. Turning it off drops them.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {view.events.length === 0 ? (
        <Empty>
          {view.enabled
            ? "No model calls since recording started."
            : "Turn recording on, then use chat or start a run."}
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead className="text-right">Avg</TableHead>
                <TableHead className="text-right">Input</TableHead>
                <TableHead className="text-right">Output</TableHead>
                <TableHead className="text-right">Cache read</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.models.map((m) => (
                <TableRow key={m.modelId}>
                  <TableCell className="font-mono" title={m.modelId}>
                    {shortModel(m.modelId)}
                  </TableCell>
                  <TableCell className={NUM}>{m.calls}</TableCell>
                  <TableCell className={NUM}>{m.errors}</TableCell>
                  <TableCell className={NUM}>{ms(m.avgMs)}</TableCell>
                  <TableCell className={NUM}>{tokens(m.input)}</TableCell>
                  <TableCell className={NUM}>{tokens(m.output)}</TableCell>
                  <TableCell className={NUM}>{tokens(m.cacheRead)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table aria-label="Recent model calls">
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Time</TableHead>
                <TableHead className="text-right">In / out</TableHead>
                <TableHead>Result</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recent.map((ev) => (
                <TableRow key={ev.id}>
                  <TableCell className="text-dim-foreground">{ago(ev.startedAt)}</TableCell>
                  <TableCell className="font-mono" title={ev.modelId}>
                    {shortModel(ev.modelId)}
                  </TableCell>
                  <TableCell>
                    {ev.source}
                    {ev.runId && (
                      <span className="ml-1 font-mono text-dim-foreground">
                        {ev.runId.slice(0, 12)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={NUM}>{ms(ev.durationMs)}</TableCell>
                  <TableCell className={NUM}>
                    {ev.state === "ok"
                      ? `${tokens(ev.input ?? 0)} / ${tokens(ev.output ?? 0)}`
                      : "–"}
                  </TableCell>
                  <TableCell className={cn(WRAP, "max-w-[360px] whitespace-normal")}>
                    {ev.state === "ok" ? (
                      <Badge tone="ok">ok</Badge>
                    ) : (
                      <span className="flex items-start gap-2">
                        <Badge tone="err">error</Badge>
                        <span className="text-[12px]">{ev.errorMessage}</span>
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  );
}

function ErrorLogPanel({ projectKey }: { projectKey: string }) {
  const [log, reload] = useLoad(() => diagnostics.errors(projectKey), [projectKey]);
  if (log.state !== "ready") return <LoadState value={log} what="the error log" />;
  const { errors } = log.data;
  return (
    <section className={SETUP} aria-label="Error log">
      <div className={ROW}>
        <p className={cn(LEDE, NOTE, "flex-1")}>
          Failures off the chat transcript in this backend: hooks, language servers, agents and
          session saves. Kept in memory (the latest 500) until the backend stops; chat and tool
          errors stay in their chats.
        </p>
        <Button variant="secondary" size="md" onClick={reload}>
          Refresh
        </Button>
      </div>
      {errors.length === 0 ? (
        <Empty>No background errors since this backend started.</Empty>
      ) : (
        <Table>
          <TableBody>
            {errors.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="w-[1%] text-dim-foreground">{ago(e.timestamp)}</TableCell>
                <TableCell className="w-[1%] font-mono">{e.source}</TableCell>
                <TableCell className={cn(WRAP, "whitespace-pre-wrap font-mono text-[12px]")}>
                  {e.message}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

export function DiagnosticsSection({ project }: SectionProps) {
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Disk use of BAKED's data, the model calls and the background errors of this project's
        backend. The terminal UI shows the same with <span className="font-mono">/storage</span>,{" "}
        <span className="font-mono">/model-events</span> and{" "}
        <span className="font-mono">/errors</span>.
      </p>
      <h2 className={H2}>Storage</h2>
      <StoragePanel projectKey={project.key} />
      <h2 className={H2}>Model events</h2>
      <ModelEventsPanel projectKey={project.key} />
      <h2 className={H2}>Error log</h2>
      <ErrorLogPanel projectKey={project.key} />
    </div>
  );
}

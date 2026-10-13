import { useEffect, useState } from "react";
import {
  type IntelligenceCheck,
  type LspActionView,
  type LspServer,
  type LspView,
  lsp,
} from "../../client/lsp.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Dot } from "../../components/ui/dot.js";
import { Empty } from "../../components/ui/empty.js";
import { Switch } from "../../components/ui/switch.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  BACKEND_STATE_LABEL,
  BACKEND_STATE_TONE,
  backendState,
  LSP_STATE_LABEL,
  LSP_STATE_TONE,
  lspSourceLine,
  lspState,
  PROBE_LABEL,
  visibleServers,
} from "./lsp-logic.js";
import {
  ACTIONS,
  errorText,
  GROW,
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

/** How often the list refreshes while a server is starting. */
const POLL_MS = 1500;

function ServerRow({
  server,
  busy,
  installing,
  onToggle,
  onInstall,
  onRestart,
}: {
  server: LspServer;
  busy: boolean;
  installing: boolean;
  onToggle: (enabled: boolean) => void;
  onInstall: () => void;
  onRestart: () => void;
}) {
  const state = lspState(server);
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] text-soft-foreground">
      <div className={ROW}>
        <Switch
          aria-label={`${server.disabled ? "Turn on" : "Turn off"} ${server.id}`}
          checked={!server.disabled}
          disabled={busy}
          onCheckedChange={(checked) => onToggle(checked)}
        />
        <span className={cn(GROW, "flex flex-col gap-0.5")}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-foreground">{server.id}</span>
            {server.languages.map((language) => (
              <Tag key={language}>{language}</Tag>
            ))}
          </span>
          <span className={cn(WRAP, "font-mono text-[12px] text-dim-foreground")}>
            {lspSourceLine(server)}
            {server.running &&
              ` · ${server.openFiles} open files · ${server.diagnosticCount} diagnostics`}
          </span>
        </span>
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Dot tone={LSP_STATE_TONE[state]} />
          {installing ? "Installing…" : LSP_STATE_LABEL[state]}
        </span>
        <span className={ACTIONS}>
          {!server.installed && server.package && (
            <Button
              variant="primary"
              size="md"
              disabled={busy || !server.installable}
              title={
                server.installable
                  ? undefined
                  : `Needs ${server.requiresToolchain ?? "a toolchain"} on PATH`
              }
              onClick={onInstall}
            >
              {installing ? "Installing…" : "Install"}
            </Button>
          )}
          {server.installed && !server.disabled && (
            <Button variant="secondary" size="md" disabled={busy} onClick={onRestart}>
              {server.running ? "Restart" : "Start"}
            </Button>
          )}
        </span>
      </div>
      {server.lastError && (
        <span className={cn(WRAP, "text-[12px] text-[var(--err)]")}>
          {server.lastError.message}
        </span>
      )}
      {server.disabledIn.length > 0 && (
        <span className={cn("text-dim-foreground", NOTE)}>
          Turned off in{" "}
          {server.disabledIn
            .map((s) => (s === "project" ? "this project" : "your user config"))
            .join(" and ")}
          .
        </span>
      )}
    </li>
  );
}

/** Every backend of the check with how each key operation went, as `/diagnose` shows it. */
function CheckPanel({ check }: { check: IntelligenceCheck }) {
  return (
    <section aria-label="Code intelligence check" className={STACK}>
      <h2 className={LABEL}>Code intelligence check · {check.language}</h2>
      <span className={cn(WRAP, "font-mono text-dim-foreground", NOTE)}>
        {check.probeFile ? `Probed ${check.probeFile}` : "No file of this language to probe."}
      </span>
      <ul className={cn(PANEL, LIST, "p-0")}>
        {check.backends.map((backend) => {
          const state = backendState(check, backend);
          return (
            <li
              key={backend.backend}
              className="flex flex-col gap-1 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] text-soft-foreground"
            >
              <div className={ROW}>
                <span className={cn(GROW, "font-mono font-semibold text-foreground")}>
                  {backend.backend}
                  <span className="font-normal text-dim-foreground"> · tier {backend.tier}</span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <Dot tone={BACKEND_STATE_TONE[state]} />
                  {BACKEND_STATE_LABEL[state]}
                </span>
              </div>
              {backend.initError && (
                <span className={cn(WRAP, "text-[12px] text-[var(--err)]")}>
                  Failed to start: {backend.initError}
                </span>
              )}
              {backend.supports && backend.probes.length > 0 && (
                <span className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[12px] text-dim-foreground">
                  {backend.probes.map((probe) => (
                    <span
                      key={probe.operation}
                      title={probe.error}
                      className={cn(
                        (probe.status === "error" || probe.status === "timeout") &&
                          "text-[var(--err)]",
                      )}
                    >
                      {probe.operation} {PROBE_LABEL[probe.status]}
                      {probe.ms !== undefined && probe.status !== "unsupported" && ` ${probe.ms}ms`}
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function restartedText(view: LspActionView, what: string): string {
  if (view.startedNow) return "Started the project's language servers.";
  return view.restarted.length ? `${what} Restarted ${view.restarted.join(", ")}.` : what;
}

/**
 * Language servers for the project's languages: whether they are installed, turned off, running
 * or failing, with Install, Turn off and Restart, and the code intelligence check of `/diagnose`. The same as `/lsp` in the terminal and
 * `baked lsp`, through `/v1/lsp*` of the project's backend.
 */
export function LspSection({ project }: SectionProps) {
  const [list, reload, setList] = useLoad(() => lsp.status(project.key), [project.key, "lsp"]);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);
  const [check, setCheck] = useState<IntelligenceCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const starting = list.state === "ready" && list.data.servers.some((s) => s.running && !s.ready);
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [starting, reload]);

  const act = async (work: () => Promise<LspActionView>, done: (view: LspActionView) => string) => {
    setBusy(true);
    try {
      const view = await work();
      setList(view satisfies LspView);
      const warning = view.installed?.warning;
      setNotice(warning ? { text: warning, failed: true } : { text: done(view) });
    } catch (e) {
      setNotice({ text: errorText(e), failed: true });
    } finally {
      setBusy(false);
      setInstalling(null);
    }
  };

  const runCheck = async () => {
    setChecking(true);
    setNotice(null);
    try {
      const result = await lsp.diagnose(project.key);
      setCheck(result);
      // The check starts the servers when none ran yet.
      reload();
    } catch (e) {
      setNotice({ text: errorText(e), failed: true });
    } finally {
      setChecking(false);
    }
  };

  if (list.state !== "ready") return <LoadState value={list} what="language servers" />;
  const view = list.data;
  const servers = visibleServers(view, all);

  return (
    <div className={SETUP}>
      <div className={ROW}>
        <p className={cn(LEDE, GROW)}>
          Language servers give chats and runs go-to-definition, references and diagnostics. Without
          one, BAKED falls back to tree-sitter. Turning a server off applies to all your projects
          unless this project has its own list.
        </p>
        <Button
          variant="secondary"
          size="md"
          disabled={busy}
          onClick={() =>
            void act(
              () => lsp.restart(project.key),
              (v) => restartedText(v, "Restarted the language servers."),
            )
          }
        >
          {view.started ? "Restart all" : "Start servers"}
        </Button>
        <Button
          variant="secondary"
          size="md"
          disabled={busy || checking}
          onClick={() => void runCheck()}
        >
          {checking ? "Checking…" : "Check code intelligence"}
        </Button>
      </div>
      {!view.started && (
        <Alert>
          Servers start with the first chat message or run step. Start them now to check they come
          up.
        </Alert>
      )}
      {view.uncovered.length > 0 && (
        <Alert>
          No working language server for {view.uncovered.join(", ")}. Install one below.
        </Alert>
      )}
      {notice && <Alert tone={notice.failed ? "error" : undefined}>{notice.text}</Alert>}
      {check && <CheckPanel check={check} />}
      <section aria-label="Servers" className={STACK}>
        <div className={ROW}>
          <h2 className={cn(LABEL, GROW)}>
            {all ? "All servers" : "For this project's languages"} · {servers.length}
          </h2>
          <span className="flex items-center gap-2 text-[13px]">
            <Switch id="lsp-all" checked={all} onCheckedChange={setAll} />
            <label htmlFor="lsp-all">Show all</label>
          </span>
        </div>
        <span className={cn("text-dim-foreground", NOTE)}>
          Languages found: {view.languages.length ? view.languages.join(", ") : "none"}.
          {!view.registry && " The first install downloads the Mason registry."}
        </span>
        {servers.length === 0 ? (
          <Empty className="p-4 text-[13px]">
            No server for this project's languages. Turn on Show all to see every server.
          </Empty>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                busy={busy}
                installing={installing === server.id}
                onToggle={(enabled) =>
                  void act(
                    () => lsp.setDisabled(project.key, server.id, !enabled),
                    (v) =>
                      restartedText(v, `${enabled ? "Turned on" : "Turned off"} ${server.id}.`),
                  )
                }
                onInstall={() => {
                  setInstalling(server.id);
                  void act(
                    () => lsp.install(project.key, server.id),
                    (v) => restartedText(v, `Installed ${v.installed?.package ?? server.id}.`),
                  );
                }}
                onRestart={() =>
                  void act(
                    () => lsp.restart(project.key, server.id),
                    (v) => restartedText(v, `Restarted ${server.id}.`),
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

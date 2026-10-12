import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { getCwd } from "../../core/cwd.js";
import { getDetailedLspServers } from "../../core/intelligence/instance.js";
import {
  type LspServerView,
  lspStatus,
  restartLspServer,
} from "../../core/intelligence/lsp-service.js";
import { type ThemeTokens, useTheme } from "../../core/theme/index.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { useErrorStore } from "../../stores/errors.js";
import {
  buildGroupedRows,
  type GroupedItem,
  GroupedList,
  type GroupedListGroup,
  handleCursorNavKey,
  InfoLine,
  type InfoLineData,
  PremiumPopup,
  Section,
} from "../ui/index.js";
import { fitPopupHeight, fitPopupWidth } from "../ui/popup-geometry.js";
import { listScrollAccel } from "../ui/scroll.js";

const POLL_MS = 2000;

interface LspServerDetail {
  language: string;
  command: string;
  args: string[];
  pid: number | null;
  cwd: string;
  openFiles: number;
  diagnosticCount: number;
  diagnostics: Array<{ file: string; message: string; severity: number }>;
  ready: boolean;
  backend: "standalone";
}

function severityLabel(severity: number, t: ThemeTokens): { text: string; color: string } {
  switch (severity) {
    case 1:
      return { text: "ERR", color: t.error };
    case 2:
      return { text: "WRN", color: t.warning };
    case 3:
      return { text: "INF", color: t.info };
    case 4:
      return { text: "HNT", color: t.textMuted };
    default:
      return { text: "ERR", color: t.error };
  }
}

function shortCommand(cmd: string): string {
  return cmd.split("/").pop() ?? cmd;
}

function shortPath(path: string, maxLen: number): string {
  if (path.length <= maxLen) return path;
  const home = process.env.HOME ?? "";
  if (home && path.startsWith(home)) {
    const rel = `~${path.slice(home.length)}`;
    if (rel.length <= maxLen) return rel;
    return `…${rel.slice(-(maxLen - 1))}`;
  }
  return `…${path.slice(-(maxLen - 1))}`;
}

interface ServerRow extends GroupedItem {
  detail: LspServerDetail | null;
  /** A server of a project language that is not running, from the shared LSP status. */
  idle?: LspServerView;
}

/** What `/lsp status`, `baked lsp status` and the desktop app call a server that is not running. */
function idleState(server: LspServerView): string {
  if (server.disabled) return "disabled";
  if (!server.installed)
    return server.installable ? "not installed · /lsp to install" : "not installed";
  if (server.lastError) return `failed: ${server.lastError.message}`;
  return "installed · starts on first use";
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function LspStatusPopup({ visible, onClose }: Props) {
  const t = useTheme();
  const { width: tw, height: th } = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [detailIdx, setDetailIdx] = useState<number | null>(null);
  const [servers, setServers] = useState<LspServerDetail[]>([]);
  const [project, setProject] = useState<LspServerView[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);
  const detailOffset = useRef(0);

  const bgErrors = useErrorStore((s) => s.errors);
  const lspErrors = useMemo(() => bgErrors.filter((e) => e.source.startsWith("LSP:")), [bgErrors]);

  const popupW = fitPopupWidth(Math.min(110, Math.max(72, Math.floor(tw * 0.8))), tw);
  const popupH = fitPopupHeight(Math.min(30, Math.max(16, th - 4)), th);
  const contentW = Math.max(1, popupW - 6);

  useEffect(() => {
    if (!visible) return;
    setCursor(0);
    setDetailIdx(null);
    detailOffset.current = 0;

    const poll = async () => {
      const sd: LspServerDetail[] = (await getDetailedLspServers()).map((s) => ({
        ...s,
        backend: "standalone" as const,
      }));
      setServers(sd);
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    // The full status scans the project, so it loads once per open and after a restart.
    lspStatus({ workspace: getCwd() })
      .then((status) => setProject(status.servers.filter((s) => s.detected)))
      .catch(() => {});
    return () => clearInterval(id);
  }, [visible]);

  const groups = useMemo<GroupedListGroup<ServerRow>[]>(() => {
    const items: ServerRow[] = [];
    for (const s of servers) {
      items.push({
        id: `s-${s.language}-${s.pid ?? ""}`,
        detail: s,
        label: shortCommand(s.command),
        meta: `${s.language} · ${s.backend}${s.diagnosticCount > 0 ? ` · ${s.diagnosticCount} diag` : ""}`,
        status: s.ready ? "online" : "warning",
      });
    }

    const running = new Set(
      servers.map((s) => shortCommand(s.command).replace(/\.(exe|cmd)$/i, "")),
    );
    const idle: ServerRow[] = project
      .filter((s) => !running.has(s.id))
      .map((s) => ({
        id: `p-${s.id}`,
        detail: null,
        idle: s,
        label: s.id,
        meta: `${s.languages.join(", ")} · ${idleState(s)}`,
        status: s.disabled ? "offline" : !s.installed ? "idle" : s.lastError ? "error" : "idle",
      }));

    return [
      { id: "lsp", label: "Servers", hideHeader: true, items },
      ...(idle.length ? [{ id: "project", label: "Not running", items: idle }] : []),
    ];
  }, [servers, project]);

  const rows = useMemo(() => buildGroupedRows(groups, new Set(["lsp", "project"])), [groups]);

  const inDetail = detailIdx !== null;
  const selectedRow = inDetail ? (rows[detailIdx]?.item as ServerRow | undefined) : undefined;
  const selectedServer = selectedRow?.detail ?? null;

  const detailLines = useMemo<InfoLineData[]>(() => {
    if (!selectedServer) return [];
    const lines: InfoLineData[] = [
      { type: "header", label: "Server" },
      { type: "entry", label: "Command", desc: selectedServer.command },
    ];
    if (selectedServer.args.length > 0) {
      lines.push({ type: "entry", label: "Args", desc: selectedServer.args.join(" ") });
    }
    lines.push(
      { type: "entry", label: "PID", desc: String(selectedServer.pid ?? "N/A") },
      { type: "entry", label: "Status", desc: selectedServer.ready ? "Running" : "Starting" },
      { type: "spacer" },
      { type: "header", label: "Workspace" },
      { type: "entry", label: "Root", desc: selectedServer.cwd },
      { type: "entry", label: "Open files", desc: String(selectedServer.openFiles) },
      { type: "spacer" },
      { type: "header", label: "Diagnostics" },
    );
    if (selectedServer.diagnostics.length === 0) {
      lines.push({ type: "text", label: "  No diagnostics", color: t.textMuted });
    } else {
      for (const d of selectedServer.diagnostics) {
        const sev = severityLabel(d.severity, t);
        lines.push({
          type: "text",
          label: `  [${sev.text}] ${shortPath(d.file, 30)}: ${d.message}`,
          color: sev.color,
        });
      }
    }
    const serverErrors = lspErrors.filter((e) =>
      e.source.includes(shortCommand(selectedServer.command)),
    );
    if (serverErrors.length > 0) {
      lines.push({ type: "spacer" }, { type: "header", label: "Recent Errors" });
      for (const e of serverErrors.slice(0, 10)) {
        lines.push({ type: "text", label: `  ${e.message}`, color: t.error });
      }
    }
    return lines;
  }, [selectedServer, lspErrors, t]);

  const detailRows = Math.max(6, popupH - 9);

  useKeyboard((evt) => {
    if (!visible) return;

    if (inDetail) {
      if (evt.name === "escape") {
        setDetailIdx(null);
        detailOffset.current = 0;
        evt.preventDefault();
        return;
      }
      if (evt.name === "up" || evt.name === "k") {
        const n = Math.max(0, detailOffset.current - 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        evt.preventDefault();
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        const maxOff = Math.max(0, detailLines.length - detailRows);
        const n = Math.min(maxOff, detailOffset.current + 1);
        detailOffset.current = n;
        detailScrollRef.current?.scrollTo(n);
        evt.preventDefault();
        return;
      }
      evt.preventDefault();
      return;
    }

    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "r") {
      const r = rows[cursor];
      const item = r?.kind === "item" ? (r.item as ServerRow) : undefined;
      const id = item?.idle?.id ?? (item?.detail ? shortCommand(item.detail.command) : undefined);
      setNotice(`Restarting ${id ?? "all servers"}…`);
      restartLspServer({ workspace: getCwd() }, id?.replace(/\.(exe|cmd)$/i, ""))
        .then((result) => {
          setProject(result.status.servers.filter((s) => s.detected));
          setNotice(
            result.restarted.length
              ? `Restarted ${result.restarted.join(", ")}`
              : "Nothing was running; servers start on the next code lookup",
          );
        })
        .catch((error: unknown) =>
          setNotice(error instanceof Error ? error.message : String(error)),
        );
      evt.preventDefault();
      return;
    }
    if (evt.name === "return") {
      const r = rows[cursor];
      if (r?.kind === "item" && (r.item as ServerRow).detail) {
        setDetailIdx(cursor);
      }
      evt.preventDefault();
      return;
    }
    handleCursorNavKey(evt, setCursor, rows.length);
    evt.preventDefault();
  });

  if (!visible) return null;

  if (inDetail && selectedServer) {
    return (
      <PremiumPopup
        visible={visible}
        width={popupW}
        height={popupH}
        title={shortCommand(selectedServer.command)}
        titleIcon="code"
        blurb={`${selectedServer.language} · ${selectedServer.ready ? "running" : "starting"} · pid ${selectedServer.pid ?? "n/a"}`}
        status={selectedServer.ready ? "online" : "warning"}
        footerHints={[
          { key: "↑↓", label: "scroll" },
          { key: "Esc", label: "back" },
        ]}
      >
        <Section>
          <scrollbox ref={detailScrollRef} height={detailRows} scrollAcceleration={listScrollAccel}>
            {detailLines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: positional
              <InfoLine key={`d-${i}`} line={line} width={contentW} />
            ))}
          </scrollbox>
        </Section>
      </PremiumPopup>
    );
  }

  const blurb =
    notice ??
    `${servers.length} running${lspErrors.length > 0 ? ` · ${lspErrors.length} errors` : ""}`;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={popupH}
      title="Language Servers"
      titleIcon="code"
      blurb={blurb}
      footerHints={[
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "detail" },
        { key: "r", label: "restart" },
        { key: "Esc", label: "close" },
      ]}
    >
      <Section>
        {rows.length === 0 ? (
          <box flexDirection="row" paddingX={2} paddingY={1}>
            <text bg={t.bgPopup} fg={t.textMuted}>
              · No language servers running
            </text>
          </box>
        ) : (
          <GroupedList
            groups={groups}
            expanded={new Set(["lsp", "project"])}
            selectedIndex={cursor}
            width={contentW}
            maxRows={Math.max(4, popupH - 9)}
          />
        )}
      </Section>
    </PremiumPopup>
  );
}

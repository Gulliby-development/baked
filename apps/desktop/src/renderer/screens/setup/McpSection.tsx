import { useEffect, useState } from "react";
import {
  type McpScope,
  type McpServer,
  type McpTransport,
  type McpView,
  mcp,
} from "../../client/mcp.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Dot } from "../../components/ui/dot.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import type { SectionProps } from "../sections.js";
import {
  draftFrom,
  draftProblem,
  draftServer,
  EMPTY_DRAFT,
  type McpDraft,
  STATUS_LABEL,
  STATUS_TONE,
  serverTarget,
} from "./mcp-logic.js";
import {
  ACTIONS,
  errorText,
  FIELD_HALF,
  FL,
  FORM,
  GROW,
  LIST,
  LoadState,
  NOTE,
  PAIR,
  ROW,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

/** How often the list refreshes while a server is connecting. */
const POLL_MS = 1500;
const FOOTER = "flex flex-wrap justify-end gap-2";

const SCOPES: [McpScope, string, string][] = [
  ["project", "This project", "Saved in .baked/config.json of this project."],
  ["global", "All projects", "Saved in your user config; every project gets it."],
];
const TRANSPORTS: [McpTransport, string][] = [
  ["stdio", "Command"],
  ["http", "HTTP"],
  ["sse", "SSE"],
];

type Dialogs =
  | { kind: "add" }
  | { kind: "edit"; server: McpServer }
  | { kind: "remove"; server: McpServer }
  | { kind: "tools"; server: McpServer };

function ServerForm({
  initial,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: McpDraft;
  busy: boolean;
  error: string | null;
  onSave: (draft: McpDraft) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [tried, setTried] = useState(false);
  const problem = draftProblem(draft);
  const set = (field: keyof McpDraft) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [field]: e.target.value }));
  const stdio = draft.transport === "stdio";
  return (
    <form
      className={FORM}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!problem) onSave(draft);
      }}
    >
      <div className={FL}>
        <label htmlFor="mcp-name">Name</label>
        <Input
          id="mcp-name"
          value={draft.name}
          onChange={set("name")}
          placeholder="github"
          disabled={busy}
          autoFocus
        />
        <span className={cn("text-dim-foreground", NOTE)}>
          Agents see its tools as{" "}
          <span className="font-mono">mcp__{draft.name || "name"}__tool</span>.
        </span>
      </div>
      <div className={PAIR}>
        <div className={FIELD_HALF}>
          <span id="mcp-scope">Saved for</span>
          <SegmentGroup aria-labelledby="mcp-scope">
            {SCOPES.map(([value, label]) => (
              <Segment
                key={value}
                type="button"
                aria-pressed={draft.scope === value}
                disabled={busy}
                onClick={() => setDraft((d) => ({ ...d, scope: value }))}
              >
                {label}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
        <div className={FIELD_HALF}>
          <span id="mcp-transport">Transport</span>
          <SegmentGroup aria-labelledby="mcp-transport">
            {TRANSPORTS.map(([value, label]) => (
              <Segment
                key={value}
                type="button"
                aria-pressed={draft.transport === value}
                disabled={busy}
                onClick={() => setDraft((d) => ({ ...d, transport: value }))}
              >
                {label}
              </Segment>
            ))}
          </SegmentGroup>
        </div>
      </div>
      <span className={cn("text-dim-foreground", NOTE)}>
        {SCOPES.find(([s]) => s === draft.scope)?.[2]}
      </span>
      {stdio ? (
        <>
          <div className={FL}>
            <label htmlFor="mcp-command">Command</label>
            <Input
              id="mcp-command"
              className="font-mono"
              value={draft.command}
              onChange={set("command")}
              placeholder="npx"
              disabled={busy}
            />
          </div>
          <div className={FL}>
            <label htmlFor="mcp-args">Arguments</label>
            <Input
              id="mcp-args"
              className="font-mono"
              value={draft.args}
              onChange={set("args")}
              placeholder="-y @modelcontextprotocol/server-github"
              disabled={busy}
            />
          </div>
        </>
      ) : (
        <>
          <div className={FL}>
            <label htmlFor="mcp-url">URL</label>
            <Input
              id="mcp-url"
              className="font-mono"
              value={draft.url}
              onChange={set("url")}
              placeholder="https://mcp.example.com/mcp"
              disabled={busy}
            />
          </div>
          <div className={FL}>
            <label htmlFor="mcp-headers">Headers, one KEY=value per line</label>
            <Textarea
              id="mcp-headers"
              className="font-mono"
              rows={2}
              value={draft.headers}
              onChange={set("headers")}
              placeholder="Authorization=Bearer …"
              disabled={busy}
            />
          </div>
        </>
      )}
      <div className={PAIR}>
        <div className={cn(FIELD_HALF, "flex-[3_1_260px]")}>
          <label htmlFor="mcp-env">Environment, one KEY=value per line</label>
          <Textarea
            id="mcp-env"
            className="font-mono"
            rows={2}
            value={draft.env}
            onChange={set("env")}
            placeholder="GITHUB_TOKEN=…"
            disabled={busy}
          />
        </div>
        <div className={FIELD_HALF}>
          <label htmlFor="mcp-timeout">Tool call timeout, s</label>
          <Input
            id="mcp-timeout"
            inputMode="numeric"
            value={draft.timeout}
            onChange={set("timeout")}
            placeholder="30"
            disabled={busy}
          />
        </div>
      </div>
      {tried && problem && <Alert tone="error">{problem}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      <div className={FOOTER}>
        <Button type="button" variant="secondary" size="md" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function ServerRow({
  server,
  busy,
  onToggle,
  onReconnect,
  onOpen,
}: {
  server: McpServer;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onReconnect: () => void;
  onOpen: (dialog: Dialogs) => void;
}) {
  const off = server.status === "disabled";
  const env = Object.keys(server.config.env ?? {});
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] text-soft-foreground">
      <div className={ROW}>
        <Switch
          aria-label={`${off ? "Turn on" : "Turn off"} ${server.name}`}
          checked={!off}
          disabled={busy}
          onCheckedChange={(checked) => onToggle(checked)}
        />
        <span className={cn(GROW, "flex flex-col gap-0.5")}>
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono font-semibold text-foreground">{server.name}</span>
            <Tag>{server.transport}</Tag>
            {server.overridesGlobal && <Tag>replaces global</Tag>}
          </span>
          <span className={cn(WRAP, "font-mono text-[12px] text-dim-foreground")}>
            {serverTarget(server.config)}
            {env.length > 0 && ` · env ${env.join(", ")}`}
          </span>
        </span>
        <span className="flex items-center gap-2 whitespace-nowrap">
          <Dot tone={STATUS_TONE[server.status]} />
          {STATUS_LABEL[server.status]}
          {server.status === "ready" && (
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 font-mono text-[12px] text-dim-foreground underline [font-family:inherit]"
              onClick={() => onOpen({ kind: "tools", server })}
            >
              {server.tools.length} {server.tools.length === 1 ? "tool" : "tools"}
            </button>
          )}
        </span>
        <span className={ACTIONS}>
          {!off && (
            <Button
              variant="secondary"
              size="md"
              disabled={busy || server.status === "connecting"}
              onClick={onReconnect}
            >
              {server.status === "idle" ? "Connect" : "Reconnect"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="md"
            disabled={busy}
            onClick={() => onOpen({ kind: "edit", server })}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            size="md"
            aria-label={`Remove ${server.name}`}
            disabled={busy}
            onClick={() => onOpen({ kind: "remove", server })}
          >
            Remove
          </Button>
        </span>
      </div>
      {server.error && (
        <span className={cn(WRAP, "text-[12px] text-[var(--err)]")}>{server.error}</span>
      )}
    </li>
  );
}

function Group({
  label,
  about,
  servers,
  replaced = [],
  ...row
}: {
  label: string;
  about: string;
  servers: McpServer[];
  /** Names of servers in this group that a project server of the same name replaces. */
  replaced?: string[];
} & Omit<Parameters<typeof ServerRow>[0], "server" | "onToggle" | "onReconnect"> & {
    onToggle: (server: McpServer, enabled: boolean) => void;
    onReconnect: (server: McpServer) => void;
  }) {
  return (
    <section aria-label={label} className={STACK}>
      <h2 className={LABEL}>
        {label} · {servers.length + replaced.length}
      </h2>
      <span className={cn("text-dim-foreground", NOTE)}>{about}</span>
      {servers.length + replaced.length === 0 ? (
        <Empty className="p-4 text-[13px]">None yet.</Empty>
      ) : (
        <ul className={cn(PANEL, LIST, "p-0")}>
          {replaced.map((name) => (
            <li
              key={`replaced/${name}`}
              className="flex items-center gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] text-dim-foreground opacity-60"
            >
              <span className="font-mono font-semibold">{name}</span>
              <Tag>replaced here</Tag>
              <span className={NOTE}>This project's server of the same name is used instead.</span>
            </li>
          ))}
          {servers.map((server) => (
            <ServerRow
              key={`${server.scope}/${server.name}`}
              server={server}
              busy={row.busy}
              onOpen={row.onOpen}
              onToggle={(enabled) => row.onToggle(server, enabled)}
              onReconnect={() => row.onReconnect(server)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * MCP servers of the project and global config with their status and tools: the same as `/mcp`
 * in the terminal, through `/v1/mcp*` of the project's backend.
 */
export function McpSection({ project }: SectionProps) {
  const [list, reload, setList] = useLoad(() => mcp.list(project.key), [project.key, "mcp"]);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; failed?: boolean } | null>(null);

  const connecting =
    list.state === "ready" && list.data.servers.some((s) => s.status === "connecting");
  useEffect(() => {
    if (!connecting) return;
    const timer = setTimeout(reload, POLL_MS);
    return () => clearTimeout(timer);
  }, [connecting, reload]);

  const close = () => {
    if (!busy) setDialog(null);
  };
  const act = async (work: () => Promise<McpView>, done: string | null, closeDialog = true) => {
    setBusy(true);
    setError(null);
    try {
      setList(await work());
      setNotice(done ? { text: done } : null);
      if (closeDialog) setDialog(null);
    } catch (e) {
      if (closeDialog && dialog) setError(errorText(e));
      else setNotice({ text: errorText(e), failed: true });
    } finally {
      setBusy(false);
    }
  };

  if (list.state !== "ready") return <LoadState value={list} what="MCP servers" />;
  const { servers, started } = list.data;
  const rowProps = {
    busy,
    onOpen: (next: Dialogs) => {
      setError(null);
      setDialog(next);
    },
    onToggle: (server: McpServer, enabled: boolean) =>
      void act(
        () => mcp.setDisabled(project.key, server.scope, server.name, !enabled),
        `${enabled ? "Turned on" : "Turned off"} ${server.name}.`,
        false,
      ),
    onReconnect: (server: McpServer) =>
      void act(() => mcp.reconnect(project.key, server.name), null, false),
  };

  return (
    <div className={SETUP}>
      <div className={ROW}>
        <p className={cn(LEDE, GROW)}>
          MCP servers give agents more tools, named{" "}
          <span className="font-mono">mcp__server__tool</span>. A project server with the same name
          as a global one replaces it here. Workflow runs use only the MCP tools their profile and
          policy grant.
        </p>
        <Button
          variant="primary"
          size="md"
          onClick={() => {
            setError(null);
            setDialog({ kind: "add" });
          }}
        >
          Add server
        </Button>
      </div>
      {!started && servers.some((s) => s.status === "idle") && (
        <Alert>
          Servers connect with the first chat message or run step. Connect one now to check it and
          see its tools.
        </Alert>
      )}
      {notice && <Alert tone={notice.failed ? "error" : undefined}>{notice.text}</Alert>}
      <Group
        label="In this project"
        about="In .baked/config.json of this project."
        servers={servers.filter((s) => s.scope === "project")}
        {...rowProps}
      />
      <Group
        label="Global"
        about="In your user config; every project gets them."
        servers={servers.filter((s) => s.scope === "global")}
        replaced={servers.filter((s) => s.overridesGlobal).map((s) => s.name)}
        {...rowProps}
      />

      <Dialog open={dialog !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent
          className={dialog?.kind === "tools" ? "w-[min(720px,calc(100vw-32px))]" : ""}
        >
          {(dialog?.kind === "add" || dialog?.kind === "edit") && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog.kind === "add" ? "Add MCP server" : `Edit ${dialog.server.name}`}
                </DialogTitle>
                <DialogDescription>
                  {dialog.kind === "add"
                    ? "BAKED connects it when a chat or run needs it, or when you press Connect."
                    : "Saving reconnects the server when it was connected."}
                </DialogDescription>
              </DialogHeader>
              <ServerForm
                initial={
                  dialog.kind === "edit"
                    ? draftFrom(dialog.server.config, dialog.server.scope)
                    : EMPTY_DRAFT
                }
                busy={busy}
                error={error}
                onCancel={close}
                onSave={(draft) => {
                  const server = draftServer(draft);
                  void act(
                    () =>
                      dialog.kind === "add"
                        ? mcp.add(project.key, draft.scope, server)
                        : mcp.edit(
                            project.key,
                            dialog.server.scope,
                            dialog.server.name,
                            server,
                            draft.scope,
                          ),
                    dialog.kind === "add" ? `Added ${server.name}.` : `Saved ${server.name}.`,
                  );
                }}
              />
            </>
          )}
          {dialog?.kind === "tools" && (
            <>
              <DialogHeader>
                <DialogTitle>{`Tools of ${dialog.server.name}`}</DialogTitle>
                <DialogDescription>
                  {dialog.server.tools.length} tools, offered to agents as{" "}
                  <span className="font-mono">mcp__{dialog.server.name}__…</span>
                </DialogDescription>
              </DialogHeader>
              <ul className={cn(PANEL, LIST, "min-h-0 flex-1 overflow-auto p-0")}>
                {dialog.server.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex flex-col gap-0.5 border-b border-[var(--line)] px-[14px] py-[9px] text-[13px]"
                  >
                    <span className="font-mono font-semibold text-foreground">{tool.name}</span>
                    {tool.description && (
                      <span className={cn(WRAP, "text-muted-foreground")}>{tool.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {dialog?.kind === "remove" && (
            <>
              <DialogHeader>
                <DialogTitle>{`Remove ${dialog.server.name}?`}</DialogTitle>
                <DialogDescription>
                  Deletes it from{" "}
                  {dialog.server.scope === "global"
                    ? "your user config, for every project"
                    : "this project's config"}
                  .
                  {dialog.server.overridesGlobal &&
                    " The global server with the same name takes its place."}
                </DialogDescription>
              </DialogHeader>
              {error && <Alert tone="error">{error}</Alert>}
              <div className={FOOTER}>
                <Button variant="secondary" size="md" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => mcp.remove(project.key, dialog.server.scope, dialog.server.name),
                      `Removed ${dialog.server.name}.`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

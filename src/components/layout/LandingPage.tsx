import { useEffect, useState } from "react";
import { icon } from "../../core/icons.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { useTheme } from "../../core/theme/index.js";
import { BUN_WIDTH } from "../../core/utils/bake-art.js";
import { useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { useMCPStore } from "../../stores/mcp.js";
import { useRepoMapStore } from "../../stores/repomap.js";
import { BunMascot } from "../brand/BunMascot.js";
import { BrutalBox } from "../ui/BrutalBox.js";

// ── Status block — model on top (colored), info below (muted) ───────

function StatusBlock() {
  const tk = useTheme();

  // Live repo map / LSP status
  const [repoState, setRepoState] = useState(() => {
    const s = useRepoMapStore.getState();
    return { status: s.status, lspStatus: s.lspStatus };
  });

  useEffect(
    () =>
      useRepoMapStore.subscribe((s) => {
        setRepoState((prev) => {
          if (prev.status === s.status && prev.lspStatus === s.lspStatus) return prev;
          return { status: s.status, lspStatus: s.lspStatus };
        });
      }),
    [],
  );

  // Live MCP server count
  const mcpReady = useMCPStore((s) => {
    let count = 0;
    for (const srv of Object.values(s.servers)) {
      if (srv.status === "ready") count++;
    }
    return count;
  });

  const { status, lspStatus } = repoState;

  // Only surface BakeMap / LSP errors — scanning/generating are silent.
  let mapNode: React.ReactNode;
  if (status === "error") {
    mapNode = (
      <text key="map">
        <span fg={tk.error}>{icon("error")}</span>
        <span fg={tk.error}> Baked Map</span>
      </text>
    );
  }

  let lspNode: React.ReactNode;
  if (lspStatus === "error") {
    lspNode = (
      <text key="lsp">
        <span fg={tk.error}>{icon("error")}</span>
        <span fg={tk.error}> LSP</span>
      </text>
    );
  }

  // MCP only shown when ready (informational — keep)
  let mcpNode: React.ReactNode;
  if (mcpReady > 0) {
    mcpNode = (
      <text key="mcp">
        <span fg={tk.success}>{icon("check")}</span>
        <span fg={tk.textSecondary}> {String(mcpReady)} MCP</span>
      </text>
    );
  }

  const parts = [mapNode, lspNode, mcpNode].filter(Boolean);
  const joined: React.ReactNode[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      joined.push(
        <text key={`sep-${String(i)}`} fg={tk.textFaint}>
          {"  │  "}
        </text>,
      );
    }
    joined.push(parts[i]);
  }

  return (
    <box flexDirection="column" alignItems="center" gap={0}>
      {joined.length > 0 && (
        <box flexDirection="row" gap={0} justifyContent="center">
          {joined}
        </box>
      )}
    </box>
  );
}

// ── Start card: what to do first ─────────────────────────────────────

const CARD_WIDTH = 56;

function KeyRow({ keys }: { keys: [string, string][] }) {
  const tk = useTheme();
  return (
    <box flexDirection="row" height={1}>
      {keys.map(([key, label]) => (
        <text key={key} wrapMode="none">
          <span fg={tk.bgApp} bg={tk.textPrimary}>{` ${key} `}</span>
          <span fg={tk.textSecondary}>{` ${label}  `}</span>
        </text>
      ))}
    </box>
  );
}

function StartCard({ hasModel }: { hasModel: boolean }) {
  const tk = useTheme();
  return (
    <BrutalBox width={CARD_WIDTH} height={5} title="START HERE">
      {hasModel ? (
        <KeyRow keys={[["Enter", "ask about this project or give a task"]]} />
      ) : (
        <text wrapMode="none">
          <span fg={tk.bgApp} bg={tk.error}>
            {" ^L "}
          </span>
          <span fg={tk.error}>{" No model yet: pick one to start"}</span>
        </text>
      )}
      <KeyRow
        keys={[
          ["/", "commands"],
          ["@", "attach a file"],
          ["!", "run a command"],
        ]}
      />
      <KeyRow
        keys={[
          ["^P", "resume a session"],
          ["^K", "palette"],
        ]}
      />
    </BrutalBox>
  );
}

// ── Main landing page ───────────────────────────────────────────────

interface LandingPageProps {
  bootProviders: ProviderStatus[];
  bootPrereqs: PrerequisiteStatus[];
  activeModel?: string;
}

export function LandingPage({
  bootProviders: _bp,
  bootPrereqs: _bq,
  activeModel,
}: LandingPageProps) {
  const tk = useTheme();
  const { width, height } = useTerminalDimensions();
  const columns = width ?? 80;
  const rows = height ?? 24;

  const showCard = columns >= CARD_WIDTH + 4 && rows >= 16;
  const showBun = columns >= BUN_WIDTH + 2 && rows >= (showCard ? 20 : 14);
  const hasModel = Boolean(activeModel && activeModel !== "none");

  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} overflow="hidden">
      {/* Flexible top spacer: absorbs extra height so the content stack below always sits
          flush against the input. When the input grows, this shrinks first. */}
      <box flexGrow={1} flexShrink={1} minHeight={0} />

      <box flexDirection="column" alignItems="center" gap={0} flexShrink={0} zIndex={1}>
        {showBun && <BunMascot mood="idle" />}
        {showCard ? (
          <StartCard hasModel={hasModel} />
        ) : (
          <text fg={hasModel ? tk.textMuted : tk.error}>
            {hasModel ? "Ask anything · / for commands" : "No model yet · ^L to pick one"}
          </text>
        )}

        {/* Status line: only appears when something is wrong */}
        <StatusBlock />
      </box>
    </box>
  );
}

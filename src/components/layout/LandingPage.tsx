import { useEffect, useState } from "react";
import { getCwd } from "../../core/cwd.js";
import { icon } from "../../core/icons.js";
import type { ProviderStatus } from "../../core/llm/provider.js";
import type { PrerequisiteStatus } from "../../core/setup/prerequisites.js";
import { useTheme } from "../../core/theme/index.js";
import { BUN_WIDTH } from "../../core/utils/bake-art.js";
import { agentOrigins, listAgents } from "../../core/workflows/agent-import.js";
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

// ── Agents card: only in a project that brought agents from other tools ──

/** The track an agent glyph travels along, toward the workflow's stations. */
const TRACK = 14;

/**
 * Shown only when the project already has custom agents (#832): BAKED is customized through
 * workflows, so the card points at `/agents`, which turns them into one. A small glyph runs
 * from the agents to the workflow while the page is open.
 */
export function AgentsCard({ count, origins }: { count: number; origins: string }) {
  const tk = useTheme();
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStep((s) => (s + 1) % (TRACK + 4)), 160);
    return () => clearInterval(timer);
  }, []);
  const at = Math.min(step, TRACK - 1);
  const arrived = step >= TRACK;
  const track = Array.from({ length: TRACK }, (_, i) => (i === at && !arrived ? "◆" : "─")).join(
    "",
  );
  return (
    <BrutalBox width={CARD_WIDTH} height={5} title="YOUR AGENTS">
      <text wrapMode="none" fg={tk.textSecondary}>
        {`${String(count)} agent${count === 1 ? "" : "s"} from ${origins} in this project`}
      </text>
      <text wrapMode="none">
        <span fg={tk.textMuted}>{"agents "}</span>
        <span fg={tk.textFaint}>{track}</span>
        <span fg={arrived ? tk.success : tk.textMuted}>{" ▣ workflow"}</span>
      </text>
      <KeyRow keys={[["/agents", "turn them into a workflow"]]} />
    </BrutalBox>
  );
}

/** The project's agents for the card, read once per landing page. */
function useProjectAgents(): { count: number; origins: string } {
  const [found] = useState(() => {
    try {
      const { agents } = listAgents(getCwd());
      return { count: agents.length, origins: agentOrigins(agents) };
    } catch {
      return { count: 0, origins: "" };
    }
  });
  return found;
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
  const agents = useProjectAgents();
  const showAgents = showCard && agents.count > 0 && rows >= (showBun ? 26 : 20);

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

        {showAgents && <AgentsCard count={agents.count} origins={agents.origins} />}

        {/* Status line: only appears when something is wrong */}
        <StatusBlock />
      </box>
    </box>
  );
}

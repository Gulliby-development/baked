export interface TaskRouter {
  /** Model for ⚡ spark agents — explore/investigate. */
  spark: string | null;
  /** Model for 🔥 ember agents — code edits. */
  ember: string | null;
  webSearch: string | null;
  desloppify: string | null;
  verify: string | null;
  compact: string | null;
  semantic: string | null;
  default: string | null;
  /** Max concurrent dispatch agents. Default: 3. Range: 2–8. */
  maxConcurrentAgents?: number;
  /** @config-compat Legacy fields — mapped to spark/ember on load. Hidden from /router UI. */
  coding?: string | null;
  exploration?: string | null;
  trivial?: string | null;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  /** Which intelligence backend handled this (ts-morph, lsp, tree-sitter, regex) */
  backend?: string;
  /** True when read returned only an outline (large file) — tracker should not cache this as a full read */
  outlineOnly?: boolean;
  /** Files edited by dispatch tool — used by /changes panel to track per-tab edits */
  filesEdited?: string[];
}

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

interface PlanStep {
  id: string;
  label: string;
  status: PlanStepStatus;
  startedAt?: number;
}

export type PlanDepth = "light" | "full";

export interface Plan {
  title: string;
  steps: PlanStep[];
  createdAt: number;
  depth: PlanDepth;
}

interface PlanSymbolChange {
  name: string;
  kind: string;
  action: "add" | "modify" | "remove" | "rename";
  details: string;
  line?: number;
}

interface PlanFileChange {
  path: string;
  action: "create" | "modify" | "delete";
  description: string;
  symbols?: PlanSymbolChange[];
}

export interface PlanOutput {
  title: string;
  context: string;
  files: PlanFileChange[];
  steps: Array<{ id: string; label: string; details?: string }>;
  verification: string[];
}

interface QuestionOption {
  label: string;
  value: string;
  description?: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options: QuestionOption[];
  allowSkip: boolean;
  resolve: (answer: string) => void;
  /** Permission prompts (web access, outside-cwd, destructive) — answer shown in UI but not sent as steering. */
  isPermission?: boolean;
  /** Hide the "Other" free-text option — only show the listed options. */
  hideOther?: boolean;
}

export type PlanReviewAction = "execute" | "clear_execute" | "cancel" | string;

export interface PendingPlanReview {
  plan: Plan;
  planFile: string;
  planContent: string;
  resolve: (action: PlanReviewAction) => void;
}

export interface InteractiveCallbacks {
  onPlanCreate: (plan: Plan) => void;
  onPlanStepUpdate: (stepId: string, status: PlanStepStatus) => void;
  onPlanReview: (plan: Plan, planFile: string, planContent: string) => Promise<PlanReviewAction>;
  onAskUser: (question: string, options: QuestionOption[], allowSkip: boolean) => Promise<string>;
  onWebSearchApproval: (query: string) => Promise<boolean>;
  onFetchPageApproval: (url: string) => Promise<boolean>;
}

export interface QueuedMessage {
  content: string;
  queuedAt: number;
  images?: ImageAttachment[];
  /** How the turn is submitted; watch mode queues its turns with these. */
  options?: SubmitOptions;
}

export interface SubmitOptions {
  /** Shown as the user message instead of `input`; the model still gets `input`. */
  display?: string;
  /** Send `input` as is: no custom slash command, `@` mention or `!command` expansion. */
  verbatim?: boolean;
}

export type MessageSegment =
  | { type: "text"; content: string }
  | { type: "tools"; toolCallIds: string[] }
  | { type: "reasoning"; content: string; id: string }
  | { type: "plan"; plan: Plan };

export interface ImageAttachment {
  /** Sequential label shown in chat, e.g. "image-1" */
  label: string;
  /** Base64-encoded image data */
  base64: string;
  /** IANA media type */
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  /** Ordered segments for interleaved text/tool rendering. */
  segments?: MessageSegment[];
  /** When true, system messages render inline in chat instead of the ephemeral banner. */
  showInChat?: boolean;
  /** Marks a user message injected via steering (sent while AI was working). */
  isSteering?: boolean;
  /** How long the assistant response took (ms). Set when the response completes. */
  durationMs?: number;
  /** Attached images (pasted from clipboard or referenced by path). */
  images?: ImageAttachment[];
  /** True when the model called `final_response()` to mark the answer boundary.
   *  When true, text segments after the last `tools` segment stream as the final
   *  answer; the rest renders as a collapsed rail. */
  finalResponseCalled?: boolean;
  /** What the message's `@` mentions and `!` command added to the context. */
  inputContext?: InputContextItem[];
}

/** One `@` mention or `!` command of a user message and what it attached. */
export interface InputContextItem {
  kind: "file" | "directory" | "symbol" | "command";
  /** The mention target or the command as typed. */
  ref: string;
  ok: boolean;
  /** A short line such as "120 lines", "ran" or "not found". */
  summary: string;
  /** The start of the command output, for display. */
  output?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  /** Image art for inline display. Half-block ANSI art or Kitty graphics placeholders. */
  imageArt?: Array<{
    name: string;
    lines: string[];
    kittyImageId?: number;
    kittyCols?: number;
    kittyRows?: number;
  }>;
  /** Parent code_execution tool call ID — set when this tool was called from code execution. */
  parentId?: string;
}

interface CodeIntelligenceConfig {
  backend?: "auto" | "ts-morph" | "tree-sitter" | "regex";
  language?: string;
}

export type ThinkingMode = "off" | "adaptive" | "enabled" | "disabled" | "auto";

interface ThinkingConfig {
  /** "auto" enables adaptive thinking for Anthropic models. Default: "auto" */
  mode: ThinkingMode;
  /** Budget tokens — only used when mode is "enabled". Min 1024. */
  budgetTokens?: number;
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** A chat's reasoning effort: `default` follows the global `performance` settings. */
export type ChatEffort = EffortLevel | "default";

type OpenAIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ServiceTier = "auto" | "flex" | "priority" | "default";
export type CompatReasoningEffort = "off" | "low" | "medium" | "high" | "xhigh";

export interface PerformanceConfig {
  /** Effort level for model reasoning. "off" = not sent to API. */
  effort?: EffortLevel | "off";
  /** Speed mode — "fast" enables 2.5x output for Opus 4.6. "off" = not sent to API. */
  speed?: "off" | "fast" | "standard";
  /** Disable parallel tool calls — model calls one tool at a time. */
  disableParallelToolUse?: boolean;
  /** Send reasoning content in requests. Default: true. */
  sendReasoning?: boolean;
  /** Stream tool call arguments incrementally. Default: true. Set false to receive complete tool calls. */
  toolStreaming?: boolean;
  /** OpenAI reasoning effort for o3/o4/gpt-5 models. "off" = not sent. */
  openaiReasoningEffort?: OpenAIReasoningEffort | "off";
  /** OpenAI service tier — "flex" saves 50% with latency trade-off. */
  serviceTier?: ServiceTier | "off";
  /** OpenAI reasoning summary level — "detailed" | "auto" | "off" */
  openaiReasoningSummary?: "off" | "auto" | "detailed";
  /** OpenAI gpt-5 verbosity — controls answer length. */
  openaiVerbosity?: "off" | "low" | "medium" | "high";

  compatReasoningEffort?: CompatReasoningEffort;
}

type PruningTarget = "none" | "main" | "subagents" | "both";

export interface ContextManagementConfig {
  /** Enable server-side context compaction for 200K+ models */
  compact?: boolean;
  /** Clear old tool use results server-side (triggers at 65% context window, busts cache) */
  clearToolUses?: boolean;
  /** Preserve thinking blocks with keep:"all" for cache stability (default: on) */
  clearThinking?: boolean;
  /** @deprecated Use pruningTarget instead */
  disablePruning?: boolean;
  /** Which agents get tool result pruning: none | main | subagents | both. Default: none (pruning breaks prompt cache — only enable if context savings outweigh cache loss) */
  pruningTarget?: PruningTarget;
}

interface CompactionConfig {
  /** "v1" = LLM batch summarization, "v2" = incremental structured extraction (default), "disabled" = no auto-compaction */
  strategy?: "v1" | "v2" | "disabled";
  /** Threshold (0-1) at which auto-compaction triggers. Default: 0.7 */
  triggerThreshold?: number;
  /** Hysteresis reset threshold. Default: 0.4 */
  resetThreshold?: number;
  /** Number of recent messages to keep verbatim. Default: 4 */
  keepRecent?: number;
  /** Max tool result slots to retain in working state (v2 only). Default: 30 */
  maxToolResults?: number;
  /** Use a cheap LLM gap-fill pass for fuzzy extraction (v2 only). Default: true */
  llmExtraction?: boolean;
  /** Disable semantic pruning of old tool results in subagents. Default: true (disabled). Pruning breaks prompt cache — Anthropic models use server-side context management instead. */
  disablePruning?: boolean;
}

export interface AgentFeatures {
  /** Run a cleanup agent after code agents to remove sloppy patterns. Default: false — enable via /agent-features or config */
  desloppify?: boolean;
  /** Auto-classify tasks as trivial and route to cheaper models. Default: true (when trivial model is set in /router) */
  tierRouting?: boolean;
  /** Cache file reads across dispatch boundaries so parent doesn't re-read. Default: true */
  dispatchCache?: boolean;
  /** Require targetFiles on dispatch tasks — reject vague instructions. Default: true */
  targetFileValidation?: boolean;
  /** Run a verification agent after code agents to adversarially review changes. Default: false — enable via /agent-features or config */
  verifyEdits?: boolean;
  /** Allow the agent to search, install, and load skills. Default: true */
  agentSkills?: boolean;
  /** Only expose core tools initially; deferred tools loaded via request_tools. Default: false — all tools active to avoid roundtrips. */
  onDemandTools?: boolean;
}

/** Doppelganger (spark) = inherits parent conversation, same model, cache hits. Diverge (ember) = fresh context, can use cheaper model. */
export type TaskTier = "spark" | "ember";

/** Defaults of the code quality gates of workflow runs (#630); each run freezes them in its policy. */
export interface QualityConfig {
  /** Duplication and dead-code ratchet: `warn` (default) reports, `ratchet` blocks, `off` skips. */
  duplication?: "off" | "warn" | "ratchet";
  /** Rules of the anti-slop pack that do not run (built-in or ast-grep rule IDs). */
  disabledRules?: string[];
  /** Severity per rule ID: `error` blocks the run, `warning` is a note. */
  ruleSeverity?: Record<string, "error" | "warning">;
  /** The project's ast-grep rule files, relative to the workspace; they run when ast-grep is installed. */
  ruleFiles?: string[];
  /** Semgrep on the run's diff: `auto` (default) runs it when installed, `off` never. */
  sast?: "auto" | "off";
  /** Semgrep `--config` for `sast`; default `p/default`. */
  sastConfig?: string;
  /** Look new dependencies up in their public registries (default true). */
  registryLookups?: boolean;
}

export interface AppConfig {
  /** Code quality gate defaults for new workflow runs. */
  quality?: QualityConfig;
  workflows?: import("zod").infer<
    typeof import("../core/workflows/schemas.js").WorkflowConfigSchema
  >;
  defaultModel: string;
  /**
   * Per-model fallback chains. When a model fails with transient errors,
   * the fallbacks for THAT specific model are tried in order.
   * Key = model ID, Value = ordered fallback model IDs.
   */
  modelFallback?: Record<string, string[]>;
  taskRouter?: TaskRouter;
  /** Models of workflow agents by class, role, profile and stage. See `src/core/llm/model-routing.ts`. */
  modelRouting?: import("../core/llm/model-routing.js").ModelRouting;
  theme: {
    name: string;
    transparent?: boolean;
    accentColor?: string;
    /** User message background opacity when transparent mode is on: 0=clear, 30=dim, 70=subtle, 100=solid */
    userMessageOpacity?: number;
    /** Diff background opacity when transparent mode is on: 0=clear, 30=dim, 70=subtle, 100=solid */
    diffOpacity?: number;
    /** Border visibility strength: default, strong, op */
    borderStrength?: "default" | "strong" | "op";
  };
  /** Brand animations: `full` (default) or `reduced` for still frames. `BAKED_REDUCED_MOTION=1` forces reduced. */
  motion?: "full" | "reduced";
  codeIntelligence?: CodeIntelligenceConfig;
  thinking?: ThinkingConfig;
  performance?: PerformanceConfig;
  contextManagement?: ContextManagementConfig;
  compaction?: CompactionConfig;
  /** Watch mode: `baked!` and `baked?` comments start the agent. See `src/core/watch/`. */
  watch?: import("../core/watch/config.js").WatchConfig;
  /** Limits on what the project coordinator may launch (see docs/coordinator.md). */
  coordinator?: {
    /** Launched sessions, runs and initiatives active at once. Default: 3 */
    maxActive?: number;
    /** Tokens summed over everything the coordinator launched. Default: 20,000,000 */
    maxTokens?: number;
  };
  codeExecution?: boolean;
  /** Enable Anthropic's computer use tool (keyboard/mouse/screenshot). Claude-only. Default: false */
  computerUse?: boolean;
  /** Enable Anthropic's text editor tool (str_replace_based_edit_tool). Claude-only. Default: false */
  anthropicTextEditor?: boolean;
  /** Enable web search tool for all LLMs. Always prompts for approval before searching. Default: true */
  webSearch?: boolean;
  /** Allow deploying artifacts to the user's Vercel account. Each deploy still asks. Default: false */
  artifactDeploy?: boolean;
  /** The Vercel team artifacts deploy to; unset (or VERCEL_TEAM_ID unset) is the personal account. */
  vercelTeamId?: string;
  /** Show verbose tool output (plan updates, etc.) in chat. Default: false */
  verbose?: boolean;
  /** Diff display style: "default" | "sidebyside" | "compact". Default: "default" */
  diffStyle?: "default" | "sidebyside" | "compact";
  /** Auto-compact diffs after streaming ends (Ctrl+O to expand). Default: false */
  collapseDiffs?: boolean;
  /** Chat layout style. Default: "accent" */
  chatStyle?: ChatStyle;
  /** Show reasoning/thinking content in chat. Default: true */
  showReasoning?: boolean;
  /** Add co-author trailer on AI-assisted commits. Default: true */
  coAuthorCommits?: boolean;
  /** Default Baked mode for new sessions. Default: "default" */
  defaultBakeMode?: BakeMode;
  /** Enable/disable Baked map (AST index). Disabling saves ~4-8k prompt tokens. Default: true. Toggle via /repo-map → 'e'. */
  repoMap?: boolean;
  /** Semantic summary mode: "off", "ast" (docstrings only), "synthetic" (ast + name-derived, free), "llm" (ast + AI-generated), "full" (ast + llm + synthetic). Boolean compat: true → "synthetic", false → "off". "on" is legacy alias for "full". */
  semanticSummaries?: "off" | "ast" | "synthetic" | "llm" | "full" | "on" | boolean;
  /** Max symbols to summarize with LLM (default 300). Controls API cost for llm/full modes. PageRank-ranked — top N most connected symbols get LLM summaries. */
  semanticSummaryLimit?: number;
  /** Auto-regenerate LLM summaries when files change. Default: false (only ast/synthetic auto-regen). */
  semanticAutoRegen?: boolean;
  /** Token budget for Baked map rendering. Undefined = auto (scales with conversation length). */
  repoMapTokenBudget?: number;
  /** LSP servers to disable (by Mason package name). Scoped: project overrides global. */
  disabledLspServers?: string[];
  agentFeatures?: AgentFeatures;
  /** Tools disabled by the user. Persisted across sessions. */
  disabledTools?: string[];
  /** Instruction files to load into system prompt. Default: ["baked"] (baked.md only). */
  instructionFiles?: string[];
  /** API key resolution priority: "env" = env vars first (default), "app" = keychain/file first. */
  keyPriority?: "env" | "app";
  /** Whether the first-run onboarding wizard has been completed. */
  onboardingComplete?: boolean;
  /** MCP servers to connect to. Each entry spawns a subprocess (stdio) or connects via HTTP+SSE. */
  mcpServers?: MCPServerConfig[];
  /** Auto-retry on stream stalls. Default: false (disabled). Toggle via /watchdog. */
  watchdog?: boolean;
  /** Watchdog timeouts for detecting stalled streams. */
  watchdogTimeouts?: WatchdogTimeouts;
  /** Tool call timeout in minutes. Applies to shell, project, and agent tools. Default: 2 */
  toolTimeout?: number;
  /** Retry behavior for transient provider errors (429, 529, 503, timeouts, overloaded). */
  retry?: RetryConfig;
  /** Memory subsystem config. embeddingModel: AI SDK model id (e.g. "openai/text-embedding-3-small"). null/undefined falls back to hashbag-v2. */
  memory?: { embeddingModel?: string | null };
  /** Anthropic prompt cache settings. Always global. */
  cache?: {
    /** Ephemeral cache TTL. "5m" (free, default) or "1h" (paid: ~2× cache-write cost, 12× lifetime). */
    ttl?: "5m" | "1h";
  };

  contextWindowOverrides?: Record<string, number>;
  /**
   * Schema version. Bumped when introducing a config-visible change that
   * needs a one-time user notice on upgrade. Current: 2.
   */
  configVersion?: number;
  /**
   * Anonymous usage telemetry, recorded locally. Default: enabled. Set false
   * to opt out (also honoured: env DO_NOT_TRACK=1, BAKED_TELEMETRY=0). Records
   * only a version/os/surface event with a random install id — never prompts,
   * paths, keys, or PII. See src/core/telemetry.ts.
   */
  telemetry?: boolean;
  /**
   * Receiver for telemetry events, in addition to the local log. Unset by
   * default: nothing is sent. BAKED_TELEMETRY_URL overrides it.
   */
  telemetryUrl?: string;
  /** Set once the one-time telemetry first-run notice has been shown. */
  telemetryNoticeShown?: boolean;
  /** How BAKED announces a workflow run that waits for a person. */
  notifications?: NotificationsConfig;
}

/** Announcements of workflow runs that wait for a person; see `src/core/workflows/attention-notify.ts`. */
export interface NotificationsConfig {
  /** Native desktop notifications from the terminal app and the CLI. Default: true. */
  system?: boolean;
  /** Unset by default: nothing is sent. Receives one JSON POST per waiting request or blocked run. */
  webhook?: {
    url: string;
    /** Extra request headers, such as an authorization token. */
    headers?: Record<string, string>;
    /** Skip advisory acceptance decisions, which the run does not wait for. Default: false. */
    blockingOnly?: boolean;
  };
}

export interface RetryConfig {
  /** @deprecated Use maxTransientRetries / maxStallRetries. Still accepted as a default for both. */
  maxAttempts?: number;
  /** Max retry attempts per request for transient errors (429, 529, 503, timeouts, overloaded). Default: 3. Range: 1–10. */
  maxTransientRetries?: number;
  /** Max retry attempts per request for stall detection (stream inactivity). Default: 3. Range: 1–10. */
  maxStallRetries?: number;
  /** Base delay in ms before the first retry. Doubles each attempt + jitter. Default: 2000 (agents), 1000 (chat). Range: 250–60000. */
  baseDelayMs?: number;
}

export interface WatchdogTimeouts {
  /** Timeout in ms before first content chunk. Default: 180000 (180s). Range: 30000-600000. */
  firstChunkMs?: number;
  /** Timeout in ms between subsequent chunks. Default: 120000 (120s). Range: 30000-600000. */
  chunkMs?: number;
  /** Max timeout in ms while tools are executing. Default: 900000 (15min). Range: 120000-1800000. */
  toolMaxMs?: number;
  /** Grace period in ms after abort before force-resolving. Default: 5000 (5s). Range: 1000-30000. */
  forceResolveMs?: number;
}

/** Clamp watchdog timeout values to their documented safe ranges. */
export function clampWatchdogTimeouts(
  raw: Partial<WatchdogTimeouts> | undefined,
): Required<WatchdogTimeouts> {
  const clamp = (value: number | undefined, min: number, max: number, fallback: number) => {
    if (value === undefined) return fallback;
    return Math.max(min, Math.min(max, value));
  };
  return {
    firstChunkMs: clamp(raw?.firstChunkMs, 30_000, 600_000, 180_000),
    chunkMs: clamp(raw?.chunkMs, 30_000, 600_000, 120_000),
    toolMaxMs: clamp(raw?.toolMaxMs, 120_000, 1_800_000, 900_000),
    forceResolveMs: clamp(raw?.forceResolveMs, 1_000, 30_000, 5_000),
  };
}

export interface MCPServerConfig {
  /** Display name and tool namespace prefix (e.g. "github" → tools namespaced as mcp__github__*) */
  name: string;
  /** Transport type. "stdio" for local subprocess, "http" for Streamable HTTP (recommended for remote), "sse" for legacy SSE. Default: "stdio" */
  transport?: "stdio" | "http" | "sse";
  /** Command to spawn (stdio transport). e.g. "npx" */
  command?: string;
  /** Arguments for the command. e.g. ["-y", "@modelcontextprotocol/server-github"] */
  args?: string[];
  /** Environment variables passed to the subprocess. */
  env?: Record<string, string>;
  /** URL for http/sse transports (remote servers). */
  url?: string;
  /** Per-tool-call timeout in ms. Default: 30000 */
  timeout?: number;
  /** Disable this server without removing config. */
  disabled?: boolean;
  /** HTTP headers for http/sse transports (e.g. Authorization). */
  headers?: Record<string, string>;
}

export type BakeMode = "default" | "architect" | "plan" | "auto";

export type ChatStyle = "accent" | "bubble";

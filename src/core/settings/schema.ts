/**
 * The chat settings that the terminal UI edits in its pickers, described once so the local API can
 * validate and serve them and the desktop can render its settings pages from the same description.
 * Each setting names its place in `config.json` (a dotted path), its type, default and the config
 * layers it may live in. API keys are `secret` settings: they live in the secret store, never in
 * the config file, and their value is never returned. This module is plain data so the desktop
 * renderer can import it; the validators are in `values.ts`.
 */
export type SettingScope = "global" | "project";

export interface SettingOption {
  value: string;
  label: string;
  help?: string;
}

/** Shows a stored number in another unit, e.g. milliseconds as seconds (`factor: 1000`). */
export interface SettingDisplay {
  unit: string;
  factor: number;
}

interface SettingBase {
  /** Dotted path in config.json, e.g. `performance.effort`; for secrets, the secret store key. */
  id: string;
  page: SettingPageId;
  section: string;
  label: string;
  help: string;
  scopes: readonly SettingScope[];
  /** Shown only as available while another setting has one of these values. */
  enabledWhen?: { id: string; values: readonly (string | boolean)[] };
}

export type SettingDefinition = SettingBase &
  (
    | { type: "boolean"; default: boolean }
    | { type: "enum"; default: string; options: readonly SettingOption[] }
    | {
        type: "number";
        /** Null means unset: BAKED picks the value itself. */
        default: number | null;
        min: number;
        max: number;
        step?: number;
        integer?: boolean;
        nullable?: boolean;
        display?: SettingDisplay;
      }
    /** A model ID such as `anthropic/claude-sonnet-4-6`; null means unset. */
    | { type: "model"; default: string | null }
    /** Names chosen from a catalog the server lists, e.g. the tool catalog. */
    | { type: "string-list"; default: readonly string[]; catalog: "tools" }
    /** Model ID → ordered fallback model IDs. */
    | { type: "model-list-map"; default: Record<string, string[]> }
    /** Model ID → positive integer, e.g. a context-window override. */
    | { type: "model-number-map"; default: Record<string, number>; min: number; max: number }
    | { type: "secret"; default: null; envVar: string }
  );

export type SettingType = SettingDefinition["type"];

export type SettingPageId =
  | "chat-model"
  | "provider-options"
  | "chat-router"
  | "tools"
  | "agent-features"
  | "baked-map"
  | "compaction"
  | "limits";

export interface SettingPage {
  id: SettingPageId;
  title: string;
  description: string;
  /** The terminal command that edits the same settings. */
  command: string;
}

export const SETTING_PAGES: readonly SettingPage[] = [
  {
    id: "chat-model",
    title: "Chat model",
    description: "The model new chats start with and where that choice is saved.",
    command: "/model-scope",
  },
  {
    id: "provider-options",
    title: "Provider options",
    description: "Reasoning, speed, cache and server-side context options sent to the provider.",
    command: "/provider-settings",
  },
  {
    id: "chat-router",
    title: "Chat router",
    description: "Models of the chat's helper agents and fallback chains for failing models.",
    command: "/router",
  },
  {
    id: "tools",
    title: "Tools",
    description: "Tools the chat agent may call, keys for better web search, and the OS sandbox.",
    command: "/tools",
  },
  {
    id: "agent-features",
    title: "Agent features",
    description: "Extra passes and checks the chat agent runs around code edits.",
    command: "/agent-features",
  },
  {
    id: "baked-map",
    title: "Baked map",
    description: "The repository map BAKED adds to the prompt, and its symbol summaries.",
    command: "/repo-map",
  },
  {
    id: "compaction",
    title: "Compaction",
    description: "When and how a long chat is summarized to free context.",
    command: "/compaction",
  },
  {
    id: "limits",
    title: "Timeouts and limits",
    description: "Tool and stream timeouts, and context-window overrides per model.",
    command: "/timeouts",
  },
];

const BOTH: readonly SettingScope[] = ["global", "project"];
const GLOBAL: readonly SettingScope[] = ["global"];

const opts = (...values: string[]): SettingOption[] =>
  values.map((value) => ({ value, label: value }));

/** Tools the terminal UI and chat agent leave off until the user turns them on. */
export const DEFAULT_DISABLED_TOOLS: readonly string[] = [
  "request_tools",
  "release_tools",
  "skills",
];

const ROUTER_SLOTS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["default", "Main", "Default", "Conversation model and last fallback for the slots below."],
  ["webSearch", "Tools", "Web search", "Runs web searches and reads fetched pages."],
  ["spark", "Dispatch", "Explore", "Read-only agents that investigate the code."],
  ["ember", "Dispatch", "Code", "Agents that edit files."],
  ["desloppify", "After dispatch", "Cleanup", "Polishes style after code agents (de-sloppify)."],
  ["verify", "After dispatch", "Review", "Reviews the changes of code agents adversarially."],
  ["compact", "Background", "Compaction", "Summarizes old context when the chat compacts."],
  ["semantic", "Background", "Baked map summaries", "Writes symbol summaries for the Baked map."],
];

export const SETTINGS: readonly SettingDefinition[] = [
  // Chat model
  {
    id: "defaultModel",
    page: "chat-model",
    section: "Default",
    label: "Default chat model",
    help: "Model new chats start with. Save it to the project to use a different model here than in other projects.",
    scopes: BOTH,
    type: "model",
    default: null,
  },

  // Provider options: Claude
  {
    id: "thinking.mode",
    page: "provider-options",
    section: "Claude",
    label: "Thinking",
    help: "Extended thinking. auto and adaptive let the model decide; enabled uses a fixed budget.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "auto", label: "Auto", help: "Adaptive thinking on models that support it." },
      { value: "adaptive", label: "Adaptive" },
      { value: "enabled", label: "Fixed budget" },
    ],
  },
  {
    id: "thinking.budgetTokens",
    page: "provider-options",
    section: "Claude",
    label: "Thinking budget",
    help: "Tokens the model may spend thinking when thinking uses a fixed budget.",
    scopes: BOTH,
    type: "number",
    default: 10_000,
    min: 1024,
    max: 128_000,
    step: 1024,
    integer: true,
    display: { unit: "tokens", factor: 1 },
    enabledWhen: { id: "thinking.mode", values: ["enabled"] },
  },
  {
    id: "performance.effort",
    page: "provider-options",
    section: "Claude",
    label: "Effort",
    help: "Reasoning depth across thinking, text and tool calls. off sends nothing.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "low", "medium", "high", "xhigh", "max"),
  },
  {
    id: "contextManagement.clearThinking",
    page: "provider-options",
    section: "Claude",
    label: "Preserve thinking",
    help: "Keep thinking blocks across turns so the prompt cache keeps hitting. Needs thinking on.",
    scopes: BOTH,
    type: "boolean",
    default: true,
    enabledWhen: { id: "thinking.mode", values: ["auto", "adaptive", "enabled"] },
  },
  {
    id: "performance.speed",
    page: "provider-options",
    section: "Claude",
    label: "Speed",
    help: "fast asks for faster output on models that offer it.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "standard", "fast"),
  },
  {
    id: "performance.toolStreaming",
    page: "provider-options",
    section: "Claude",
    label: "Tool streaming",
    help: "Stream tool call arguments as they are written instead of waiting for the whole call.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "performance.sendReasoning",
    page: "provider-options",
    section: "Claude",
    label: "Send reasoning",
    help: "Include earlier reasoning in multi-turn requests.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "codeExecution",
    page: "provider-options",
    section: "Claude",
    label: "Code execution",
    help: "Programmatic tool calling: the model batches reads in a Python sandbox.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "computerUse",
    page: "provider-options",
    section: "Claude",
    label: "Computer use",
    help: "Let Claude control the keyboard and mouse and take screenshots.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "anthropicTextEditor",
    page: "provider-options",
    section: "Claude",
    label: "Text editor tool",
    help: "Anthropic's str_replace editor tool alongside BAKED's own edit tools.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "contextManagement.compact",
    page: "provider-options",
    section: "Claude",
    label: "Server compaction",
    help: "Let Anthropic compact the context on the server for models with 200K+ context.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "contextManagement.clearToolUses",
    page: "provider-options",
    section: "Claude",
    label: "Clear old tool uses",
    help: "Drop old tool results on the server at 65% of the context. Breaks the prompt cache when it fires.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "cache.ttl",
    page: "provider-options",
    section: "Claude",
    label: "Cache lifetime",
    help: "5m is free. 1h costs about twice as much to write and lives 12 times longer, for long agentic chats.",
    scopes: GLOBAL,
    type: "enum",
    default: "5m",
    options: opts("5m", "1h"),
  },

  // Provider options: OpenAI
  {
    id: "performance.openaiReasoningEffort",
    page: "provider-options",
    section: "OpenAI",
    label: "Reasoning effort",
    help: "Reasoning depth of o-series and GPT-5 models. none is fastest.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "none", "minimal", "low", "medium", "high", "xhigh"),
  },
  {
    id: "performance.openaiReasoningSummary",
    page: "provider-options",
    section: "OpenAI",
    label: "Reasoning summary",
    help: "Include a summary of the model's reasoning in the response.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "auto", "detailed"),
  },
  {
    id: "performance.openaiVerbosity",
    page: "provider-options",
    section: "OpenAI",
    label: "Verbosity",
    help: "How long GPT-5 answers are.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "low", "medium", "high"),
  },
  {
    id: "performance.serviceTier",
    page: "provider-options",
    section: "OpenAI",
    label: "Service tier",
    help: "flex costs half with more latency; priority is fastest where your account has it.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "auto", "default", "flex", "priority"),
  },

  // Provider options: GitHub Copilot and GitHub Models
  {
    id: "performance.compatReasoningEffort",
    page: "provider-options",
    section: "GitHub",
    label: "Reasoning effort",
    help: "Sent as reasoning_effort to GitHub Copilot and GitHub Models.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: opts("off", "low", "medium", "high", "xhigh"),
  },

  // Provider options: all providers
  {
    id: "performance.disableParallelToolUse",
    page: "provider-options",
    section: "All providers",
    label: "Sequential tools",
    help: "Run tools one at a time instead of in parallel.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "contextManagement.pruningTarget",
    page: "provider-options",
    section: "All providers",
    label: "Tool result pruning",
    help: "Shorten old tool results in the client. Saves context but breaks the prompt cache.",
    scopes: BOTH,
    type: "enum",
    default: "none",
    options: opts("none", "main", "subagents", "both"),
  },

  // Chat router
  ...ROUTER_SLOTS.map(
    ([slot, section, label, help]): SettingDefinition => ({
      id: `taskRouter.${slot}`,
      page: "chat-router",
      section,
      label,
      help: `${help} Unset uses the chat model.`,
      scopes: BOTH,
      type: "model",
      default: null,
    }),
  ),
  {
    id: "taskRouter.maxConcurrentAgents",
    page: "chat-router",
    section: "Dispatch",
    label: "Concurrency",
    help: "Most agents a dispatch runs at once.",
    scopes: BOTH,
    type: "number",
    default: 3,
    min: 2,
    max: 8,
    integer: true,
  },
  {
    id: "modelFallback",
    page: "chat-router",
    section: "Fallbacks",
    label: "Fallback chains",
    help: "When a model keeps failing with transient errors, its fallbacks are tried in order.",
    scopes: BOTH,
    type: "model-list-map",
    default: {},
  },

  // Tools
  {
    id: "disabledTools",
    page: "tools",
    section: "Tools",
    label: "Available tools",
    help: "Tools the chat agent may call. A tool turned off is not offered to the model. Saved as the list of tools turned off.",
    scopes: GLOBAL,
    type: "string-list",
    default: DEFAULT_DISABLED_TOOLS,
    catalog: "tools",
  },
  {
    id: "webSearch",
    page: "tools",
    section: "Web search",
    label: "Web search",
    help: "Allow the web search tool. Each search still asks for approval.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "brave-api-key",
    page: "tools",
    section: "Web search",
    label: "Brave Search key",
    help: "Better search results. The free plan has 2,000 queries a month.",
    scopes: GLOBAL,
    type: "secret",
    default: null,
    envVar: "BRAVE_SEARCH_API_KEY",
  },
  {
    id: "jina-api-key",
    page: "tools",
    section: "Web search",
    label: "Jina Reader key",
    help: "Faster page reading. The free plan has 10M tokens.",
    scopes: GLOBAL,
    type: "secret",
    default: null,
    envVar: "JINA_API_KEY",
  },
  {
    id: "sandbox",
    page: "tools",
    section: "Sandbox",
    label: "OS sandbox",
    help: "Run shell, project and check commands in an OS sandbox (bubblewrap on Linux, seatbelt on macOS): writes stay in the project, credential files are hidden. A project config can only raise it.",
    scopes: GLOBAL,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "Off", help: "Commands run without OS sandbox." },
      {
        value: "auto",
        label: "Auto",
        help: "Sandbox when a backend is available; otherwise run without it and warn once.",
      },
      {
        value: "required",
        label: "Required",
        help: "Refuse to run commands when no sandbox backend is available.",
      },
    ],
  },
  {
    id: "sandboxNetwork",
    page: "tools",
    section: "Sandbox",
    label: "Network in the sandbox",
    help: "Network access of sandboxed chat commands. Workflow runs follow their policy's network setting.",
    scopes: GLOBAL,
    type: "enum",
    default: "allow",
    options: [
      { value: "allow", label: "Allow" },
      { value: "deny", label: "Deny", help: "Only loopback works." },
    ],
    enabledWhen: { id: "sandbox", values: ["auto", "required"] },
  },
  {
    id: "artifactDeploy",
    page: "tools",
    section: "Artifacts",
    label: "Deploy artifacts to Vercel",
    help: "Let any chat publish a saved artifact to your own Vercel account. Each deploy asks first and is scanned for secrets.",
    scopes: GLOBAL,
    type: "boolean",
    default: false,
  },
  {
    id: "vercel-token",
    page: "tools",
    section: "Artifacts",
    label: "Vercel token",
    help: "A token from Vercel > Account Settings > Tokens, best limited to one team and with an expiry.",
    scopes: GLOBAL,
    type: "secret",
    default: null,
    envVar: "VERCEL_TOKEN",
  },

  // Agent features
  {
    id: "agentFeatures.desloppify",
    page: "agent-features",
    section: "After code agents",
    label: "De-sloppify",
    help: "Run a cleanup pass after code agents. Uses the Cleanup model of the chat router.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "agentFeatures.verifyEdits",
    page: "agent-features",
    section: "After code agents",
    label: "Verify edits",
    help: "Run an adversarial review after code agents.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
  {
    id: "agentFeatures.tierRouting",
    page: "agent-features",
    section: "Dispatch",
    label: "Tier routing",
    help: "Send trivial tasks to cheaper models.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "agentFeatures.dispatchCache",
    page: "agent-features",
    section: "Dispatch",
    label: "Dispatch cache",
    help: "Share file reads across dispatched agents so files are not read twice.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "agentFeatures.targetFileValidation",
    page: "agent-features",
    section: "Dispatch",
    label: "Target file validation",
    help: "Reject dispatched tasks that name no files.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },

  // Baked map
  {
    id: "repoMap",
    page: "baked-map",
    section: "Map",
    label: "Baked map",
    help: "Add a ranked map of the repository's symbols to the prompt. Off saves about 4-8K prompt tokens.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "repoMapTokenBudget",
    page: "baked-map",
    section: "Map",
    label: "Token budget",
    help: "Most tokens the map may use. Unset scales with the chat's length.",
    scopes: BOTH,
    type: "number",
    default: null,
    nullable: true,
    min: 500,
    max: 50_000,
    step: 500,
    integer: true,
    display: { unit: "tokens", factor: 1 },
    enabledWhen: { id: "repoMap", values: [true] },
  },
  {
    id: "semanticSummaries",
    page: "baked-map",
    section: "Summaries",
    label: "Symbol summaries",
    help: "How symbols get one-line summaries in the map.",
    scopes: BOTH,
    type: "enum",
    default: "synthetic",
    options: [
      { value: "off", label: "Off" },
      { value: "ast", label: "Docstrings", help: "Only from doc comments." },
      { value: "synthetic", label: "Synthetic", help: "Doc comments and names. Free." },
      { value: "llm", label: "Model", help: "Doc comments and model-written summaries." },
      { value: "full", label: "Full", help: "All of the above." },
    ],
    enabledWhen: { id: "repoMap", values: [true] },
  },
  {
    id: "semanticSummaryLimit",
    page: "baked-map",
    section: "Summaries",
    label: "Model summary limit",
    help: "Most symbols, by rank, that get a model-written summary. Caps the cost.",
    scopes: BOTH,
    type: "number",
    default: 500,
    min: 10,
    max: 5000,
    step: 10,
    integer: true,
    enabledWhen: { id: "semanticSummaries", values: ["llm", "full"] },
  },
  {
    id: "semanticAutoRegen",
    page: "baked-map",
    section: "Summaries",
    label: "Regenerate on change",
    help: "Rewrite model summaries when files change. Docstring and synthetic summaries always update.",
    scopes: BOTH,
    type: "boolean",
    default: false,
    enabledWhen: { id: "semanticSummaries", values: ["llm", "full"] },
  },

  // Compaction
  {
    id: "compaction.strategy",
    page: "compaction",
    section: "Strategy",
    label: "Strategy",
    help: "How a long chat frees context.",
    scopes: BOTH,
    type: "enum",
    default: "v2",
    options: [
      { value: "v2", label: "Incremental", help: "Extract state as the chat goes. Default." },
      { value: "v1", label: "Summarize", help: "Summarize with a model when context is full." },
      { value: "disabled", label: "Off", help: "Context fills up to the model's limit." },
    ],
  },
  {
    id: "compaction.triggerThreshold",
    page: "compaction",
    section: "Thresholds",
    label: "Compact at",
    help: "Share of the context window at which the chat compacts.",
    scopes: BOTH,
    type: "number",
    default: 0.7,
    min: 0.3,
    max: 0.95,
    step: 0.05,
    display: { unit: "%", factor: 0.01 },
    enabledWhen: { id: "compaction.strategy", values: ["v1", "v2"] },
  },
  {
    id: "compaction.resetThreshold",
    page: "compaction",
    section: "Thresholds",
    label: "Rearm below",
    help: "Context share the chat must drop under before it can compact again.",
    scopes: BOTH,
    type: "number",
    default: 0.4,
    min: 0.1,
    max: 0.9,
    step: 0.05,
    display: { unit: "%", factor: 0.01 },
    enabledWhen: { id: "compaction.strategy", values: ["v1", "v2"] },
  },
  {
    id: "compaction.keepRecent",
    page: "compaction",
    section: "Thresholds",
    label: "Keep recent messages",
    help: "Latest messages kept word for word.",
    scopes: BOTH,
    type: "number",
    default: 4,
    min: 1,
    max: 50,
    integer: true,
    enabledWhen: { id: "compaction.strategy", values: ["v1", "v2"] },
  },
  {
    id: "compaction.maxToolResults",
    page: "compaction",
    section: "Incremental",
    label: "Tool results kept",
    help: "Tool results the incremental strategy keeps in its working state.",
    scopes: BOTH,
    type: "number",
    default: 30,
    min: 5,
    max: 200,
    integer: true,
    enabledWhen: { id: "compaction.strategy", values: ["v2"] },
  },
  {
    id: "compaction.llmExtraction",
    page: "compaction",
    section: "Incremental",
    label: "Model gap-fill",
    help: "Use a cheap model pass for what the incremental strategy cannot extract itself.",
    scopes: BOTH,
    type: "boolean",
    default: true,
    enabledWhen: { id: "compaction.strategy", values: ["v2"] },
  },

  // Timeouts and limits
  {
    id: "toolTimeout",
    page: "limits",
    section: "Tools",
    label: "Tool timeout",
    help: "Minutes a shell, project or agent tool may run. 0 means no limit.",
    scopes: GLOBAL,
    type: "number",
    default: 2,
    min: 0,
    max: 120,
    integer: true,
    display: { unit: "min", factor: 1 },
  },
  {
    id: "watchdog",
    page: "limits",
    section: "Stream watchdog",
    label: "Watchdog",
    help: "Retry a model response that stops streaming.",
    scopes: GLOBAL,
    type: "boolean",
    default: false,
  },
  ...(
    [
      ["firstChunkMs", "First chunk", "Wait for the first part of a response.", 180, 30, 600],
      ["chunkMs", "Between chunks", "Wait between parts of a response.", 120, 30, 600],
      ["toolMaxMs", "While tools run", "Longest wait while tools execute.", 900, 120, 1800],
      ["forceResolveMs", "After stop", "Grace period after a stop before giving up.", 5, 1, 30],
    ] as const
  ).map(
    ([key, label, help, seconds, min, max]): SettingDefinition => ({
      id: `watchdogTimeouts.${key}`,
      page: "limits",
      section: "Stream watchdog",
      label,
      help,
      scopes: GLOBAL,
      type: "number",
      default: seconds * 1000,
      min: min * 1000,
      max: max * 1000,
      step: 1000,
      integer: true,
      display: { unit: "s", factor: 1000 },
      enabledWhen: { id: "watchdog", values: [true] },
    }),
  ),
  {
    id: "contextWindowOverrides",
    page: "limits",
    section: "Context window",
    label: "Context window overrides",
    help: "Tokens BAKED assumes a model's context window holds, for models it does not know.",
    scopes: GLOBAL,
    type: "model-number-map",
    default: {},
    min: 1000,
    max: 10_000_000,
  },
];

const BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

export function settingById(id: string): SettingDefinition | undefined {
  return BY_ID.get(id);
}

/** Reads a dotted path from a config layer. */
export function readSettingPath(layer: unknown, id: string): unknown {
  let node: unknown = layer;
  for (const part of id.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Returns a copy of a config layer with a dotted path set; undefined removes it. */
export function writeSettingPath(
  layer: Record<string, unknown>,
  id: string,
  value: unknown,
): Record<string, unknown> {
  const parts = id.split(".");
  const out = { ...layer };
  let node = out;
  const parents: [Record<string, unknown>, string][] = [];
  for (const part of parts.slice(0, -1)) {
    const child = node[part];
    const copy =
      child && typeof child === "object" && !Array.isArray(child)
        ? { ...(child as Record<string, unknown>) }
        : {};
    node[part] = copy;
    parents.push([node, part]);
    node = copy;
  }
  const leaf = parts[parts.length - 1] as string;
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
  // Drop objects the removal left empty so the file keeps no `{}` behind.
  for (const [parent, key] of parents.reverse()) {
    const child = parent[key] as Record<string, unknown>;
    if (Object.keys(child).length === 0) delete parent[key];
    else break;
  }
  return out;
}

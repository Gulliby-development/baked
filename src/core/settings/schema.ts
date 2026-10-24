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
        /** What an unset nullable value is called; default `auto`. */
        unsetLabel?: string;
        display?: SettingDisplay;
        /** The ID of a number setting this one must stay below, e.g. a rearm level under its trigger. */
        below?: string;
      }
    /** A model ID such as `anthropic/claude-sonnet-4-6`; null means unset. */
    | { type: "model"; default: string | null }
    /** Names turned off in a catalog the server lists: the tool catalog or the quality rules. */
    | { type: "string-list"; default: readonly string[]; catalog: SettingCatalog }
    /** Model ID → ordered fallback model IDs. */
    | { type: "model-list-map"; default: Record<string, string[]> }
    /** Model ID → positive integer, e.g. a context-window override. */
    | { type: "model-number-map"; default: Record<string, number>; min: number; max: number }
    | { type: "secret"; default: null; envVar: string }
    /**
     * Where workflow implementers get library docs: `{ dir }` or `{ mcp: { server, tool, args? } }`,
     * each with an optional `maxChars`; null means none. The whole source is one value.
     */
    | { type: "library-docs"; default: null }
  );

export type SettingType = SettingDefinition["type"];
/** The catalogs `string-list` settings choose from (`SettingsView.catalogs`). */
export type SettingCatalog = "tools" | "quality-rules";

export type SettingPageId =
  | "chat-model"
  | "provider-options"
  | "chat-router"
  | "tools"
  | "agent-features"
  | "baked-map"
  | "compaction"
  | "limits"
  | "code-quality"
  | "coordinator";

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
    description:
      "Tool and stream timeouts, context-window overrides per model, and the cost cap of workflow runs.",
    command: "/timeouts",
  },
  {
    id: "code-quality",
    title: "Code quality",
    description:
      "Quality gates of workflow runs. New runs take these defaults and keep them until they finish.",
    command: "/code-quality",
  },
  {
    id: "coordinator",
    title: "Coordinator",
    description:
      "How the project coordinator proposes work: workflow runs, parallel chats, or asking each time.",
    command: "/coordinator style",
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
    help: "Run shell, project and check commands in an OS sandbox (bubblewrap on Linux, seatbelt on macOS, a low-integrity restricted token on Windows): writes stay in the project, credential files are hidden. A project config can only raise it.",
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
    id: "editDiagnostics",
    page: "agent-features",
    section: "Edit diagnostics",
    label: "Edits that add errors",
    help: "After each edit, BAKED compares diagnostics of the file and of the files importing it. Feedback returns new errors to the agent; reject also restores the file. A workflow run keeps the mode it started with.",
    scopes: BOTH,
    type: "enum",
    default: "feedback",
    options: [
      {
        value: "feedback",
        label: "Feedback",
        help: "Keep the edit and return the errors. Default.",
      },
      {
        value: "reject",
        label: "Reject",
        help: "Restore the file and return the errors with the original text.",
      },
    ],
  },
  {
    id: "designKit",
    page: "agent-features",
    section: "Design",
    label: "BAKED kit",
    help: "Default styles for web pages the agent builds. Auto offers the BAKED kit only to web projects with no styles of their own whose instruction files say nothing about design. Artifacts without styles get the kit and a small Made with BAKED mark.",
    scopes: BOTH,
    type: "enum",
    default: "auto",
    options: [
      {
        value: "auto",
        label: "Auto",
        help: "Use the kit in web projects that have no styles. Default.",
      },
      { value: "always", label: "Always", help: "Prefer the kit for new UI in every project." },
      { value: "off", label: "Off", help: "Never suggest the kit or add it to artifacts." },
    ],
  },
  {
    id: "agentFeatures.approvalReview",
    page: "agent-features",
    section: "Approvals",
    label: "Approval reviewer",
    help: "Before asking you, the chat model reviews project-local cleanup commands (rm inside the project, git rebase, git branch -D, kill of a process) and edits of CI or Docker files, and runs them only at low risk. Force pushes, hard resets, database drops, piped scripts, secrets and anything outside the project always ask.",
    scopes: BOTH,
    type: "boolean",
    default: false,
  },
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
    id: "repoMapBackgroundRefresh",
    page: "baked-map",
    section: "Map",
    label: "Background updates",
    help: "Keep the index current while BAKED runs: at startup, after file changes, chat turns, runs and git checkouts or pulls. Off updates it only when the map or code graph is used.",
    scopes: BOTH,
    type: "boolean",
    default: true,
    enabledWhen: { id: "repoMap", values: [true] },
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
    below: "compaction.triggerThreshold",
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
    id: "diagnostics.timeoutMs",
    page: "limits",
    section: "Tools",
    label: "Edit diagnostics wait",
    help: "How long an edit waits for diagnostics, before and after it. A check that does not finish in time is reported as not checked.",
    scopes: GLOBAL,
    type: "number",
    default: 2500,
    min: 250,
    max: 30_000,
    step: 250,
    integer: true,
    display: { unit: "s", factor: 1000 },
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
    id: "runBudget.maxCostUsd",
    page: "limits",
    section: "Workflow runs",
    label: "Cost cap",
    help: "US dollars a workflow run may spend on models; the run stops for a decision before a step would pass it. Every model the run can call needs a known price. Empty means no cap: only the token budget applies. A policy that sets maxCostUsd itself keeps it, and the start forms can set a cap per run.",
    scopes: BOTH,
    type: "number",
    default: null,
    min: 0.01,
    max: 100_000,
    step: 1,
    nullable: true,
    unsetLabel: "none",
    display: { unit: "USD", factor: 1 },
  },
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

  // Code quality
  {
    id: "quality.duplication",
    page: "code-quality",
    section: "Workflow runs",
    label: "Duplication ratchet",
    help: "Code a run copies, and code it adds that nothing uses. warn reports them in the run report; ratchet makes them blocking findings the run must fix; off skips the measurement.",
    scopes: BOTH,
    type: "enum",
    default: "warn",
    options: [
      { value: "off", label: "off", help: "Do not measure." },
      { value: "warn", label: "warn", help: "Report in the run report." },
      { value: "ratchet", label: "ratchet", help: "Block until the run reuses the code." },
    ],
  },
  {
    id: "quality.disabledRules",
    page: "code-quality",
    section: "Anti-slop rules",
    label: "Rules",
    help: "Patterns checked on the lines a run adds: empty catch blocks, silent fallbacks, new suppressions, placeholders. An error rule blocks the run until it is fixed; a warning is noted in the run report. Turn off a rule the project does not want.",
    scopes: BOTH,
    type: "string-list",
    default: [],
    catalog: "quality-rules",
  },
  {
    id: "quality.registryLookups",
    page: "code-quality",
    section: "Dependencies",
    label: "Look up new dependencies",
    help: "Before a run's checks install anything, every package it adds is looked up in its registry (npm, PyPI, crates.io, Go proxy, NuGet, Maven Central). A package that does not exist, looks like a typosquat or was published days ago blocks the run; the others are listed in the run report. Off, new dependencies are only listed.",
    scopes: BOTH,
    type: "boolean",
    default: true,
  },
  {
    id: "quality.sast",
    page: "code-quality",
    section: "Dependencies",
    label: "Semgrep",
    help: "Runs Semgrep on the code files a run changed when it is installed. An ERROR match on a line the run added blocks the run; other matches are noted. BAKED does not install Semgrep.",
    scopes: BOTH,
    type: "enum",
    default: "auto",
    options: [
      { value: "auto", label: "auto", help: "Run Semgrep when it is installed." },
      { value: "off", label: "off", help: "Do not run Semgrep." },
    ],
  },
  {
    id: "quality.mutation",
    page: "code-quality",
    section: "Tests",
    label: "Mutation gate",
    help: "Plants small faults (a flipped condition, a shifted boundary, a changed constant) in the lines a run added and runs the required test checks against each. A fault the tests do not notice means they assert too little. advisory lists those in the run report; required makes them findings the run fixes with a test; preset follows the workflow (advisory for full runs, off for quick and standard).",
    scopes: BOTH,
    type: "enum",
    default: "preset",
    options: [
      { value: "preset", label: "preset", help: "As the workflow preset says." },
      { value: "off", label: "off", help: "Do not run the gate." },
      { value: "advisory", label: "advisory", help: "Report surviving mutants." },
      { value: "required", label: "required", help: "Block until a test kills them." },
    ],
  },
  {
    id: "quality.mutationEngine",
    page: "code-quality",
    section: "Tests",
    label: "Mutation engine",
    help: "Which engine makes the mutation gate's mutants. auto runs the project's own mutation tool when it is already installed (Stryker, mutmut, cargo-mutants, PIT, go-mutesting) and the built-in operators otherwise; built-in always uses the operators. BAKED never installs a tool.",
    scopes: BOTH,
    type: "enum",
    default: "auto",
    options: [
      { value: "auto", label: "auto", help: "Use an installed tool, else the built-in operators." },
      { value: "built-in", label: "built-in", help: "Always use the built-in operators." },
    ],
  },
  {
    id: "quality.baselineReplay",
    page: "code-quality",
    section: "Tests",
    label: "Baseline replay",
    help: "After the checks pass, runs the required test checks once more in a copy of the delivered tree whose changed non-test files are put back as they were before the run, and keeps which tests fail there as review evidence. A criterion that the new tests fail on the old code is then checked by the run instead of left to a person. Costs one more test run per review.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "off", help: "Do not replay the tests on the old code." },
      { value: "on", label: "on", help: "Replay them and keep the result as evidence." },
    ],
  },
  {
    id: "quality.packageContents",
    page: "code-quality",
    section: "Tests",
    label: "Package contents",
    help: "When a run changes a manifest's packaging fields (package data, included files, packed items), builds the package in a copy of the delivered tree and keeps the list of files it holds as review evidence. A criterion that the built wheel, crate, jar, nupkg or npm package contains a file is then checked by the run instead of left to a person. Costs one package build per review.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "off", help: "Do not build the package." },
      { value: "on", label: "on", help: "Build it and keep its file list as evidence." },
    ],
  },
  {
    id: "quality.chainRewrite",
    page: "code-quality",
    section: "Workflow runs",
    label: "Finding chain rewrite",
    help: "When review finds a second case of one defect on the same function after a correction (a repeat chain), the next correction rewrites the function from its spec against every case found so far instead of patching the new one, and the host reruns all those cases after each correction, before the next review. A case that fails again reopens the correction without a review call.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "off", help: "Patch each finding as it comes." },
      { value: "on", label: "on", help: "Rewrite at the second case and rerun the cases." },
    ],
  },
  {
    id: "quality.chainProbe",
    page: "code-quality",
    section: "Workflow runs",
    label: "Finding chain sibling probe",
    help: "With the finding chain rewrite on, before the rewrite starts, one small review call proposes the other inputs of the defect class around the cases found so far (nested, swapped and combined delimiters, the empty input). The host runs them, and each that fails joins the cases the rewrite must pass, so the next review round does not find them one at a time.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      { value: "off", label: "off", help: "The rewrite gets only the cases review found." },
      { value: "on", label: "on", help: "Probe the class once and add the failing inputs." },
    ],
  },
  {
    id: "quality.misquoteFix",
    page: "code-quality",
    section: "Workflow runs",
    label: "Misquote host fix",
    help: "When a task reports a spec conflict because its test copied a criterion's value with a small change, and that spelling occurs exactly once in the task's test files with nothing to escape, the host replaces it with the criterion's value as written and runs the task's required checks. When they pass the task goes on without another model session; when one fails the edit is put back and a session corrects the test as before.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      {
        value: "off",
        label: "off",
        help: "A session corrects the test; the host only records what it would do.",
      },
      {
        value: "on",
        label: "on",
        help: "Make the exact replacement and keep it when the checks pass.",
      },
    ],
  },
  {
    id: "quality.defectClasses",
    page: "code-quality",
    section: "Workflow runs",
    label: "Cross-run defect classes",
    help: "Each run keeps the defect classes its review corrected (such as nested emphasis delimiters in Markdown or Decimal precision in money totals) in a list on this machine, by domain, with a few cases each. The planner and the implementers of a later run whose request names the same domain see those classes as examples, so the first version of the code avoids them.",
    scopes: BOTH,
    type: "enum",
    default: "off",
    options: [
      {
        value: "off",
        label: "off",
        help: "Each run starts without the list and adds nothing to it.",
      },
      { value: "on", label: "on", help: "Read and add to the list of defect classes by domain." },
    ],
  },
  {
    id: "quality.propertyTests",
    page: "code-quality",
    section: "Tests",
    label: "Property-based tests",
    help: "The spec author marks criteria that must hold for a whole input domain (numbers, strings, parsing, round trips, invariants); each gets a property-based test (fast-check, Hypothesis, proptest, jqwik, Kotest property, rapid, FsCheck, CsCheck) and the run is blocked until it has one. A failing property's shrunk counterexample goes into the finding. preset follows the workflow (auto for standard and full runs, off for quick).",
    scopes: BOTH,
    type: "enum",
    default: "preset",
    options: [
      { value: "preset", label: "preset", help: "As the workflow preset says." },
      {
        value: "auto",
        label: "auto",
        help: "Ask for property tests where criteria call for them.",
      },
      { value: "off", label: "off", help: "No property tests." },
    ],
  },
  {
    id: "libraryDocs",
    page: "code-quality",
    section: "Library docs",
    label: "Library docs source",
    help: "Docs for the library versions the project's lockfiles pin, given to each implementer task for up to three libraries its files use. A directory holds <name>@<version>.md (or <name>/<version>.md) files; an MCP tool of a server in mcpServers gets {name}, {version} and {ecosystem} in its arguments. maxChars caps each library's docs (default 8000). Not set, implementers get no docs.",
    scopes: BOTH,
    type: "library-docs",
    default: null,
  },
  {
    id: "coordinator.workStyle",
    page: "coordinator",
    section: "Proposing work",
    label: "Work style",
    help: "How the coordinator proposes work that is more than a quick answer. With a preference it goes that way without asking which; with only, it never offers the other way.",
    scopes: BOTH,
    type: "enum",
    default: "ask",
    options: [
      {
        value: "workflows-only",
        label: "Workflows only",
        help: "Always a workflow run; never parallel chats.",
      },
      {
        value: "prefer-workflows",
        label: "Mostly workflows",
        help: "A workflow run; chats only when you ask for them.",
      },
      {
        value: "ask",
        label: "Not set",
        help: "Offer a workflow; when you decline it, offer parallel chats.",
      },
      {
        value: "prefer-chats",
        label: "Mostly chats",
        help: "Parallel chats, or one chat; a workflow only when you ask for one.",
      },
      { value: "chats-only", label: "Chats only", help: "Always chats; never a workflow run." },
    ],
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

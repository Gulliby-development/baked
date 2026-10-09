import { getProvider } from "./llm/providers/index.js";

const ASCII: Record<string, string> = {
  ghost: "◆",
  pencil: "✎",
  chat: "▸",
  folder: "/",
  brain: "⚙",
  brain_alt: "⚙",
  user: "●",
  ai: "▹",
  system: "⚙",
  tokens: "⚡",
  sparkle: "✦",
  arrow: "›",
  arrow_right: "→",
  clock: "◷",
  clock_alt: "◷",
  git: "⎇",
  tools: "⚒",
  wrench: "⚒",
  plan: "☰",
  question: "?",
  changes: "△",
  search: "⌕",
  check: "✓",
  spinner: "○",
  skip: "⊘",
  trash: "✕",
  clear: "⌫",
  skills: "★",
  cog: "⚙",
  error: "✕",
  warning: "⚠",
  quit: "⏻",
  stop: "■",
  play: "▶",
  compress: "↕",
  context: "◉",
  lock: "⊙",

  panel: "▣",
  file: "□",
  terminal: "$",
  globe: "⊕",
  bookmark: "⊡",
  trash_alt: "✕",
  code: "{}",
  references: "⇉",
  definition: "⊳",
  actions: "⚡",
  rename: "✎",
  format: "≡",
  lightning: "⚡",
  explore: "◎",
  memory: "✿",
  memory_alt: "✿",
  dispatch: "▹",
  spark: "✦",
  ember: "✺",
  router: "⚙",
  tabs: "☰",
  info: "ⓘ",
  powerline_left: "│",
  powerline_right: "│",
  help: "?",
  repomap: "◈",
  storage: "▪",
  delete_all: "✕",
  chat_style: "◇",
  budget: "◎",
  verbose: "◉",
  compact: "↕",
  ban: "⊘",
  web_search: "⊕",
  check_link: "✓",
  model: "⚙",
  gear: "⚙",
  gauge: "◎",
  cache: "⚡",
  cleanup: "♻",
  investigate: "◎",
  key: "⚷",
  key_missing: "⚷",
  impact: "⚡",
  cochange: "↔",
  success: "✓",
  fail: "✗",
  diff_add: "+",
  diff_remove: "-",
  create: "+",
  write: "✎",
  worker: "⚡",
  worker_busy: "⚡",
  worker_crash: "⚡✗",
  worker_restart: "⚡↻",
  image: "🖼",
  smithy: "⚒",
  read_only: "◎",
  edit: "✎",
  web: "⊕",
  review: "◎",
  compact_task: "↕",
  mcp: "⛨",
  mcp_server: "⚡",
  mcp_tool: "⚒",
  plug: "⚡",
  unplug: "✗",
  shield: "⊙",
  pulse: "~",
  refresh: "↻",
  circle_dot: "●",
  circle_empty: "○",
  chevron_right: "›",
  server: "⚡",
  cloud: "☁",
  rewind: "↶",
  checkpoint: "◆",
  morph: "✦",
  note: "≡",
  scroll: "≡",
  prompt: "▸",
};

export function icon(name: string): string {
  const set = ASCII;
  return set[name] ?? name;
}

export const UI_ICONS = {
  get ghost() {
    return icon("ghost");
  },
  get chat() {
    return icon("chat");
  },
  get folder() {
    return icon("folder");
  },
  get brain() {
    return icon("brain");
  },
  get user() {
    return icon("user");
  },
  get ai() {
    return icon("ai");
  },
  get system() {
    return icon("system");
  },
  get tokens() {
    return icon("tokens");
  },
  get sparkle() {
    return icon("sparkle");
  },
  get arrow() {
    return icon("arrow");
  },
  get clock() {
    return icon("clock");
  },
  get git() {
    return icon("git");
  },
  get tools() {
    return icon("tools");
  },
};

function inferProviderId(idOrModel: string): string {
  const p = getProvider(idOrModel);
  if (p) return idOrModel;
  const id = idOrModel.toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.startsWith("chatgpt")
  )
    return "openai";
  if (id.startsWith("gemini")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (id.startsWith("llama") || id.startsWith("meta-")) return "other";
  if (
    id.startsWith("mistral") ||
    id.startsWith("codestral") ||
    id.startsWith("pixtral") ||
    id.startsWith("magistral") ||
    id.startsWith("ministral")
  )
    return "mistral";
  if (id.startsWith("deepseek")) return "deepseek";
  if (id.startsWith("accounts/fireworks")) return "fireworks";
  if (id.includes("/")) return "other";
  return idOrModel;
}

export function providerIcon(providerId: string): string {
  const resolved = inferProviderId(providerId);
  const provider = getProvider(resolved);
  return provider?.asciiIcon ?? "●";
}

/**
 * What each hook event means, in plain words, and ready-made hooks to start from. The desktop
 * Hooks screen and the terminal's `/hooks` both read this, so the two explain events the same
 * way. Pure data: no Node APIs, so the desktop renderer imports it directly.
 */
import type { HookEventName } from "./types.js";

/** Where an event sits in a turn of the agent; the timeline groups events by it. */
export type HookPhase = "start" | "tools" | "subagents" | "context" | "finish" | "runs";

export const HOOK_PHASES: { id: HookPhase; title: string }[] = [
  { id: "start", title: "Session and prompt" },
  { id: "tools", title: "Tool calls" },
  { id: "subagents", title: "Subagents" },
  { id: "context", title: "Compaction" },
  { id: "finish", title: "End of a turn" },
  { id: "runs", title: "Workflow runs" },
];

export interface HookEventInfo {
  event: HookEventName;
  phase: HookPhase;
  /** A short name for the moment, such as "Before a tool runs". */
  title: string;
  /** One or two sentences on when it fires and what a hook there is good for. */
  summary: string;
  /** What the matcher is compared with, or null when the event ignores it. */
  matcher: { target: string; examples: string[] } | null;
  /** What a hook that exits with code 2 does here, or null when it cannot stop anything. */
  blocks: string | null;
  /** False for events Claude Code has that BAKED does not fire yet: their hooks never run. */
  fires: boolean;
}

const TOOLS = { target: "tool name", examples: ["Bash", "Edit|Write", "Read", "^mcp__.*"] };

/** Every event, in the order a session meets them. */
export const HOOK_EVENT_INFO: HookEventInfo[] = [
  {
    event: "SessionStart",
    phase: "start",
    title: "When a session starts",
    summary:
      "Runs when a session opens, resumes, is cleared, compacted or forked. What it prints goes to the model with your next message.",
    matcher: { target: "source", examples: ["startup", "resume", "clear|compact", "fork"] },
    blocks: null,
    fires: true,
  },
  {
    event: "UserPromptSubmit",
    phase: "start",
    title: "When you send a message",
    summary:
      "Runs before your message reaches the model, with the text on stdin. Good for checks on what is asked.",
    matcher: null,
    blocks: "Exit code 2 drops the message and shows the hook's reason.",
    fires: true,
  },
  {
    event: "PreToolUse",
    phase: "tools",
    title: "Before a tool runs",
    summary:
      "Runs before every matching tool call, with the tool and its input on stdin. Use it to guard commands or rewrite input.",
    matcher: TOOLS,
    blocks: "Exit code 2 stops the call; the agent sees the hook's reason.",
    fires: true,
  },
  {
    event: "PostToolUse",
    phase: "tools",
    title: "After a tool succeeds",
    summary:
      "Runs after a matching tool call finishes, with its result on stdin. Use it to format, lint or log.",
    matcher: TOOLS,
    blocks: null,
    fires: true,
  },
  {
    event: "PostToolUseFailure",
    phase: "tools",
    title: "After a tool fails",
    summary: "Runs when a matching tool call ends in an error.",
    matcher: TOOLS,
    blocks: null,
    fires: true,
  },
  {
    event: "SubagentStart",
    phase: "subagents",
    title: "When a subagent starts",
    summary: "Runs when the agent hands work to a subagent; stdin names its id and role.",
    matcher: { target: "subagent role", examples: ["explore", "code", "investigate"] },
    blocks: null,
    fires: true,
  },
  {
    event: "SubagentStop",
    phase: "subagents",
    title: "When a subagent finishes",
    summary: "Runs when a subagent returns its result.",
    matcher: { target: "subagent role", examples: ["explore", "code", "investigate"] },
    blocks: null,
    fires: true,
  },
  {
    event: "PreCompact",
    phase: "context",
    title: "Before the context is compacted",
    summary:
      "Runs before a long conversation is summarised to free context. Good for saving a transcript.",
    matcher: { target: "trigger", examples: ["manual", "auto"] },
    blocks: null,
    fires: true,
  },
  {
    event: "PostCompact",
    phase: "context",
    title: "After the context is compacted",
    summary: "Runs once the summary has replaced the older messages.",
    matcher: { target: "trigger", examples: ["manual", "auto"] },
    blocks: null,
    fires: true,
  },
  {
    event: "Notification",
    phase: "finish",
    title: "When the agent notifies you",
    summary:
      "Runs when BAKED waits for you: a permission to approve, a question or plan to answer, a workflow run that needs you.",
    matcher: {
      target: "notification type",
      examples: ["permission_prompt", "question", "run_attention"],
    },
    blocks: null,
    fires: true,
  },
  {
    event: "Stop",
    phase: "finish",
    title: "When the agent finishes",
    summary: "Runs when the agent ends its turn. Good for a desktop notification or a final check.",
    matcher: null,
    blocks: null,
    fires: true,
  },
  {
    event: "StopFailure",
    phase: "finish",
    title: "When a turn fails",
    summary: "Runs when the turn ends in an error instead of an answer.",
    matcher: null,
    blocks: null,
    fires: true,
  },
  {
    event: "SessionEnd",
    phase: "finish",
    title: "When a session ends",
    summary: "Runs when a session ends: on exit, on /clear, or when a chat is deleted.",
    matcher: { target: "reason", examples: ["prompt_input_exit", "clear", "other"] },
    blocks: null,
    fires: true,
  },
  {
    event: "RunAttention",
    phase: "runs",
    title: "When a workflow run needs you",
    summary:
      "Runs when a workflow run waits for a person or is blocked; stdin describes the run and what it needs.",
    matcher: {
      target: "request kind",
      examples: ["approval", "clarification", "delivery", "budget_exhausted"],
    },
    blocks: null,
    fires: true,
  },
];

export function hookEventInfo(event: string): HookEventInfo | undefined {
  return HOOK_EVENT_INFO.find((info) => info.event === event);
}

/** The operating system a template's command is written for. */
export type HookPlatform = "win32" | "darwin" | "linux";

export interface HookTemplate {
  id: string;
  title: string;
  description: string;
  event: HookEventName;
  matcher?: string;
  if?: string;
  async?: boolean;
  timeout?: number;
  /** The command per OS; `posix` covers macOS and Linux unless they have their own. */
  command: { posix: string; win32: string; darwin?: string };
}

/** Ready-made hooks; the New hook form starts from one and every field stays editable. */
export const HOOK_TEMPLATES: HookTemplate[] = [
  {
    id: "format-after-edit",
    title: "Format after edits",
    description: "Runs your formatter whenever the agent edits or writes a file.",
    event: "PostToolUse",
    matcher: "Edit|Write",
    timeout: 60,
    command: { posix: "npm run format --silent", win32: "npm run format --silent" },
  },
  {
    id: "block-rm-rf",
    title: "Block rm -rf",
    description: "Stops any shell command that starts with rm -rf before it runs.",
    event: "PreToolUse",
    matcher: "Bash",
    if: "Bash(rm -rf *)",
    command: {
      posix: "echo 'rm -rf is not allowed in this project' >&2; exit 2",
      win32: "echo rm -rf is not allowed in this project 1>&2 & exit 2",
    },
  },
  {
    id: "notify-when-done",
    title: "Notify when done",
    description: "Shows a desktop notification when the agent finishes its turn.",
    event: "Stop",
    async: true,
    command: {
      posix: "notify-send BAKED 'The agent finished'",
      darwin: `osascript -e 'display notification "The agent finished" with title "BAKED"'`,
      win32: 'powershell -NoProfile -Command "[console]::beep(880,300)"',
    },
  },
  {
    id: "log-shell",
    title: "Log shell commands",
    description: "Appends every shell call the agent makes to .baked/hook-log.jsonl.",
    event: "PreToolUse",
    matcher: "Bash",
    async: true,
    command: {
      posix: "cat >> .baked/hook-log.jsonl && echo >> .baked/hook-log.jsonl",
      win32: "more >> .baked\\hook-log.jsonl",
    },
  },
  {
    id: "run-needs-approval",
    title: "Ping on approvals",
    description: "Alerts you when a workflow run stops to wait for your approval.",
    event: "RunAttention",
    matcher: "approval",
    async: true,
    command: {
      posix: "notify-send BAKED 'A run waits for your approval'",
      darwin: `osascript -e 'display notification "A run waits for your approval" with title "BAKED"'`,
      win32: 'powershell -NoProfile -Command "[console]::beep(660,400)"',
    },
  },
];

/** The template's command for `platform`. */
export function templateCommand(template: HookTemplate, platform: HookPlatform): string {
  if (platform === "win32") return template.command.win32;
  if (platform === "darwin") return template.command.darwin ?? template.command.posix;
  return template.command.posix;
}

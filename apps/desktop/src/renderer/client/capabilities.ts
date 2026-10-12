/**
 * Capability groups of `GET /v1/health` (docs/desktop/api.md, "Health and capabilities"). Kept
 * free of the bridge so tests can import it.
 */

/** `/v1/workflow/checks*`. */
export const CHECKS_CAPABILITY = "checks";
/** `POST /v1/workflow/gates/draft`, `POST /v1/workflow/gates`, `/v1/workflow/gates/ID/places|bind`. */
export const GATE_DRAFTS_CAPABILITY = "gate-drafts";
/** `/v1/commands` and `/v1/skills`. */
export const LIBRARY_CAPABILITY = "library";
/** `/v1/workflow/routing`. */
export const ROUTING_CAPABILITY = "routing";
/** `POST /v1/sessions/ID/compact` ("Compact now" in chat). */
export const COMPACTION_CAPABILITY = "compaction";
/** `GET /v1/sessions/ID/diff` (line counts of the files a chat changed). */
export const DIFF_STATS_CAPABILITY = "diff-stats";
/** `mode: "plan"` in chat sessions and its `plan-review` prompt. */
export const PLAN_MODE_CAPABILITY = "plan-mode";
/** `POST /v1/sessions/ID/undo` and `/redo` (Undo and Redo in chat). */
export const CHAT_UNDO_CAPABILITY = "chat-undo";
/** `GET|POST /v1/workflow/memory` (the Run memory section). */
export const RUN_MEMORY_CAPABILITY = "run-memory";
/** `/v1/memory*` (the Chat memory section). */
export const CHAT_MEMORY_CAPABILITY = "chat-memory";
/** `images` on chat messages (paste and drop in the composer). */
export const IMAGES_CAPABILITY = "images";

/** Chat messages that start with a custom slash command expand on the server (the composer lists them). */
export const CUSTOM_COMMANDS_CAPABILITY = "custom-commands";

/** `GET /v1/skills/catalog`, `POST /v1/skills`, `GET|DELETE /v1/skills/SCOPE/NAME` (the Skills section). */
export const SKILLS_INSTALL_CAPABILITY = "skills-install";

/** `GET|PATCH /v1/settings` (the Chat settings pages). */
export const SETTINGS_CAPABILITY = "settings";

/** `GET /v1/sessions/ID/export` (Export in the chat menu). */
export const CHAT_EXPORT_CAPABILITY = "chat-export";

/** `/v1/graph*` (the Code graph section). */
export const CODE_GRAPH_CAPABILITY = "code-graph";

/** `GET /v1/git` and `POST /v1/git/actions` (the Git section). */
export const GIT_CAPABILITY = "git";
/** `/v1/diagnostics/*` (the Diagnostics section: storage, model events, error log). */
export const DIAGNOSTICS_CAPABILITY = "diagnostics";

/** `GET /v1/hooks` and `POST /v1/hooks/session` (the Hooks section). */
export const HOOKS_CAPABILITY = "hooks";

/** `POST /v1/providers/ID/switch` (Switch account for Codex and Claude Code). */
export const PROVIDER_SWITCH_CAPABILITY = "provider-switch";

/**
 * Whether a backend offers a capability: true or false from its health answer, null when the
 * health answer could not be read, so the caller has to try the endpoint and treat 404 as "no".
 */
export function offers(capabilities: readonly string[] | null, name: string): boolean | null {
  return capabilities === null ? null : capabilities.includes(name);
}

/** `/v1/mcp*` (the MCP servers section). */
export const MCP_CAPABILITY = "mcp";

/** `/v1/lsp*` (the Language servers section). */
export const LSP_CAPABILITY = "lsp";

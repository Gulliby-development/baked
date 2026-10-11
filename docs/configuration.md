# Configuration

## Files and scopes

| Scope | File |
| --- | --- |
| Global | `config.json` in the global data directory: `~/.baked/` on macOS and Linux, `%LOCALAPPDATA%\baked\` on Windows |
| Project | `<project>/.baked/config.json` |
| Project manifest | `baked/project.json` `defaults.config` (`defaultModel`, `taskRouter`, `modelRouting`, `modelFallback`; see [projects](projects.md)) |

Project settings override global ones; a setting changed for the session only overrides both until exit. Commands that change settings ask which scope to save to. `/settings` lists every option in one place. The global file is created with defaults on the first start; an invalid JSON file stops startup with the error and is not overwritten.

The type of the whole file is `AppConfig` in `src/types/index.ts`; the comments there are the reference for each field.

The chat settings that the terminal pickers edit (provider options, chat router and fallbacks, default chat model, tools and web search keys, agent features, Baked map, compaction, timeouts and context-window overrides) are also described in `src/core/settings/schema.ts`: key, type, allowed values, default, label, help and the scopes each may be saved in. The local API serves and validates them through `GET|PATCH /v1/settings` ([API contract](desktop/api.md#chat-settings)), and the desktop draws its chat settings pages from that description. Nested keys saved in different scopes merge: a project file may set only `taskRouter.spark` and keep the other router slots, `agentFeatures`, `cache` and `watchdogTimeouts` fields from the global file.

## Example

```json
{
  "defaultModel": "anthropic/claude-sonnet-4-5",
  "thinking": { "mode": "adaptive" },
  "taskRouter": {
    "spark": "anthropic/claude-haiku-4-5",
    "ember": "anthropic/claude-sonnet-4-5",
    "compact": "openai/gpt-4.1-mini"
  },
  "modelFallback": { "anthropic/claude-sonnet-4-5": ["openai/gpt-5"] },
  "compaction": { "strategy": "v2", "triggerThreshold": 0.7, "keepRecent": 4 },
  "retry": { "maxTransientRetries": 5, "baseDelayMs": 3000 },
  "instructionFiles": ["baked", "claude", "codex"]
}
```

## Common settings

| Field | Default | Does |
| --- | --- | --- |
| `defaultModel` | `"none"` | Active model as `provider/model`; `"none"` opens the picker on launch |
| `taskRouter` | unset | Models per kind of work ([user guide](guide.md#models-and-the-task-router)); `maxConcurrentAgents` 2..8, default 3 |
| `modelRouting` | unset | Models of workflow agents by class, role, profile and stage ([runtime guide](workflows/runtime.md#model-routing)) |
| `modelFallback` | unset | Per-model fallback chains ([providers](providers.md#model-fallback)) |
| `thinking.mode` | `"auto"` | `off`, `auto`/`adaptive` or `enabled`; `thinking.budgetTokens` (at least 1024) with `enabled` |
| `performance` | unset | Effort, speed, OpenAI reasoning effort, service tier and verbosity; set through `/provider-settings` |
| `agentFeatures` | see [guide](guide.md#agent-features) | Agent behavior toggles |
| `disabledTools` | `[]` | Tools turned off with `/tools` |
| `webSearch` | `true` | Web search tool (asks before each search) |
| `codeExecution`, `computerUse`, `anthropicTextEditor` | `true`, `false`, `false` | Provider-side tools for Claude models |
| `repoMap` | `true` | Build the repository graph on launch |
| `semanticSummaries` | `"ast"` | Symbol summaries: `off`, `ast`, `synthetic`, `llm`, `full`; `semanticSummaryLimit` caps LLM summaries (300) |
| `repoMapTokenBudget` | auto | Token budget of the graph in the prompt |
| `disabledLspServers` | `[]` | Language servers to skip (Mason package names) |
| `compaction` | `strategy: "v2"`, `triggerThreshold: 0.7`, `resetThreshold: 0.4`, `keepRecent: 4`, `maxToolResults: 30`, `llmExtraction: true` | Context compaction; `strategy: "disabled"` turns auto-compaction off |
| `contextManagement` | unset | Anthropic server-side context management and tool-result pruning |
| `contextWindowOverrides` | unset | Context window size per model ID |
| `retry` | `maxTransientRetries: 3`, `maxStallRetries: 3`, `baseDelayMs` 1000 (chat) / 2000 (agents) | Retries on 429, 5xx, overload and stalled streams; the delay doubles each attempt |
| `watchdog`, `watchdogTimeouts` | `false` | Retry stalled streams; `/watchdog` and `/timeouts` |
| `toolTimeout` | `2` | Minutes before a shell, project or agent tool call times out; `0` disables |
| `cache.ttl` | `"5m"` | Anthropic prompt cache lifetime: `5m` or `1h` |
| `memory.embeddingModel` | unset | Embedding model for memory recall; unset uses the offline embedder |
| `mcpServers` | `[]` | MCP servers ([extensions](extensions.md#mcp-servers)) |
| `hooks` | unset | Lifecycle hooks ([extensions](extensions.md#hooks)) |
| `workflows` | on (`enabled` defaults to `true`; set `false` to turn them off) | Spec-driven workflows ([runtime guide](workflows/runtime.md#enabling)) |
| `keyPriority` | `"env"` | Key lookup order, see below |
| `theme`, `diffStyle`, `chatStyle`, `collapseDiffs`, `showReasoning`, `verbose` | | Display; `/theme`, `/diff-style`, `/chat-style`, `/reasoning`, `/verbose` |
| `motion` | `"full"` | Brand animations; `"reduced"` shows still frames (`/motion`, or `BAKED_REDUCED_MOTION=1`) ([guide](guide.md#motion)) |
| `coAuthorCommits` | `true` | Co-author trailer on commits made through BAKED |
| `defaultBakeMode` | `"default"` | Mode of new sessions; the earlier name `defaultForgeMode` is still read |
| `telemetry`, `telemetryUrl` | `true`, unset | Local usage events and an optional receiver; `/telemetry` or `baked telemetry on\|off` switches `telemetry` ([privacy](privacy.md)) |
| `notifications` | `system: true`, no webhook | Announce a workflow run that waits for a person: a native notification and an optional webhook; `/notifications` edits them ([runtime guide](workflows/runtime.md#notifications-when-a-run-waits)) |

## Provider keys

`/keys` (or `baked --set-key <provider> <key>`) stores a key in the operating system's credential store:

| Platform | Storage |
| --- | --- |
| macOS | Login keychain, service `baked` |
| Linux | libsecret through `secret-tool`; without it `secrets.json` (mode 0600) in the global data directory |
| Windows | DPAPI-encrypted `secrets.dat` in the global data directory |

Environment variables such as `ANTHROPIC_API_KEY` work too and are not stored. `keyPriority: "env"` (default) checks the environment first; `"app"` checks stored keys first. `baked --list-providers` shows which source each provider uses.

## Instruction files

Project instructions are loaded into the system prompt from the files of the enabled sources. Only `baked` is on by default; `/instructions` toggles the others.

| ID | Files |
| --- | --- |
| `baked` | `baked.md`, `.baked/baked.md`, `.baked/instructions.md` |
| `claude` | `CLAUDE.md`, `.claude/instructions.md` |
| `codex` | `AGENTS.md`, `.agents/instructions.md` |
| `cursorrules` | `.cursorrules`, `.cursor/rules`, `.cursor/rules.md` |
| `github-copilot` | `.github/copilot-instructions.md` |
| `cline` | `.clinerules`, `.cline/rules` |
| `windsurf` | `.windsurfrules` |
| `aider` | `.aider.conf.yml`, `.aiderignore` |
| `amp` | `AMPLIFY.md`, `.amp/instructions.md` |

The list is `INSTRUCTION_SOURCES` in `src/core/instructions.ts`.

## Environment variables

| Variable | Does |
| --- | --- |
| `BAKED_NO_REPOMAP=1` | Skip the repository scan at startup |
| `BAKED_REDUCED_MOTION=1` | Still frames instead of brand animations, including the startup screen |
| `BAKED_MAX_OUTPUT_TOKENS` | Output token cap per step for all agents (default 64000) |
| `BAKED_DEBUG_API=1` | Dump each API request to `<project>/.baked/api-export/` |
| `BAKED_TELEMETRY=0`, `DO_NOT_TRACK=1` | Turn off local telemetry |
| `BAKED_TELEMETRY_URL` | Telemetry receiver; overrides `telemetryUrl` |
| `BAKED_BROWSER_EXECUTABLE` | Chromium executable for the AI acceptance gate's browser driver (Playwright) |

Older lower-case `baked_*` names are still read as a fallback (`src/core/legacy-env.ts`).

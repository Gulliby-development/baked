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
| `artifactDeploy` | `false` | Allow deploying [artifacts](artifacts.md) to your Vercel account (asks before each deploy) |
| `vercelTeamId` | unset | Vercel team artifacts deploy to; unset is the personal account (`VERCEL_TEAM_ID` works too) |
| `codeExecution`, `computerUse`, `anthropicTextEditor` | `true`, `false`, `false` | Provider-side tools for Claude models |
| `repoMap` | `true` | Build the repository graph on launch |
| `semanticSummaries` | `"ast"` | Symbol summaries: `off`, `ast`, `synthetic`, `llm`, `full`; `semanticSummaryLimit` caps LLM summaries (300) |
| `repoMapTokenBudget` | auto | Token budget of the graph in the prompt |
| `disabledLspServers` | `[]` | Language servers to skip, by command (`gopls`); Mason package names such as `pyright` work too. A project list replaces the global one. See [language servers](#language-servers) |
| `compaction` | `strategy: "v2"`, `triggerThreshold: 0.7`, `resetThreshold: 0.4`, `keepRecent: 4`, `maxToolResults: 30`, `llmExtraction: true` | Context compaction; `strategy: "disabled"` turns auto-compaction off |
| `watch` | `marker: "baked"`, `debounceMs: 300`, `ignore: []`, `removeAnswered: false`, `poll: false` | [Watch mode](watch.md): which comments start the agent and how files are watched |
| `coordinator` | `maxActive: 3`, `maxTokens: 20000000` | Limits on what the [project coordinator](coordinator.md) may launch: items active at once, and tokens summed over everything it launched |
| `contextManagement` | unset | Anthropic server-side context management and tool-result pruning |
| `contextWindowOverrides` | unset | Context window size per model ID |
| `retry` | `maxTransientRetries: 3`, `maxStallRetries: 3`, `baseDelayMs` 1000 (chat) / 2000 (agents) | Retries on 429, 5xx, overload and stalled streams; the delay doubles each attempt |
| `watchdog`, `watchdogTimeouts` | `false` | Retry stalled streams; `/watchdog` and `/timeouts` |
| `toolTimeout` | `2` | Minutes before a shell, project or agent tool call times out; `0` disables |
| `cache.ttl` | `"5m"` | Anthropic prompt cache lifetime: `5m` or `1h` |
| `memory.embeddingModel` | unset | Embedding model for memory recall; unset uses the offline embedder |
| `mcpServers` | `[]` | MCP servers ([extensions](extensions.md#mcp-servers)) |
| `hooks` | unset | Lifecycle hooks ([extensions](extensions.md#hooks)) |
| `workflows` | on (`enabled` defaults to `true`; set `false` to turn them off) | Spec-driven workflows ([runtime guide](workflows/runtime.md#enabling)); `workflows.maxParallelRuns` (1..8, default 2) caps the runs executing at once ([parallel runs](workflows/runtime.md#parallel-runs)) |
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

Project instructions are loaded into the system prompt from the files of the enabled sources, first the project's file and then the one in the home folder for each source, with the files listed in `baked/project.json` last. Only `baked` is on by default. `instructionFiles` in config holds the IDs of the enabled sources.

Each source is switched on and off, and each file viewed and edited, in both front ends:

- TUI: `/instructions` switches sources (the picker shows the file each one found). `/instructions files` lists every file on disk in prompt order, including those of switched-off sources; Enter opens one in `$EDITOR` (`$VISUAL`, then `$EDITOR`, then `nano`/`vim`/`vi`, or Notepad on Windows). `/instructions show PATH` shows a file's content and `/instructions edit PATH` edits it directly, or creates it when `PATH` is a file name a source reads, such as `AGENTS.md`.
- Desktop: the Instructions screen under Setup lists the files with a switch per source and an editor, and creates `AGENTS.md` or `baked.md` when the project has none ([desktop app](desktop/app.md)).

A save is checked against the version that was read: when the file changed in the meantime (another editor, Git, the other front end), the save is refused and, in the TUI, the edit is kept in a temporary file. Workflow runs freeze these files when they start, so a save lists the active runs that froze the earlier version; such a run stops at its next step until its plan is revised.

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
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Vercel token and team for [artifact deploys](artifacts.md#deploying-to-vercel) |
| `BAKED_BROWSER_EXECUTABLE` | Chromium executable for the AI acceptance gate's browser driver (Playwright) |

Older lower-case `baked_*` names are still read as a fallback (`src/core/legacy-env.ts`).

## Language servers

Code intelligence starts a language server for each language it finds in the project, from the servers on PATH, in baked's own directory (`lsp-servers` in the user config directory, where `/lsp` installs them) and in Mason's `bin` directory. A language with no server falls back to tree-sitter. `disabledLspServers` keeps baked from starting a server. Three front ends show the same status and make the same changes: `/lsp` and `/lsp status` in the terminal UI, `baked lsp` headless ([language servers](headless.md#language-servers)) and the desktop app's Language servers page over [`/v1/lsp`](desktop/api.md#language-servers). Their changes apply to running servers without restarting the project: turning a server off stops it, and installing or turning one on restarts the servers of its languages. The workflow doctor warns about a detected language with no working server.

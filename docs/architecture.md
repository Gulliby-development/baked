# Architecture

BAKED is one core with three front ends: the terminal UI (`src/components/`, `src/hooks/`, `src/stores/`), the headless CLI (`src/headless/`) and the local HTTP API (`src/core/api/`, `baked serve`) that the desktop app uses. Agent logic does not depend on any of them.

## Startup

`src/boot.tsx` parses the command line. Subcommands (`workflow`, `quick`, `doctor`, `serve`, `projects`, `project`, `telemetry`, `self-check`) and `--headless` run without the UI; everything else starts the terminal UI in the current folder or `--cwd`. One process works in one folder.

## The agent loop

The main agent, Forge (`src/core/agents/forge.ts`), assembles each turn's system prompt, context, tools, approval callbacks and mode, and runs the model loop through a provider from `src/core/llm/providers/`. For larger tasks it dispatches subagents (`src/core/agents/subagent-tools.ts`, `agent-runner.ts`): `spark` for read-only research and `ember` for edits, each on its router model. Dispatched agents share a bus (`agent-bus.ts`): a file and tool-result cache, serialized writes per file, and a findings channel that reaches the others at their next step.

## Context

The prompt is assembled in `src/core/context/manager.ts` and `src/core/prompts/`: mode, project and Git information, the rendered repository graph, instruction files, relevant memories, active skills, forbidden-file rules and the working set of the project manifest. Compaction (`src/core/compaction/`) keeps a structured record of the conversation so most compactions need no model call.

## Code intelligence

`src/core/intelligence/` keeps the repository graph (tree-sitter parsing, import edges, PageRank, Git co-change, SQLite index) and routes code questions to the best backend: standalone language servers, ts-morph for TypeScript and JavaScript, tree-sitter, then regex. The graph runs in a worker so the UI stays responsive.

## Tools and safety

Tools live in `src/core/tools/` and are registered in `src/core/tools/index.ts`. Every tool call passes the same wrapper: forbidden files are refused, paths outside the project ask through `onApproveOutsideCwd` (`src/core/security/outside-cwd.ts`), destructive commands and sensitive files ask through `onApproveDestructive`, hooks run before and after, and tabs coordinate edits through file claims (`src/core/coordination/`). Secrets are read through `src/core/secrets.ts` and never written to config.

## Storage

| Data | Location |
| --- | --- |
| Global config, keys fallback, known projects, telemetry log, language servers | The global data directory: `~/.baked/` (`%LOCALAPPDATA%\baked\` on Windows) |
| Project config | `<project>/.baked/config.json` |
| Sessions | `<project>/.baked/sessions/` (JSONL) |
| Memory | `<project>/.baked/memory.db` and `memory.db` in the global directory (SQLite) |
| Repository graph | `<project>/.baked/repomap.db` (SQLite) |
| Workflow runs, initiatives, artifacts and events | `<project>/.baked/workflows.sqlite` and `<project>/.baked/` artifact folders |
| Shared project content | `baked/` in the repository: `project.json`, `workflows/`, `gates/`, `agents/`, `skills/` |

`.baked/` is added to `.gitignore`; `baked/` is meant to be committed.

## Workflows

`src/core/workflows/`, `src/core/specs/` and `src/core/verification/` implement durable spec-driven runs: a state machine over stages, approvals bound to digests, budgets, leases, recovery and evidence-based verification. Durable events in SQLite are authoritative; the terminal UI, the CLI and the API only render them and send commands through `WorkflowService`. See [workflows](workflows/README.md).

## Desktop app

`apps/desktop` is an Electron app with its own package. Its main process runs one `baked serve` per open project and proxies the renderer's requests to it. See [desktop app](desktop/app.md) and the [API contract](desktop/api.md).

## Extension points

Providers (`src/core/llm/providers/`), tools (`src/core/tools/`), slash commands (`src/core/commands/`), MCP servers and hooks ([extensions](extensions.md)), skills, custom commands, workflow definitions, gates and agent profiles. [CONTRIBUTING.md](../CONTRIBUTING.md) describes development and checks.

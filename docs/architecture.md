# Architecture

BAKED is one core with three front ends: the terminal UI (`src/components/`, `src/hooks/`, `src/stores/`), the headless CLI (`src/headless/`) and the local HTTP API (`src/core/api/`, `baked serve`) that the desktop app uses. Agent logic does not depend on any of them.

## Startup

`src/boot.tsx` parses the command line. Subcommands (`workflow`, `quick`, `doctor`, `serve`, `projects`, `project`, `telemetry`, `self-check`) and `--headless` run without the UI; everything else starts the terminal UI in the current folder or `--cwd`. One process works in one folder.

## The agent loop

The main agent, Bake (`src/core/agents/bake.ts`), assembles each turn's system prompt, context, tools, approval callbacks and mode, and runs the model loop through a provider from `src/core/llm/providers/`. For larger tasks it dispatches subagents (`src/core/agents/subagent-tools.ts`, `agent-runner.ts`): `spark` for read-only research and `ember` for edits, each on its router model. Dispatched agents share a bus (`agent-bus.ts`): a file and tool-result cache, serialized writes per file, and a findings channel that reaches the others at their next step.

## Context

The prompt is assembled in `src/core/context/manager.ts` and `src/core/prompts/`: mode, project and Git information, the rendered repository graph, instruction files, relevant memories, active skills, forbidden-file rules and the working set of the project manifest. Compaction (`src/core/compaction/`) keeps a structured record of the conversation so most compactions need no model call.

## Code intelligence

`src/core/intelligence/` keeps the repository graph (tree-sitter parsing, import edges, PageRank, Git co-change, SQLite index) and routes code questions to the best backend: standalone language servers, ts-morph for TypeScript and JavaScript, tree-sitter, then regex. The graph runs in a worker so the UI stays responsive.

One process runs one intelligence worker, so one repository scan and one set of language servers serve everything in it. The root context (`src/core/context/shared-root.ts`) is created on first use; chat tabs, chat sessions and workflow steps build their own context managers on top of it.

- `baked serve`: the workflow service owns the root context and the chat host borrows it, so desktop chat and runs share the worker. Language servers start on the first chat turn or run step and stop when the server stops.
- Terminal UI: workflow runs execute in the workflow worker thread, which borrows the main thread's intelligence worker through a relay (`src/core/workers/intelligence-relay.ts`). Only the owner scans, clears or closes the worker; the borrower follows its scan state. When no worker is shared for the workspace, the workflow worker starts its own.
- `baked workflow` runs in its own process with its own worker.

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

Worker and desktop server supervision accept a `SupervisorClock` from `src/core/workflows/supervisor-clock.ts`. The default uses real wall time, monotonic time and unreferenced intervals. The takeover tests inject a manual clock and advance only the supervisor's polls after observing the expired lease or the scripted tool's stall marker. Worker close events, child process exits, SQLite recovery and workflow completion still use real I/O. Startup and healthy replacement work cannot consume a test's shortened grace period.

## Desktop app

`apps/desktop` is an Electron app with its own package. Its main process runs one `baked serve` per open project and proxies the renderer's requests to it. See [desktop app](desktop/app.md) and the [API contract](desktop/api.md).

## Extension points

Providers (`src/core/llm/providers/`), tools (`src/core/tools/`), slash commands (`src/core/commands/`), MCP servers and hooks ([extensions](extensions.md)), skills, custom commands, workflow definitions, gates and agent profiles. [CONTRIBUTING.md](../CONTRIBUTING.md) describes development and checks.

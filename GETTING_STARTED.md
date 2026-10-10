# Getting Started

## Run from source

Use Bun >= 1.3.13 on Windows, macOS, or Linux. From the repository root:

```sh
bun install
bun run dev
```


Configure a model provider through `/keys` and select a model with `Ctrl+L`. Local providers are supported. Use `bun run src/boot.tsx --list-providers` to inspect provider availability.

Commands below using `baked` assume a built installation. From source, use `bun run src/boot.tsx` from this checkout, or an absolute path to that entry point from another directory. Pass `--cwd <project>` to target another project.

Global configuration lives in `~/.baked/config.json`; project configuration lives in `.baked/config.json`. See [configuration](mintlify-docs/reference/configuration.mdx) for supported settings.

## The Interface

When baked starts you'll see:

```
┌─────────────────────────────────────────────────┐
│  󰊠 baked │ tokens │ context │ git │ model   │  ← header
│                                                 │
│  Chat messages appear here                      │  ← chat area
│  Tool calls show in real time                   │
│                                                 │
│  > type here...                                 │  ← input
│  ^X Stop  ^D Mode  ^G Git  ^L LLM   │  ← footer
└─────────────────────────────────────────────────┘
```

**Header** shows token usage, context budget, git branch, and active model.

**Chat area** renders messages with markdown, syntax-highlighted code blocks, and live tool call progress.

**Input box** accepts natural language or slash commands (type `/` to see them). Pasting multi-line content collapses to show the first line + a line count badge — press up/down to expand.

**Footer** shows keybinding shortcuts.

## Switching Models

Press `Ctrl+L` to open the model picker. Pick a provider, then a model. The switch takes effect on the next message — you can change models mid-conversation.

## Task Router

Use `/router` to assign different models to different task types:

| Slot | Section | Use Case |
|------|---------|----------|
| `spark` | Dispatch | Read-only explore/investigate agents — searches, reads, analyzes |
| `ember` | Dispatch | Code agents — reads files and makes edits |
| `webSearch` | Dispatch | Web search and page fetching agent |
| `desloppify` | Post-Dispatch | Cleanup pass after code agents finish |
| `verify` | Post-Dispatch | Adversarial review pass after code agents |
| `compact` | Background | Context compaction summarizer |
| `semantic` | Background | Repo map LLM symbol summaries |
| `default` | — | Fallback when no specific slot matches |

For example: Sonnet for `ember` (code quality matters), a fast cheap model for `spark` and `desloppify`.

> **Legacy fields** `coding`, `exploration`, `trivial`, and `planning` are still accepted for backwards compatibility but map to `spark`/`ember` internally and are hidden from the `/router` UI.

## Agent Features

Use `/agent-features` to toggle agent behavior. All features default to **on** (when the relevant router model is configured).

| Feature | What it does |
|---------|-------------|
| **De-sloppify** | Runs a cleanup agent after code agents to remove sloppy patterns (console.log, commented-out code, redundant checks). Requires a model in the `desloppify` router slot. |
| **Tier Routing** | Auto-classifies tasks as trivial (single-file, short prompt) and routes them to the `spark` model for faster, cheaper execution. |
| **Dispatch Cache** | Caches file reads across dispatch boundaries so the parent agent doesn't re-read files that subagents already returned. |
| **Target File Validation** | Requires file paths on dispatch tasks — rejects vague instructions before any subagent runs. |

Settings are scoped (project or global) and saved to `.baked/config.json`:

```json
{
  "agentFeatures": {
    "desloppify": false,
    "tierRouting": true
  }
}
```

## Modes

`Ctrl+D` cycles through Forge's personas:

| Mode | Behavior |
|------|----------|
| **default** | Standard — investigates then implements |
| **architect** | Design only — outlines and tradeoffs, no code |
| **plan** | Research only — reads and plans, no file edits |

Or switch directly: `/mode architect`

## Plan Mode

`/plan refactor the auth system` enters plan mode. Forge researches the codebase, writes a structured plan, then asks you to approve, revise, or cancel before executing anything.

The plan sidebar shows step-by-step progress during execution.

## Skills

Skills are markdown files that extend what Forge knows. Press `Ctrl+S` to browse.

Three tabs:

- **Search** — find and install from the [skills.sh](https://skills.sh) community registry
- **Installed** — skills on your machine (`~/.agents/skills/`, `~/.claude/skills/`)
- **Active** — skills loaded in the current session

## Web Search

Forge can search the web and read pages. Two search backends (Brave API → DuckDuckGo fallback) and two page fetchers (Jina Reader → Mozilla Readability fallback).

When a web search model is configured via `/router`, searches spawn a dedicated agent that can run multiple queries, follow links, and synthesize a structured summary — all within a single tool call.

Configure API keys via `/web-search`.

## Git

`Ctrl+G` opens the git menu with shortcuts for common operations:

| Key | Action |
|-----|--------|
| `c` | Commit (AI-generated message) |
| `p` | Push |
| `u` | Pull |
| `s` | Stash |
| `o` | Stash pop |
| `l` | Log |

Or use slash commands: `/git commit`, `/git push`, `/git pull`, `/git status`, `/git diff`, `/git log`, `/git branch`.

Toggle co-author commit trailers with `/git co-author`.

## Context Management

baked auto-summarizes when context exceeds 80% of the model's window. You can also:

- `/summarize` or `/compact` — manually compact the conversation
- `/context` — view the context budget inspector (shows per-section token breakdown, cache hit rate)
- `/context clear` — reset conversation context

## Repo Map

On startup, baked builds a live graph of your codebase — files, symbols, and import edges. PageRank ranks the most important files, which appear in the system prompt so the AI understands your codebase's shape.

Configure via `/repo-map`. See [baked.baked.com/concepts/repo-map](https://baked.baked.com/concepts/repo-map) for the full technical reference.

## Memory

Forge can store decisions, patterns, and preferences that persist across conversations via a SQLite-backed memory system.

- `/memory` — configure write scope (session/project/global), view and clear memories
- Memory appears in the system prompt automatically

## Scoped Configuration

Every setting can be saved to one of three scopes:

- **Session** — lost on exit (default)
- **Project** — saved to `.baked/config.json` in the project root
- **Global** — saved to `~/.baked/config.json` for all projects

Project settings override global; session overrides both.

## Projects

A project groups the sessions and workflow runs of one piece of work, across one or more checkouts. It is described by `baked/project.json`, which can be committed:

```sh
baked project init --name "My app" --root ../my-app-docs
baked project add "src/auth/**/*.ts" docs/auth.md
baked project show
```

- **Working set**: the files and globs in `workingSet` go into the chat context at the start of each session (`/clear` captures them again) and into the first agents of each workflow run, so the agent does not search for them again. Files over the budget (64 KB in total, 16 KB per file) are listed by name. Secrets matching the forbidden-file patterns, `.git`, `.baked`, `node_modules`, Git-ignored files and binaries are never included.
- **Roots**: `roots` names other checkouts of the project. A root outside the current checkout is used only after `baked project register`, which records it in `~/.baked/projects.json`; a root added to the manifest later needs registering again. Sessions started in a registered root belong to the project too. Roots do not change file access: tools still ask before touching files outside the working directory.
- **Defaults**: `defaults.config` may set `defaultModel`, `taskRouter`, `modelRouting` and `modelFallback`; `.baked/config.json` overrides them. `defaults.instructions` lists markdown files added to the project instructions.
- Sessions and workflow runs record the project's `id`, so `baked project show` lists them from every root.

See [design/projects-lite.md](design/projects-lite.md) for the design.

## Storage

`/storage` shows per-component disk usage across project and global storage — repo map index, sessions, plans, memory, history, config, binaries. One-click cleanup for each component.

## Troubleshooting


**No models in `Ctrl+L`**
Your API key isn't set or isn't exported. Add `export ANTHROPIC_API_KEY=...` to your shell profile and restart your terminal.

**Forge seems slow**
Switch to a faster model with `Ctrl+L` (e.g. Haiku 4.5). Use `/router` to assign fast/cheap models to `spark`, `desloppify`, and `compact` slots, and reserve a strong model for `ember`.

**Context getting large**
Run `/summarize` or `/compact` to condense the conversation. `/context` shows exactly where tokens are going.

## What's Next

- Type `/help` for the full command reference
- Press `Ctrl+S` to browse community skills
- Use `/router` to optimize model assignment per task
- Read [CONTRIBUTING.md](CONTRIBUTING.md) to hack on baked itself
- See [baked.baked.com](https://baked.baked.com/introduction) for deep dives on architecture, repo map, compound tools, and the agent bus

# Commands and keys

Type `/` in the input or press `Ctrl+K` for the command palette. `/help` opens the same list.

## Keys

| Key | Action |
| --- | --- |
| `Ctrl+K`, `Ctrl+H` | Command palette |
| `Ctrl+L` | Switch model |
| `Ctrl+G` | Git menu |
| `Ctrl+P` | Browse sessions |
| `Alt+O` | Switch project |
| `Ctrl+S` | Browse skills |
| `Ctrl+N` | New session (saves the current one) |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+[` / `Ctrl+]`, `Ctrl+1`..`Ctrl+9` | Previous / next tab, tab N |
| `Tab` / `Shift+Tab` | Cycle tabs from the input |
| `Ctrl+D` | Cycle mode |
| `Ctrl+B` / `Ctrl+F` | Previous / next checkpoint |
| `Ctrl+X` | Stop the agent |
| `Ctrl+X` then `E` (while the agent is idle) | Open the input in your editor and send what you save; see [composing in an editor](guide.md#composing-in-an-editor) |
| `Ctrl+O` | Expand or collapse code and reasoning |
| `Ctrl+C` | Copy the selection, or exit |
| `Meta+R` (`Alt+R` on Linux) | Error log |
| `@` in the input | Mention a file, folder or symbol (`Tab`/`Enter` inserts, `Esc` closes); see [mentions and shell commands](guide.md#mentions-and-shell-commands-in-the-input) |
| `!` at the start of a message | Run a shell command and add its output to the context |

## Slash commands

The tables below list the commands the palette shows, generated from `src/core/commands/registry.ts`. Some commands take arguments that are not listed: `/plan <task>`, `/mode <name>`, `/checkpoint undo [N]` or `/undo [N]` (see the [user guide](guide.md#checkpoints)), `/workflow new TEXT`, `/workflow quick TEXT`, `/workflow edit ID` and `/workflow routing`, `/workflow report RUN_ID` (see the [runtime guide](workflows/runtime.md#tui)).

### Session

| Command | Does |
| --- | --- |
| `/project` | This project: sessions, workflow runs, what waits for you |
| `/projects` | Switch project: known folders, pin, forget, open folder (Alt+O) |
| `/workflow` | Spec-driven workflows, approvals and verification |
| `/editor` | Compose a message in $EDITOR and send it (Ctrl+X E) |
| `/stash` (`/drafts`) | Browse stashed drafts (restore, delete) |
| `/compact` | Compact — run, settings, logs |
| `/compact logs` | View compaction events |
| `/compact settings` | Compaction strategy & pruning settings |
| `/session` | Session — history, clear, export, compact |
| `/session clear` | Clear chat history |
| `/session continue` | Continue interrupted generation |
| `/session export` | Export chat — markdown, json, clipboard, all |
| `/session export all` | Full diagnostic export (system prompt, messages, tools) |
| `/session export api` | Toggle per-step API request dump |
| `/session export clipboard` | Copy chat to clipboard (markdown) |
| `/session export json` | Export chat as JSON |
| `/session history` | Browse & restore sessions |
| `/session new` | Start a new session (saves current) |
| `/session rename` | Rename current session |
| `/session plan` | Toggle plan mode (research & plan only) |
| `/checkpoint` | Browse checkpoints — undo, redo, save |
| `/checkpoint undo` (`/undo`) | Undo last checkpoint (revert files) |
| `/checkpoint redo` (`/redo`) | Redo last undone checkpoint |
| `/checkpoint fork` | Fork a checkpoint into a new tab (rolls back files): `/checkpoint fork [N] [--force]` |
| `/checkpoint save` | Force save current state as git tag |
| `/checkpoint live` | Back to live view |

### Git

| Command | Does |
| --- | --- |
| `/git` | Git menu |
| `/git branch` | Show/create branch |
| `/git co-author` | Toggle co-author trailer |
| `/git commit` | Git commit with message |
| `/git diff` | View changes |
| `/git init` | Initialize git repo |
| `/git log` | Show recent commits |
| `/git pull` | Pull from remote |
| `/git push` | Push to remote |
| `/git stash` | Stash changes — pop to restore |
| `/git stash pop` | Pop latest stash |
| `/git status` | Git status |

### Models

| Command | Does |
| --- | --- |
| `/keys` | Manage LLM provider API keys |
| `/codex` | Show Codex login status |
| `/codex login` | Log in to Codex with your ChatGPT subscription |
| `/codex logout` | Log out of the current Codex account |
| `/codex switch` | Switch to a different Codex account |
| `/codex status` | Show Codex login status |
| `/claude-code` | Show Claude Code login status |
| `/claude-code login` | Log in to Claude Code with your Claude subscription |
| `/claude-code logout` | Log out of the current Claude Code account |
| `/claude-code status` | Show Claude Code login status |
| `/model-scope` | Set model scope (project/global) |
| `/models` | Switch LLM model (Ctrl+L) |
| `/provider-settings` | Provider options — thinking, effort, speed, context |
| `/router` | Route models per task (code, explore, plan, verify) |
| `/web-search` | Web search keys & settings |
| `/mcp` | MCP servers — status, tools, reconnect |

### Intelligence

| Command | Does |
| --- | --- |
| `/context` | Context & system dashboard |
| `/diagnose` | Health check — LSP, tree-sitter, semantic indexing |
| `/lsp` | Manage LSP servers — install, disable, enable |
| `/lsp install` | Install & manage LSP servers (Mason registry) |
| `/lsp restart` | Restart LSP servers (all or specific) |
| `/lsp status` | LSP status dashboard |
| `/memory` | Manage memory scopes, view & clear; the Runs tab shows and edits what workflow runs remember |
| `/repo-map` | Baked map settings (AST index) |
| `/skills` | Browse & install skills |
| `/tools` | Enable/disable tools for the agent |

### Settings

| Command | Does |
| --- | --- |
| `/agent-features` | Toggle agent features (de-sloppify, tier routing) |
| `/chat-style` | Toggle chat layout style |
| `/diff-style` | Change diff display style |
| `/instructions` | Toggle instruction files (baked.md, CLAUDE.md, etc.) |
| `/mode` | Switch Baked mode |
| `/motion` | Full or reduced animation |
| `/reasoning` | Show or hide reasoning content |
| `/settings` | Settings hub — all options in one place |
| `/theme` | Switch color theme (live preview) |
| `/verbose` | Toggle verbose tool output |
| `/verbose-tab` | Toggle verbose render for this tab — off folds tools into a rail, on shows raw stream |

### Tabs

| Command | Does |
| --- | --- |
| `/changes` | Toggle files changed this session |
| `/claim` | Show active file claims across tabs |
| `/claim force` | Steal a file claim from another tab |
| `/claim release` | Release a file claim from current tab |
| `/claim release-all` | Release all claims from current tab |
| `/tab` | Tabs — switch, new, close, rename |
| `/tab close` | Close current tab (Ctrl+W) |
| `/tab new` | Open new tab (Ctrl+T) |
| `/tab rename` | Rename current tab |

### System

| Command | Does |
| --- | --- |
| `/errors` | Browse error log |
| `/help` | Command palette (Ctrl+K) |
| `/commands` | List custom commands from .baked/commands |
| `/hooks` | View active hooks (PreToolUse, PostToolUse, etc.) |
| `/quit` (`/q`) | Exit baked |
| `/exit` (`/q`) | Exit baked |
| `/restart` | Full restart |
| `/setup` | Check & install prerequisites |
| `/status` | System status dashboard |
| `/model-events` | Model events — per-call latency, tokens, errors (opt-in) |
| `/storage` | View & manage storage usage |
| `/wizard` | Re-run the first-run setup wizard |
| `/timeouts` | Configure tool and watchdog timeouts |

## Custom commands

Markdown files in `<project>/.baked/commands/` and `~/.baked/commands/` become slash commands under **Custom**: `fix-ci.md` runs as `/fix-ci` and `frontend/component.md` as `/frontend:component`. `/commands` lists them with their files. Built-in commands win over custom ones with the same name. See [custom commands](custom-commands.md).

## Shell commands

| Command | Does |
| --- | --- |
| `baked` | Terminal UI in the current folder (`--cwd DIR` for another, `--session ID` to resume) |
| `baked --headless "<prompt>"` | One prompt without the UI; see [headless CLI](headless.md) |
| `baked --list-providers`, `--list-models [provider]`, `--set-key <provider> <key>`, `--version` | Provider status, models, store a key, version |
| `baked workflow <command>` | Durable workflow runs; see the [runtime guide](workflows/runtime.md) |
| `baked quick TEXT` | A small task through the quick workflow ([quick workflow](workflows/quick.md)) |
| `baked doctor` | Checks before a workflow run: keys, routed models, check commands, Git, budget |
| `baked serve [--port N] [--allow-origin ORIGIN]` | Local HTTP API on 127.0.0.1 for the desktop app ([local API](workflows/runtime.md#local-api-baked-serve)) |
| `baked session fork ID [--at MESSAGE_ID \| --checkpoint N] [--rollback-files] [--force] [--json]` | Save a fork of a session, optionally rolling files back ([forking a session](headless.md#forking-a-session)) |
| `baked session undo ID [--to N] [--force] [--json]`, `baked session redo ID [--force] [--json]` | Undo the last turn of a saved session with its file edits, or put the oldest undone turn back ([undoing a turn](headless.md#undoing-a-turn)) |
| `baked projects ...`, `baked project ...` | Known projects and the project manifest ([projects](projects.md)) |
| `baked telemetry [--json]` | The locally recorded usage events ([privacy](privacy.md)) |
| `baked self-check` | Loads native libraries, bundles and SQLite; non-zero exit on a failure |

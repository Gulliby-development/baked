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

The tables below list the commands the palette shows, generated from `src/core/commands/registry.ts`. Some commands take arguments that are not listed: `/plan <task>`, `/mode <name>`, `/effort <level>`, `/context-size <size>`, `/checkpoint undo [N]` or `/undo [N]` (see the [user guide](guide.md#checkpoints)), `/workflow new TEXT`, `/workflow quick TEXT`, `/workflow edit ID`, `/workflow definitions`, `/workflow routing` and `/workflow usage`, `/workflow report RUN_ID`, `/workflow usage RUN_ID --format md` (see the [runtime guide](workflows/runtime.md#tui)).

### Session

| Command | Does |
| --- | --- |
| `/project` | This project: sessions, workflow runs, what waits for you |
| `/project rename` | `/project rename NAME` renames this project in the picker, `baked projects` and the desktop app; without a name it restores the default |
| `/project waiting` | Run requests and blocked runs that wait for you, in this project and in your pinned and recent projects; Enter opens the run here or switches to its project |
| `/coordinator` | The [project coordinator](coordinator.md#terminal-ui): its conversation, launched work and split cards over the current tab; `Ctrl+Y` approves, `Ctrl+N` rejects, `Ctrl+E` rejects a split and starts a message to change it, `Esc` stops a running turn or goes back; `Ctrl+S` asks what's happening |
| `/coordinator summary` | Opens the [project coordinator](coordinator.md#terminal-ui) and asks it what is running, what waits for you, what finished since its last summary and what is still open |
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
| `/effort` | Reasoning effort of this chat (low … max, or default) |
| `/context-size` | Context window of this chat when the model offers several (e.g. 200k or 1M) |
| `/provider-settings` | Provider options — thinking, effort, speed, context |
| `/router` | Route models per task (code, explore, plan, verify) |
| `/web-search` | Web search keys & settings |
| `/mcp` | MCP servers — status, tools, reconnect |

Without the terminal UI, `baked login codex|claude-code` and `baked logout ...` sign the same CLIs in and out, and `baked --set-key` / `baked --remove-key` save and remove API keys ([headless CLI](headless.md#keys-and-sign-in)).

### Intelligence

| Command | Does |
| --- | --- |
| `/context` | Context & system dashboard |
| `/diagnose` | Health check — LSP, tree-sitter, semantic indexing (also `baked diagnose`, and Check code intelligence in the desktop) |
| `/graph` | Code graph at a glance: biggest groups and key files |
| `/lsp` | Manage LSP servers — install, disable, enable |
| `/lsp install` | Install & manage LSP servers (Mason registry) |
| `/lsp restart` | Restart LSP servers (all or specific) |
| `/lsp status` | LSP status: running servers, and the servers of the project's languages that are not running (not installed, off or failed); `r` restarts the selected one |
| `/memory` | Project memory: the Chat tab browses what the chat agent remembers, the Runs tab shows and edits what workflow runs remember, plus Hidden, Cleanup and scope Settings |
| `/repo-map` | Baked map settings (AST index) |
| `/skills` | Browse & install skills |
| `/packages` | [Packages](packages.md) installed in the project; `/packages add PATH` shows a local package's plan and installs it after you pick Install, `/packages remove NAME` deletes its unchanged files (both ask first); `/packages pack PATH [--name NAME] [--version VER] [--description "TEXT"] [--check]` writes the manifest of a package folder you author |
| `/agents` | Only in a project that has [agents from other tools](workflows/runtime.md#workflows-from-a-projects-agents) (Claude Code, GitHub Copilot, OpenCode, Roo Code): lists them, edits one in `$EDITOR`, removes its file, and turns them into a workflow (keys 1-9 pick each agent's stage, `b` the base workflow, `r` whether the agent files go); `/agents convert [ID]` starts there, `/agents edit NAME` opens one |
| `/tools` | Enable/disable tools for the agent |
| `/artifacts` | [Artifacts](artifacts.md) shared by every project: pick one to open it in the browser; `/artifacts open ID` opens one, `/artifacts deploy ID [prod]` asks the agent to deploy it (it asks before it deploys) |
| `/watch` | Watch files: saved baked! and baked? comments start the agent; `/watch on` starts it in this tab, `/watch off` stops it, `/watch status` shows it ([watch mode](watch.md)) |

### Settings

| Command | Does |
| --- | --- |
| `/agent-features` | Toggle agent features (de-sloppify, tier routing) |
| `/code-quality` | Quality gates of workflow runs (duplication ratchet, anti-slop rules, dependency check, Semgrep, property-based tests, mutation gate) and the library docs source of implementers |
| `/chat-style` | Toggle chat layout style |
| `/diff-style` | Change diff display style |
| `/instructions` | Toggle instruction files (baked.md, CLAUDE.md, etc.) |
| `/instructions edit` | Edit or create an instruction file in $EDITOR |
| `/instructions files` | List instruction files in prompt order; Enter edits one in $EDITOR |
| `/instructions show` | Show an instruction file's content |
| `/mode` | Switch Baked mode |
| `/motion` | Full or reduced animation |
| `/notifications` | System notifications and the webhook for runs that wait for you; `/notifications system on\|off`, `/notifications webhook URL\|off`, `/notifications blocking-only on\|off` ([runtime guide](workflows/runtime.md#notifications-when-a-run-waits)) |
| `/reasoning` | Show or hide reasoning content |
| `/sandbox` | OS sandbox of shell, project and check commands; `/sandbox off\|auto\|required` saves it globally, `/sandbox status` shows mode and backend ([OS sandbox](sandbox.md)) |
| `/settings` | Settings hub — all options in one place |
| `/telemetry` | Turn anonymous usage telemetry on or off; `/telemetry on\|off` ([privacy](privacy.md)) |
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
| `baked session checkpoints ID [--json]` | List the turns of a saved session that `undo --to N` can go back to ([undoing a turn](headless.md#undoing-a-turn)) |
| `baked session undo ID [--to N] [--force] [--json]`, `baked session redo ID [--force] [--json]` | Undo the last turn of a saved session with its file edits, or put the oldest undone turn back ([undoing a turn](headless.md#undoing-a-turn)) |
| `baked projects ...`, `baked project ...` | Known projects and the project manifest ([projects](projects.md)) |
| `baked telemetry [--json]`, `baked telemetry on\|off` | The locally recorded usage events, or turn recording on or off in the global config ([privacy](privacy.md)) |
| `baked sandbox status [--json]` | OS sandbox mode, its source and the backend of this machine; exit 1 when the sandbox is required but unavailable ([OS sandbox](sandbox.md)) |
| `baked self-check` | Loads native libraries, bundles and SQLite and starts a command in the OS sandbox when a backend works ([sandbox](sandbox.md)); non-zero exit on a failure |

# User guide

The terminal UI is started with `baked` in a project folder. One process works in one folder.

## The screen

- **Header**: model, project name, Git branch, context budget, token usage and cost, and a badge such as `2 waiting in other projects`.
- **Chat**: Markdown, highlighted code, live tool calls and diffs. A checkpoint rail on the right marks each turn.
- **Input**: plain text or slash commands (type `/`). A multi-line paste collapses to its first line and a line count. Typing while the agent works queues a steering message that is injected at the next step, without aborting.
- **Footer**: the main shortcuts.

## Models and the task router

`Ctrl+L` (or `/models`) picks a provider and model; the switch applies to the next message. `/model-scope` stores the choice in the project or global config.

`/router` assigns models to kinds of work. Unset slots use `taskRouter.default`, then the active model.

| Slot | Used by |
| --- | --- |
| `spark` | Read-only research agents dispatched by the main agent |
| `ember` | Code-editing agents |
| `webSearch` | The web search agent |
| `desloppify` | The cleanup pass after code agents (when enabled) |
| `verify` | The adversarial review after code agents (when enabled) |
| `compact` | Context compaction |
| `semantic` | One-line symbol summaries in the repository graph |
| `default` | Fallback for every slot |

A cheap model for `spark`, `compact` and `semantic` with a strong one for `ember` is where most savings come from. The legacy fields `coding`, `exploration` and `trivial` are still read and mapped to `spark` and `ember`.

The router screen also holds the per-model fallback chains (see [providers](providers.md#model-fallback)).

## Agent features

`/agent-features` toggles agent behavior per project or globally (`agentFeatures` in config):

| Feature | Default | Does |
| --- | --- | --- |
| `tierRouting` | on | Sends trivial tasks (one file, short prompt) to the `spark` model |
| `dispatchCache` | on | Shares file reads across dispatched agents so the parent does not re-read them |
| `targetFileValidation` | on | Rejects dispatch tasks that name no target files |
| `agentSkills` | on | Lets the agent search, install and load skills |
| `desloppify` | off | Cleanup agent after code agents (needs the `desloppify` slot) |
| `verifyEdits` | off | Adversarial review agent after code agents |
| `onDemandTools` | off | Starts with core tools only; the agent loads others with `request_tools` |

## Modes and plan mode

`Ctrl+D` cycles modes, or `/mode <name>`:

| Mode | Behavior |
| --- | --- |
| `default` | Investigates, then implements |
| `architect` | Design only: outlines and trade-offs, no edits |
| `plan` | Research and a written plan, no edits until you approve |
| `auto` | Works with as few interruptions as possible |

`/plan <task>` starts plan mode for one task: the agent researches, writes a structured plan, and asks you to approve, revise or cancel before it executes. The plan sidebar tracks progress.

For durable, resumable work with budgets, checks and review, use [workflows](workflows/README.md) instead (`/workflow`, `baked workflow`).

## Checkpoints

Every turn is a checkpoint. `Ctrl+B` and `Ctrl+F` step back and forward; browsing is read-only. Sending a message while viewing a past checkpoint branches from it: the later turns are undone as with `/undo N` before the message is sent.

| Command | Does |
| --- | --- |
| `/checkpoint` | List checkpoints |
| `/checkpoint N`, `/checkpoint live` | View checkpoint N, return to live |
| `/checkpoint undo [N] [--force]`, `/undo [N] [--force]` | Undo the last checkpoint, or every checkpoint after N, including their file edits |
| `/checkpoint redo [--force]`, `/redo [--force]` | Re-apply the oldest undone checkpoint: its messages come back and its files return to their state after that turn |
| `/checkpoint fork [N] [--force]` | Continue from checkpoint N (the viewed one, or the latest) in a new tab, with the files rolled back to it |
| `/checkpoint save` | Save the current state as a Git tag |

`/undo N` keeps checkpoint N whole, its prompt and its answer, and drops the turns after it; `/undo 0` drops every turn. The files those turns edited go back to their content at the end of checkpoint N, with the safeguards of a fork ([forking a checkpoint](#forking-a-checkpoint)): a `baked/undo-backup-*` tag first, and a file you or another program changed after the agent did is left as it is and listed unless `--force`. Without Git, undo rewinds the conversation only. Each tab has its own checkpoint history.

`/redo` steps forward one checkpoint at a time, in the order the turns ran, so `/undo 1` followed by `/redo` twice brings back turns 2 and 3. A file the redone turn deleted is deleted again, and folders it created are recreated. Files Git ignores are in no snapshot, so neither undo nor redo deletes them. Sending a new message clears the redo history.

The same rewind and redo run in the desktop app ("Rewind to here" and "Redo", [desktop app](desktop/app.md)) and on the command line (`baked session rewind` and `baked session redo`, [headless CLI](headless.md#rewinding-a-session)).

### Forking a checkpoint

`/checkpoint fork N` opens a new tab with the conversation up to the end of checkpoint N and restores the files the agent edited after it to their state at N; the original tab keeps its whole history. Browse to a checkpoint with `Ctrl+B` and run `/checkpoint fork` to fork the one you are viewing. The working tree is shared, so the rollback is visible to every tab.

The snapshots are Git tags (`baked/cp-*`) of the whole working tree, uncommitted and untracked files included and ignored files left out, made in a temporary index so your index, HEAD and branch do not change. The first message of a tab snapshots the workspace as it was before the conversation, and each checkpoint with edits snapshots it after. Forking never discards work silently:

- Before any file changes, the current working tree is saved to a `baked/fork-backup-*` tag; restore a file with `git restore --source=baked/fork-backup-XXXX -- path`.
- A file whose current content is in none of the conversation's snapshots (you or another program changed it after the agent did) is left as it is and listed. `--force` restores it too; it is still in the backup tag.
- Files another tab is editing, files Git ignores, and files outside the project are left as they are and listed.
- Only files the agent changed with its edit tools are rolled back; changes made through shell commands are not tracked.

Fork needs a Git repository only when there are files to restore. The same fork is `baked session fork` on the command line ([headless CLI](headless.md#forking-a-session)) and "Fork from here" in the desktop chat.

## Sessions

Sessions are saved after every turn as JSONL in `<project>/.baked/sessions/` and rebuilt after a crash. `Ctrl+P` (or `/session history`) resumes one, `Ctrl+N` starts a new one. `/session export` writes Markdown, JSON, the clipboard, or a full diagnostic dump. From a shell, `baked --session <id-prefix>` resumes in the UI and `baked --headless --session <id-prefix> "<prompt>"` without it.

## Tabs

Up to 5 tabs per project (`Ctrl+T`, `Ctrl+W`, `Ctrl+[` / `Ctrl+]`, `Ctrl+1`..`Ctrl+9`). Each tab has its own session, model, mode and checkpoints; the repository graph, language servers and MCP servers are shared.

Tabs coordinate through file claims. The first edit of a file claims it for that tab; another tab's agent gets a warning before editing it. Claims are released when the tab finishes its prompt, on `Ctrl+X`, when the tab closes, or after 5 minutes idle. `/claim` lists them, `/claim release`, `/claim release-all` and `/claim force` manage them. Git commands that change the working tree are blocked while another tab has dispatched agents running, so a commit never captures half-written edits.

## Git

`Ctrl+G` opens the Git menu: `c` commit (with a generated message), `p` push, `u` pull, `s` stash, `o` stash pop, `l` log. The same actions are slash commands: `/git commit`, `/git push`, `/git pull`, `/git status`, `/git diff`, `/git log`, `/git branch`, `/git stash`. `/git co-author` toggles the co-author trailer.

## Changed files

Once a tab's agent edits files, a line above the input lists them: new and modified counts, the lines they add and remove (`+52 −3`) and the first few names. `/changes` opens the side panel with the files as a tree, each with its own `+added −removed` (or `binary`). The line counts come from git, as in the desktop app's chat ([local API](desktop/api.md)): they are what is uncommitted in those files against `HEAD` now, so a file committed or reverted since drops out of the totals, and a new untracked file counts all its lines as added. They are measured when a turn ends and when the tab comes back into view; outside a git repository only the names are shown. Headless runs report the same numbers ([headless CLI](headless.md#changed-files)).

## Context and compaction

`/context` shows the context budget per section, cache hit rate and cost per model. When the conversation reaches 70% of the model's window (`compaction.triggerThreshold`), BAKED compacts it: older messages become a summary and the last few stay verbatim. The default `v2` strategy keeps a structured record of files, decisions and tool results as the conversation goes, so compaction usually needs no model call; `v1` asks the `compact` model for a prose summary. `/compact` runs it now and `/compact settings` changes the strategy. In the desktop app, **Compact now** in the chat's context panel does the same for a chat session.

## Repository graph

On startup BAKED indexes files, symbols and imports with tree-sitter, ranks files with PageRank, and puts the top of that graph in the system prompt. Files you edit or mention are boosted for the next turn, and edits re-index immediately. `/repo-map` configures it; `--no-repomap` or `BAKED_NO_REPOMAP=1` skips the scan for one run. See [tools and code intelligence](tools.md).

## Memory

The agent stores preferences, decisions and pitfalls in SQLite: `<project>/.baked/memory.db` for the project and `memory.db` in the global data directory for preferences across projects. Before each turn up to 3 relevant memories are injected. `/memory` browses, pins, hides and restores them and sets the read and write scopes. Deletes are soft. `memory.embeddingModel` in config switches from the built-in offline embedder to a provider model.

## Skills and instruction files

Skills are folders with a `SKILL.md`. `Ctrl+S` or `/skills` searches the [skills.sh](https://skills.sh) catalog, lists installed skills and toggles them for the session. See [extensions](extensions.md#skills).

Project instructions come from `baked.md` (also `.baked/baked.md`, `.baked/instructions.md`). `/instructions` can also load the files of other tools: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.clinerules`, `.windsurfrules` and others (see [configuration](configuration.md#instruction-files)).

## Custom commands

Markdown files in `.baked/commands/` and `~/.baked/commands/` become slash commands: `fix-ci.md` is `/fix-ci`. See [custom commands](custom-commands.md).

## Mentions and shell commands in the input

`@` in the chat input opens a fuzzy list of the project's files, folders and, when the repository graph is ready, symbols. `Up`/`Down` choose, `Tab` or `Enter` inserts, `Esc` closes the list. When the message is sent, each mention attaches context for the model; the message shows as typed, with one line per mention under it:

| Mention | Attaches |
| --- | --- |
| `@src/auth.ts` | The file (up to 2000 lines or 100 KB) |
| `@src/auth.ts#10-40` | Lines 10 to 40 of the file |
| `@src/auth/` | The folder listing |
| `@"docs/my notes.md"` | A path with spaces |
| `@AuthService`, `@AuthService.login` | The definition from the repository graph with its call sites and importers |

A mention that names nothing (an e-mail address, `@types/node`) stays plain text. Files outside the project and files matching the [forbidden patterns](configuration.md) are not attached; the line under the message says why. `@` inside inline code or a code block is literal.

A message that starts with `!` runs the rest of its first line as a shell command in the project folder, for example `!git log -5`. Its output (up to 20 000 characters) goes into the context, and the first lines show under the message. Lines after the command are the question for the model: `!bun test` then `why does this fail?` on the next line. A bare `!command` sends the output with a short note, so the agent comments on it. The command goes through the same rules as the agent's `shell` tool: it does not run in `plan` or `architect` mode, `PreToolUse`/`PostToolUse` hooks for `shell` apply, forbidden paths are refused, and a destructive command (`rm -rf`, `git reset --hard`, ...) asks for approval in default mode and runs unasked in auto mode. When the command does not run and the message has nothing else, no turn starts. `Ctrl+X` stops a running command.

A message with `@` or `!` typed while the agent works waits for the turn to end instead of steering it, so it is expanded like a new message.

## Composing in an editor

Press `Ctrl+X` and then `E` while the agent is idle, or run `/editor`, to write the message in your own editor. The current input (with collapsed pastes expanded) opens in a temporary `prompt.md`; save and quit to send it. Quitting with an error (`:cq` in Vim) or saving an empty file sends nothing and keeps the input as it was. While the agent works, `Ctrl+X` keeps stopping it, so use `/editor` to compose a message that queues for the end of the turn; `/editor` starts from an empty file.

The editor is `$VISUAL`, then `$EDITOR`; the value can carry arguments, such as `code --wait` or `"C:\Program Files\Notepad++\notepad++.exe" -multiInst -nosession`. GUI editors need their wait flag so BAKED knows when you are done. Without either variable BAKED uses Notepad on Windows and the first of `nano`, `vim` or `vi` on macOS and Linux.

## Web search

The agent can search the web and read pages; each search asks for approval. `/web-search` sets the keys (Brave, with DuckDuckGo as the fallback; Jina Reader for pages, with Readability as the fallback). With a `webSearch` model in `/router`, searches run in a dedicated agent that can follow links and returns one summary.

## Projects

A project is any folder BAKED was opened in. Each folder keeps its sessions and workflow runs in its own `.baked/`, so nothing moves when you switch.

- **`/projects`** or **`Alt+O`** lists known folders with their sessions, active workflow runs and requests waiting for you. Pinned folders come first, then the most recently opened. `Enter` opens one; `Tab` opens its actions (resume a session, pin, rename, forget). **Open folder…** adds a path.
- **`/project`** shows the current folder: name, path, working set (when `baked/project.json` exists), its sessions and workflow runs, and what waits for you.
- **Switching** saves the session as an exit does and restarts BAKED in the other folder with `--cwd`. A workflow run executing in this process is paused first, after asking; resume it from `/workflow` later.
- **Header badge**: requests waiting in the pinned folders and the 10 most recently opened, refreshed every 60 seconds.

From a shell:

```sh
baked projects list [--json]
baked projects add [PATH]
baked projects pin [PATH]          # unpin reverses it
baked projects rename [PATH] NAME  # "" restores the default name
baked projects forget [PATH]       # sessions and runs stay in the folder
```

A manifest `baked/project.json` groups one piece of work across several checkouts and adds a working set that goes into every new session's context: `baked project init`, `baked project add`, `baked project show`, `baked project register`. See [projects](projects.md).

## Storage

`/storage` shows disk usage per component (repository graph, sessions, plans, memory, history, config, binaries) and cleans each one up.

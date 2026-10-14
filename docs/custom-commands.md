# Custom slash commands

Status: implemented.

Repeatable prompts live as Markdown files and run as slash commands, as in Claude Code and OpenCode. `.baked/commands/fix-ci.md` becomes `/fix-ci`; its body is sent to the agent as the user prompt.

## Files

| Scope | Directory |
|---|---|
| Global | `~/.baked/commands/` |
| Project | `<cwd>/.baked/commands/` |

- Every `*.md` file under a directory is a command. The name is the path relative to the directory without `.md`, with subdirectories joined by `:`: `frontend/component.md` is `/frontend:component`.
- Names are lowercased. A file whose name contains anything other than letters, digits, `-`, `_` and `.` (or `:` from a subdirectory) is skipped. Hidden files and directories are skipped. Files larger than 64 KB are skipped.
- A project command replaces a global command with the same name.
- Only `.baked/commands` is read. `.claude/commands` files often rely on inline !`command` expansion, which BAKED does not perform, so reading them would send unexpanded syntax to the model.

## Format

```markdown
---
description: Fix the failing CI job
argument-hint: <job name>
---
Find why the CI job $1 fails and fix it. Extra notes: $ARGUMENTS
```

- Optional frontmatter with flat `key: value` lines. `description` and `argument-hint` are used; other keys are ignored so files written for other tools still load. Without `description`, the first non-empty body line (truncated) is shown.
- `$ARGUMENTS` is replaced with everything after the command name. `$1` to `$9` are replaced with positional arguments split on whitespace, where double-quoted text counts as one argument. Missing positionals become empty strings.
- When the body has no placeholder and arguments were given, they are appended as `\n\nARGUMENTS: <args>` so they are not lost.
- The expanded text is an ordinary user prompt and goes through the normal `UserPromptSubmit` hooks, approvals and tools. Like typed text, its `@` mentions attach files and symbols, and a body whose first line starts with `!` runs that line as a command ([mentions and shell commands](guide.md#mentions-and-shell-commands-in-the-input)).

## Managing commands

- Terminal UI: `/commands` lists them. `/commands add NAME PROMPT` writes `.baked/commands/NAME.md` of the project with the prompt as its body, and `/commands add --global NAME PROMPT` the same file in `~/.baked/commands/`; edit the file for frontmatter or a longer prompt. `/commands remove [--global] NAME` deletes it. `NAME` is `fix-ci`, `/fix-ci` or `frontend:component` (a file in a subfolder).
- Desktop app: **Settings > Global commands** lists the commands of `~/.baked/commands/` and adds, edits and removes them with a form: name, description, argument hint and prompt.
- Local API: `POST /v1/commands`, `GET|PUT|DELETE /v1/commands/SCOPE/NAME` (servers with the `commands-edit` capability, see the [API reference](desktop/api.md)).

A name is refused when it is empty, has characters other than lowercase letters, digits, `-`, `_` and `.` (with `:` between folder levels), or is taken by another command of the same scope; an empty prompt is refused too. A rename moves the file, and a folder a removal leaves empty is removed.

## Name conflicts

Built-in commands win. A custom command whose name equals a built-in command, its first word (for example `/session`) or an alias is not runnable and is hidden from the palette. `/commands` lists custom commands with their scope and file, and marks shadowed ones.

## Architecture

- `src/core/commands/custom.ts` has no terminal UI imports: `listCustomCommands(cwd)`, `findCustomCommand()`, `expandCustomCommand()` and `expandCustomCommandInput(input, cwd, isReserved?)`. The desktop app and the headless CLI use the same functions.
- `listCustomCommands` reads the disk on each call; `getCachedCustomCommands` keeps the result for two seconds for the palette and autocomplete, which ask on every keystroke. Running a command always reads the file fresh.
- Terminal UI:
  - `getCommandDefs()` appends runnable custom commands in a `Custom` category, so the palette and input autocomplete show them.
  - `TabInstance` sends a custom command to `chat.handleSubmit` instead of the built-in dispatcher, and `useChat.handleSubmit` expands it. Expansion at that single point also covers prompts queued while the agent is busy; `InputBox` queues custom commands like plain messages instead of running them immediately.
  - The chat shows the expanded prompt; what its `@` mentions and `!` command attached is listed under it.
- Headless CLI: the `--headless` prompt and each chat-mode prompt are expanded. The headless CLI has no built-in slash commands, so no name is reserved there.
- Local API and desktop app: `ChatSession.send` (`src/core/chat/sessions.ts`) expands a message from `POST /v1/sessions` or `POST /v1/sessions/ID/messages` before it starts a turn, is queued or is steered into a running turn, so the session stores and the model receives the expanded prompt, as in the terminal UI. Global commands come from the home folder of the user running `baked serve`. The API has no built-in slash commands, so no name is reserved there either. Servers that expand commands list the `custom-commands` capability; on those, the desktop composer lists the commands (`GET /v1/commands`) when a message starts with `/`, with their argument hint, description and scope, and Tab or Enter completes the highlighted name.

## Not included

Per-command model or mode selection, inline !`command` expansion inside a body, and per-project command sets beyond the working directory (projects-lite can add a roots list later).

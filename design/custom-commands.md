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
- Only `.baked/commands` is read. `.claude/commands` files often rely on `!` shell and `@file` expansion that BAKED does not perform, so reading them would send unexpanded syntax to the model.

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
- No shell execution or file inclusion happens. The expanded text is an ordinary user prompt and goes through the normal `UserPromptSubmit` hooks, approvals and tools.

## Name conflicts

Built-in commands win. A custom command whose name equals a built-in command, its first word (for example `/session`) or an alias is not runnable and is hidden from the palette. `/commands` lists custom commands with their scope and file, and marks shadowed ones.

## Architecture

- `src/core/commands/custom.ts` has no terminal UI imports: `listCustomCommands(cwd)`, `findCustomCommand()`, `expandCustomCommand()` and `expandCustomCommandInput(input, cwd, isReserved?)`. The desktop app and the headless CLI use the same functions.
- `listCustomCommands` reads the disk on each call; `getCachedCustomCommands` keeps the result for two seconds for the palette and autocomplete, which ask on every keystroke. Running a command always reads the file fresh.
- Terminal UI:
  - `getCommandDefs()` appends runnable custom commands in a `Custom` category, so the palette and input autocomplete show them.
  - `TabInstance` sends a custom command to `chat.handleSubmit` instead of the built-in dispatcher, and `useChat.handleSubmit` expands it. Expansion at that single point also covers prompts queued while the agent is busy; `InputBox` queues custom commands like plain messages instead of running them immediately.
  - The chat shows the expanded prompt, which is exactly what the model receives.
- Headless CLI: the `--headless` prompt and each chat-mode prompt are expanded. The headless CLI has no built-in slash commands, so no name is reserved there.

## Not included

Per-command model or mode selection, `!` shell and `@file` expansion (a separate feature), and per-project command sets beyond the working directory (projects-lite can add a roots list later).

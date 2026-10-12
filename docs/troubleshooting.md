# Troubleshooting

Start with `/status` (system dashboard), `/diagnose` (LSP, tree-sitter, semantic indexing), `/errors` (error log, also `Meta+R`) and, before a workflow, `baked doctor`. In the desktop app, a project's **Diagnostics** page shows the same error log, model events and storage for that project's backend ([desktop app](desktop/app.md#screens)).

## No models in the picker

No key is configured for any provider. Save one with `/keys` or `baked --set-key anthropic sk-ant-...`, or export it (`export ANTHROPIC_API_KEY=...`) and restart the terminal. `baked --list-providers` shows what each provider sees. If an exported key keeps overriding a stored one, set `"keyPriority": "app"`.

`baked login` shows whether the Codex and Claude Code CLIs are installed and signed in.

## Rate limits (429) and overloads

Raise the retries and add a fallback model:

```json
{
  "retry": { "maxTransientRetries": 5, "baseDelayMs": 3000 },
  "modelFallback": { "anthropic/claude-sonnet-4-5": ["openai/gpt-5"] }
}
```

See [providers](providers.md#model-fallback).

## Context is full

`/compact` compacts now; `/context` shows where the tokens go. Lower `compaction.triggerThreshold` (default `0.7`) to compact earlier, or switch to a model with a larger window.

## The agent is slow or expensive

Route research and background work to a fast model in `/router` (`spark`, `compact`, `semantic`) and keep the strong model for `ember`. `/model-events` (or **Diagnostics** in the desktop app) shows per-call latency and errors when several models are in use. Recording is off until you turn it on, and each process (the terminal UI, each project's `baked serve`) records only its own calls.

## LSP is not working

`/lsp status` lists attached servers. `/lsp install` installs a missing one from the Mason registry; restart BAKED afterwards.

## Copilot: 401

The Copilot token was rotated. Copy it again from the IDE's `apps.json` ([providers](providers.md#github-copilot)).

## A session is missing

Sessions are per folder, in `<project>/.baked/sessions/`. Open the right folder (`Alt+O`), then `Ctrl+P` or `/session history`. `baked --headless --chat` browses them from a shell.

## Windows: pasting an image does nothing

Windows Terminal's bracketed paste sends an empty sequence for image clipboards, and the clipboard read needs `powershell` or `pwsh` on `PATH`.

- Press `Alt+V` instead of `Ctrl+V`.
- Make sure `C:\Windows\System32\WindowsPowerShell\v1.0` is on `PATH`.
- `/errors` shows a `clipboard` entry when the read failed.
- Otherwise save the screenshot to a file and give its path in the prompt.

## Windows: command not found after install

`PATH` changes do not reach the shell that ran the installer; open a new terminal. With the ZIP, put the folder on `PATH` or run `baked.exe` by its full path, and keep `deps/` next to it. `baked self-check` reports a missing native library or bundle.

## Lint reports every file on a Windows checkout

The checkout predates `.gitattributes` and has CRLF line endings; see [CONTRIBUTING.md](../CONTRIBUTING.md#verification).

## The .baked folder is large

`/storage` (or **Diagnostics → Storage** in the desktop app) shows what takes the space. The code map rebuilds itself after Clear; chat sessions, plans and prompt history do not come back. Compact databases reclaims the space SQLite keeps after deleted rows without deleting anything. The desktop app refuses to clear sessions or the code map while a chat turn or a workflow run of that project is working.

## Still stuck

Open an issue at [GitHub](https://github.com/Gulliby-development/baked/issues) with the output of `/status` and `/errors` (in the desktop app, the project's Diagnostics page).

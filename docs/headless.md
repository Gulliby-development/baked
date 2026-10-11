# Headless CLI

`baked --headless` runs the same agent and tools without the terminal UI, for scripts and CI. Agent text goes to stdout; progress goes to stderr, so pipes stay clean.

```sh
baked --headless "explain the auth middleware"
echo "find unused exports" | baked --headless
baked --headless --json "list all TODOs"          # one JSON result
baked --headless --events "refactor the store"    # JSONL event stream
baked --headless --chat                           # interactive multi-turn chat
```

## Options

| Option | Does |
| --- | --- |
| `--model <provider/model>` | Override the model |
| `--mode <mode>` | `default`, `architect`, `plan` or `auto` |
| `--max-steps <n>` | Stop after N agent steps |
| `--timeout <ms>` | Abort after N milliseconds |
| `--cwd <dir>` | Work in another folder |
| `--system "..."` | Add system instructions |
| `--include <file>` | Load a file into context first (repeatable) |
| `--no-repomap` | Skip the repository scan |
| `--diff` | List the files the session changed, with the lines each adds and removes |
| `--save-session` | Save the conversation for a later `--session` |
| `--session <id>` | Resume a saved session (an ID prefix is enough) |
| `--quiet` | Suppress the header and footer on stderr |

Exit codes: `0` success, `1` error, `2` timeout, `130` aborted.

`--events` emits one JSON object per line with a `type` of `start`, `input-context`, `text`, `tool-call`, `tool-result`, `step`, `error`, `done` or `session-saved`. `input-context` carries `items` (`{kind, ref, ok, summary, output?}`) for the prompt's `@` mentions and `!` command.

## Changed files

When the session has edited files, the stderr footer ends with the totals (`+52 −3 in 3 files`), and `--diff` lists each file as `+ADDED −REMOVED PATH`, with `(added)`, `(deleted)`, `(unchanged)`, `(outside)` or `(unknown)` when it is not a plain edit. `--json` output, the `done` event and in `--chat` each `turn-done` event carry the same numbers as `diffStats`, the `SessionDiffStats` object of the [local API](desktop/api.md) (`{base, files: [{path, status, added, removed, binary?}], totals: {files, added, removed}}`). Git measures what is uncommitted in those files against `HEAD`, as in the [terminal UI](guide.md#changed-files). The session's files are the ones this run edited plus those a resumed session's saved tool calls name; a session saved by an earlier headless run stores only text, so its earlier edits are not included.

## Mentions and shell commands

Prompts accept the same `@path`, `@path#10-40`, `@Symbol` and leading `!command` as the terminal input ([user guide](guide.md#mentions-and-shell-commands-in-the-input)); each attached item is listed on stderr. `baked --headless '!git diff'` sends the diff to the agent. Destructive commands are denied unless `--mode auto`, and no command runs in `plan` or `architect` mode; a prompt that is only a refused command exits with code 1 in a single run and is skipped in `--chat`.

## Sessions across runs

```sh
baked --headless --save-session "analyze the auth module, find all issues"
baked --headless --session <id> --save-session "now fix them"
```

## Forking a session

```sh
baked session fork <id> --checkpoint 2 --rollback-files
baked --headless --session <new-id> "try the other approach"
```

`baked session fork ID` saves a new session with the active conversation of session `ID` and prints its id. `--at MESSAGE_ID` keeps the messages up to and including that message, `--checkpoint N` up to the end of checkpoint (turn) N; without either the whole conversation is copied. `--rollback-files` also restores the files the agent edited after that point to their state there, with the same safeguards as `/checkpoint fork` in the terminal UI ([forking a checkpoint](guide.md#forking-a-checkpoint)): a backup tag first, and files changed since the agent last touched them are left as they are unless `--force`. `--json` prints `{sessionId, title, messageCount, checkpoint, rollback}`, where `rollback` is the report described in the [local API](desktop/api.md). The command exits 1 when the session, message or checkpoint does not exist, or when files need restoring and the project is not a Git repository.

Headless runs do not snapshot the workspace, so a session made only with `--save-session` can be forked but its files cannot be rolled back.

## Rewinding a session

```sh
baked session checkpoints <id>
baked session rewind <id> --checkpoint 1 --rollback-files
baked session redo <id>
```

`baked session rewind ID --checkpoint N` changes session `ID` itself instead of saving a copy: it keeps the turns up to and including checkpoint N (`0` keeps none) and drops the later ones, as `/undo N` does in the terminal UI ([checkpoints](guide.md#checkpoints)). `--rollback-files` also restores the files the dropped turns edited, with the fork's safeguards and `--force`. `baked session checkpoints ID` lists the checkpoints with their prompts and the turns a redo can bring back.

`baked session redo ID` brings back the oldest dropped turn, and moves its files forward when the rewind rolled them back. The dropped turns are saved with the session, so redo works in a later invocation; they are discarded once the conversation changes in any other way, for example a new turn after `baked --session ID`. Run these commands on a session no terminal UI or `baked serve` has open, since those keep their own copy and save it over the change.

All three take `--json`: `checkpoints` prints `{sessionId, checkpoints, redo}`, `rewind` and `redo` print `{sessionId, checkpoint, messageCount, rollback, redo}`. They exit 1 when the session or checkpoint does not exist, when there is nothing to redo, or when files need restoring and the project is not a Git repository.

## Approvals

There is no one to ask in headless mode: actions that would ask for approval in the terminal UI (writes outside the project, destructive shell commands) are not prompted. Cap runs with `--max-steps` and `--timeout`, keep API keys in CI secrets, and run untrusted prompts in a disposable checkout.

## Custom commands and workflows

`baked --headless "/fix-ci lint"` expands [custom commands](custom-commands.md). For multi-stage work with approvals, checks and budgets, use `baked workflow` ([runtime guide](workflows/runtime.md)), which is scriptable on its own and has its own exit codes.

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
| `--diff` | List the files changed by the run |
| `--save-session` | Save the conversation for a later `--session` |
| `--session <id>` | Resume a saved session (an ID prefix is enough) |
| `--quiet` | Suppress the header and footer on stderr |

Exit codes: `0` success, `1` error, `2` timeout, `130` aborted.

`--events` emits one JSON object per line with a `type` of `start`, `text`, `tool-call`, `tool-result`, `step`, `error`, `done` or `session-saved`.

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

## Approvals

There is no one to ask in headless mode: actions that would ask for approval in the terminal UI (writes outside the project, destructive shell commands) are not prompted. Cap runs with `--max-steps` and `--timeout`, keep API keys in CI secrets, and run untrusted prompts in a disposable checkout.

## Custom commands and workflows

`baked --headless "/fix-ci lint"` expands [custom commands](custom-commands.md). For multi-stage work with approvals, checks and budgets, use `baked workflow` ([runtime guide](workflows/runtime.md)), which is scriptable on its own and has its own exit codes.

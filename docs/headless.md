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
| `--image <file>` | Attach a PNG, JPEG, GIF or WebP image to the prompt (repeatable, at most 4); see [Images](#images) |
| `--no-repomap` | Skip the repository scan |
| `--diff` | List the files the session changed, with the lines each adds and removes |
| `--save-session` | Save the conversation for a later `--session` |
| `--session <id>` | Resume a saved session (an ID prefix is enough) |
| `--quiet` | Suppress the header and footer on stderr |

Exit codes: `0` success, `1` error, `2` timeout, `130` aborted.

`--events` emits one JSON object per line with a `type` of `start`, `input-context`, `text`, `tool-call`, `tool-result`, `step`, `error`, `done` or `session-saved`. `input-context` carries `items` (`{kind, ref, ok, summary, output?}`) for the prompt's `@` mentions and `!` command.

## Changed files

When the session has edited files, the stderr footer ends with the totals (`+52 −3 in 3 files`), and `--diff` lists each file as `+ADDED −REMOVED PATH`, with `(added)`, `(deleted)`, `(unchanged)`, `(outside)` or `(unknown)` when it is not a plain edit. `--json` output, the `done` event and in `--chat` each `turn-done` event carry the same numbers as `diffStats`, the `SessionDiffStats` object of the [local API](desktop/api.md) (`{base, files: [{path, status, added, removed, binary?}], totals: {files, added, removed}}`). Git measures what is uncommitted in those files against `HEAD`, as in the [terminal UI](guide.md#changed-files). The session's files are the ones this run edited plus those a resumed session's saved tool calls name; a session saved by an earlier headless run stores only text, so its earlier edits are not included.

## Images

`--image` attaches image files to the prompt (not in `--chat`), with the limits of the [local API](desktop/api.md#images): at most 4, PNG, JPEG, GIF or WebP by their file header. A file over 3.5 MiB is re-encoded as JPEG with the same tools the terminal UI uses for pasted images (`sips` on macOS, ffmpeg or ImageMagick elsewhere); without one, the run stops with exit code 1. `--save-session` stores the images with the user message, so a resumed session sends them again.

## Mentions and shell commands

Prompts accept the same `@path`, `@path#10-40`, `@Symbol` and leading `!command` as the terminal input ([user guide](guide.md#mentions-and-shell-commands-in-the-input)); each attached item is listed on stderr. `baked --headless '!git diff'` sends the diff to the agent. Destructive commands are denied unless `--mode auto`, and no command runs in `plan` or `architect` mode; a prompt that is only a refused command exits with code 1 in a single run and is skipped in `--chat`.

## Sessions across runs

```sh
baked --headless --save-session "analyze the auth module, find all issues"
baked --headless --session <id> --save-session "now fix them"
```

`baked session list` prints the saved sessions of the project, most recently updated first (`--limit N`, default 50); `--json` prints `{sessions: [{id, title, messageCount, startedAt, updatedAt, sizeBytes, projectId?}]}`. `baked session delete ID` deletes one, by its id or a prefix that matches only that session, together with the checkpoint tags it made; the workspace files stay as they are. It exits 1 when no session or more than one matches. The terminal UI and the desktop app list the same sessions, so do not delete one they have open.

## Usage and attention

```sh
baked usage --days 30 --group-by stage,model --json
baked attention --json
```

`baked usage` adds up the tokens and estimated cost of every workflow attempt that started in the last `--days N` days (default 7, at most 366), across runs. `--group-by` takes one or two of `model`, `stage` and `day` (default `model`); `--model ID` (`(host)` for host attempts) and `--stage ID` filter. `--json` prints the answer of the local API's [`GET /v1/usage`](desktop/api.md); without it a table prints. For one run use `baked workflow usage RUN_ID`.

`baked attention` lists what waits for a person in the project, oldest first: pending decisions of workflow runs, blocked runs and pending initiative decisions. `--json` prints `{items}` in the shape of [`GET /v1/attention`](workflows/runtime.md); advisory acceptance requests have `blocking: false`. Chat prompts appear only in the local API, where the chat sessions run. Both commands only read the workflow database and exit 0, with nothing listed in a project where no run was started.

## Model routing

`baked workflow routing set TARGET MODEL`, `clear TARGET` and `review MODE` change the `modelRouting` of the project (or `--scope global`) with the checks of the terminal routing screen, and `show` prints it; see the [routing screen](workflows/runtime.md#routing-screen) for targets and output.

## Keys and sign-in

```sh
baked --set-key openai sk-...       # save an API key (system keychain or ~/.baked/secrets.json)
baked --remove-key openai           # remove it again
baked login                         # whether the Codex and Claude Code CLIs are installed and signed in
baked login claude-code             # sign the CLI in with your subscription
baked logout codex
```

`--remove-key` removes the saved key of a provider and says so when an environment variable still provides one. `baked login codex|claude-code` runs the same sign-in as `/codex login` and `/claude-code login` in the terminal UI: it prints the CLI's progress and the page to open on stderr and waits until the sign-in ends, with exit code 0 when signed in, 1 when it failed or the CLI is not installed, and 130 when interrupted. A CLI that is already signed in succeeds at once. `baked logout` runs the CLI's own logout. `--json` prints the `Login` object of the local API's [`GET /v1/providers/ID/login`](desktop/api.md); `baked login --json` prints `{providers: [{provider, installed, loggedIn, message, command}]}`. BAKED never reads or stores the CLI's tokens.

## Forking a session

```sh
baked session fork <id> --checkpoint 2 --rollback-files
baked --headless --session <new-id> "try the other approach"
```

`baked session fork ID` saves a new session with the active conversation of session `ID` and prints its id. `--at MESSAGE_ID` keeps the messages up to and including that message, `--checkpoint N` up to the end of checkpoint (turn) N; without either the whole conversation is copied. `--rollback-files` also restores the files the agent edited after that point to their state there, with the same safeguards as `/checkpoint fork` in the terminal UI ([forking a checkpoint](guide.md#forking-a-checkpoint)): a backup tag first, and files changed since the agent last touched them are left as they are unless `--force`. `--json` prints `{sessionId, title, messageCount, checkpoint, rollback}`, where `rollback` is the report described in the [local API](desktop/api.md). The command exits 1 when the session, message or checkpoint does not exist, or when files need restoring and the project is not a Git repository.

Headless runs do not snapshot the workspace, so a session made only with `--save-session` can be forked but its files cannot be rolled back.

## Undoing a turn

```sh
baked session undo <id>            # drop the last turn and restore the files it edited
baked session undo <id> --to 1     # keep only checkpoint 1
baked session redo <id>            # put the oldest undone turn back
```

`baked session undo ID` drops the last turn of the active conversation of session `ID` (with `--to N`, every turn after checkpoint N; `--to 0` drops them all) and restores the files those turns edited, with the safeguards of `/undo` in the terminal UI ([checkpoints](guide.md#checkpoints)): a backup tag first, and files changed since the agent last wrote them are left as they are unless `--force`. The undone turns are saved with the session; `baked session redo ID` puts back the oldest one and restores the files it edited. After a new message in the session they can no longer be put back. `--json` prints `{sessionId, action, checkpoint, messageCount, redoCount, rollback}`. The command exits 1 when the session does not exist or there is nothing to undo or redo.

## Approvals

There is no one to ask in headless mode: actions that would ask for approval in the terminal UI (writes outside the project, destructive shell commands) are not prompted. Cap runs with `--max-steps` and `--timeout`, keep API keys in CI secrets, and run untrusted prompts in a disposable checkout.

## Custom commands and workflows

`baked --headless "/fix-ci lint"` expands [custom commands](custom-commands.md). For multi-stage work with approvals, checks and budgets, use `baked workflow` ([runtime guide](workflows/runtime.md)), which is scriptable on its own and has its own exit codes. `approve`, `answer` and `evidence` record the decision and then continue the run (resume and drive, with the exit codes of `resume`), as the terminal app and the desktop app do; `--no-resume` only records it, and a run that still has another request waiting for a person stops there with exit code 3.

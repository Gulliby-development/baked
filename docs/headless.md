# Headless CLI

`baked --headless` runs the same agent and tools without the terminal UI, for scripts and CI. Agent text goes to stdout; progress goes to stderr, so pipes stay clean. While the repository map is still being built, stderr shows how far it got (`Indexing files 412/1,380`, then each later phase such as `Building edges`), at most one count every two seconds; `--json`, `--events` and `--quiet` leave it out.

```sh
baked --headless "explain the auth middleware"
echo "find unused exports" | baked --headless
baked --headless --json "list all TODOs"          # one JSON result
baked --headless --events "refactor the store"    # JSONL event stream
baked --headless --chat                           # interactive multi-turn chat
baked --headless --watch                          # turns from baked! / baked? comments (watch mode)
```

## Options

| Option | Does |
| --- | --- |
| `--model <provider/model>` | Override the model |
| `--mode <mode>` | `default`, `architect`, `plan` or `auto` |
| `--effort <level>` | Reasoning effort: `default` (the configured one), `low`, `medium`, `high`, `xhigh` or `max`; see [reasoning effort per chat](providers.md#reasoning-effort-per-chat) |
| `--max-steps <n>` | Stop after N agent steps |
| `--timeout <ms>` | Abort after N milliseconds |
| `--cwd <dir>` | Work in another folder |
| `--system "..."` | Add system instructions |
| `--include <file>` | Load a file into context first (repeatable) |
| `--image <file>` | Attach a PNG, JPEG, GIF or WebP image to the prompt (repeatable, at most 4); see [Images](#images) |
| `--no-repomap` | Skip the repository scan |
| `--sandbox <mode>` | OS sandbox of shell and project commands for this process: `off`, `auto` or `required`; replaces the global setting, a project config can still raise it ([OS sandbox](sandbox.md)) |
| `--diff` | List the files the session changed, with the lines each adds and removes |
| `--save-session` | Save the conversation for a later `--session` |
| `--session <id>` | Resume a saved session (an ID prefix is enough) |
| `--quiet` | Suppress the header and footer on stderr |

Exit codes: `0` success, `1` error, `2` timeout, `130` aborted.

`--events` emits one JSON object per line with a `type` of `start`, `input-context`, `text`, `tool-call`, `tool-result`, `step`, `warning`, `error`, `done` or `session-saved`. `tool-result` has a `summary` of up to 200 characters: the tool's output, or the text of an MCP tool's result. `warning` names what the provider does not support and why (`[unsupported] temperature: Codex CLI ignores this setting`), once per run however many steps repeat it. `input-context` carries `items` (`{kind, ref, ok, summary, output?}`) for the prompt's `@` mentions and `!` command. `step` carries the running `tokens` with the step's own `lastStepInput`, `lastStepOutput` and `lastStepCacheRead`; with the Codex provider over app-server it also has `modelRequests`, the number of model responses whose usage Codex reported during the step (see [providers](providers.md#openai-codex)).

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

`baked session list` prints the saved sessions of the project, most recently updated first (`--limit N`, default 50); `--json` prints `{sessions: [{id, title, messageCount, startedAt, updatedAt, sizeBytes, projectId?}]}`. `baked session delete ID` deletes one, by its id or a prefix that matches only that session, together with the checkpoint tags it made; the workspace files stay as they are. It exits 1 when no session or more than one matches. The terminal UI and the desktop app list the same sessions, so do not delete one they have open. `baked session export ID` writes the conversation of the session's active tab as Markdown (or `--format json`) to `--output FILE`, or to `.baked/exports/` as `/session export` does in the terminal UI; `--json` prints `{sessionId, path, messageCount, format}`. The [project coordinator](coordinator.md) is not listed; `baked session coordinator` prints its session id and project brief (`--json`: `{sessionId, brief}`) and exits 1 when the project has none.

## Usage and attention

```sh
baked usage --days 30 --group-by stage,model --json
baked attention --json
```

`baked usage` adds up the tokens and estimated cost of every workflow attempt that started in the last `--days N` days (default 7, at most 366), across runs. `--group-by` takes one or two of `model`, `stage` and `day` (default `model`); `--model ID` (`(host)` for host attempts) and `--stage ID` filter. `--json` prints the answer of the local API's [`GET /v1/usage`](desktop/api.md); without it a table prints. `--format md` prints a Markdown document to share and `--output FILE` writes it to FILE in the project ([usage reports](workflows/runtime.md#usage-reports)). For one run use `baked workflow usage RUN_ID` (also with `--format md` and `--output`).

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
baked session checkpoints <id>     # list the turns: number, snapshot, files, prompt
baked session undo <id> --to 1     # keep only checkpoint 1
baked session redo <id>            # put the oldest undone turn back
```

`baked session undo ID` drops the last turn of the active conversation of session `ID` (with `--to N`, every turn after checkpoint N; `--to 0` drops them all) and restores the files those turns edited, with the safeguards of `/undo` in the terminal UI ([checkpoints](guide.md#checkpoints)): a backup tag first, and files changed since the agent last wrote them are left as they are unless `--force`. The undone turns are saved with the session; `baked session redo ID` puts back the oldest one and restores the files it edited. After a new message in the session they can no longer be put back. `--json` prints `{sessionId, action, checkpoint, messageCount, redoCount, rollback}`. The command exits 1 when the session does not exist or there is nothing to undo or redo.

`baked session checkpoints ID` lists the turns of the active conversation, one per line: the checkpoint number to pass to `--to`, `snapshot` when the files of that turn can be restored, how many files it edited and the first line of its prompt; undone turns follow, marked `undone`. `--json` prints `{sessionId, checkpoints, redo}` as `GET /v1/sessions/ID/checkpoints` does.

## MCP servers

```sh
baked mcp list --json        # servers of the global and project config
baked mcp list --check       # connect each enabled server; exit 1 when one fails
baked mcp disable github     # keep it in the config without connecting it
```

`baked mcp` lists and changes the [MCP servers](extensions.md#mcp-servers) headless runs connect. `list --json` prints `{servers}` in the shape of the local API's [`GET /v1/mcp`](desktop/api.md#mcp-servers); without `--check` every server is `idle`. `enable`, `disable` and `remove` take `--scope global|project`; without it they change the file that defines the server, the project one when both do. They exit 2 for an unknown server.

## Language servers

```sh
baked lsp status --json            # servers for the project's languages, install and run state
baked lsp install go               # install a server for a language (or name a server or Mason package)
baked lsp check                    # start the project's servers, wait, exit 1 when one does not work
baked lsp disable biome            # keep baked from starting a server
baked diagnose --json              # probe every code intelligence backend, as /diagnose does
```

`baked lsp` shows and changes the [language servers](configuration.md#language-servers) code intelligence uses, through the same code as `/lsp` in the terminal UI and the desktop app's Language servers page. `status` lists the servers for the languages found in the project (`--all` for every server baked knows) with whether each is installed (and where: PATH, baked's own directory or Mason's), turned off, and how to install it; `--json` prints the shape of the local API's [`GET /v1/lsp`](desktop/api.md#language-servers), where `uncovered` names the detected languages no enabled, installed server covers. `install ID` installs from the Mason registry into baked's own directory (the registry is downloaded on first use); `ID` is a server command (`gopls`), a Mason package (`pyright`) or a language (`go`, which picks the first server for it whose toolchain is on PATH, or reports one that is already installed). It needs no prompt and exits 1 when the install fails or the toolchain (`go`, `cargo`, `pip3`, or `python3` for generic packages with a Python launcher such as `jdtls`, which also needs Java 21+) is missing. `check [ID]` starts the project's servers in this process, waits up to a minute for them and prints the status; it exits 1 when an enabled, installed server of a detected language did not start (its error is printed) or a detected language has no server. `restart` is the same as `check`: a headless process keeps no servers between commands. `enable` and `disable` take `--scope global|project`; without it, `disable` writes the project file when it has its own `disabledLspServers` (which replaces the global list) and the global file otherwise, and `enable` removes the server from every list that names it. A running terminal UI or `baked serve` applies them when the server restarts. Unknown servers and bad arguments exit 2.

`baked diagnose` runs the code intelligence health check of `/diagnose` in the terminal UI: it starts the project's servers in this process, then probes every backend (language server, ts-morph, tree-sitter, regex) with the key operations against a file of the project's main language and prints each probe's result and time. `--json` prints the shape of [`POST /v1/lsp/diagnose`](desktop/api.md#language-servers). It exits 1 when a backend that supports the language failed to start or a probe errored or timed out (`failing` names them), and 2 on an unknown argument.

## OS sandbox

```sh
baked sandbox status               # mode, where it comes from, backend, chat network
baked sandbox status --json        # the shape of GET /v1/diagnostics/sandbox
baked --headless --sandbox required "run the tests"
```

`baked sandbox status` prints the effective [OS sandbox](sandbox.md) mode (the global `sandbox` setting, raised by the project config), the backend of this machine (`bwrap` on Linux, `seatbelt` on macOS, none on Windows) or why it is unavailable, and the network of sandboxed chat commands. It exits 1 when the mode is `required` and no backend works, so CI can check the sandbox before it runs anything. `--sandbox MODE` on a headless run replaces the global mode for that process; with `required` and no backend, shell and project commands are refused.

## Artifacts

`baked artifacts list|show|save|deploy|remove` manages the [artifacts](artifacts.md) shared by every project: HTML pages kept in the BAKED data folder. `deploy ID` prints what it would send to your Vercel account and deploys only with `--yes` (`--prod` for production).

## Approvals

There is no one to ask in headless mode: actions that would ask for approval in the terminal UI (writes outside the project, destructive shell commands) are not prompted. Cap runs with `--max-steps` and `--timeout`, keep API keys in CI secrets, and run untrusted prompts in a disposable checkout or with `--sandbox required`.

## Custom commands and workflows

`baked --headless "/fix-ci lint"` expands [custom commands](custom-commands.md). For multi-stage work with approvals, checks and budgets, use `baked workflow` ([runtime guide](workflows/runtime.md)), which is scriptable on its own and has its own exit codes. `approve`, `answer` and `evidence` record the decision and then continue the run (resume and drive, with the exit codes of `resume`), as the terminal app and the desktop app do; `--no-resume` only records it, and a run that still has another request waiting for a person stops there with exit code 3.

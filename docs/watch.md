# Watch mode

Watch mode starts the agent from comments you write in any editor. BAKED watches the project's files. When a save adds a `baked!` or `baked?` comment, BAKED sends the request at that place to the chat as a normal turn, so no editor plugin is needed.

```ts
function load(id: string) {
  // baked! retry twice on a network error, then give up
  return fetch(`/items/${id}`);
}
```

```python
def total(items):  # baked? why is tax added here and in checkout()
    ...
```

| Comment | What happens |
| --- | --- |
| `baked!` | **Act.** The agent changes the code the comment asks about, then removes the `baked!` comment lines it handled. |
| `baked?` | **Ask.** The agent answers in the chat without editing files for it. With `watch.removeAnswered` it also removes the answered `baked?` lines. |
| `baked` | **Context.** Collected and sent with the next `baked!` or `baked?`, so one request can be spread over several places. An act turn removes the context comments it used. |

## Where markers count

- The marker is a whole word at the start or at the end of a comment, in any letter case: `// baked! …`, `# … baked?`, `/* BAKED: … */`. `// we baked the bread` and `half-baked!` do not count.
- Only comments count. BAKED detects the file's comment syntax from its extension:
  - `//` and `/* */` for C-like languages: TypeScript, JavaScript, Go, Rust, Java, C#, C and C++, Swift, Kotlin, PHP and more.
  - `#` for Python, shell, Ruby, YAML, TOML and similar.
  - `--` for SQL, Lua and Haskell.
  - `;` for Lisps and assembly.
  - `<!-- -->` for HTML, XML and Markdown.
  - `/* */` for CSS.
- A string literal that contains `// baked!` is not a comment, and neither is a URL inside a string. In files of unknown types, any line that starts or ends with the marker counts.
- Consecutive comment lines that each take a whole line form one request, so a request can span several lines. A comment after code on the same line stands alone.

## When a turn starts

- **New markers only.** A save starts a turn only when it adds a `baked!` or `baked?` comment that was not in the file before. BAKED compares markers by kind and text, so moving code above an old marker does not repeat it. Deleting a marker starts nothing. The first time BAKED sees a file, all its markers count as new.
- **Saves are batched.** BAKED waits until saves settle (`watch.debounceMs`, 300 ms) and sends the markers of all changed files in one turn.
- **Queued behind a running turn.** A marker saved while a turn runs waits for the next turn, so watch turns go through the same approvals, checkpoints and undo as typed messages.
- **BAKED's own edits never trigger.** BAKED records the content of each file its tools write. A change event whose content matches that record is ignored, including the edit that removes a handled marker.
- **The prompt.** It holds each request with its file and line, the comment, and the 20 lines on either side, then the context comments.

## What is watched

- **Always skipped:** `.git`, `.baked`, `node_modules`, `dist`, `build`, `out`, `coverage`, `target`, `.next`, `.turbo`, `.cache`, `.venv`, `venv` and `__pycache__`.
- **Skipped by your rules:** paths matched by `.gitignore`, `.bakedignore` and `watch.ignore`.
- **Not read:** binary files and files over 1 MiB.
- **How changes are found:** BAKED uses the operating system's recursive file events on Windows, macOS and Linux. Where those are not available, or with `watch.poll`, it checks file times every second for up to 20,000 files. Use polling on network drives and WSL mounts of Windows folders.

## Running it

### In the terminal app

- `/watch on` starts watch mode in the current tab. A `WATCHING` chip shows in the header.
- One tab watches at a time; `/watch on` in another tab moves the watch there.
- Each watch turn shows in the chat as `From src/load.ts:2 (baked!): retry twice on a network error…`. The model gets the full prompt with the code around the comment.
- A turn saved while the tab is busy waits in the steering queue under the input.
- `/watch status` shows the folder, the number of turns and the last one; `/watch off` stops. Closing the watching tab stops it too.

### From a script


```sh
baked --headless --watch            # turns from baked! and baked? comments until Ctrl+C
baked --headless --watch-poll       # the same, polling file times
baked --headless --watch --permissions full --events
```

- `--watch` runs the [headless chat](headless.md) loop, but its prompts come from the watch instead of stdin.
- It accepts the chat's options: `--model`, `--mode`, `--session`, `--events`, `--json`, `--quiet`.
- Each turn prints where it came from (`From  src/load.ts:2 (baked!)`), followed by the usual turn output.
- With `--events`, BAKED writes a `watch` event (`started`, `triggered`, `stopped`, `error`) and a `watch-turn` event before each turn.
- Ctrl+C stops the watch and ends the session.

### In the desktop app

**Watch files** in a chat's header turns watch mode on for that chat, and **Watching files** turns it off. Watch turns show as `From load.ts:2 (baked!): …` in the chat and run like typed messages, with the same approvals. One chat of a project watches at a time; turning it on in another chat moves it. The local API offers the same through `GET|POST /v1/sessions/ID/watch` and a `watch` event ([API](desktop/api.md#watch-mode-watch-files)).

## Configuration

`watch` in `~/.baked/config.json` or the project's `.baked/config.json`:

| Key | Default | Meaning |
| --- | --- | --- |
| `watch.marker` | `"baked"` | The marker word; `ai` makes `ai!` and `ai?` the markers. Letters, digits, `_` and `-`, starting with a letter. |
| `watch.ignore` | `[]` | More gitignore-style patterns to skip. |
| `watch.debounceMs` | `300` | How long saves settle before the changed files are read (50 to 10000). |
| `watch.removeAnswered` | `false` | Ask the agent to remove `baked?` comments after answering them. |
| `watch.poll` | `false` | Poll file times instead of file events. |

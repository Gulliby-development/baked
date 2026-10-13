# Desktop API contract

The desktop app (`apps/desktop`) talks to BAKED only through the local HTTP API that `baked serve` starts (`src/core/api/`). This document is the contract between the two: the desktop builds against it, and the server keeps it. Endpoints that already exist are described in "Local API" in [the runtime guide](../workflows/runtime.md#local-api-baked-serve); this document lists them only by name and specifies everything that is new.

Status of each group: **exists** (on `main`), **A** (sessions and chat), **B** (workflow, project setup and settings gaps). A and B land as separate pull requests; until a group lands, `GET /v1/health` does not list its capability.

## Process model

- One `baked serve` per project folder. The desktop main process starts `baked serve --cwd FOLDER --port 0 --allow-origin ORIGIN` for each open project, reads the one JSON line `{"url","port","tokenFile"}` from stdout, reads the token from `tokenFile`, and stops the process with SIGTERM (Windows: the process is killed; the token file is removed on the next start).
- The server binds 127.0.0.1 only. Every request carries `Authorization: Bearer TOKEN`. The Host header must name the loopback address and port. Requests with an `Origin` header are refused unless that origin was allowed with `--allow-origin`.
- Everything that is shared between projects (the known-project list, global config, provider keys) is read from the user profile, so any project's server can answer for it.
- App-only preferences (theme, density, language of the app, notifications, tray behavior, shortcuts) are stored by the desktop app itself. The API never reads or writes them.

## Conventions

- JSON bodies, `Content-Type: application/json`, at most 1 MiB (20 MiB for `POST /v1/sessions` and `POST /v1/sessions/ID/messages`, which carry [images](#images)). Methods: `GET`, `POST`, `PATCH`, `DELETE`.
- Errors: `{"error":{"code":"...","message":"..."}}` with the HTTP status. Codes in use: `INVALID_REQUEST` 400, `UNAUTHORIZED` 401, `CAPABILITY_DENIED`/`ORIGIN_REJECTED` 403, `NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `REVISION_CONFLICT`/`COMMAND_CONFLICT`/`STALE_DECISION`/`WORKSPACE_BUSY`/`NOT_A_REPOSITORY`/`INPUT_CHANGED`/`RUN_TERMINAL`/`SESSION_BUSY`/`STALE_PROMPT` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `HOST_REJECTED` 421, `INTERNAL` 500, `SHUTTING_DOWN` 503. Messages have secrets redacted.
- Workflow and initiative mutations carry `commandId` (client-chosen, safe id) and `expectedRevision`; a retry with the same `commandId` returns the first result.
- Streams are Server-Sent Events. Each event has `id:` (a sequence number), the client resumes with `Last-Event-ID` or `?after=`, and the server sends `: keep-alive` comments every 15 s. A client that asks only for `application/json` gets a JSON page instead of a stream where noted.
- Timestamps are milliseconds since the epoch.

## Health and capabilities (exists, extended by A and B)

`GET /v1/health` returns `{apiVersion: 1, version, workspace, capabilities: string[]}`. `capabilities` names the groups this server supports: `workflow`, `attention`, `projects` (exist), `project-rename` (`POST /v1/projects/rename`), `sessions` (A), `setup`, `initiatives` (B), `checks` (`/v1/workflow/checks*`), `library` (`/v1/commands`, `/v1/skills`), `routing` (`/v1/workflow/routing`), `compaction` (`POST /v1/sessions/ID/compact`), `diff-stats` (`GET /v1/sessions/ID/diff`), `chat-undo` (`POST /v1/sessions/ID/undo` and `/redo`), `checkpoints` (`GET /v1/sessions/ID/checkpoints`), `run-memory` (`/v1/workflow/memory`), `critic-outcomes` (`GET /v1/workflow/critic`), `chat-memory` (`/v1/memory*`), `code-graph` (`/v1/graph*`), `plan-mode` (`mode: "plan"` in sessions and the `plan-review` prompt), `images` (`images` on chat messages), `custom-commands` (chat messages that start with a [custom slash command](../custom-commands.md) are expanded), `chat-export` (`GET /v1/sessions/ID/export`), `chat-effort` (`effort` on sessions and `efforts` on `GET /v1/models`), `skills-install` (`GET /v1/skills/catalog`, `POST /v1/skills`, `GET|DELETE /v1/skills/SCOPE/NAME`), `settings` (`GET|PATCH /v1/settings`), `git` (`GET /v1/git`, `POST /v1/git/actions`), `hooks` (`GET /v1/hooks`, `POST /v1/hooks/session`), `provider-switch` (`POST /v1/providers/ID/switch`), `mcp` (`/v1/mcp*`), `lsp` (`/v1/lsp*`), `workflow-editor` (`POST /v1/workflow/editor*`), `lsp-diagnose` (`POST /v1/lsp/diagnose`), `run-maintenance` (`POST /v1/workflow/import`, `POST /v1/workflow/gc`, `POST /v1/workflow/runs/ID/export` and `/redact`), `diagnostics` (`/v1/diagnostics/*`), `coordinator` (`/v1/coordinator*`), `watch` (`GET|POST /v1/sessions/ID/watch`) and `gate-drafts` (`POST /v1/workflow/gates/draft`, `POST /v1/workflow/gates`, `GET /v1/workflow/gates/ID`, `GET /v1/workflow/gates/ID/places`, `POST /v1/workflow/gates/ID/bind`). The desktop hides a screen whose capability is missing instead of failing on 404. The API version stays 1 while changes are additive.

## Sessions and chat (A)

A session is a chat conversation stored in `.baked/sessions/ID/` of the project, the same store the terminal UI uses: sessions created by either front end are listed and can be continued by the other. A session saved by the terminal UI with several tabs is continued on its active tab; the other tabs are kept as they are. The server saves a session after every turn. Only one writer should hold a session at a time: while the API runs a turn of a session, the terminal UI should not continue the same session.

### Types

```ts
type Mode = "default" | "architect" | "plan" | "auto";   // "plan" needs the plan-mode capability
type Effort = "default" | "low" | "medium" | "high" | "xhigh" | "max";  // needs the chat-effort capability
type SessionState = "idle" | "working" | "waiting";        // waiting: a prompt waits for a person

interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  startedAt: number;
  updatedAt: number;
  projectId?: string;
  state: SessionState;
  model: string | null;   // provider/model of the next turn; null when nothing is configured
  mode: Mode;
  effort: Effort;         // reasoning effort of the next turn; "default" follows the configuration
  compacting: boolean;    // a manual compaction runs; state is then "working"
}

interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  prompts: Prompt[];        // pending only
  queued: string[];         // messages waiting to be steered into the running turn
  usage: { input: number; output: number; cacheRead: number };   // whole session
  context: { usedTokens: number; windowTokens: number; percent: number } | null;
  filesEdited: string[];    // paths the session's edit tools wrote, as the tools named them
  plan: Plan | null;        // the plan being reviewed or carried out
  redo: { index: number; prompt: string }[];   // undone turns Redo puts back, oldest first
  lastSeq: number;          // subscribe to events with ?after=lastSeq to miss nothing
}

interface ChatMessage {          // as stored in messages.jsonl (src/types/index.ts)
  id: string;
  role: "user" | "assistant" | "system";
  content: string;               // assistant: the full text of the turn
  timestamp: number;
  toolCalls?: { id: string; name: string; args: Record<string, unknown>;
                result?: { success: boolean; output: string; error?: string; filesEdited?: string[] } }[];
  segments?: ({ type: "text"; content: string } | { type: "tools"; toolCallIds: string[] }
            | { type: "reasoning"; content: string; id: string })[];   // render order
  durationMs?: number;
  isSteering?: boolean;          // a user message sent while the turn ran
  inputContext?: { kind: "file" | "directory" | "symbol" | "command"; ref: string;
                   ok: boolean; summary: string; output?: string }[];   // what @ and ! attached
  images?: { label: string; base64: string;                             // user messages: attached images
             mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }[];
}

type Prompt = { id: string; createdAt: number } & (
  | { kind: "outside-cwd"; tool: string; path: string }          // approve or deny
  | { kind: "destructive"; description: string }                 // approve or deny
  | { kind: "web-search"; query: string }                        // approve or deny
  | { kind: "fetch-page"; url: string }                          // approve or deny
  | { kind: "question"; question: string; allowSkip: boolean;
      options: { label: string; value: string; description?: string }[] }   // answer
  | { kind: "plan-review"; title: string; depth: "light" | "full";
      steps: { id: string; label: string }[];
      planFile: string;     // relative to the project, e.g. .baked/plans/ID.md
      content: string }     // the plan as Markdown; answer with an action
);

interface Plan {
  title: string;
  depth: "light" | "full";
  steps: { id: string; label: string; status: "pending" | "active" | "done" | "skipped"; startedAt?: number }[];
  createdAt: number;
}
```

In `default` and `architect` mode, writes outside the project, destructive commands, web searches and page fetches wait for a prompt answer, exactly as the terminal UI asks. `auto` approves them without asking. A prompt waits until it is answered or the turn is interrupted; interrupting denies every pending prompt.

### Plan mode

In `plan` mode the agent works as in the terminal UI's [plan mode](../guide.md#modes-and-plan-mode): it researches without editing and writes a plan to `.baked/plans/`, which waits as a `plan-review` prompt. The session's `plan` (and a `plan` event) shows the proposed plan. Answer the prompt with `{action}`:

| `action` | Effect | `prompt-resolved` `outcome` |
| --- | --- | --- |
| `execute` | The turn ends as `completed`, the session switches to `default` mode, a `system` note "Plan accepted — executing." joins the transcript (`notice` event), and a new turn starts at once with the plan file's current text (edits made to the file during the review count); its user message in the transcript reads "Execute the plan: TITLE", while the model receives the whole plan. That turn keeps to the plan's tools and marks steps as it goes; each change is a `plan` event | `approved` |
| `clear-execute` | As `execute`, but the conversation sent to the model starts over with the plan; the transcript keeps every message | `approved` |
| `revise` | Needs `feedback` (text). The agent revises the plan in the same turn and asks again with a new prompt | `answered` |
| `cancel` | The agent stops, the session switches to `default` mode and the note "Plan cancelled: TITLE" joins the transcript | `denied` |

`prompt-resolved` of a plan review also carries `action`. Interrupting a turn while its plan waits for review ends the turn and keeps `plan` mode. A plan the agent makes in another mode is carried out without a review, as before. When a turn ends without an accepted plan, and when the turn that carried one out ends, `plan` becomes null.

### Endpoints

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /v1/sessions` | `?limit=` (default 50) | `{sessions: SessionSummary[]}`, most recently updated first |
| `POST /v1/sessions` | `{title?, model?, mode?, effort?, text?, images?}` | 201 `SessionDetail`; with `text` or `images` the first turn starts at once |
| `GET /v1/sessions/ID` | | `SessionDetail` |
| `PATCH /v1/sessions/ID` | `{title?, model?, mode?, effort?}` | `SessionSummary`; `model`, `mode` and `effort` apply from the next turn |
| `DELETE /v1/sessions/ID` | | 204; 409 `SESSION_BUSY` while a turn runs |
| `POST /v1/sessions/ID/fork` | `{atMessageId?, rollbackFiles?, force?}` | 201 `SessionDetail` of a new session with the messages up to and including `atMessageId` (all when absent); with `rollbackFiles`, plus `rollback` (below). 409 `SESSION_BUSY` with `rollbackFiles` while any turn runs, 409 `ROLLBACK_UNAVAILABLE` when files need restoring and the workspace is not a Git repository or cannot be backed up |
| `GET /v1/sessions/ID/checkpoints` | | `{checkpoints: [Checkpoint], redo: [RedoEntry]}` ([below](#checkpoints)): one entry per turn of the conversation, and the undone turns a redo puts back, oldest first |
| `POST /v1/sessions/ID/undo` | `{toCheckpoint?, force?}` | `SessionDetail` plus `rollback` (below) after dropping the last turn, or every turn after checkpoint `toCheckpoint` (0 drops them all), and restoring the files they edited. 409 `SESSION_BUSY` while any turn of the project runs, 409 `NOTHING_TO_UNDO` without turns, 400 when `toCheckpoint` is not before the last turn, 409 `ROLLBACK_UNAVAILABLE` when the workspace cannot be backed up |
| `POST /v1/sessions/ID/redo` | `{force?}` | `SessionDetail` plus `rollback` after putting back the oldest undone turn and restoring the files it edited to their state after that turn. 409 `SESSION_BUSY` as for undo, 409 `NOTHING_TO_REDO` when nothing was undone |
| `POST /v1/sessions/ID/messages` | `{text?, images?}` | 202 `{turnId, queued: false}` when a turn starts; `{turnId, queued: true}` when a turn already runs and the message is steered into it at its next step. A message needs text, images or both; 400 for invalid [images](#images). Text that starts with a [custom slash command](../custom-commands.md) (`/fix-ci lint`) is expanded first, here and on `POST /v1/sessions`; the stored message and `queued` hold the expanded prompt, and an unknown `/name` is sent as typed |
| `POST /v1/sessions/ID/interrupt` | | `{interrupted: boolean}` |
| `POST /v1/sessions/ID/prompts/PROMPT_ID` | `{approve: boolean}`, `{answer: string}` or, for a `plan-review`, `{action: "execute" \| "clear-execute" \| "revise" \| "cancel", feedback?: string}` | `{resolved: true}`; 404 unknown, 409 `STALE_PROMPT` when already answered or the turn ended, 400 for a body that does not fit the prompt's kind or a `revise` without `feedback`. `answer: ""` skips a question that allows it |
| `POST /v1/sessions/ID/compact` | `{}` | 202 `{compactionId}`; the compaction runs in the background and reports with `compaction-start` and `compaction-done`. 409 `SESSION_BUSY` while a turn or a compaction runs, 409 `NOTHING_TO_COMPACT` when the conversation is too short, 501 `NOT_SUPPORTED` when the server cannot compact |
| `GET /v1/sessions/ID/diff` | | `SessionDiffStats` below |
| `GET /v1/sessions/ID/watch` | | `WatchStatus` below: [watch mode](../watch.md) as this session sees it |
| `POST /v1/sessions/ID/watch` | `{on: boolean}` | `WatchStatus`. `on: true` makes this session receive the watch turns, moving the watch from another session; `on: false` turns it off when this session watches and changes nothing otherwise |
| `GET /v1/sessions/ID/export?format=markdown\|json` | | 200 with the chat as a file: `text/markdown` (default) or `application/json`, and `Content-Disposition: attachment; filename="TITLE-TIMESTAMP.md"` (or `.json`). Markdown is what the terminal UI's `/session export` writes (title, time range, messages with tool calls, reasoning and plans); JSON is the session's `messages` array. 400 for another format |
| `GET /v1/sessions/ID/events` | `?after=SEQ`, or `Last-Event-ID` | SSE stream below |
| `GET /v1/models` | `?provider=` | `{providers: [{id, name, configured, models: [{id, name, contextWindow?, efforts?}], error?}]}`; `configured` is whether a key or login is available, `models` is empty for a provider that is not configured, `id` is the `provider/model` id to send as `model`; `efforts` lists the reasoning efforts BAKED sends to that model, lowest first, and is absent when it takes none ([reasoning effort per chat](../providers.md#reasoning-effort-per-chat)) |
| `GET /v1/mentions` | `?q=&limit=` (default 20, at most 50) | `{mentions: [{kind: "file" \| "directory" \| "symbol", insert, label, detail, indices}]}`: `@` completions for the composer; `insert` is the text after `@`, `indices` the matched characters of `label` |

`ID` accepts a unique prefix of a session id, like `--session` on the command line.

#### Watch mode ("Watch files")

One session of the project at a time watches its files ([watch mode](../watch.md)). When a save adds a `baked!` or `baked?` comment, the server sends that session a turn whose model prompt quotes the comment and the code around it; the user message in `messages` reads `From src/load.ts:2 (baked!): retry twice on a network error`. A watch turn that arrives while a turn or a compaction runs waits in `queued` and starts a turn of its own afterwards; it is never steered into the running turn, and `@` and `!` in it are not expanded. Deleting the session, deleting all sessions or stopping the server stops the watch. The settings come from `watch` in the configuration.

```ts
interface WatchStatus {
  watching: boolean;              // this session receives the watch turns
  watchingSession: string | null; // the session that watches, when another one does
  method: "native" | "poll" | null; // how changes are found; null while starting or off
  turns: number;                  // watch turns sent since the watch started
  last: string | null;            // where the last one came from: "src/load.ts:2 (baked!)"
  error: string | null;           // the last watcher error, or why a turn could not start
}
```

#### Compaction ("Compact now")

`POST /v1/sessions/ID/compact` does what `/compact` does in the terminal UI, with the same code (`src/core/compaction/manual.ts`): the model messages before the last `compaction.keepRecent` (default 4) become one summary, written with the task router's `compact` model (the session's model when no route is set) and the configured `compaction.strategy`; `v2` rebuilds its working state from the saved messages first, any other strategy writes a full summary. The next turn sends the summary, an acknowledgement and the kept messages. The transcript (`messages`) keeps every message and gains a `system` message that says how many messages were compacted; `context` becomes an estimate until the next turn reports real numbers, and the summary's tokens count in `usage`. A message sent while the compaction runs is queued (`{turnId: compactionId, queued: true}`) and starts the next turn when it ends. `interrupt` stops a running compaction and keeps the conversation as it was. A compaction that cannot produce a summary of at least 50 characters is `skipped` and changes nothing.

#### Images

`images` on `POST /v1/sessions` and `POST /v1/sessions/ID/messages` is a list of `{mediaType, data}`: `data` is the image as plain base64 (no `data:` prefix) and `mediaType` one of `image/png`, `image/jpeg`, `image/gif` or `image/webp`. A message carries at most 4 images of at most 3.5 MiB each (decoded), the size providers accept once encoded, and the file header must match `mediaType`; anything else is refused with 400 `INVALID_REQUEST` naming the image. The server does not resize: clients scale down or re-encode larger images first (the desktop re-encodes them as JPEG).

The user message stores the images like the terminal UI stores pasted ones (`images` on `ChatMessage`, labelled `image-1`, `image-2`… in order, saved in `messages.jsonl`), and the model receives them as image parts after the text. Images sent while a turn runs are steered into it with the text; messages queued together keep all their images, relabelled in order. A session's model messages rebuilt after an undo or from an older save keep the stored images. Whether the model can read images is up to the chosen model; a provider that rejects them fails the turn with its error.

#### Diff statistics

```ts
interface SessionDiffStats {
  base: "HEAD" | null;   // null outside a git repository: only file names are known
  files: { path: string;   // workspace-relative with "/"; absolute when outside the project
           status: "modified" | "added" | "deleted" | "unchanged" | "outside" | "unknown";
           added: number; removed: number; binary?: boolean }[];
  totals: { files: number; added: number; removed: number };   // files that are not unchanged or outside
}
```

`GET /v1/sessions/ID/diff` measures the files in `filesEdited` against the last commit with git (`git diff --numstat HEAD`; a new untracked file counts all its lines as added). The numbers are what is uncommitted in those files now, whoever made the change; a file the session edited that was committed or reverted since is `unchanged`. Outside a git repository every file is `unknown` with zero counts.

A message text with `@` mentions or a leading `!command` is expanded on the server before the model sees it, by the same code as the terminal UI ([user guide](../guide.md#mentions-and-shell-commands-in-the-input)): the stored user message keeps the typed text and lists what was attached in `inputContext`. A destructive `!` command asks with a `destructive` prompt in `default` mode, is denied in `architect` mode with every other command, and runs in `auto` mode. A message that is only a command that did not run ends its turn with `turn-done` `completed` and `message: null`. Text with `@` or `!` sent while a turn runs is not steered into it; it starts its own turn afterwards.

Each turn of an API session that edits files snapshots the workspace in a Git tag, and the first turn snapshots it before it starts; the tags are saved in the session's tab as `checkpointTags`, as the terminal UI saves them. A fork with `rollbackFiles` restores the files the agent edited after the fork point to the latest snapshot at or before it. The fork point of a message is the end of its turn, or the end of the previous turn when the message is the user prompt that starts a turn. `rollback` is `{checkpoint, snapshot, backupTag, restored: [path], removed: [path], skipped: [{path, reason}]}`: `restored` files were rewritten, `removed` ones did not exist at the checkpoint, and `backupTag` (null when nothing changed) holds the whole working tree from before the rollback. A file is skipped, not overwritten, when its current content is in none of the session's snapshots (changed outside the agent) unless `force` is set, and always when Git ignores it or it is outside the workspace. The fork gets copies of the snapshots up to its fork point, so it can be forked again. [Forking a checkpoint](../guide.md#forking-a-checkpoint) describes the same behavior in the terminal UI.

#### Undo and redo

Undo and redo share their code with `/undo` and `/redo` in the terminal UI and `baked session undo|redo` (`src/core/checkpoints/undo.ts`). Undo rolls the files back exactly as a fork with `rollbackFiles` does, with the same `rollback` report, skipped files and backup tag (`baked/undo-backup-*`), then drops the undone turns from `messages` and rebuilds the model messages from what is left, so a compaction summary of the dropped part is gone. The undone turns are saved with the session (`redoTurns` in its tab) and listed in `redo`. Redo puts back the oldest one with its messages and restores the files that turn edited to the turn's own snapshot; a file whose current content is in no snapshot is skipped unless `force` is set. Starting a turn forgets the undone turns and deletes their snapshot tags. Outside a Git repository the conversation still rewinds and every edited file is reported in `skipped`. Each undo or redo emits a `rewind` event.

#### Checkpoints

```ts
interface Checkpoint {
  index: number;            // turn N, from 1: undo with toCheckpoint N keeps turns 1 to N
  anchorMessageId: string;  // the user message that starts the turn
  endMessageId: string;     // the turn's last message
  prompt: string;           // first line of the prompt, at most 120 characters
  startedAt: number;
  filesEdited: string[];
  snapshot: boolean;        // a workspace snapshot was taken at the end of the turn
}
interface RedoEntry { index: number; anchorMessageId: string; prompt: string }
```

A turn starts at each user message not sent while a turn was working, as for undo, fork and `/checkpoint` in the terminal UI (`src/core/checkpoints/list.ts`). A turn without a snapshot edited no files, or ran before snapshots were taken; undoing to it still rewinds the chat. The desktop shows **Rewind to here** at the end of each earlier turn when the server lists `checkpoints`, and sends `undo` with that turn's `toCheckpoint`.

### Session events

Every event is `id: SEQ`, `event: TYPE`, `data: {seq, type, at, ...}`. Sequences are per session and per server start; the server keeps the latest 5000 events of each session in memory.

| `type` | Fields |
| --- | --- |
| `turn-start` | `turnId`, `message` (the user `ChatMessage`) |
| `text` | `turnId`, `delta` |
| `reasoning` | `turnId`, `delta` |
| `tool-call` | `turnId`, `toolCallId`, `tool`, `input` |
| `tool-result` | `turnId`, `toolCallId`, `tool`, `success`, `output` (at most 4000 characters), `error?`, `filesEdited?` |
| `steering` | `turnId`, `message` (the steered user `ChatMessage`) |
| `rewind` | `action` (`undo` or `redo`), `checkpoint` (the checkpoint undone to, or the turn redone), `messageCount`: the transcript changed; fetch `GET /v1/sessions/ID` |
| `prompt` | `prompt` (`Prompt`) |
| `prompt-resolved` | `promptId`, `outcome` (`approved`, `denied`, `answered`, `skipped`), `action?` (how a `plan-review` was answered) |
| `plan` | `plan` (`Plan`, or null when it is cleared) when the agent proposes a plan or a step changes status |
| `notice` | `message` (a `system` `ChatMessage` added to the transcript, such as "Plan accepted — executing."); it follows the `turn-done` of the turn it ends |
| `step` | `turnId`, `step`, `usage` (this turn so far) |
| `turn-done` | `turnId`, `status` (`completed`, `interrupted`, `failed`), `error?`, `message` (the assistant `ChatMessage`, null when nothing was produced), `usage`, `durationMs` |
| `compaction-start` | `compactionId` |
| `compaction-done` | `compactionId`, `status` (`compacted`, `skipped`, `failed`, `interrupted`), `message` (the `system` `ChatMessage` added to the transcript, null when failed or interrupted), `compacted` (model messages summarized), `error?`, `context` |
| `session` | `session` (`SessionSummary`) after a state, title, model, mode or effort change |
| `watch` | `watch` (`WatchStatus`) when the watch starts, stops or moves to another session, finds its method, sends a turn or hits an error; a session that loses the watch gets one too |
| `reset` | the requested sequence is no longer buffered or belongs to an earlier server start: fetch `GET /v1/sessions/ID` and continue from its `lastSeq` |

The persisted messages are authoritative: after `turn-done`, `GET /v1/sessions/ID` returns the same assistant message that the event carried.

### Project coordinator

The project coordinator is one long-lived chat session per project ([guide](../coordinator.md)). It is an ordinary session with `kind: "coordinator"` in its `SessionSummary`, so messages, events, prompts, interrupt and compaction use the `/v1/sessions/ID/...` endpoints above; `GET /v1/sessions` does not list it.

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/coordinator` | | `SessionDetail` of the coordinator; 404 `NOT_FOUND` when the project has none |
| `POST /v1/coordinator` | `{model?}` | 201 with the new coordinator's `SessionDetail`, or 200 with the existing one |
| `GET /v1/coordinator/brief` | | `Brief` |
| `PUT /v1/coordinator/brief` | `{expectedRevision, decisions, conventions, openQuestions, launched}` | the saved `Brief`; 409 `STALE_REVISION` when the brief changed since `expectedRevision`, 400 `TOO_LARGE` over 8000 characters |

`Brief` is `{revision, updatedAt, decisions: string[], conventions: string[], openQuestions: string[], launched: [{kind: "session" \| "run" \| "initiative", id, why, status, task?: {ref, url?, state: "open" \| "closed" \| "local"}}]}`; a brief never saved has revision 0. The coordinator always runs in `architect` mode (a `PATCH` to another mode is a 400): it reads but does not edit files or run commands, it edits the brief itself with its `coordinator_brief` tool, it reads runs, initiatives, sessions and the attention list with its `project_state` tool, and it starts background sessions, runs and initiatives with `launch_session`, `start_run` and `start_initiative`. A `default`- or `auto`-mode session needs a person's yes first, through a `destructive` prompt on the coordinator. Its `propose_split` tool shows a `split` prompt: `{kind: "split", id, createdAt, title, mode: "runs" | "initiative", flows: [{id, title, paths, dependsOn, task}], digest}`, where `task` is the flow's issue (`owner/name#N`), `new issue` (approving creates it) or `local task` (no GitHub token). Answer it with `{approve: true, digest}` (a different digest is 409 `STALE_PROMPT`) or `{approve: false}`; approving starts every flow ([splitting a request](../coordinator.md)). When a launched item finishes, fails or waits for a person, or a completed run's issue is closed by its merged pull request, the coordinator session gets a `notice` event with a `system` message, and the item's status in the brief changes. `GET /v1/coordinator/launched` returns `{launched: [{...entry, active, tokens}]}`: each launched entry with its live status, whether it is still active and the tokens it has used (404 before the coordinator exists). Every turn puts the current brief into its system prompt. After a completed turn whose context fill passes `compaction.triggerThreshold` (0.7 by default), the server compacts the coordinator on its own, with the same `compaction-start` and `compaction-done` events as a manual compaction; a compaction that summarizes nothing is not retried until the fill drops below `compaction.resetThreshold`.

### Attention (exists, extended by A)

`GET /v1/attention` items gain `source: "run" | "chat" | "initiative"`. Chat items are the pending prompts of sessions: `{source: "chat", sessionId, title, requestId: PROMPT_ID, kind: prompt kind, blocking: true, createdAt, runId: null, featureId: null, status: "waiting"}`. Run items keep their fields and get `source: "run"`, `sessionId: null`, `title: null`.

## Workflow runs (exists, gaps filled by B)

Exists: `GET /v1/workflow/definitions` (each summary has `stages` and `line`: `stages[]` with `id`, `type`, `consumes`, `produces`, `human` for a person's approval and `gates[]` (the stage's own gates, then those on the transitions leaving it: `id`, `type` or null for an unknown ID, `mode` (`required` or `advisory`), `does` (what it does in words) and `transition` (`{id, to, on}`, null for the stage's own gate)), and `loops[]` with `from`, `to`, `on` and `carries` for transitions back to the same or an earlier stage; schema 1 definitions are described through their v2 upgrade), `GET /v1/workflow/profiles`, `GET /v1/workflow/doctor`, `GET /v1/workflow/estimate`, `GET|POST /v1/workflow/runs`, `GET /v1/workflow/runs/RUN_ID` (snapshot with `limitations`: `{count, ids}` of the findings the run is accepted with, so a `completed` run with `count` above 0 is not clean, `stalled`: `{silentMs, lastEventAt}` only while a running run has journaled no event for longer than the [stall limit](../workflows/runtime.md#stalls-deadlines-and-automatic-resume), and `requests`, including tasks and writers, and `worktree`: `{path, branch, present}` for a worktree run, where `present` turns false once delivery or `discard-worktree` removed it, or null for a run in the working copy), `.../usage` (`?format=md` answers `{runId, markdown}`, the run's [usage report](../workflows/runtime.md#usage-reports)), `.../artifacts`, `.../report` (`{runId, markdown}`, the [run report](../workflows/runtime.md#run-report)), `.../events`, `POST .../pause|resume|cancel|approve|reject|answer|extend|reroute`. `reroute` takes `commandId`, `expectedRevision`, `model` and/or `routes` (stage ID to model) and moves a stopped run to other models ([switching a run to another model](../workflows/runtime.md#switching-a-run-to-another-model)); it records a `run.rerouted` event and a new `routing.json` revision. `POST /v1/workflow/runs` also takes `budget` (`quick`, `standard`, `extended` or `checkpoints`, as `--budget`), which the server applies to `policy`, the configured policy or the built-in default, and `modelStrict: true` (the run model overrides configured model routes) and the run view has `routing` with the effective model of each role and stage and the routing warnings. Quick tasks are runs started with `workflow: "quick"`. `POST /v1/workflow/runs` takes `issue` (a GitHub issue URL, `OWNER/NAME#N` or `#N`, as `--issue`); with it `feature` and `prompt` are optional, the request comes from the issue and the run's delivery pull request closes it ([starting from a GitHub issue](../workflows/runtime.md#starting-from-a-github-issue)).

B adds the remaining `baked workflow` commands the screens need. Each takes `commandId` and `expectedRevision` like the other mutations. The CLI's `approve`, `answer` and `evidence` continue the run after the decision unless `--no-resume` is given; the API endpoints for the same decisions (`approve`, `answer`, `evidence`) only record it, and the client calls `resume`.

| Method and path | Body | CLI |
| --- | --- | --- |
| `POST /v1/workflow/runs/RUN_ID/continue` | `requestId` | `continue` (a token checkpoint, or one more repair round of a stopped convergence) |
| `POST /v1/workflow/runs/RUN_ID/accept` | `requestId` | `accept` (accepts the findings of a stopped convergence as known limitations; `reject` stops it, see [stopped convergence](../workflows/runtime.md#stopped-convergence)) |
| `POST /v1/workflow/runs/RUN_ID/evidence` | `requestId`, `evidence` (text), `accepted` | `evidence` (manual acceptance criterion) |
| `POST /v1/workflow/runs/RUN_ID/recover` | `requestId`, `effectId`, `resolution: "record-applied" \| "record-not-applied" \| "retry" \| "cancel"`, `evidence` | `recover` |
| `POST /v1/workflow/runs/RUN_ID/fork` | | `fork` |
| `POST /v1/workflow/runs/RUN_ID/undo` | `path?` | `undo` |
| `POST /v1/workflow/runs/RUN_ID/discard-worktree` | | `discard-worktree` |
| `POST /v1/workflow/runs/RUN_ID/deliver` | `remote?`, `branch?`, `draft?`, `pullRequest?` (default true); no revision | `deliver` (prepares the plan and its approval request) |
| `POST /v1/workflow/runs/RUN_ID/deliver/execute` | `expectedRevision`, `requestId?`; no `commandId` | `deliver --execute`, after the plan was approved |
| `GET /v1/workflow/runs/RUN_ID/progress` | | `export-progress` |
| `POST /v1/workflow/runs/RUN_ID/export` | `destination?` (a new directory, relative to the workspace); no `commandId` | `export`: writes `manifest.json` and returns `{path, manifestHash}`. Without `destination` it is `.baked/exports/RUN_ID-STAMP`; a directory outside the workspace is refused with 403 `CAPABILITY_DENIED`, one that exists with 409 |
| `POST /v1/workflow/runs/RUN_ID/redact` | `artifactId`, `reason` (required); no `commandId` | `redact`: `{redacted: true}` |
| `POST /v1/workflow/gc` | `before` (ISO date), `dryRun?` | `gc`: `{runIds, bytes}`, the ended runs older than 30 days and `before` that it removes, or with `dryRun` would remove |
| `POST /v1/workflow/import` | `source: "spec-kit" \| "ecc" \| "markdown-edit"`, `path` (a local directory), `featureId`, `commandId?` | `import`: `{candidateHash, warnings, unsupported}`; 403 `CAPABILITY_DENIED` while `workflows.importsEnabled` is off |
| `POST /v1/workflow/runs/RUN_ID/candidate` | `commandId`, `spec?` (object), `plan?` (Markdown), `tasks?` (task graph), `policy?`; no revision | `candidate`: stages a revision and returns `{candidateHash, reportArtifactId}`; with no field it adopts the current instruction files |
| `POST /v1/workflow/runs/RUN_ID/revise` | `candidate` (the hash) | `revise`: applies the candidate; the plan is approved again, then `resume` |
| `POST /v1/workflow/editor` | `from` (definition ID), `copy?` (an unsaved "Duplicate as custom" copy of `from`), `definition?` (the working copy from the last view), `op?` | `/workflow edit` in the terminal: returns `{view, error?}`. See [workflow editor](#workflow-editor) |
| `POST /v1/workflow/editor/review` | as above, without `op` | `{review}`: what Save shows before it writes |
| `POST /v1/workflow/editor/save` | as above, plus `confirm?` (the auto approval hash prefix) | writes `baked/workflows/ID.json` |
| `GET /v1/workflow/gates` | | `gates`: gates with `required`, `scope`, `source`, `confirmed`, plus `problems` |
| `POST /v1/workflow/gates/confirm` | `{ids?: string[], all?: true}` | `gates confirm` |
| `POST /v1/workflow/gates/draft` | `{text, kind?: "command"\|"ai-acceptance", id?, fromCriteria?: boolean, model?}` | `gate new`: `{gate, script, summary, capabilities, problems, path}`; writes nothing; 422 when the model's reply is not a gate |
| `POST /v1/workflow/gates` | `{gate, script?: {path, content}}` | `gate save`: writes `baked/gates/ID.json` (and the script) and confirms it; 201 `{id, path, script}`, 422 with the problems when it cannot be saved or would overwrite a file |
| `GET /v1/workflow/gates/ID` | | `gate show`: `{id, type, mode, source, path, summary, confirmed?, capabilities, gate}`, 404 for an unknown ID |
| `GET /v1/workflow/gates/ID/places?workflow=W` | | `gate places`: `{workflowId, copyTo, places: [{key, label, bound, disabled}]}`; `key` is `stage:ID` or `transition:ID`, `label` says where it runs in words, `disabled` why the gate cannot go there; `copyTo` names the custom copy a built-in workflow becomes |
| `POST /v1/workflow/gates/ID/bind` | `{workflow?, at}` | `gate bind`: adds the gate at `at` and saves `baked/workflows/ID.json` (a built-in workflow is copied as `ID-custom` first); `{workflowId, path, copiedFrom}`, 422 when the gate cannot go there |
| `GET /v1/workflow/route` | `?workflow=&model=&route=` | `route`: who runs each stage and why |
| `GET /v1/workflow/routing` | `?workflow=&model=` | `{layers: {global, project}, workflows, workflowId, runModel, classes, roles, stages, profiles, independentReview: {global, project, effective}, reviewMinConfidence: {global, project, effective}, critic: {global, project, effective}, warnings, error}`. Each of `classes`, `roles`, `stages` (of `workflowId`, `sdd` by default) and `profiles` is a list of rows `{target, path, label, global, project, resolved}`: `target` is `{kind: "class", name}`, `{kind: "role", role}`, `{kind: "profile", id}` or `{kind: "stage", workflowId, stageId}`, `path` the key under `modelRouting`, `global` and `project` the route each layer's own file sets (or null), and `resolved` `{model, source, effort?, fallback?}` what a run would use, or null. Routes resolve with the server's running config; `error` says why stages and profiles could not be explained (no run model, unknown workflow) |
| `PATCH /v1/workflow/routing` | `{scope: "global" \| "project", target, route: {model, effort?, fallback?} \| null, create?, workflow?, model?}` or `{scope, independentReview: "off" \| "warn" \| "require" \| "provider" \| null, workflow?, model?}` or `{scope, reviewMinConfidence: 0..1 \| null, workflow?, model?}` or `{scope, critic: "off" \| "advise" \| "select" \| "earlyStop" \| null, workflow?, model?}` | as `GET`. Sets one route of the layer's `modelRouting` (a model ID, or `$class` outside a class), or removes it with `route: null`; `create: true` adds a class that must not exist yet. The change is checked as a run start would check the merged routing; a refused one answers 422 `ROUTING_REFUSED` with every reason in `problems` (an empty model, a class naming a class, a class reference no layer defines, including removing a class still in use, fallback models that are classes, repeat the primary or exceed three, schema errors) and writes nothing. Only the `modelRouting` section of the file changes, and an emptied one is removed. New runs use it; started runs keep their frozen routing |
| `GET /v1/usage` | `?days=7&groupBy=model\|stage\|day` (or two, comma-separated: `stage,model`), `model?` (`(host)` for host attempts), `stage?`, `format?` (`md`) | `{days, since, groupBy: string[], filters, runs, attempts, tokens, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, unpricedTokens, groups: [{key, keys: {model?, stage?, day?}, runs, attempts, tokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, unpricedTokens}]}` over every attempt started in the window. `key` joins the group's values with ` / `. Stage keys are stage IDs (`plan`, `task-T001`, `checks`), days are UTC dates. `costUsd` is estimated from the price table (uncached input, cache reads, cache writes and output; attempts recorded before cache writes were report 0 writes); `unpricedTokens` are tokens of attempts it could not price (no per-step usage, or a model without a price). With `format=md` the answer is `{markdown}`: the same summary as a Markdown document to share ([usage reports](../workflows/runtime.md#usage-reports)); any other `format` is a 400 |

### Workflow editor

The terminal workflow editor ([workflow editor](../workflows/runtime.md#workflow-editor)) for the desktop, with the `workflow-editor` capability; the code is shared (`src/core/workflows/v2/editor-service.ts`). The server keeps no editor state: each request sends `from`, the definition the editor was opened with, and after the first one the working copy as `definition` with `copy: true` while it is an unsaved duplicate. An unknown `from` is 404; a working copy whose `id` differs from `from` without `copy` is 400.

`POST /v1/workflow/editor` without `op` opens the definition. With `op` it applies one edit and returns the new view; an edit the editor refuses returns the unchanged view with `error`, and a read-only definition refuses every edit but `duplicate`. Operations:

```ts
type GateTarget = {kind: "stage"; stageId: string} | {kind: "transition"; id: string};
type EditorOp =
  | {op: "addGate"; target: GateTarget; gateId: string}
  | {op: "removeGate" | "toggleMode"; target: GateTarget; index: number}
  | {op: "moveGate"; target: GateTarget; index: number; delta: -1 | 1}
  | {op: "addTransition"; from: string; to: string; on: Outcome; loop: number | null}
  | {op: "removeTransition"; id: string}
  | {op: "addWaitStage"; after: string}      // a wait stage on the one passed edge out of `after`
  | {op: "removeWaitStage"; stageId: string}
  | {op: "changeField"; stageId: string; key: string; delta: -1 | 1}  // key from stage fields
  | {op: "duplicate"};
```

The view is `{id, from, copy, definition, readOnly (the reason, or null), dirty, stages, problems: [{owner, messages}], estimate}`. Each stage has `id`, `type`, `produces`, `fields` (`{key, label, value, hint}`), `targets` (its own gate list for a check, review or wait stage, then each outgoing transition: `{target, name, transition: {to, on, loop} | null, bindings: [{gateId, mode, override, summary}], options: [{gateId, summary, disabled}]}`, where `disabled` is why a gate cannot be bound there) and `transitionChoices` (`{to, on, loop}` for the new-transition form).

`/review` returns `{review}`: `{kind: "read-only", message}`, `{kind: "problems", groups}`, `{kind: "unchanged"}` or `{kind: "review", path, text, diff, gates, autoApproval: {hash, prefix, limits} | null}`. `/save` writes the file when the review allows it and returns `{saved: true, path, view}`; otherwise `{saved: false, review, confirmationNeeded, view}`, where `confirmationNeeded` means new auto approval limits wait for `confirm`, at least the first 12 characters of their hash.

## Initiatives (B)

The `baked workflow initiative` commands over HTTP. Mutations take `commandId` and `expectedRevision`. Drives of one initiative run one after another; a launch while another drive waits to start is merged into it.

| Method and path | Body | CLI |
| --- | --- | --- |
| `GET /v1/initiatives` | | `list` |
| `POST /v1/initiatives` | `commandId`, `initiativeId`, `prompt`, `plan?`, `workflow?`, `policy?`, `model?`, `owner?`, `budget?: {tokens, calls, timeMs}`, `tieredApproval?: {maxTasks, maxFiles}`, `confirmAutoApproval?` | `start`; 202 with the view, planning is driven in the background like a run |
| `GET /v1/initiatives/ID` | | `show` |
| `GET /v1/initiatives/ID/events` | `?after=` | `events` as SSE, or JSON with `Accept: application/json` |
| `POST /v1/initiatives/ID/merge` | `features`, `id?`, `title?` | `merge` |
| `POST /v1/initiatives/ID/split` | `feature`, `parts` | `split` |
| `POST /v1/initiatives/ID/remove`, `/rename`, `/replan` | `feature` (and `title` for rename) | same |
| `POST /v1/initiatives/ID/approve`, `/reject` | `requestId` and `digest`, or `requestId` and `reason` | same; approve drives in the background |
| `POST /v1/initiatives/ID/resume`, `/pause` | | same; resume drives in the background |
| `POST /v1/initiatives/ID/extend` | `tokens?`, `calls?`, `timeMs?` | `extend` |
| `POST /v1/initiatives/ID/reroute` | `model`, `resume?` | `reroute`; with `resume: true` it drives in the background |

Initiative requests also appear in `GET /v1/attention` with `source: "initiative"` and `initiativeId`.

## Projects and project setup (exists, extended by B)

Exists: `GET /v1/projects` (every known folder with counts and `current`), `GET /v1/projects/current` (manifest summary, working set, sessions, runs), `POST /v1/projects/current/working-set` (`{add?, remove?}`).

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v1/projects/pin`, `/unpin`, `/forget` | `{path}` (absolute) | the `GET /v1/projects` list; 404 for a folder that is not known |
| `POST /v1/projects/rename` | `{path, name}` (absolute path; `name` at most 120 characters, trimmed) | the `GET /v1/projects` list with the new `name`; `""` restores the manifest or folder name. Only the shared list changes, not `baked/project.json`. 404 for a folder that is not known. Capability `project-rename` |
| `GET /v1/projects/current/instructions` | | `{files: [{order, path, absolutePath, source, sourceLabel, scope: "project" \| "global", enabled, bytes, hash, content}], sources: [{id, label, files, enabled, defaultEnabled}], sourcesScope: "project" \| "global", promptBytes}`: every non-empty instruction file in the project and home folder, in the order agents read them, with the project manifest's files last; `enabled` is false (and `order` null) when the file's source is switched off; `hash` is the SHA-256 of the file's bytes; `sources` are the instruction sources and whether each is on, and `sourcesScope` the config file that sets `instructionFiles` (older servers send neither `enabled` nor `sources`) |
| `PUT /v1/projects/current/instructions` | `{path, content, expectedHash}` | the file entry plus `affectedRuns` (IDs of runs that have not ended and froze this file); only a listed file can be written, switched on or not (404 otherwise; a project file wins over a global one with the same path), 409 `INPUT_CHANGED` when `expectedHash` no longer matches. `expectedHash: null` creates a project file at a path a source reads (`AGENTS.md`, `baked.md`, ...; 404 for any other path, 409 when a non-empty file is there); creating does not switch its source on |
| `PUT /v1/projects/current/instructions/sources` | `{source, enabled, scope?: "project" \| "global"}` | the `GET` answer after switching the source on or off; writes `instructionFiles` to `scope`, by default the config file that already sets it (the project's when neither does); 404 for an unknown source |
| `GET /v1/workflow/checks` | | `{checks: [Check & {lastResult?}], workflowsEnabled}`: the commands runs use as evidence (`workflows.policy.checks`, project config first) |
| `PUT /v1/workflow/checks` | `{checks: Check[]}` | as `GET`; replaces the list in the project's `.baked/config.json` and keeps every other setting there (a project without a `workflows` block gets the effective one, so the global policy is copied once, not merged). New runs use the list at once; started runs keep the copy they froze. 400 for an invalid check or a repeated ID |
| `GET /v1/workflow/memory` | | `{enabled, entries, hidden, rendered}`: the [project memory](../workflows/runtime.md#viewing-and-editing-project-memory) a run started now reads. Each entry is `{id, kind: "note" \| "answer" \| "assumption" \| "check", text, question?, runId?, runs?, recorded?, hidden}`; `entries` add `sent` (false for a check the workspace policy already lists), `hidden` holds forgotten entries, `recorded` is what runs recorded when a person reworded the entry, `rendered` is the text the next run receives (null when empty) and `enabled` is false when the policy sets `projectMemory: false` |
| `POST /v1/workflow/memory` | `{action: "add", text}`, `{action: "edit", id, text}`, `{action: "forget", id}` or `{action: "restore", id}` | `{id, ...}` as `GET`, `id` naming the changed entry. Same as `baked workflow memory`; runs started afterwards read the result. 400 for empty text, rewording a check, restoring a note or a thirteenth note; 404 for an unknown ID |
| `GET /v1/workflow/critic` | `?runId=` | `{summary, calibration, criticOutcomes}`: the [critic outcome log](../workflows/runtime.md#critic-outcome-log) as `baked workflow outcomes --json` prints it, for one run with `runId`. `calibration` is `{samples, good, bad, auc, threshold, calibrated, reason}` from the whole log ([calibration](../workflows/runtime.md#critic-calibration)) |
| `GET /v1/memory` | | `{settings, entries, hidden, cleanupHint}`: the chat agent's [long-term memory](../guide.md#memory), the same store as the terminal's `/memory`. `settings` is `{writeScope: "project" \| "global" \| "none", readScope: "project" \| "global" \| "all" \| "none", settingsScope: "project" \| "global"}`; each entry is `{id, scope: "project" \| "global", category: "pref" \| "decision" \| "gotcha" \| "context" \| null, summary, details, topics, source: "user" \| "agent", createdAt, lastUsedAt, useCount, pinned, hidden}`; `entries` are active memories of both scopes, `hidden` the hidden ones; `cleanupHint` is `{sessions, total, stale}` when a cleanup is due, else null |
| `POST /v1/memory` | `{action: "pin" \| "unpin" \| "hide" \| "restore", scope, id}`, `{action: "edit", scope, id, summary, details?, category?}` or `{action: "purge", scope: "project" \| "global" \| "all"}` | as `GET`; `purge` adds `cleared` (how many it deleted, hidden ones included; it cannot be undone). `edit` keeps the ID, topics and pin and makes a hidden memory visible. 404 for an ID the scope does not have, 409 `DUPLICATE_MEMORY` when another memory already has the edited text |
| `PUT /v1/memory/settings` | `{writeScope?, readScope?, settingsScope?}`, at least one | as `GET`. `writeScope: "none"` stops saving, `readScope: "none"` stops recall; `settingsScope` moves the saved settings between `<project>/.baked` and the global data directory. Chat sessions that already started pick the change up on their next turn when the server's chat runs in the same process |
| `GET /v1/memory/cleanup` | | `{candidates: [{id, scope, kind: "duplicate" \| "dead" \| "stale" \| "similar", summary, detail, keeperId?}]}`: what the terminal's Cleanup tab lists; a memory appears once |
| `POST /v1/memory/cleanup` | `{actions: [{scope, id, action: "hide" \| "pin"}]}` | `{applied: {hidden, pinned}, ...}` as `GET`; records the cleanup, which resets `cleanupHint` |
| `GET /v1/workflow/checks/suggestions` | | `{suggestions: [{check, source, reason, preselected}]}`: test, lint, typecheck and build commands found in `package.json`, Python, Go and Cargo projects, minus the configured ones |
| `POST /v1/workflow/checks/ID/run` | `{}` | `{checkId, at, status: "passed" \| "failed" \| "timeout" \| "cancelled" \| "error", exitCode, durationMs, outputTail, truncated}`. Runs the check as a run would but records no evidence; the result becomes the check's `lastResult` until the server stops. 409 `WORKSPACE_BUSY` while a run holds the workspace, 404 for an unknown ID |
| `GET /v1/commands` | | `{commands: [{name, scope: "project" \| "global", path, description, argumentHint?}]}`: the custom slash commands in `.baked/commands` of the project and the home folder; a project command replaces a global one with the same name |
| `GET /v1/skills` | | `{skills: [{id, scope, path, description?}]}`: installed `SKILL.md` folders in `.baked/skills`, `.agents/skills` and `.claude/skills` of the project and the home folder; a project skill hides a global one with the same name |
| `GET /v1/skills/catalog?q=` | | `{skills: [{id, skillId, name, source, installs}]}`: the [skills.sh](https://skills.sh) catalog, popular skills for an empty `q`; 502 `CATALOG_UNAVAILABLE` when skills.sh does not answer |
| `POST /v1/skills` | `{source, skillId, scope: "project" \| "global"}` | `{skill, skills}`: installs a catalog skill the way `/skills` in the terminal does (`bunx skills add`, `npx` as the fallback; up to 30 seconds), into the skill folders of the project or the home folder; `skill` is the installed entry, `skills` the new list. 422 `INSTALL_FAILED` with the installer's message when no `SKILL.md` arrived |
| `GET /v1/skills/SCOPE/NAME` | | the skill's entry plus `content` (its `SKILL.md`, at most 256 KiB); `SCOPE` is `project` or `global`; 404 for a skill that is not installed |
| `DELETE /v1/skills/SCOPE/NAME` | | `{skills}`: deletes the skill's folder. 409 `NOT_REMOVABLE` for a `SKILL.md` lying directly in a skills folder, which is removed by hand |
| `GET /v1/hooks` | | `{disabledBy, sources, events}`: the [hooks](../extensions.md#hooks) configured for the workspace. `sources` is every file hooks are read from, in load order: `{path, scope: "user" \| "project" \| "local", exists, hooks}` (`hooks` counts its commands). `events` are `{event, known, disabled, blocking, hooks: [{source, scope, matcher, command, async, once, timeout, if}]}` in lifecycle order; `known` is false for an event name BAKED never fires, `disabled` is true when the event is switched off for this server process, `blocking` when one of its commands is not `async`. Values of secret environment variables (`*TOKEN*`, `*SECRET*`, `*API_KEY*`, ...) are replaced with `[redacted]` in `command`. `disabledBy` is the file that sets `disableAllHooks: true` (no hook runs then), or null |
| `POST /v1/hooks/session` | `{event, enabled}` | as `GET /v1/hooks`; switches every hook of `event` off or back on for this server process only, as `/hooks` does in the terminal UI. Nothing is written to a config file, and a restarted server runs every configured hook again. Hooks are created and changed only in their files; the API has no route for that. 400 for an event name BAKED does not fire |

Changing a file a run froze (an instruction file, a gate or a skill) does not pause the run at once. A run that is driving stops at its next step as `blocked` with reason `input_changed`, which `/v1/attention` shows; resuming a waiting or paused run is refused with 409 `INPUT_CHANGED`. To continue with the new text, stage a candidate (`POST /v1/workflow/runs/RUN_ID/candidate` with only `commandId`) and apply it with `revise`; the plan is approved again before the run resumes. `cancel` or `fork` are the other ways out.
| `GET /v1/config` | | `{global, project, effective, paths: {global, project}}`: both files as stored and the merged config the server runs with. Provider keys live in the secret store, not here, but values the user put in these files themselves (an MCP server's `env`) are returned as written |
| `PATCH /v1/config` | `{scope: "global" \| "project", set?: object, remove?: string[]}` | as `GET`; `set` replaces top-level keys, `remove` deletes them; the running server uses the new config at once. Model routing, fallbacks, workflow policy (checks, budget presets), default model and mode live here |
| `GET /v1/providers` | | `{providers: [{id, name, configured, acceptsKey, source: "env" \| "app" \| "detected" \| null, detectedFrom?, keyUrl?, signIn?}]}`; `acceptsKey` is false for providers signed in another way (Codex, Claude Code). `source` is `detected` when no key is set but a login another tool holds is used, and `detectedFrom` names it: `Copilot IDE login` for `copilot`, `GITHUB_TOKEN`, `GH_TOKEN` or `gh CLI` for `github-models`; a key in the environment or saved by BAKED always wins. `signIn` is present for providers that sign in through their own CLI (`claude-code`, `codex`): `{installed, loggedIn, message, command, login: Login \| null}`, where `command` is the terminal command that does the same and `login` the current or last sign-in this server started |
| `POST /v1/providers/ID/login` | | 202 `{login: Login}`: starts the CLI's own login (`claude auth login`, or Codex's ChatGPT browser login), which opens the browser on this computer; while one runs, returns it instead of starting another. A CLI that is missing fails at once, one that is already signed in succeeds at once. `Login` is `{provider, state: "running" \| "succeeded" \| "failed" \| "cancelled", lines: string[], url?, error?, startedAt, endedAt?}`: `lines` are the CLI's progress lines (the last 200), `url` the sign-in page it printed or returned. 404 for a provider that does not sign in through a CLI |
| `GET /v1/providers/ID/login` | | `{login: Login \| null}`; poll it while `state` is `running` |
| `DELETE /v1/providers/ID/login` | | `{login: Login \| null}`; stops a running sign-in (`state: "cancelled"`) |
| `POST /v1/providers/ID/logout` | | `{ok, message}`: runs the CLI's own logout (`claude auth logout`, `codex logout`) |
| `POST /v1/providers/ID/switch` | | 202 `{ok: true, message, login: Login}`: switches the CLI to another account as `/codex switch` does: runs the CLI's own logout, then starts its login (as `POST /v1/providers/ID/login`) so the user signs in with another account in the browser. While a sign-in runs, returns it without signing out. The CLI keeps one account at a time and its own credentials, so there is no account list and no token is returned. 200 `{ok: false, message, login: null}` when the logout fails and the CLI is still signed in. Needs the `provider-switch` capability |
| `PUT /v1/providers/ID/key` | `{key}` | `{configured, storage: "keychain" \| "file"}`; 404 for a provider that takes no key |
| `DELETE /v1/providers/ID/key` | | 204 |

## MCP servers

The `mcpServers` entries of the global and project config ([MCP servers](../extensions.md#mcp-servers)) with their live status, and the changes `/mcp` makes in the terminal UI. Changes write only `mcpServers` of the named config file and apply to the running server at once: once anything connected servers (a chat message, a run step, or Reconnect), removed and disabled servers disconnect and changed ones reconnect in the background. Before that, the first chat message or run step connects them. The config logic is in `src/core/mcp/config.ts`; `/mcp` and `baked mcp` use the same.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /v1/mcp` | | `McpView` |
| `POST /v1/mcp` | `{scope: "global" \| "project", server: McpServerConfig}` | `McpView`; 409 `CONFLICT` when the scope already has a server with that name, 400 for a missing command (stdio) or http(s) URL (http, sse) |
| `PATCH /v1/mcp/NAME` | `{scope, server, toScope?}` or `{scope, disabled: boolean}` | `McpView`; replaces the entry (renaming it when `server.name` differs, moving it to `toScope`) and keeps `disabled` unless `server` sets it, or turns it on or off. 404 when `scope` has no server `NAME` |
| `DELETE /v1/mcp/NAME` | `?scope=` | `McpView`; a global server with the same name takes a removed project server's place |
| `POST /v1/mcp/NAME/reconnect` | | `McpView` after one connection attempt with a fresh restart budget; it connects a server nothing connected yet too. 409 `DISABLED` |
| `POST /v1/mcp/NAME/ping` | | `{ms, ...McpView}`: lists the server's tools as a health check. 409 `NOT_CONNECTED`, 502 `PING_FAILED` |

```ts
interface McpServerConfig { name; transport?: "stdio" | "http" | "sse"; command?; args?: string[]; env?: Record<string, string>; url?; headers?: Record<string, string>; timeout?: number /* ms */; disabled?: boolean }
interface McpView {
  servers: { name; scope: "global" | "project"; overridesGlobal: boolean; transport; config: McpServerConfig;
    status: "idle" | "disconnected" | "connecting" | "ready" | "error" | "disabled"; error: string | null;
    tools: { name; description }[]; connectedAt: number | null; lastPingMs: number | null }[];
  started: boolean; // whether anything connected servers yet; "idle" servers wait for that
  paths: { global; project };
}
```

Project servers come first, then the global servers no project server replaces. `config` holds `env` and `headers` as written, secrets included, as `GET /v1/config` does. A server name is 1 to 64 letters, digits, dots, dashes or underscores.

## Language servers

The language servers code intelligence uses for the project ([language servers](../configuration.md#language-servers)), and the changes `/lsp` makes in the terminal UI. The logic is in `src/core/intelligence/lsp-service.ts`; `/lsp` and `baked lsp` use the same. Changes apply to the running backend at once: turning a server off stops it, and installing or turning one on restarts the servers of its languages. Servers start with the first chat message or run step; until then `started` is false and nothing is running.

| Endpoint | Body | Answer |
| --- | --- | --- |
| `GET /v1/lsp` | | `LspView` |
| `POST /v1/lsp/ID/install` | | `{...LspView, restarted, installed: {server, package}, log: string[]}` after the install, which can take minutes. `ID` is a server, a Mason package or a language. 404 `NOT_FOUND`, 409 `NOT_INSTALLABLE` (no package, or its toolchain is not on PATH), 409 `BUSY` while the same install runs, 502 `INSTALL_FAILED` |
| `POST /v1/lsp/ID/disable` | `{scope?: "global" \| "project"}` or none | `{...LspView, restarted}`. Without `scope`, the project file when it has its own list, otherwise the global one |
| `POST /v1/lsp/ID/enable` | `{scope?}` or none | `{...LspView, restarted}`; removes the server from every list that names it, or only from `scope` |
| `POST /v1/lsp/ID/restart` | | `{...LspView, restarted, startedNow}`: restarts the server (or a language's servers) and retries ones that failed. Before anything started the servers, it starts the project's servers instead (`startedNow: true`) |
| `POST /v1/lsp/restart` | | The same for every server |
| `POST /v1/lsp/diagnose` | | `IntelligenceCheck`: the health check of `/diagnose` and `baked diagnose`. Starts the project's servers when nothing started them, then probes every backend against a file of the project's main language; it can take tens of seconds. 503 `NOT_STARTED` when code intelligence did not start |

```ts
interface LspView {
  servers: { id /* the server command */; languages: string[]; detected: boolean /* the project has its languages */;
    installed: boolean; source: "PATH" | "baked" | "mason" | null; path: string | null;
    disabled: boolean; disabledIn: ("global" | "project")[];
    running: boolean; ready: boolean; pids: number[]; openFiles: number; diagnosticCount: number;
    lastError: { message; at: number } | null /* the last start failure, while it is not running */;
    package: string | null /* Mason package */; requiresToolchain: string | null; installable: boolean }[];
  languages: string[]; // detected, primary first
  uncovered: string[]; // detected languages no enabled, installed server covers
  started: boolean;
  registry: boolean; // whether the Mason registry is cached; the first install downloads it
  paths: { global; project };
}

interface IntelligenceCheck {
  language: string; // the project's main language
  probeFile: string; // the file the probes ran against; empty when none was found
  backends: { backend: string /* lsp:standalone, ts-morph, tree-sitter, regex */; tier: number;
    supports: boolean /* handles this language */; initialized: boolean; initMs?: number; initError?: string;
    probes: { operation: string /* findSymbols, getDiagnostics, ... */;
      status: "pass" | "empty" | "error" | "timeout" | "unsupported"; ms?: number; error?: string }[] }[];
  failing: string[]; // backends that support the language but failed to start, or whose probes errored or timed out
}
```

Servers of detected languages come first. `GET /v1/workflow/doctor` adds an `lsp.missing` warning per uncovered language, or one `lsp.servers` line when all are covered.

## Chat settings

The chat settings the terminal UI edits in its pickers (`/provider-settings`, `/router`, `/model-scope`, `/tools`, `/web-search`, `/agent-features`, `/repo-map`, `/compaction`, `/timeouts`, `/context-window`) are described once in `src/core/settings/schema.ts`. The server validates changes against that schema and the desktop draws its settings pages from it, so a setting added there shows up on every surface. Unlike `PATCH /v1/config`, these routes check every value and write nested keys without replacing their neighbours.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /v1/settings` | | `SettingsView` below |
| `PATCH /v1/settings` | `{scope: "global" \| "project", set?: {[id]: value}, reset?: id[]}` | `SettingsView` after the change; the running server uses it at once. A `null` model or number unsets it. `reset` removes the setting from that scope's file, so the other scope or the default applies. A `secret` setting takes the key itself in `set` and is stored in the secret store (keychain or `secrets.json`) whatever the scope; `reset` deletes it. 400 `INVALID_SETTING` names the setting for an unknown ID, a value the schema refuses, or a scope the setting is not saved in |

```ts
interface SettingsView {
  pages: { id; title; description; command }[];         // command: the terminal command for the same settings
  settings: SettingDefinition[];                           // in display order
  values: { [id]: { id; value; source: "project" | "global" | "default" | "env" | "keychain" | "file"; global?; project? } };
  catalogs: { tools: { name; description }[] };            // choices of string-list settings
}
interface SettingDefinition {
  id: string;            // dotted config path, e.g. "performance.effort"; a secret's store key, e.g. "brave-api-key"
  page; section; label; help: string;
  scopes: ("global" | "project")[];
  enabledWhen?: { id; values: (string | boolean)[] };   // only meaningful while that setting has one of these values
  type: "boolean" | "enum" | "number" | "model" | "string-list" | "model-list-map" | "model-number-map" | "secret";
  default: unknown;
  options?: { value; label; help? }[];                     // enum
  min?; max?; step?; integer?; nullable?;                  // number; model-number-map has min and max
  display?: { unit; factor };                              // number shown as value / factor, e.g. ms as s
  catalog?: "tools";                                       // string-list
  envVar?: string;                                         // secret: the environment variable that also supplies it
}
```

A secret's `value` is only whether a key is set; the key itself is never returned. Provider API keys stay under `/v1/providers`. Chat sessions of the server apply these settings on their next turn as the terminal UI does: disabled tools, code execution, computer use and the text editor tool, the task router, the Baked map and summary settings, and the cache lifetime.

## Code graph

The graph the repository map builds (`.baked/repomap.db`), grouped for drawing. The server reads the database read-only, so a scan in progress never waits on it, and rebuilds its grouped copy when the database changes. The first request starts indexing when no chat or run has started it yet. The grouping is in `src/core/intelligence/code-graph-model.ts`; the terminal `/graph` view uses the same.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `POST /v1/graph` | `{expanded?: string[], tests?: boolean, typeEdges?: boolean, reveal?: path}` | `{state: "ready", indexing, view: GraphView}`; without an index `{state: "indexing" \| "empty", indexing}`, and `{state: "disabled"}` when `repoMap` is off. `indexing` is true while the index is still being built or refreshed, so clients poll |
| `GET /v1/graph/file` | `?path=` | `{path, lines, symbols, exported, rank, key, test, usedBy, imports, usedByCount, importsCount, packages}`: the strongest links each way (`{path, weight, names}`, at most 8) and the external packages the file imports; 404 for a file that is not indexed |
| `GET /v1/graph/link` | `?from=&to=` | `{from, to, weight, typeOnly, names, calls, callSites: [{caller, callee, line}], cochanges, mutual}`: why `from` depends on `to`; every imported name, up to 5 call sites, how often Git changed both together and whether `to` also depends on `from`. 404 when `from` does not import `to` |
| `GET /v1/graph/search` | `?q=&limit=` | `{paths}`: indexed files whose path contains `q` (2 characters at least), best match first |

`GraphView` is one level of the drawing. A project with at most 30 code files is `flat`: every file is a unit. Otherwise the top level holds up to about 16 units: the five most depended-on files (PageRank), the biggest folders, and piles for the rest. `expanded` lists the open folder and pile IDs (`d:<folder>`, `<owner>#files` for small files, `<owner>#dirs` for extra folders); each open one is a `frame` and its children are units whose `owner` is that frame. `reveal` opens the folders around a file and returns its unit ID as `revealed`.

```ts
interface GraphView {
  flat: boolean; expanded: string[]; revealed: string | null;
  units: { id; kind: "dir" | "file" | "pile" | "dirpile"; label; path; owner: string | null; lines; files; keys; tone: 0 | 1 | 2 | 3; key; test; symbols; rank; inside: { path; lines }[] }[];
  frames: { id; kind; label; path; owner; depth; lines; files; keys; inside }[];
  edges: { id; from; to; weight; pairs; typeOnly; calls; cochanges; mutual; top: LinkPair[] }[]; // summed between visible units
  tones: { tone; label }[]; stats: { files; lines; symbols; links; calls }; hubs: { path; lines; rank }[];
}
```

`tone` 0 to 2 cycle over the top-level folders by size and 3 marks tests. `key` is a file in the top 3% by rank. Each edge sums the file links between two visible units; `top` keeps its strongest file pairs. With `typeEdges: false` links into type-heavy files are left out, with `tests: false` test files.

## Progress

Long-running work of the server that someone waits on, from `src/core/progress.ts` (capability `progress`).

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /v1/progress` | `Accept: application/json` | `{items: ProgressItem[]}`: the work running now |
| `GET /v1/progress` | `Accept: text/event-stream` | the same list as `event: progress` whenever it changes, first at once |

```ts
interface ProgressItem {
  id: string;            // the task for once-per-process work, else a unique id
  task: "open" | "index" | "run-start";
  label: string;         // "Opening the project: mapping the codebase", "Indexing files", "Building edges", "Starting the run"
  done: number | null;   // counted work only: files parsed while indexing
  total: number | null;
  startedAt: string;
}
```

`open` covers creating the project's shared context (memory, the intelligence worker, tools), which the first chat message, run step or graph request starts. `index` lasts while the repository map scans: a count of files while they are parsed (`RepoMap.onProgress`), then the later phases without a count. `run-start` lasts from a start or resume request until the run is driven. Language server start-up is not reported here; the LSP status endpoints cover it.

## Git

The terminal Git menu (`Ctrl+G`, `/git`) for the project folder, with the `git` capability. Both run the actions of `src/core/git/menu.ts` with Git's own configuration, credentials and hooks; Git never prompts (`GIT_TERMINAL_PROMPT=0`), so a remote that needs a password it does not have fails with Git's message.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /v1/git` | | `GitOverview`; `{isRepo: false, ...}` with empty lists outside a repository |
| `POST /v1/git/actions` | one of the actions below | `{ok, message, output, overview: GitOverview}`. A step Git refuses (no upstream, merge conflict, nothing to commit) answers 200 with `ok: false` and Git's reason in `message`. 400 for an unknown action or field and for a destructive action without `confirm: true`; 409 `NOT_A_REPOSITORY` outside a repository and `WORKSPACE_BUSY` while a workflow run holds the workspace. Actions of one server run one at a time |

| Action | Body | Git |
| --- | --- | --- |
| Commit | `{action: "commit", message, stageAll?}` | With `stageAll`, or when nothing is staged, stages every modified and untracked file first, then `git commit -m`. The co-author trailer follows `coAuthorCommits` (on by default). `message` is at most 10,000 characters |
| Push, pull | `{action: "push"}`, `{action: "pull"}` | `git push`, `git pull` with Git's own defaults; 30 s limit |
| Stash | `{action: "stash", message?}`, `{action: "stash-pop"}` | `git stash push [-m message]` (at most 200 characters, on one line), `git stash pop` |
| Branches | `{action: "create-branch", name}`, `{action: "switch-branch", name}` | `git checkout -b name`; `git checkout name --` for an existing local branch only. Names that start with `-`, contain `@{` or whitespace, or fail `git check-ref-format --branch` are refused |
| Force push | `{action: "force-push", confirm: true}` | `git push --force-with-lease`. Never a plain `--force` |
| Reset hard | `{action: "reset-hard", confirm: true}` | `git reset --hard HEAD`; untracked files are kept |

```ts
interface GitOverview {
  isRepo: boolean; branch: string | null; upstream: string | null; // "origin/main"
  isDirty: boolean; staged: string[]; modified: string[]; untracked: string[]; conflicts: string[];
  ahead: number; behind: number;
  branches: string[];   // local, most recently committed first, at most 200
  stashes: string[];    // `git stash list` lines, newest first
  log: { hash: string; subject: string; date: string }[]; // the 20 latest commits, relative dates
  busy: boolean;        // a workflow run holds the workspace; actions answer WORKSPACE_BUSY
}
```

## Diagnostics

Disk use and cleanup of BAKED's own data, the model calls and the background errors of this server process: what the terminal UI shows with `/storage`, `/model-events` and `/errors`. The logic is in `src/core/diagnostics/`. Project data is the workspace's `.baked` folder; global data is the user configuration directory (`~/.baked`, or `%LOCALAPPDATA%\baked` on Windows).

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /v1/diagnostics/storage` | | `StorageView` below |
| `POST /v1/diagnostics/storage/cleanup` | `{target: "repo-map" \| "sessions" \| "plans" \| "history" \| "vacuum", confirm?: true}` | `{target, freedBytes, removed?, storage: StorageView}`; `removed` is the number of sessions deleted. Every target except `vacuum` deletes data and needs `confirm: true`, or the request fails with 400 `INVALID_REQUEST`. Nothing to clear is not an error (`freedBytes: 0`). 409 `SESSION_BUSY` while a chat turn of this server runs (`sessions`, `repo-map`), 409 `WORKSPACE_BUSY` while this server drives a workflow run (`repo-map`) or when the history database cannot be opened |
| `GET /v1/diagnostics/errors` | | `{errors: {id, source, message, timestamp}[]}`, newest first. The log of failures off the chat transcript (hooks, language servers, agents, session saves) since the server started, at most 500. Read-only, like the terminal `/errors` view |
| `GET /v1/diagnostics/model-events` | | `ModelEventsView` below |
| `POST /v1/diagnostics/model-events` | `{action: "enable" \| "disable" \| "clear"}` | `ModelEventsView` after the change. Recording is off when the server starts; `disable` also drops the recorded calls |

The cleanup targets: `repo-map` deletes the repository map (`.baked/repomap.db`) through the server's context manager, which starts indexing again; `sessions` deletes every saved chat session of the workspace, including those the terminal UI saved; `plans` deletes `.baked/plans`; `history` deletes the terminal UI's prompt history in `history.db` for every project; `vacuum` runs SQLite `VACUUM` on the repository map, memory and history databases and keeps all data.

```ts
interface StorageView {
  projectDir: string; globalDir: string;
  project: { totalBytes; repoMapBytes; sessionsBytes; sessionCount; memoryBytes; plansBytes; configBytes };
  global: { totalBytes; historyBytes; memoryBytes; configBytes; binariesBytes };
}
interface ModelEventsView {
  enabled: boolean;
  events: ModelCallEvent[];   // newest first, at most 500
  models: { modelId; calls; errors; totalMs; avgMs; lastMs; input; output; cacheRead; cacheWrite; lastAt }[];
}
interface ModelCallEvent {
  id: string; modelId: string;
  source: "main" | "subagent" | "compaction" | "embed" | "run" | "other"; // main: a chat turn step; run: a workflow attempt step
  startedAt: number; durationMs: number; state: "ok" | "error";
  sessionId?: string; runId?: string; agentId?: string;                  // agentId: the run's agent profile
  input?: number; output?: number; cacheRead?: number; cacheWrite?: number; errorMessage?: string;
}
```

Events and errors live in the server's memory: they cover the chats and runs this `baked serve` process drove and are gone when it stops.

## Screen map

| Mockup | Endpoints |
| --- | --- |
| All projects | desktop main process for open/clone/close; `GET /v1/projects` of any server; `POST /v1/projects/pin\|unpin\|forget\|rename` |
| Project home | `GET /v1/projects/current`, `GET /v1/workflow/runs`, `GET /v1/attention`, `GET /v1/workflow/doctor` |
| Needs you | `GET /v1/attention` (stream) of every open project; answers go to the owning run, initiative or session |
| Chat session | `/v1/sessions/*`, `GET /v1/models`, `GET /v1/mentions`; context chip from `context`, files chip from `filesEdited`, working set chip from the project summary |
| Quick task, New run | `GET /v1/workflow/doctor`, `GET /v1/workflow/estimate`, `GET /v1/workflow/definitions`, `POST /v1/workflow/runs` |
| Workflow run, Parallel writers | `GET /v1/workflow/runs/RUN_ID` and its events, artifacts, usage; approve, reject, answer, pause, resume, cancel, undo, extend, reroute (the Model panel); `recover` from the recovery card, `fork` and `discard-worktree` from the run controls |
| AI acceptance gate | run snapshot requests and artifacts; `evidence` for manual criteria; resume to re-run |
| Delivery (in Needs you) | `deliver`, `approve`, `deliver/execute` |
| Initiatives | `/v1/initiatives/*` |
| Usage | `GET /v1/workflow/runs/RUN_ID/usage`, `GET /v1/usage` |
| Run report tab | `GET /v1/workflow/runs/RUN_ID/report` |
| Settings: chat settings pages | `GET|PATCH /v1/settings`, `GET /v1/models` |
| Settings: model routing, providers | `GET|PATCH /v1/config`, `GET|PATCH /v1/workflow/routing`, `GET /v1/workflow/critic`, `GET /v1/providers`, `PUT|DELETE /v1/providers/ID/key`, `GET|POST|DELETE /v1/providers/ID/login`, `POST /v1/providers/ID/logout`, `POST /v1/providers/ID/switch`, `GET /v1/models` |
| Project setup: workflows | `GET /v1/workflow/definitions`, `POST /v1/workflow/editor`, `POST /v1/workflow/editor/review\|save` |
| Project setup: hooks | `GET /v1/hooks`, `POST /v1/hooks/session` |
| Run memory | `GET\|POST /v1/workflow/memory` |
| Chat memory | `GET\|POST /v1/memory`, `PUT /v1/memory/settings`, `GET\|POST /v1/memory/cleanup` |
| Git | `GET /v1/git`, `POST /v1/git/actions` |
| Code graph | `POST /v1/graph`, `GET /v1/graph/file`, `GET /v1/graph/link`, `GET /v1/graph/search` |
| Project setup: gates and checks | `GET\|PUT /v1/workflow/checks`, `GET /v1/workflow/checks/suggestions`, `POST /v1/workflow/checks/ID/run`; gate definition files in `GET /v1/workflow/gates` and `POST /v1/workflow/gates/confirm` |
| Commands and skills | `GET /v1/commands`, `GET /v1/skills` |
| Project setup: skills | `GET\|POST /v1/skills`, `GET /v1/skills/catalog`, `GET\|DELETE /v1/skills/SCOPE/NAME` |
| Project setup: MCP servers | `GET\|POST /v1/mcp`, `PATCH\|DELETE /v1/mcp/NAME`, `POST /v1/mcp/NAME/reconnect` |
| Project setup: language servers | `GET /v1/lsp`, `POST /v1/lsp/ID/install\|enable\|disable\|restart`, `POST /v1/lsp/restart`, `POST /v1/lsp/diagnose` |
| Project setup: instructions | `GET|PUT /v1/projects/current/instructions`, `PUT /v1/projects/current/instructions/sources` |
| Project setup: working set | `GET /v1/projects/current`, `POST /v1/projects/current/working-set` |
| Project setup: diagnostics | `GET /v1/diagnostics/storage`, `POST /v1/diagnostics/storage/cleanup`, `GET\|POST /v1/diagnostics/model-events`, `GET /v1/diagnostics/errors` |

## Not in this contract yet

- Editing existing gate definitions in `baked/gates/` and project commands in `.baked/commands`; the desktop opens those files in the editor. New gates are drafted and saved with the `gate-drafts` routes.
- Several projects in one server process. Each folder keeps its own `baked serve`.

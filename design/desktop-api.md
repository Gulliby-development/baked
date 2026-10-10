# Desktop API contract

The desktop app (`apps/desktop`) talks to BAKED only through the local HTTP API that `baked serve` starts (`src/core/api/`). This document is the contract between the two: the desktop builds against it, and the server keeps it. Endpoints that already exist are described in "Local API" in `design/sdd-workflows/runtime-guide.md`; this document lists them only by name and specifies everything that is new.

Status of each group: **exists** (on `main`), **A** (sessions and chat), **B** (workflow, project setup and settings gaps). A and B land as separate pull requests; until a group lands, `GET /v1/health` does not list its capability.

## Process model

- One `baked serve` per project folder. The desktop main process starts `baked serve --cwd FOLDER --port 0 --allow-origin ORIGIN` for each open project, reads the one JSON line `{"url","port","tokenFile"}` from stdout, reads the token from `tokenFile`, and stops the process with SIGTERM (Windows: the process is killed; the token file is removed on the next start).
- The server binds 127.0.0.1 only. Every request carries `Authorization: Bearer TOKEN`. The Host header must name the loopback address and port. Requests with an `Origin` header are refused unless that origin was allowed with `--allow-origin`.
- Everything that is shared between projects (the known-project list, global config, provider keys) is read from the user profile, so any project's server can answer for it.
- App-only preferences (theme, density, language of the app, notifications, tray behavior, shortcuts) are stored by the desktop app itself. The API never reads or writes them.

## Conventions

- JSON bodies, `Content-Type: application/json`, at most 1 MiB. Methods: `GET`, `POST`, `PATCH`, `DELETE`.
- Errors: `{"error":{"code":"...","message":"..."}}` with the HTTP status. Codes in use: `INVALID_REQUEST` 400, `UNAUTHORIZED` 401, `CAPABILITY_DENIED`/`ORIGIN_REJECTED` 403, `NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405, `REVISION_CONFLICT`/`COMMAND_CONFLICT`/`STALE_DECISION`/`WORKSPACE_BUSY`/`INPUT_CHANGED`/`RUN_TERMINAL`/`SESSION_BUSY`/`STALE_PROMPT` 409, `PAYLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `HOST_REJECTED` 421, `INTERNAL` 500, `SHUTTING_DOWN` 503. Messages have secrets redacted.
- Workflow and initiative mutations carry `commandId` (client-chosen, safe id) and `expectedRevision`; a retry with the same `commandId` returns the first result.
- Streams are Server-Sent Events. Each event has `id:` (a sequence number), the client resumes with `Last-Event-ID` or `?after=`, and the server sends `: keep-alive` comments every 15 s. A client that asks only for `application/json` gets a JSON page instead of a stream where noted.
- Timestamps are milliseconds since the epoch.

## Health and capabilities (exists, extended by A and B)

`GET /v1/health` returns `{apiVersion: 1, version, workspace, capabilities: string[]}`. `capabilities` names the groups this server supports: `workflow`, `attention`, `projects` (exist), `sessions` (A), `setup`, `initiatives` (B). The desktop hides a screen whose capability is missing instead of failing on 404. The API version stays 1 while changes are additive.

## Sessions and chat (A)

A session is a chat conversation stored in `.baked/sessions/ID/` of the project, the same store the terminal UI uses: sessions created by either front end are listed and can be continued by the other. A session saved by the terminal UI with several tabs is continued on its active tab; the other tabs are kept as they are. The server saves a session after every turn. Only one writer should hold a session at a time: while the API runs a turn of a session, the terminal UI should not continue the same session.

### Types

```ts
type Mode = "default" | "architect" | "auto";            // "plan" is not offered over the API yet
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
}

interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  prompts: Prompt[];        // pending only
  queued: string[];         // messages waiting to be steered into the running turn
  usage: { input: number; output: number; cacheRead: number };   // whole session
  context: { usedTokens: number; windowTokens: number; percent: number } | null;
  filesEdited: string[];    // workspace-relative paths edited in this session
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
}

type Prompt = { id: string; createdAt: number } & (
  | { kind: "outside-cwd"; tool: string; path: string }          // approve or deny
  | { kind: "destructive"; description: string }                 // approve or deny
  | { kind: "web-search"; query: string }                        // approve or deny
  | { kind: "fetch-page"; url: string }                          // approve or deny
  | { kind: "question"; question: string; allowSkip: boolean;
      options: { label: string; value: string; description?: string }[] }   // answer
);
```

In `default` and `architect` mode, writes outside the project, destructive commands, web searches and page fetches wait for a prompt answer, exactly as the terminal UI asks. `auto` approves them without asking. A prompt waits until it is answered or the turn is interrupted; interrupting denies every pending prompt.

### Endpoints

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /v1/sessions` | `?limit=` (default 50) | `{sessions: SessionSummary[]}`, most recently updated first |
| `POST /v1/sessions` | `{title?, model?, mode?, text?}` | 201 `SessionDetail`; with `text` the first turn starts at once |
| `GET /v1/sessions/ID` | | `SessionDetail` |
| `PATCH /v1/sessions/ID` | `{title?, model?, mode?}` | `SessionSummary`; `model` and `mode` apply from the next turn |
| `DELETE /v1/sessions/ID` | | 204; 409 `SESSION_BUSY` while a turn runs |
| `POST /v1/sessions/ID/fork` | `{atMessageId?}` | 201 `SessionDetail` of a new session with the messages up to and including `atMessageId` (all when absent) |
| `POST /v1/sessions/ID/messages` | `{text}` | 202 `{turnId, queued: false}` when a turn starts; `{turnId, queued: true}` when a turn already runs and the text is steered into it at its next step |
| `POST /v1/sessions/ID/interrupt` | | `{interrupted: boolean}` |
| `POST /v1/sessions/ID/prompts/PROMPT_ID` | `{approve: boolean}` or `{answer: string}` | `{resolved: true}`; 404 unknown, 409 `STALE_PROMPT` when already answered or the turn ended. `answer: ""` skips a question that allows it |
| `GET /v1/sessions/ID/events` | `?after=SEQ`, or `Last-Event-ID` | SSE stream below |
| `GET /v1/models` | `?provider=` | `{providers: [{id, name, configured, models: [{id, name, contextWindow?}]}]}`; `configured` is whether a key or login is available |

`ID` accepts a unique prefix of a session id, like `--session` on the command line.

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
| `prompt` | `prompt` (`Prompt`) |
| `prompt-resolved` | `promptId`, `outcome` (`approved`, `denied`, `answered`, `skipped`) |
| `step` | `turnId`, `step`, `usage` (this turn so far) |
| `turn-done` | `turnId`, `status` (`completed`, `interrupted`, `failed`), `error?`, `message` (the assistant `ChatMessage`, null when nothing was produced), `usage`, `durationMs` |
| `session` | `session` (`SessionSummary`) after a state, title, model or mode change |
| `reset` | the requested sequence is no longer buffered or belongs to an earlier server start: fetch `GET /v1/sessions/ID` and continue from its `lastSeq` |

The persisted messages are authoritative: after `turn-done`, `GET /v1/sessions/ID` returns the same assistant message that the event carried.

### Attention (exists, extended by A)

`GET /v1/attention` items gain `source: "run" | "chat"`. Chat items are the pending prompts of sessions: `{source: "chat", sessionId, title, requestId: PROMPT_ID, kind: prompt kind, blocking: true, createdAt, runId: null, featureId: null, status: "waiting"}`. Run items keep their fields and get `source: "run"`, `sessionId: null`, `title: null`.

## Workflow runs (exists, gaps filled by B)

Exists: `GET /v1/workflow/definitions`, `GET /v1/workflow/profiles`, `GET /v1/workflow/doctor`, `GET /v1/workflow/estimate`, `GET|POST /v1/workflow/runs`, `GET /v1/workflow/runs/RUN_ID` (snapshot with `requests`, including tasks and writers), `.../usage`, `.../artifacts`, `.../events`, `POST .../pause|resume|cancel|approve|reject|answer|extend`. Quick tasks are runs started with `workflow: "quick"`.

B adds the remaining `baked workflow` commands the screens need. Each takes `commandId` and `expectedRevision` like the other mutations.

| Method and path | Body | CLI |
| --- | --- | --- |
| `POST /v1/workflow/runs/RUN_ID/continue` | `requestId` | `continue` |
| `POST /v1/workflow/runs/RUN_ID/evidence` | `requestId`, `evidence` (text), `accepted` | `evidence` (manual acceptance criterion) |
| `POST /v1/workflow/runs/RUN_ID/recover` | `requestId`, `effectId`, `resolution`, `evidence` | `recover` |
| `POST /v1/workflow/runs/RUN_ID/fork` | | `fork` |
| `POST /v1/workflow/runs/RUN_ID/undo` | `path?` | `undo` |
| `POST /v1/workflow/runs/RUN_ID/discard-worktree` | | `discard-worktree` |
| `POST /v1/workflow/runs/RUN_ID/deliver` | `remote?`, `branch?`, `draft?`, `pullRequest?` (default true); no revision | `deliver` (prepares the plan and its approval request) |
| `POST /v1/workflow/runs/RUN_ID/deliver/execute` | `requestId?` | `deliver --execute`, after the plan was approved |
| `GET /v1/workflow/runs/RUN_ID/progress` | | `export-progress` |
| `GET /v1/workflow/gates` | | `gates`: gates with `required`, `scope`, `source`, `confirmed`, plus `problems` |
| `POST /v1/workflow/gates/confirm` | `{ids?: string[], all?: true}` | `gates confirm` |
| `GET /v1/workflow/route` | `?workflow=&model=&route=` | `route`: who runs each stage and why |
| `GET /v1/usage` | `?days=7&groupBy=model\|stage\|day` | usage of every run updated in the window, summed |

## Initiatives (B)

The `baked workflow initiative` commands over HTTP. Mutations take `commandId` and `expectedRevision`.

| Method and path | Body | CLI |
| --- | --- | --- |
| `GET /v1/initiatives` | | `list` |
| `POST /v1/initiatives` | `prompt`, `workflow?`, `policy?`, `model?`, `budget?: {tokens?, calls?, timeMs?}`, `tieredApproval?`, `maxTasks?`, `maxFiles?`, `confirmAutoApproval?` | `start` (planning is driven in the background like a run) |
| `GET /v1/initiatives/ID` | | `show` |
| `GET /v1/initiatives/ID/events` | `?after=` | `events` as SSE, or JSON with `Accept: application/json` |
| `POST /v1/initiatives/ID/merge` | `features`, `id`, `title` | `merge` |
| `POST /v1/initiatives/ID/split` | `feature`, `parts` | `split` |
| `POST /v1/initiatives/ID/remove`, `/rename`, `/replan` | `feature` (and `title` for rename) | same |
| `POST /v1/initiatives/ID/approve`, `/reject` | `requestId` and `digest`, or `reason` | same |
| `POST /v1/initiatives/ID/resume`, `/pause` | | same; resume drives in the background |
| `POST /v1/initiatives/ID/extend` | `tokens?`, `calls?`, `timeMs?` | `extend` |

Initiative requests also appear in `GET /v1/attention` with `source: "initiative"` and `initiativeId`.

## Projects and project setup (exists, extended by B)

Exists: `GET /v1/projects` (every known folder with counts and `current`), `GET /v1/projects/current` (manifest summary, working set, sessions, runs), `POST /v1/projects/current/working-set` (`{add?, remove?}`).

| Method and path | Body | Result |
| --- | --- | --- |
| `POST /v1/projects/pin`, `/unpin`, `/forget` | `{path}` | `{projects}` as `GET /v1/projects` |
| `GET /v1/projects/current/instructions` | | `{files: [{order, path, source, bytes, hash, content}]}`: the instruction files every chat and workflow agent reads, in order |
| `PUT /v1/projects/current/instructions` | `{path, content, expectedHash}` | the file entry; only a listed file can be written, 409 `INPUT_CHANGED` when `expectedHash` no longer matches |
| `GET /v1/config` | | `{global, project, effective, paths: {global, project}}`; secrets never appear in config |
| `PATCH /v1/config` | `{scope: "global" \| "project", set?: object, remove?: string[]}` | as `GET`; `set` replaces top-level keys, `remove` deletes them. Model routing, fallbacks, workflow policy (checks, budget presets), default model and mode live here |
| `GET /v1/providers` | | `{providers: [{id, name, configured, source: "env" \| "app" \| null}]}` |
| `PUT /v1/providers/ID/key` | `{key}` | `{configured: true, storage: "keychain" \| "file"}` |
| `DELETE /v1/providers/ID/key` | | 204 |

## Screen map

| Mockup | Endpoints |
| --- | --- |
| All projects | desktop main process for open/clone/close; `GET /v1/projects` of any server; `POST /v1/projects/pin\|unpin\|forget` |
| Project home | `GET /v1/projects/current`, `GET /v1/workflow/runs`, `GET /v1/attention`, `GET /v1/workflow/doctor` |
| Needs you | `GET /v1/attention` (stream) of every open project; answers go to the owning run, initiative or session |
| Chat session | `/v1/sessions/*`, `GET /v1/models`; context chip from `context`, files chip from `filesEdited`, working set chip from the project summary |
| Quick task, New run | `GET /v1/workflow/doctor`, `GET /v1/workflow/estimate`, `GET /v1/workflow/definitions`, `POST /v1/workflow/runs` |
| Workflow run, Parallel writers | `GET /v1/workflow/runs/RUN_ID` and its events, artifacts, usage; approve, reject, answer, pause, resume, extend |
| AI acceptance gate | run snapshot requests and artifacts; `evidence` for manual criteria; resume to re-run |
| Delivery (in Needs you) | `deliver`, `approve`, `deliver/execute` |
| Initiatives | `/v1/initiatives/*` |
| Usage | `GET /v1/workflow/runs/RUN_ID/usage`, `GET /v1/usage` |
| Settings: model routing, providers | `GET|PATCH /v1/config`, `GET /v1/workflow/route`, `GET /v1/providers`, `PUT|DELETE /v1/providers/ID/key`, `GET /v1/models` |
| Project setup: gates and checks | `GET /v1/workflow/gates`, `POST /v1/workflow/gates/confirm`, checks in `PATCH /v1/config` (project scope) |
| Project setup: instructions | `GET|PUT /v1/projects/current/instructions` |
| Project setup: working set | `GET /v1/projects/current`, `POST /v1/projects/current/working-set` |

## Not in this contract yet

- Plan mode and its plan review in chat, image attachments, manual compaction ("Compact now"), checkpoints and rewinding a chat, per-session diff statistics. The desktop hides these controls until a later version of this contract adds them.
- Creating or editing gate definitions in `baked/gates/` and project commands in `.baked/commands`; the desktop opens those files in the editor.
- Several projects in one server process. Each folder keeps its own `baked serve`.

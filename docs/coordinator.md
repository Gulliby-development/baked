# Project coordinator

The project coordinator is one long-lived chat per project. You come back to it for the whole project instead of starting a new session each time: it answers from the project's state and from a project brief it keeps up to date, and it says which focused work should go to a separate session or workflow run.

## What exists now

- **One per project.** The coordinator is a chat session with `kind: "coordinator"`, saved in `.baked/sessions/ID/` like other sessions. `POST /v1/coordinator` creates it the first time; later calls return the same session. Ordinary session lists (`GET /v1/sessions`, `baked session list`, the terminal session picker) leave it out.
- **Read-only.** It always runs in architect mode: it can read files, search and use code intelligence, but it does not edit files or run commands.
- **Project brief.** A short structured note with four sections: decisions, conventions, launched work (kind, id, why, status) and open questions. It is stored in `brief.json` next to the session, put into the system prompt of every coordinator turn, and capped at 8000 characters. The coordinator edits it with its `coordinator_brief` tool; you can edit it through `PUT /v1/coordinator/brief`, which refuses an edit made against an older revision so neither side overwrites the other unseen.
- **Self-compaction.** After a turn that leaves the context fuller than `compaction.triggerThreshold` (0.7 by default, the same setting as the terminal chat), the coordinator compacts its older messages on its own. The brief is not part of the conversation, so compaction and server restarts keep it whole.

## Reaching it

| Surface | How |
| --- | --- |
| Local API | `GET/POST /v1/coordinator`, `GET/PUT /v1/coordinator/brief`, then the usual `/v1/sessions/ID/...` endpoints ([contract](desktop/api.md#project-coordinator)) |
| Headless CLI | `baked session coordinator [--json]` prints the session id and the brief |
| Desktop app | not yet ([#151](https://github.com/Gulliby-development/baked/issues/151)) |
| Terminal UI | not yet ([#152](https://github.com/Gulliby-development/baked/issues/152)) |

## Not yet

Reading project state as data (runs, initiatives, sessions, attention), launching and tracking work, split proposals and tying work to GitHub issues are the next parts of the coordinator ([#144](https://github.com/Gulliby-development/baked/issues/144)).

# Project coordinator

The project coordinator is one long-lived chat per project. You come back to it for the whole project instead of starting a new session each time: it answers from the project's state and from a project brief it keeps up to date, and it says which focused work should go to a separate session or workflow run.

## What exists now

- **One per project.** The coordinator is a chat session with `kind: "coordinator"`, saved in `.baked/sessions/ID/` like other sessions. `POST /v1/coordinator` creates it the first time; later calls return the same session. Ordinary session lists (`GET /v1/sessions`, `baked session list`, the terminal session picker) leave it out.
- **Read-only.** It always runs in architect mode: it can read files, search and use code intelligence, but it does not edit files or run commands.
- **Project brief.** A short structured note with four sections: decisions, conventions, launched work (kind, id, why, status) and open questions. It is stored in `brief.json` next to the session, put into the system prompt of every coordinator turn, and capped at 8000 characters. The coordinator edits it with its `coordinator_brief` tool; you can edit it through `PUT /v1/coordinator/brief`, which refuses an edit made against an older revision so neither side overwrites the other unseen.
- **Project state.** The `project_state` tool answers from the same services as `baked serve`, as short summaries rather than event logs: `overview` (what waits for a person, active runs, open initiatives, sessions with a turn running), `runs`, `run` (stages, tasks, pending requests, changed files), `initiatives`, `initiative` (features, blockers, pending decisions), `sessions`, `session` (its last messages) and `attention`. Ordinary sessions do not get this tool.
- **Launching work.** `launch_session` starts a background chat session with a brief. It runs on its own in the server, shows in the session list, and its prompts reach the attention list like any session's. A session in `architect` mode starts at once. `default` or `auto` mode can edit files, so the coordinator first asks you with an approval prompt in its own chat. `start_run` and `start_initiative` use the same start paths as `POST /v1/workflow/runs` and `POST /v1/initiatives`, so a run stops at its own approval request with its estimate, and an initiative waits for your approval of its split. The coordinator has no tool that answers approvals.
- **Following it.** Every launch is added to the brief's launched work with its id and why. The server checks launched items every two seconds and updates their status in the brief. When an item finishes, fails, is cancelled or waits for a person, a note such as "Launched run ID: waiting: approval (why)" is added to the coordinator's chat as a `notice` event. The model does not see these notes as messages; it reads the updated status in the brief on its next turn.
- **Limits.** A launch is refused while `coordinator.maxActive` launched items (3 by default) are still active, or once everything launched has used `coordinator.maxTokens` tokens (20,000,000 by default) ([configuration](configuration.md#common-settings)).
- **Self-compaction.** After a turn that leaves the context fuller than `compaction.triggerThreshold` (0.7 by default, the same setting as the terminal chat), the coordinator compacts its older messages on its own. The brief is not part of the conversation, so compaction and server restarts keep it whole.

## Reaching it

| Surface | How |
| --- | --- |
| Local API | `GET/POST /v1/coordinator`, `GET/PUT /v1/coordinator/brief`, then the usual `/v1/sessions/ID/...` endpoints ([contract](desktop/api.md#project-coordinator)) |
| Headless CLI | `baked session coordinator [--json]` prints the session id and the brief |
| Desktop app | not yet ([#151](https://github.com/Gulliby-development/baked/issues/151)) |
| Terminal UI | not yet ([#152](https://github.com/Gulliby-development/baked/issues/152)) |

## Not yet

Parallel runs in separate worktrees, split proposals and tying work to GitHub issues are the next parts of the coordinator ([#144](https://github.com/Gulliby-development/baked/issues/144)).

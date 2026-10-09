# SDD runtime: running and operations

The runtime is available through `baked workflow` and `/workflow` in the TUI. It is off by default. The release gate status is in the [report](implementation-status.md). Bun is required; SQLite and the existing BAKED providers are used. No separate server or daemon is needed.

## Enabling

Select a configured BAKED model. `defaultModel: "none"` does not allow starting a workflow. Add `workflows` to the existing `.baked/config.json` and keep the other settings. The full example is below; `policy` is required and unknown fields are rejected.

```json
{
  "workflows": {
    "enabled": true,
    "importsEnabled": false,
    "defaultWorkflow": "sdd",
    "policy": {
      "maxConcurrentReadAgents": 3,
      "maxConcurrentWriters": 1,
      "maxAgentSteps": 24,
      "maxAgentCalls": 80,
      "maxTotalTokens": 400000,
      "maxActiveMs": 3600000,
      "maxCostUsd": null,
      "maxRepairRounds": 2,
      "maxConvergenceRounds": 2,
      "maxCorrectiveTasks": 20,
      "scopeApproval": "required",
      "reviewProfiles": { "correctness": "reviewer", "security": "security-reviewer", "language": null },
      "skepticProfileId": "skeptic",
      "forceSecurityReview": false,
      "allowedTools": ["read", "bake_find", "bake_impact", "navigate", "edit_file", "multi_edit", "delete_file", "request_check", "submit_result", "submit_artifact", "submit_review"],
      "network": "deny",
      "checks": [
        { "id": "typecheck", "executable": "bun", "args": ["run", "typecheck"], "cwd": ".", "timeoutMs": 120000, "required": true, "scope": "feature", "envNames": [], "writes": [] },
        { "id": "lint", "executable": "bun", "args": ["run", "lint"], "cwd": ".", "timeoutMs": 120000, "required": true, "scope": "feature", "envNames": [], "writes": [] },
        { "id": "tests", "executable": "bun", "args": ["test"], "cwd": ".", "timeoutMs": 600000, "required": true, "scope": "feature", "envNames": [], "writes": [] }
      ]
    }
  }
}
```

Check definitions contain an executable and argv. They run reviewed project code; this is not an OS sandbox. `envNames` allows specific additional variables on top of `buildSafeEnv`; values are not stored in definitions. `writes` marks only generated outputs. Task sources, the execution configuration and the internal database must not be excluded from a check. `network: deny` forbids network agent tools, but it does not replace network isolation of the executed project script and does not forbid calls to the selected LLM provider.

A monetary cap is currently rejected: the current BAKED provider metadata has no verified shared source of exact prices. Use token/time/call limits; unknown usage keeps its reservation. Arbitrary command hooks and unknown MCP/compound effects are forbidden inside a workflow. Approved commands run as checks. The ECC import does not enable hooks.

## First run

From source, the command runs through `bun run src/boot.tsx workflow`; after a build, through `bun run dist/index.js workflow`. The installed launcher uses `baked workflow`.

```sh
baked workflow run --feature status-json --prompt "Add JSON status for a run" --events
baked workflow run sdd --feature status-json --prompt-file request.txt --events
baked workflow status RUN_ID --json
baked workflow list --status completed
baked workflow artifacts RUN_ID
baked workflow artifacts RUN_ID --file ARTIFACT_ID
```

`baked workflow list` accepts `--status STATUS` to show only runs in that status. Supported values are `created`, `running`, `waiting`, `paused`, `blocked`, `completed`, `failed`, and `cancelled`. Combine it with `--feature`, `--limit`, and `--cursor` to further filter or paginate the results.

The process runs research → specify → plan → analyze and stores an approval request. All artifacts (research, spec, plan, tasks, reviews, findings) are written in English even when the request is in another language. The planner validates the package when it submits a result: errors from `validatePackage`, unknown profiles and checks return to it in the same conversation, and it may send a corrected plan twice. If errors remain, the run blocks with these messages and R repeats the stage. Before source files are edited, review `specs/status-json/spec.json`, `spec.md`, `plan.md`, `tasks.json`, `tasks.md`, the policy and the pending request. Canonical JSON is also stored in immutable database artifacts; Markdown is a rendering.

```sh
baked workflow approve RUN_ID --request REQUEST_ID --digest SHA256 --expected-revision N
baked workflow resume RUN_ID --expected-revision NEW_N --events
```

`approve` only stores the decision. `resume` owns the subsequent execution. Use the revision from the latest response: it changes after every command. `--command-id ID` allows repeating the same management mutation after a lost response; different content with the same ID is rejected. A start with a previous ID does not create a second run.

Automatic execution walks the task graph, the required checks, independent correctness/security/language reviews and convergence for every criterion. High/critical findings go to the skeptic. Fixes are added to the task graph through a bounded correction chain within the already approved scope. New requirements, checks or file scope require a revision and a new approval. `already_satisfied` requires host evidence and passes the same final checks.

## Decisions and revisions

```sh
baked workflow answer RUN_ID --request ID --answers-file answers.json --expected-revision N
baked workflow evidence RUN_ID --request ID --file observation.txt --accept --expected-revision N
baked workflow reject RUN_ID --request ID --reason "Needs clarification" --expected-revision N
baked workflow pause RUN_ID --expected-revision N
baked workflow cancel RUN_ID --expected-revision N
```

An answer does not restart the run. It is appended to the request, and `resume` continues from the stage the answer affects: research questions continue with specify and keep the research report, spec questions repeat specify, and analysis findings repeat specify when a blocking finding refers to the spec and plan when it refers only to `plan.md` or `tasks.json`.

Research, spec and analysis run before any code changes, so they cannot know check outcomes. A blocking research unknown or analysis finding that only says checks were not run (lint, typecheck, tests) is returned to the agent at submission to be made non-blocking; if the agent keeps it, the runtime records it as a non-blocking note. The planner and spec author take verification commands from the policy checks, and the spec reviewer treats a policy check that runs a superset of a named command (the whole test suite for one test file) as satisfying it and ignores project-instruction checks for files no task writes.

Research is scoped to the request. When the request names files, the researcher gets `4 + 2 × files` steps (at most its profile limit of 12) and 14,000 tokens per step (at most the policy `maxAttemptTokens`); it is told to read the named files together, follow their direct dependencies with `bake_find`/`bake_impact` and submit once they are covered. A request that names no file keeps the profile step limit and the policy token cap.

Answers is a JSON object of string answers. Manual evidence describes the user's actual observation. It is bound to a snapshot; a new source change makes it stale. Post-release criteria require explicit consent in the scope approval and keep the deferred status.

Editing the Markdown by hand does not change the accepted spec. Prepare an approved JSON revision, then:

```sh
baked workflow candidate RUN_ID --spec spec.json --plan plan.md --tasks tasks.json --policy policy.json
baked workflow revise RUN_ID --candidate CANDIDATE_HASH --expected-revision N
baked workflow resume RUN_ID --expected-revision NEW_N
```

Candidate fields are optional: missing ones are taken from the current package. The plan must contain Context, Decisions, Components, Data, Verification and Risks; DEC-001 and references to requirements. A candidate explicitly accepts the current instructions and configuration hashes. A changed skill requires a new profile/run. Definitions and profile versions inside an existing run stay frozen. A repeated analyze and approval are mandatory; with `autoApproval.renewal` the host may give that approval (see below).

The terminal states completed/cancelled/failed are immutable; `fork RUN_ID --expected-revision N` creates a new run with the parent's artifacts, a new approval and no passing evidence. It does not start the model before resume. There is no automatic rollback of user changes.

### Auto approval

Auto approval is off by default. Enabling it is a human act: set `workflows.policy.autoApproval` in `.baked/config.json`, or pass it in a policy file or a revision candidate. The policy is part of the approval digest, so the setting is frozen with the run.

```json
"autoApproval": {
  "renewal": true,
  "limits": { "maxTasks": 3, "maxFiles": 5, "allowedPaths": ["src/**", "tests/**"],
              "allowDelete": false, "allowNewDependencies": false, "maxTotalTokens": 200000 }
}
```

At the approval stage the host compares the package with the setting. Either mode is enough to approve:

- `renewal` re-approves a revised package that stays within the latest human approval of the same run. Every write must be a path that approval covered: a delete only where a delete was approved. The checks, tools, network, review profiles and the rest of the policy must be identical. Each budget limit (`maxTotalTokens`, `maxAgentCalls`, `maxAgentSteps`, `maxActiveMs`, `maxConcurrentReadAgents`, `maxRepairRounds`, `maxConvergenceRounds`, `maxCorrectiveTasks`) may stay the same or go down. The workflow, profile and skill hashes must not change. A fork starts without a human approval, so its first approval is always human. Approvals recorded before this feature do not include the policy and cannot be renewed.
- `limits` approves a package with at most `maxTasks` tasks and `maxFiles` distinct files. Every write must match one of the `allowedPaths` globs, compared without case. Deletes are allowed only with `allowDelete`. The run's `maxTotalTokens` must not exceed `limits.maxTotalTokens`. `allowNewDependencies` can only be `false`. A setting with `renewal: false` and no `limits` is rejected.

Some packages always go to a person, whatever the setting. These are writes under `.git`, `.baked`, `baked/`, `specs/`, `.github`, `.gitlab`, `.circleci` or `.husky`, writes to package manifests and lock files, `tsconfig*`, `biome*`, `.env*`, `AGENTS.md`, `CLAUDE.md`, `constitution.md`, key and certificate files, and any spec with post-release criteria (deferring them needs explicit consent).

An automatic approval is stored on the same approval request with the same digest a person would sign. Its actor is `auto-approval`, and its answer contains the mode and a hash of the limits. The event log shows `Decision accepted (auto approval)`. When auto approval declines, the request stays pending for a person, and `autoApproval.declined` in its body lists why.

## Gates, budgets and estimates

### Gates window

A gate is one entry of `workflows.policy.checks` in `.baked/config.json`. `/workflow gates` (or G on the runs screen) opens the window that lists, adds, edits and removes them. N adds a gate, E edits the selected one, D removes it after a confirmation, R runs it now and shows the outcome, the exit code, the duration and the last 40 lines of output, and S shows what the project already offers.

- The command is one line split into an executable and arguments without a shell; quotes group words. Timeout is in seconds. Required, scope (`feature` or `task`), the env names that may be passed through and the generated outputs (`writes`) are the existing check fields. The same validation as for a run applies, so a duplicate ID or a directory outside the workspace is refused at save time.
- Saving writes only `workflows.policy.checks` and keeps every other setting of the project config. A project without a `workflows` block gets one with `enabled: false`; enabling later only flips the flag.
- A run takes a copy of the policy when it starts. Changing gates affects the runs created afterwards. Changing the gates of a started run still goes through `candidate` and `revise`.
- Run now goes through the workflow worker, so the interface stays responsive; Esc stops the process tree. It uses the same safe environment and timeout as a run. It records no evidence. It is refused while a run holds the workspace, because the command could change the files that run is checking. It needs workflows to be enabled, so a disabled project starts no worker.

Detection offers gates; nothing is added until the user confirms. It reads the project root only:

| Ecosystem | Found by | Suggested gates |
| --- | --- | --- |
| bun, npm, pnpm, yarn | `package.json` scripts; the runner follows the lock file | `typecheck` (also `type-check`, `check-types`), `lint`, `tests` (the npm placeholder test script is ignored), `build` (advisory, not preselected) |
| Python | `pytest.ini`, `[tool.pytest]` in `pyproject.toml`, `[tool:pytest]` in `setup.cfg`, `[pytest]` in `tox.ini`, `conftest.py`, or a declared pytest dependency | `pytest`: `python -m pytest -q` (`python3` outside Windows) |
| Python lint | `ruff.toml`, `.ruff.toml`, `[tool.ruff]`, or a declared ruff dependency | `ruff`: `ruff check .` |
| Go | `go.mod` | `go-test`: `go test ./...` |
| Rust | `Cargo.toml` | `cargo-test`: `cargo test`, `cargo-clippy`: `cargo clippy --all-targets -- -D warnings` |

The same detection fills the checks written when E enables workflows on the runs screen; the build gate is not part of that set. Gates that are already configured (same ID or same command) are not offered again. Existing CI scripts are not read. On Windows, give the command name (`npm`, `pnpm`, `yarn`), not the shim file: Bun launches `npm` without a shell, but a name ending in `.cmd` fails with `EINVAL`. Only `npm` was tried on this host (npm 11.16); `pnpm` and `yarn` were not installed here.

### Raising a budget limit

A run blocked with `budget_exhausted` shows B (raise limits) next to fork and cancel. The confirmation names the new values: every limit that is used up, or at least 80% used, doubles, and the tokens double when nothing else explains the stop; calls stop at 1000, active time at 24 hours and tokens at 50 million. Y applies it and the run continues from the stage that stopped.

```sh
baked workflow extend RUN_ID --expected-revision N [--tokens N] [--calls N] [--time-ms N]
baked workflow resume RUN_ID --expected-revision NEW_N
```

Limits can only go up. The change is stored as the immutable artifact `policy-revisions/COMMAND_ID.json` (previous and new limits, both policy hashes, usage, the stage) and the run moves to `paused`. Scope, tools, checks, the stage, the evidence and the approval digest are untouched, so no new approval of the plan is needed and nothing is re-run. The user's command is the approval of the new limits.

### Soft token checkpoints

The budget preset `checkpoints` removes the hard token cap (the limit becomes 1,000,000,000) and sets `checkpointTokens`, by default half the configured token limit (200k with the default policy). Calls and time are doubled like the extended preset. A run never reserves tokens past the next multiple of the interval: when the next model step could pass it, the step does not start, the run moves to `waiting` with reason `checkpoint` and a durable request of kind `checkpoint` records the usage. The same guard applies to every step of one agent loop, so a runaway loop stops at the checkpoint and not after it.

C (or Enter) continues up to the next checkpoint, one interval beyond the projected spend; X stops the run in `paused`, and resuming asks again instead of spending. From the CLI:

```sh
baked workflow continue RUN_ID --request REQUEST_ID --expected-revision N
baked workflow resume RUN_ID --expected-revision NEW_N
```

Set `workflows.policy.checkpointTokens` (at least 10000, or `null`) to choose the interval of the preset. An interrupted call whose usage is unknown keeps its reservation and counts toward the next checkpoint.

### Estimates

All numbers are estimates and are labeled as such. The new-run form shows a range before the start, and the run screen shows a re-estimate, the burn rate and a forecast.

- The range is built from the runs already in this project: per stage the middle half of the samples (the full spread with two or three samples, minus 30% to plus 40% around a single one), a typical number of tasks and the cost of one task. Without history it uses generic ranges and says so.
- The form compares the range with the chosen preset: it fits, the high end exceeds the budget, or even the low end does. The checkpoint preset has no cap, so it only reports the interval.
- After the plan exists, the remaining cost is the open tasks times the typical task cost plus the later stages, less what the running stage already spent. The burn rate is tokens per active minute, and the forecast names the stage where the budget runs out at the typical cost and at the high end.
- The range shown at creation is kept as `estimates/start.json`. A completed run shows it next to the actual usage.

### Context compaction

Every model step resends the whole conversation, so a stage that reads many files pays for each old file again on every later step. The step budget of an agent attempt (`maxAttemptTokens`, see [step-budget](../../src/core/workflows/step-budget.ts)) replaces older large results of `read`, `navigate`, `bake_find` and `bake_impact` with short stubs that keep every evidence ID; the last three tool results stay verbatim, and edits and check results are never compacted. Evidence is written by the tools into the run store, so nothing is lost; the model reads a file again if it needs the content.

## Pause, crash and recovery

A workspace has one scheduler and one writer. Ordinary BAKED mutations use the same mutex; read-only tools stay available. An external editor is not governed by the lease, so content hashes are compared before and after checks and before acceptance. The Git baseline records HEAD, tracked files and the initial user changes; filesystem-only workspaces are supported too.

The TUI runs the workflow and SQLite transactions in a separate worker. The panel receives a consistent snapshot through asynchronous RPC; the SQLite busy timeout does not block the main interface thread. The execution time limit comes from the run's stored policy, including its revisions. A local RPC timeout does not stop observing an ongoing write.

After the worker exit is confirmed, the application creates a new session for reading state and recovery. It stores a receipt with the exact owner ID and the host PID. A live host PID alone does not mean that the exited worker keeps running. The receipt does not release the lease and does not allow repeating an unknown command: child process checks and recovery effects stay in place.

If the run's owner process has exited, `pause` and `cancel` release that run's leases when the owner is proven gone and the run has no command effect of unknown outcome whose process may still run. These are the same conditions under which `resume` would take the lease over. The release is recorded as the artifact `released-leases/ID.json`; afterwards, ordinary BAKED edits in the workspace are allowed again. A live owner or such a command keeps the lease.

Ctrl+C stores a pause and stops only the processes of that run. A second Ctrl+C forcibly ends the CLI; the next start requires recovery of unfinished effects. A lost heartbeat does not allow taking the lease from a live PID. With an unknown command outcome, repetition is forbidden:

```sh
baked workflow recover RUN_ID --request ID --effect EFFECT_ID --resolution record-applied --file observed-result.txt --expected-revision N
```

Resolutions: `record-applied`, `record-not-applied`, `retry`, `cancel`. For a command, the end of its process must be confirmed first. `retry` allows the next attempt, not an immediate replay of the previous shell command. With PID reuse the decision is conservative: a live PID blocks takeover. Do not delete the lease or the database to bypass recovery.

Before recovery or a lease takeover, the runtime checks the recorded command process and its descendants: on Windows, live processes whose parent is the recorded PID and that started after the command; on POSIX, the command's process group, and on Linux also any process that inherited the command's `BAKED_PROCESS_SCOPE` marker, which finds descendants that left the group with `setsid`. Cancel and timeout signal the same set. A process table that cannot be read counts as running. On Windows, a descendant whose intermediate parent also exited cannot be linked to the command; confirm such cases by hand. Recovery `cancel` requires confirmation that all processes of the run and their descendants stopped. A known live command PID blocks this decision. The runtime stores an immutable `abandoned-effects` artifact, keeps the effect's original unknown status in history and releases only the previous leases of that run. Cancelling does not claim that the command did not change files.

Workspace and evidence files are written to a unique temp file and renamed into place. A failed write, including ENOSPC part-way through, removes the partial temp file, leaves the target unchanged and keeps the effect unknown until reconcile compares hashes. Interrupted task checks repeat before dependent tasks open. After a successful check, the runtime stores a gate bound to the generation, the snapshot and the task definition. Nested corrective tasks restore the whole chain of predecessors only after the required checks pass. The final `verified` is set during final acceptance.

## TUI

`/workflow` without arguments opens the panel with the project's run list. Runs waiting for a user decision come first, then active runs, then finished ones. ↑/↓ select a run, Enter opens it, N opens the new-run form and Esc closes the panel. `/workflow new TEXT` opens the form with the description filled in. `/workflow help` prints the full command list; the other CLI commands (`run`, `status`, `approve`, `recover` and so on) are still accepted, and their result is printed in the chat as a short text.

If workflows are off in the project, the panel shows what will be written, and E enables them: a `workflows` block with the default policy and checks found in the `package.json` scripts (`typecheck`, `lint`, `test`) for the project's runner is added to `.baked/config.json`. An existing block only gets `enabled: true`. While the project is off, the panel starts no worker and creates no database.

The new-run form contains the description, the feature ID (derived from the description; Cyrillic text is transliterated), the workflow (`sdd` and `baked/workflows/*.json`), the budget `quick`/`standard`/`extended`/`checkpoints` (×0.5/×1/×2 of the configured policy's token, call and time limits; `checkpoints` has no token cap and asks every N tokens), an estimate of the spend labeled as an estimate, the current chat tab's model and the configured checks. Ctrl+S starts from any field. The run executes in the worker in the background; the panel switches to it immediately.

The worker reports new events of its runs to the panel immediately; the panel reads changes from other processes and active time by polling every 150 ms, and a poll without changes does not re-read the view.

The run screen shows what is happening and what can be done, the stage line, budget consumption (tokens used, held by attempts with unknown usage and in flight), a summary of tasks/criteria/checks/findings, the last model, the last recorded error and the event feed. When a budget blocks the run, the panel names the limit and the remaining amount. The action line contains only the keys valid in the current state: R start/resume/retry, P pause (also for a run marked running without a live executor), C cancel with confirmation, B raise the limits of a run blocked on its budget, F fork for blocked and finished runs. Tab/Shift+Tab switch between overview, decision, tasks, changes, spec, plan, checks, criteria and findings. Changes lists the files the run changed according to the effect journal: created/modified/deleted, the number of edits, an unfinished status and a mark when a file was changed outside the run afterwards. ↑/↓ and Enter show the diff of the selected file against Git HEAD; the diff is available only for files in this run's journal. If the file had uncommitted changes in the baseline, the diff includes them and the panel warns about it. Without Git only the facts of the changes are shown: the journal stores hashes, not content. Checks shows the latest result of each check: duration, exit code, number of runs, stale evidence and the last 40 output lines of a failing check, as well as configured checks that have not run yet. When a new request appears, the panel opens decision by itself. Approval shows the criteria, the files in scope, the checks and deferred criteria: A accepts the digest, X requires a rejection reason. Clarification shows the current question in full with its answer field right below it, then the references and a compact list of all questions with blocking ones marked; ↑/↓ switch questions without losing answers, Enter saves and moves on, Ctrl+S sends, and sending with an unanswered blocking question asks for a second confirmation. Questions come from research unknowns, spec open questions or analysis findings; each answer is keyed by its question ID and text. For manual evidence, Ctrl+T toggles the verdict. Recovery chooses the outcome with the keys 1..4 and requires a description of the observation. Esc returns to the list. Shift+PageUp/PageDown scrolls the content.

While the panel is closed, a line for the selected run is shown above the footer: stage and tokens, a pending decision or the outcome. The indicator polls only an already open worker and disappears after the outcome has been seen in the panel.

A new `/workflow run` uses the current chat tab's model selected through Ctrl+L, even if the worker was opened before the model was selected. An explicit `--model provider/model` sets the model for that run only and takes precedence over the chat selection. The CLI without `--model` uses the configured defaultModel. The models of existing runs are frozen in their profiles; switching the model in the chat does not change them on resume.

Closing the panel keeps the run in the current application process. Pause the run before closing its chat tab. Shutdown stops the workflow before shared resources are released. Session restore restores the run ID and observation; the model is not started automatically.

## Import, export and retention

```sh
baked workflow import --source spec-kit --path reviewed-checkout/specs/feature --feature imported
baked workflow import --source ecc --path reviewed-checkout/agents --feature imported
baked workflow export RUN_ID --destination exports/run-001
baked workflow export-progress RUN_ID
baked workflow gc --before 2026-09-01 --dry-run
baked workflow redact RUN_ID --file ARTIFACT_ID --reason "Remove sensitive content"
```

For import, enable `importsEnabled` separately and point to a local source directory. The adapter does not download a repository, does not run scripts/hooks and does not activate imported agents. `.baked/workflow-imports/HASH` stores the candidate, hashes, the source commit when present, the license and an unsupported report. Spec Kit Markdown stays a draft; schema-compatible spec.json/tasks.json are validated with their IDs kept. An ECC prompt candidate requires native role/tool/output mapping and enabling through a reviewed profile. `markdown-edit` uses the same inert directory reader.

To accept a schema-compatible imported package, pass its spec/plan/tasks to `candidate`; the import itself does not change accepted data. Profiles are loaded from the built-in definitions, `~/.baked/agents/*.json`, then `baked/agents/*.json`. The source and hash are visible in `workflow profiles`. A project workflow is stored in `baked/workflows/ID.json`; the mandatory SDD stages cannot be removed or reordered. Skills live in `baked/skills/ID/SKILL.md` and are frozen by hash.

For a review by another model, save the full definition of `reviewer` or `security-reviewer` in `baked/agents/ID.json` and set its `model` to a specific configured `provider/model`. `workflow profiles` shows the format of the other fields. Correctness, security and skeptic profiles can use different models. Without such an assignment, the built-in `$review` uses an available review slot or the active model. Reviewer context separation is mandatory regardless of the model choice; a separate profile name alone does not mean a different model. The model ID of every attempt is stored in the journal.

Export creates a new directory inside the workspace. The host API allows a separate outside-path approval callback; the CLI does not provide one automatically. Raw provider messages and command output are not part of the portable report; known credentials are masked. Redaction removes the selected artifact content, keeps the original hash and a tombstone and invalidates evidence. It does not promise to remove every possible copy of a string from other artifacts.

GC removes only terminal runs older than 30 days and the given cutoff when no child run needs them and they hold no lease. Active/waiting/blocked data and the shared `specs/` are kept. For a backup, stop the writers and save `.baked/workflows.sqlite` together with `.baked/workflow-runs/`. Copying a live SQLite database also needs the WAL/SHM files or an SQLite backup; an arbitrary copy of one file during writes is not a consistent backup.

## Exit codes

| Code | run/resume |
| --- | --- |
| 0 | completed |
| 1 | validation/failed |
| 2 | active deadline exhausted |
| 3 | waiting, decision stored |
| 4 | blocked, including the token/call/round budget |
| 5 | revision/digest/input/lease conflict |
| 130 | pause/cancel |

Management commands return 0 when the change is stored. `status`, `list`, `artifacts` and `export` are available with the feature flag off and do not call a model. `--events` prints JSONL with the stored sequence numbers and a final snapshot; `--after N` sets the replay point for run/resume. The process does not continue working after the CLI exits.

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

A monetary cap is currently rejected: the current BAKED provider metadata has no verified shared source of exact prices. Use token/time/call limits; usage left unknown by a crash keeps its reservation. Arbitrary command hooks and unknown MCP/compound effects are forbidden inside a workflow. Approved commands run as checks. The ECC import does not enable hooks.

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

### The run's own edits and undo

A run keeps the edits it executed. A revision, a failed or interrupted task attempt and a fork leave the files as they are, and the runtime recognises content the run itself wrote by the effect journal:

- Plan consistency and the implementer accept a `create` target that exists only because this run, or the run it was forked from, created it and nothing changed it since. Any other existing file is still a conflict ("already exists; use modify").
- The workspace check before each stage accepts a file that differs from the last snapshot when it holds exactly what the run's last journaled write produced, and records it in the expected baseline. Pausing or interrupting a task no longer blocks the resume with "Sources changed outside the active task"; a change by anyone else still does.
- A repeated task receives the paths that still contain its earlier attempt's edits (`earlierEdits` in its input) and must read them before editing. Those edits count as the task's changes, so a repeated attempt that finds the work already done does not fail with "did not complete its implementation".

Undo is an explicit command:

```sh
baked workflow undo RUN_ID --expected-revision N [--path PATH]
```

It restores the files changed by the run's uncommitted task edits: edits of a task that has no snapshot because its attempt failed or was interrupted, a revision invalidated it or dropped it, or the run was cancelled. A task's edits are committed when the runtime snapshots them after the task; to undo implemented work, apply a revision first. Before each task edit the runtime stores the file's previous content as a `pre-image` artifact. Undo restores a file only while it still holds exactly what the run wrote last, and never overwrites a later change by a person or another tool. Before replacing a file, it keeps the run's version as a `rolled-back` artifact. Each restore is a journaled `file_patch` effect with the tool `rollback`, and the outcome is an immutable `workspace-rollback` artifact that lists restored files and the files left in place with the reason. The command prints that report. Files restored or left in place are settled and are not reported again; a file whose restore failed, or whose edit has an unknown outcome, is retried by the next undo. The expected baseline follows each restored path, so the next resume does not treat the restore as an outside change. The run must not be running: undo takes the run's execution and mutation leases.

A typical recovery from a rejected implementation: `candidate`, `revise`, optionally `undo` to start the tasks from the original files, then `resume`.

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

- `renewal` re-approves a revised package that stays within the latest human approval of the same run. Every write must be a path that approval covered: a delete only where a delete was approved. Every task must use a profile that approval covered. The workflow, profile and skill hashes must not change. Capabilities may stay or shrink but never grow, whoever changed them: no tool outside the approved `allowedTools`, no wider `network`, the same review profiles and skeptic, and `forceSecurityReview` stays on if it was on. The other policy settings (checks, budget limits, `maxAttemptTokens`, `maxCostUsd`, `checkpointTokens`, `autoApproval`) must either match the approval, with each budget limit (`maxTotalTokens`, `maxAgentCalls`, `maxAgentSteps`, `maxActiveMs`, `maxConcurrentReadAgents`, `maxRepairRounds`, `maxConvergenceRounds`, `maxCorrectiveTasks`) the same or lower, or be exactly the policy an operator command set later. `workflow extend` and a `workflow revise` that changes the policy each write a `policy-revisions/COMMAND_ID.json` artifact with `approvedBy: "user"` and the new policy hash; that command is the human decision on the policy, so a re-plan with the same writes after `extend --tokens N` or after a revised check command renews without a person. Only these host-written records count; nothing in a candidate's spec, plan or graph, or in any model output, is treated as consent. A fork starts without a human approval, so its first approval is always human. Approvals recorded before the policy, or before the task profiles, were stored in the request cannot be renewed; the next approval goes to a person once.
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

### Token accounting and reservations

An agent attempt records its spend as each model step finishes, not only when it returns. An attempt that fails, is cancelled or stops on a cap is charged the tokens of its finished steps, writes `attempts/ID/usage.json` with stop reason `error` or `aborted` where it threw, and releases its reservation; `baked workflow usage` therefore includes failed attempts. Only an attempt interrupted by a crashed process, whose executor left no record, keeps its reservation as unknown usage.

Before each step the attempt reserves its spend so far plus an estimate of that step: the input tokens the provider reported for the previous step, adjusted by the bytes added or compacted since at three bytes per token, and an output of twice the largest output seen (at least 4096 tokens, at most the profile's output cap). Before any usage is known it counts the messages at three bytes per token plus 8192 tokens for the system prompt and tool definitions. A step is refused (`Next model step exceeds remaining token budget`, with the used, held and requested tokens) only when the spend plus this estimate would pass the run limit. The attempt cap is `maxAttemptTokens` or, when less, what the run limit still leaves after the other attempts, so an attempt that starts near the limit switches to its submit-only final step in time instead of failing mid-loop.

### Raising a budget limit

A run blocked with `budget_exhausted` shows B (raise limits) next to fork and cancel. The confirmation names the new values: every limit that is used up, or at least 80% used, doubles, and the tokens double when nothing else explains the stop; calls stop at 1000, active time at 24 hours and tokens at 50 million. Y applies it and the run continues from the stage that stopped.

```sh
baked workflow extend RUN_ID --expected-revision N [--tokens N] [--calls N] [--time-ms N]
baked workflow resume RUN_ID --expected-revision NEW_N
```

Limits can only go up. The change is stored as the immutable artifact `policy-revisions/COMMAND_ID.json` (previous and new limits, both policy hashes, usage, the stage) and the run moves to `paused`. Scope, tools, checks, the stage, the evidence and the approval digest are untouched, so no new approval of the plan is needed and nothing is re-run. The user's command is the approval of the new limits. When `autoApproval.limits.maxTotalTokens` covered the old token limit, it is raised with it, so a later scope approval is not sent to a person only because of the larger budget; a bound set below the old limit is kept. For the same reason `autoApproval.renewal` accepts the extended limits: they are the policy the operator set (see [Auto approval](#auto-approval)).

### Soft token checkpoints

The budget preset `checkpoints` removes the hard token cap (the limit becomes 1,000,000,000) and sets `checkpointTokens`, by default half the configured token limit (200k with the default policy). Calls and time are doubled like the extended preset. A run never reserves tokens past the next multiple of the interval: when the next model step could pass it, the step does not start, the run moves to `waiting` with reason `checkpoint` and a durable request of kind `checkpoint` records the usage. The same guard applies to every step of one agent loop, so a runaway loop stops at the checkpoint and not after it.

C (or Enter) continues up to the next checkpoint, one interval beyond the projected spend; X stops the run in `paused`, and resuming asks again instead of spending. From the CLI:

```sh
baked workflow continue RUN_ID --request REQUEST_ID --expected-revision N
baked workflow resume RUN_ID --expected-revision NEW_N
```

Set `workflows.policy.checkpointTokens` (at least 10000, or `null`) to choose the interval of the preset. A call interrupted by a crash, whose usage is unknown, keeps its reservation and counts toward the next checkpoint.

### Estimates

All numbers are estimates and are labeled as such. The new-run form shows a range before the start, and the run screen shows a re-estimate, the burn rate and a forecast.

- The range is built from the runs already in this project: per stage the middle half of the samples (the full spread with two or three samples, minus 30% to plus 40% around a single one), a typical number of tasks and the cost of one task. Without history it uses generic ranges and says so.
- The form compares the range with the chosen preset: it fits, the high end exceeds the budget, or even the low end does. The checkpoint preset has no cap, so it only reports the interval.
- After the plan exists, the remaining cost is the open tasks times the typical task cost plus the later stages, less what the running stage already spent. The burn rate is tokens per active minute, and the forecast names the stage where the budget runs out at the typical cost and at the high end.
- The range shown at creation is kept as `estimates/start.json`. A completed run shows it next to the actual usage.

### Context compaction

Every model step resends the whole conversation, so a stage that reads many files pays for each old file again on every later step. The step budget of an agent attempt (`maxAttemptTokens`, see [step-budget](../../src/core/workflows/step-budget.ts)) replaces older large results of `read`, `navigate`, `bake_find` and `bake_impact` with short stubs that keep every evidence ID; the last three tool results stay verbatim, and edits and check results are never compacted. Evidence is written by the tools into the run store, so nothing is lost; the model reads a file again if it needs the content.

## Workflow definitions (v2)

Definitions of schema version 2 describe stages, transitions, contracts and gates as data ([design](workflow-v2-design.md)). `baked workflow run --workflow ID` starts a run from `sdd`, a preset or `baked/workflows/ID.json`; the new-run form lists the same IDs. A run validates the definition against the gate library when it starts and freezes the definition and the gates it binds.

- `baked workflow definitions` lists `sdd`, the five presets (`quick-fix`, `standard`, `full`, `spike`, `review-only`) and every `baked/workflows/*.json`, with the stages, whether the workflow changes files and its validation problems.
- `baked workflow validate ID` or `--file FILE` checks a definition against the gate library and exits 1 with the problems. A v1 file is checked by the v1 rules and through the migration to v2.
- `baked workflow define ID --from PRESET` copies a preset or another definition to `baked/workflows/ID.json` as a custom workflow. The copy never carries auto approval; the presets use the project's own checks in their check stages and after each task.
- A run of a v2 definition walks its graph: each stage reports an outcome (`passed`, `failed` for a check stage whose required gate failed, `changes_requested` for review and reflection), and the transition that answers it is taken after its gates pass. `transition.taken` and `gate.finished` events record the walk. A loop edge runs at most `maxIterations` times and the run at most `limits.maxStageVisits` stage visits; either bound stops the run as `no_progress`.
- Quick fix plans from the request alone (the host states it as one requirement), asks for approval and runs the tasks and checks. Spike researches and writes a report (`report.json`, also in `completion.json`); it changes no file and asks for no approval. Review only freezes `git diff HEAD` (or the last commit when the tree is clean) when the run starts and runs the correctness and, for security-sensitive paths, the security reviewer on it; its findings are the result and are not repaired.
- An advisory gate is recorded and never blocks. A command gate with `retries` records every attempt; a pass after a failure is flagged flaky. A human gate on a transition waits for evidence: answer it with `baked workflow evidence RUN_ID --request ID --file FILE --accept --expected-revision N`.
- Auto approval belongs to the definition: an approval stage with `decision: "auto"` and the definition's `autoApproval` limits. Such a run starts only when the user confirms the limits; the refusal names them and the hash to pass (`--confirm-auto-approval HASH`). Inside the limits the host records the approval with the actor `auto-approval` and the digest a person would sign; anything outside them, or an always-human path, waits for a person. A stage with `decision: "human"` never approves on its own, and the project policy's `autoApproval` does not apply to v2 runs. The run overview shows the limits for the life of the run.
- `baked workflow gates` lists the gate library: the built-in review gates, the policy checks, the user's `~/.baked/gates/*.json` and the project's `baked/gates/*.json`, in that order of precedence, with what each gate shadows. A file that does not parse is listed as a problem and never used. Reading the library runs nothing.
- A project gate (`baked/gates/*.json`) runs only after the user confirms it: a run that binds an unconfirmed project gate does not start and names the command `baked workflow gates confirm ID...` (or `--all`). The confirmation stores the gate's hash in `.baked/gate-confirmations.json`, so editing the file asks again; the confirmation message says when the gate replaces a built-in, policy or user gate of the same ID. `baked workflow gates` marks confirmed project gates.
- Workflow agents cannot edit `baked/workflows/`, `baked/gates/`, `baked/agents/`, `baked/skills/` or `baked/constitution.md`; these paths decide what a run may do.

## Worktree execution

A run can execute in its own Git worktree instead of the working copy. Request it with `baked workflow run ... --worktree`, or in a schema 2 definition with `"execution": "worktree"`; the flag overrides the definition, which overrides the policy field `executionMode` (`inline` or `worktree`, default `inline`). The mode is part of the run policy and therefore of the approval digest. An inline run's policy has no `executionMode` field, so its hash and behavior are what they were before execution modes existed.

- Git is required. A workspace that is not the top level of a Git repository with at least one commit is refused when the run starts (`details.reason` `git_required`); it does not fall back to inline execution, because inline execution would write the working copy the user asked to keep untouched. A definition that reviews the working copy's diff (Review only) runs inline only.
- When the run first executes, the runtime records the current HEAD as the baseline and creates the branch `baked/wf/RUN_ID` from it with the worktree `.baked/worktrees/RUN_ID/main` (artifact `worktree/created.json`, `state.worktree`). Hooks do not run during creation. The project's top-level `node_modules` is linked into the worktree (a junction on Windows) so checks can run there. From then on research, spec publication, task edits, snapshots, checks, review and final acceptance all use the worktree; the working copy, its index and HEAD are never changed by the scheduler.
- Uncommitted user changes do not enter the worktree. When approved tasks write a file that has uncommitted changes in the working copy, the approval request lists it under `worktree.userChangesInScope`, auto approval declines, and approving needs the explicit choice to leave those changes out: `baked workflow approve RUN_ID --request ID --digest SHA256 --expected-revision N --exclude-user-changes` (the TUI prompt names the files and `A` makes that choice). To keep the changes instead, reject, commit them and start a new run. The excluded paths are recorded in `state.worktree.excludedUserChanges`.
- The run holds the `execution` lease and the mutation lease of its worktree (`worktree:.baked/worktrees/RUN_ID/main`, migration 004), not the project's `mutation` lease: the user can keep editing the working copy, and ordinary BAKED edits there are allowed during the run. Another run still cannot execute at the same time. A dead owner's worktree lease is taken over or released by the same rules as the v1 leases.
- File effects record their root: an intent with `root` names the worktree path relative to the project; a record without `root` means the project root. Reconcile, recovery, undo and the plan consistency check resolve every effect in its own root and never against another one; an effect whose root no longer exists stays `unknown` and goes to recovery.
- On acceptance, after the acceptance checks pass, the accepted content (the files the run journaled in its worktree and the declared task writes that differ from the approval baseline, without `.baked/`, `.git/`, symbolic links and secret-looking files) is committed on the run branch with the baseline HEAD as parent. The commit is built in a temporary index, so commit hooks do not run; its author is the repository's `user.name`/`user.email` (or `BAKED workflow <workflow@baked.invalid>` when none is set) and its dates are the run's creation time, so the same accepted content always gives the same commit and a crash before the completion is saved rebuilds it. The branch is never moved when someone else moved it (`branch_moved`). `completion.json` and `state.worktree.commit` name the commit.
- The intelligence index is the project's own, used read-only by the worktree's agents; it can be stale for files the run changed. A per-worktree index is an open decision ([design](parallel-worktrees.md#open-decisions)).
- `baked workflow deliver` works for a worktree run: see [Delivery](#delivery). The scheduler never applies the result to the working copy.
- The worktree is removed only for a terminal run: automatically after its delivery completes (the run branch stays as the record of the accepted commit), or by `baked workflow discard-worktree RUN_ID --expected-revision N`, which removes the worktree and deletes the run branch of a completed, failed or cancelled run (artifact `worktree/discarded.json`). A run that is still active must be cancelled first; a delivery step of unknown outcome must be settled first.

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

The new-run form contains the description, the feature ID (derived from the description; Cyrillic text is transliterated), the workflow (`sdd`, the five presets and `baked/workflows/*.json`, with the stages of the chosen one and "no file will change" for a workflow that only reads), the budget `quick`/`standard`/`extended`/`checkpoints` (×0.5/×1/×2 of the configured policy's token, call and time limits; `checkpoints` has no token cap and asks every N tokens), an estimate of the spend labeled as an estimate, the current chat tab's model and the configured checks. Ctrl+S starts from any field. The run executes in the worker in the background; the panel switches to it immediately.

The worker reports new events of its runs to the panel immediately; the panel reads changes from other processes and active time by polling every 150 ms, and a poll without changes does not re-read the view.

The run screen shows what is happening and what can be done, the stage line, budget consumption (tokens used, held by attempts with unknown usage and in flight), a summary of tasks/criteria/checks/findings, the last model, the last recorded error and the event feed. When a budget blocks the run, the panel names the limit and the remaining amount. The action line contains only the keys valid in the current state: R start/resume/retry, P pause (also for a run marked running without a live executor), C cancel with confirmation, B raise the limits of a run blocked on its budget, F fork for blocked and finished runs. Tab/Shift+Tab switch between overview, decision, tasks, changes, spec, plan, checks, criteria and findings. Changes lists the files the run changed according to the effect journal: created/modified/deleted, the number of edits, an unfinished status and a mark when a file was changed outside the run afterwards. ↑/↓ and Enter show the diff of the selected file against Git HEAD; the diff is available only for files in this run's journal. If the file had uncommitted changes in the baseline, the diff includes them and the panel warns about it. Without Git only the facts of the changes are shown: the journal stores hashes, and the pre-images it keeps are used only by undo. Checks shows the latest result of each check: duration, exit code, number of runs, stale evidence and the last 40 output lines of a failing check, as well as configured checks that have not run yet. When a new request appears, the panel opens decision by itself. Approval shows the criteria, the files in scope, the checks and deferred criteria: A accepts the digest, X requires a rejection reason. Clarification shows the current question in full with its answer field right below it, then the references and a compact list of all questions with blocking ones marked; ↑/↓ switch questions without losing answers, Enter saves and moves on, Ctrl+S sends, and sending with an unanswered blocking question asks for a second confirmation. Questions come from research unknowns, spec open questions or analysis findings; each answer is keyed by its question ID and text. For manual evidence, Ctrl+T toggles the verdict. Recovery chooses the outcome with the keys 1..4 and requires a description of the observation. Esc returns to the list. Shift+PageUp/PageDown scrolls the content.

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

## Delivery

A completed run whose verification is `current` can be delivered through Git: one commit of the run's files on a new branch, a push of that branch and a pull request. Every step needs a person's approval of the exact plan; delivery never runs inside auto approval.

```sh
baked workflow deliver RUN_ID [--remote origin] [--branch NAME] [--draft] [--no-pr]
baked workflow approve RUN_ID --request ID --digest SHA256 --expected-revision N
baked workflow deliver RUN_ID --execute --expected-revision N [--request ID]
```

`deliver` prepares a plan and changes nothing in Git. It is stored as the immutable artifact `delivery/PLAN_ID/plan.json` with the reviewable diff in `delivery/PLAN_ID/diff.patch`, and a pending request of kind `delivery` carries the plan's digest. The plan names the operations (`commit`, `push`, `pull_request`), the remote and its URL, the branch (default `baked/FEATURE-` followed by the first 8 characters of the run ID), the base commit and branch (the current HEAD), the commit author, every file with its action, content hash and mode, the excluded files with a reason, the user's other uncommitted changes, the commit message, the pull request title, body, base and draft flag, and the check, criterion and review results. The command prints the `approve` command for that digest. A new `deliver` supersedes an older pending plan. Approving or rejecting a delivery request does not change the run's status; the run stays `completed`.

Which files are delivered: the files of the run's effect journal (task edits and published spec artifacts) and the files that changed between the approval baseline snapshot and the final snapshot inside the tasks' declared writes. Other files in the workspace are never committed; they are listed under `userChanges` and left as they are. Excluded and reported: anything under `.baked/` or `.git/`, symbolic links, files ignored by Git, files with no net change from HEAD, and files that look like secrets (`.env*`, `.envrc`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`, `credentials.json`, SSH keys, `*.pem`, `*.key`, `*.crt`, `*.cer`, `*.der`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`, `*.asc`, `*.gpg`, `*.ovpn`, or content with a private key header).

Preparation refuses, with `details.reason` in the error:

| Reason | Cause |
| --- | --- |
| `git_required` | The workspace is not a Git repository, or not its top level. Delivery needs Git; a filesystem-only project keeps its changes in place |
| `run_not_completed`, `verification_not_current` | Only a completed and currently verified result is delivered |
| `dirty_files` | A delivered file differs from the run's verified snapshot |
| `base_mismatch` | A delivered file had uncommitted user changes before the run, or a commit since the run started changed it; the run's changes cannot be separated, so commit or revert those changes by hand |
| `missing_remote`, `remote_unreachable`, `missing_auth` | The remote is not configured, cannot be read, or credentials (Git or the pull request token) are missing |
| `branch_exists` | The branch exists locally or on the remote; delivery never overwrites a branch |
| `detached_head`, `no_commits`, `missing_identity` | No base branch, no base commit, or no `user.name`/`user.email` |
| `nothing_to_deliver` | Every changed file was excluded |
| `worktree_missing`, `branch_moved` | A worktree run's worktree was removed, or its run branch no longer points at the accepted commit |

A HEAD that moved since the run's baseline is accepted when the new commits do not touch the delivered files; the plan records `headMoved`.

A run executed in a worktree is delivered from its run branch: the files are read in its worktree, which must still exist and hold the branch at the accepted commit (`worktree_missing`, `branch_moved` otherwise), and the plan records them under `worktree` (path, branch, commit). The delivery commit is still built on the working copy's current HEAD in a temporary index, so the user's checkout is not touched; the user's own uncommitted changes are listed under `userChanges`. After the delivery completes the worktree is removed; the branch `baked/wf/RUN_ID` stays.

`deliver --execute` performs the latest approved plan (or `--request ID`). It refuses a plan approved by anyone but a person, a plan whose artifact no longer matches its digest, a changed remote URL, HEAD moved since the plan (`head_moved`) and files changed since the plan (`dirty_files`). The commit is built in a temporary index from the approved content; the user's checkout, index, HEAD and files are not touched, and the new branch is created only if it does not exist. The author and committer date is the plan's time, so the same plan always produces the same commit ID. Commit hooks do not run because no checkout is used; the push runs the local `pre-push` hook and the remote's hooks. The push names the branch without `+`, so Git only creates or fast-forwards it. Delivery never force-pushes, merges, resets, rebases or deletes anything.

Every operation is a `delivery` effect in the run's journal with its plan ID, branch and commit. A failure Git or the host reports for certain (non-fast-forward, hook rejection, authentication, unreachable remote, HTTP 401/403) marks the effect `failed` and stops with that reason; the next `--execute` retries only the failed step. When the outcome is not known (a crash, a dropped connection, a lost API response), the runtime checks before doing anything again: the local branch for the commit, `git ls-remote` for the push, the pull request by head branch for the pull request. A found result is recorded as `reconciled`; a confirmed absence as `failed`, which allows a retry. If the check itself cannot be answered, the effect stays `unknown` and a `recovery` request is created, as for v1 commands; it is answered with `recover` (`record-applied`, `record-not-applied`, `retry`, or `cancel`, which abandons the delivery). A later `--execute` that can check the remote settles the effect itself and supersedes the request. When everything is done, `delivery/PLAN_ID/result.json` links the commit ID, the branch, the remote and the pull request URL to the run, its revision at planning, the accepted snapshot and the approval root. Executing a delivered plan again returns that result and creates nothing.

Pull requests use the GitHub REST API. The token is read from the environment variable named in the configuration (default `GITHUB_TOKEN`) and sent only to the configured API URL; github.com remotes map to `https://api.github.com`, other API URLs (GitHub Enterprise) serve remotes on their own host. Other hosts are delivered with `--no-pr` (commit and push only).

```json
{ "workflows": { "delivery": { "tokenEnv": "GITHUB_TOKEN", "apiUrl": "https://api.github.com" } } }
```

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

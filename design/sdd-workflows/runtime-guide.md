# SDD runtime: running and operations

The runtime is available through `baked workflow` and `/workflow` in the TUI. It is off by default. The release gate status is in the [report](implementation-status.md). Bun is required; SQLite and the existing BAKED providers are used. No separate server or daemon is needed; `baked serve` optionally exposes the same commands to local clients ([Local API](#local-api-baked-serve)).

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

`revise` leaves the run paused. `revise ... --resume [--events]` resumes and drives it in the same command, with the exit codes of `resume`.

Candidate fields are optional: missing ones are taken from the current package. The plan must contain Context, Decisions, Components, Data, Verification and Risks; DEC-001 and references to requirements. A candidate explicitly accepts the current instructions and configuration hashes. A changed skill requires a new profile/run. Profile versions inside an existing run stay frozen; a v2 definition changes only through a definition revision (see [Workflow definitions](#workflow-definitions-v2)). A repeated analyze and approval are mandatory; with `autoApproval.renewal` the host may give that approval (see below).

The terminal states completed/cancelled/failed are immutable; `fork RUN_ID --expected-revision N` creates a new run with the parent's artifacts, a new approval and no passing evidence. It does not start the model before resume. There is no automatic rollback of user changes.

### The run's own edits and undo

A run keeps the edits it executed. A revision, a failed or interrupted task attempt and a fork leave the files as they are, and the runtime recognises content the run itself wrote by the effect journal:

- Plan consistency and the implementer accept a `create` target that exists only because this run, or the run it was forked from, created it and nothing changed it since. Any other existing file is still a conflict ("already exists; use modify").
- The workspace check before each stage accepts a file that differs from the last snapshot when it holds exactly what the run's last journaled write produced, and records it in the expected baseline. Pausing or interrupting a task no longer blocks the resume with "Sources changed outside the active task"; a change by anyone else still does.
- A package revision implements again only the tasks it changed. When the spec, plan and project instructions are unchanged, no task's write scope changed and the revision is not a definition revision, an implemented task whose definition is unchanged keeps its implementation, unless it depends on a task that is implemented again or shares a file with one. Its evidence is invalidated like all other evidence: after the new approval the implementation stage runs its task checks again without calling the implementer, and the check stage reruns every check on the current snapshot. A policy-only revision, such as a changed check command, therefore reruns the checks and implements nothing.
- A repeated task receives the paths that still contain its earlier attempt's edits (`earlierEdits` in its input) and must read them before editing. Those edits count as the task's changes, so a repeated attempt that finds the work already done does not fail with "did not complete its implementation".

Undo is an explicit command:

```sh
baked workflow undo RUN_ID --expected-revision N [--path PATH]
```

It restores the files changed by the run's uncommitted task edits: edits of a task that has no snapshot because its attempt failed or was interrupted, a revision invalidated it or dropped it, or the run was cancelled. A task's edits are committed when the runtime snapshots them after the task; to undo implemented work, apply a revision that changes the task first (a task the revision keeps stays committed). Before each task edit the runtime stores the file's previous content as a `pre-image` artifact. Undo restores a file only while it still holds exactly what the run wrote last, and never overwrites a later change by a person or another tool. Before replacing a file, it keeps the run's version as a `rolled-back` artifact. Each restore is a journaled `file_patch` effect with the tool `rollback`, and the outcome is an immutable `workspace-rollback` artifact that lists restored files and the files left in place with the reason. The command prints that report. Files restored or left in place are settled and are not reported again; a file whose restore failed, or whose edit has an unknown outcome, is retried by the next undo. The expected baseline follows each restored path, so the next resume does not treat the restore as an outside change. The run must not be running: undo takes the run's execution and mutation leases.

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
# or both in one command, with the exit codes of resume:
baked workflow extend RUN_ID --expected-revision N --tokens N --resume [--events]
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
- A started run keeps the definition it was frozen with; editing `baked/workflows/ID.json` or a bound gate file stops it with `input_changed` at the next boundary. To move the run to the edited definition, revise it (V2-11):

  ```sh
  baked workflow candidate RUN_ID --workflow baked/workflows/ID.json [--confirm-auto-approval HASH]
  baked workflow revise RUN_ID --candidate CANDIDATE_HASH --expected-revision N
  baked workflow resume RUN_ID --expected-revision NEW_N
  ```

  The candidate is checked like a run start (schema, validator with the approval invariant, gate library, first-use confirmation of project gates, the profiles frozen in the run) and against the run's history. It is refused with every reason when the workflow ID or its inputs change, the current stage or a completed stage is missing or changes its type or contract, the run's stage visits already exceed the new `maxStageVisits`, or a stage the run can still reach consumes a contract that neither the run holds nor every path to that stage produces. New or changed auto-approval limits need `--confirm-auto-approval`, as at start; unchanged limits were confirmed at start. The execution mode cannot change. `revise` supersedes pending requests, stores the new definition, freezes its gates again, records `definition-revisions/COMMAND_ID.json` (the previous definition and both hashes, `approvedBy: "user"`) and clears the approval. A run that already has a spec, plan and task package restarts at the analysis stage, or the first approval, so the plan is approved again; a run without a package continues at its current stage under the new graph. A run of a schema 1 workflow keeps its definition; fork it or start a new run.

### Workflow editor

`/workflow edit ID` opens the editor window for a definition; E on the workflow field of the new-run form opens it for the chosen workflow, and Esc returns to the form. It edits definition files only and never a started run: a started run keeps the frozen copy it began with, and the window says so.

- Three panes: the stages (type glyph, `(writes)` for the stage that changes files), the gate lists of the selected stage (its own gates for a check or review stage, then its outgoing transitions with outcome, target, loop bound and gate count) and the ordered gates of the selected list with their effective mode (`*` marks a mode set by this workflow). Tab and Shift+Tab switch panes, ↑/↓ select. Below 90 columns the panes become one list with a pane switcher that also shows the problem count.
- A opens the gate picker for the selected list: a search over ID, type and description, and one line per gate with type, default mode, scope, timeout and source (`project, unconfirmed` for a project gate nobody confirmed yet). Gates that cannot be bound there are listed as disabled with the reason: an AI review gate on a transition, a task gate after a stage that is not `tasks`, a non-command gate in a check stage, a non-review gate in a review stage, a task gate in a stage, a gate already in the list, or a thirteenth gate on a transition.
- In the gates pane J and K move the selected gate down and up, M toggles required and advisory for this workflow only (the override is stored only when it differs from the gate's default; an AI walk-through stays advisory) and D removes the binding. In the transitions pane D removes the selected transition.
- N adds a transition from the selected stage: target stage or `done`, an outcome the stage type can report and an optional loop bound (1 to 5); it carries the contract the stage produces. E edits the stage options: the profile of an agent or reflection stage (only profiles that return the stage's contract), the decision (`human` or `auto`) and `covers` of an approval stage, and the bound of each loop leaving the stage.
- The strip below the panes shows the problems of the working copy after every change, from the schema and from the validator a run start uses, each attached to its stage or transition, and the spend estimate of the whole definition. The estimate prices the earlier runs that started from the same workflow ID (model stages by stage ID, tasks as task price times task count, check and approval stages at zero); without such runs it says "none yet", and while workflows are off it says "not available", because the history comes from the workflow worker.
- Ctrl+S with problems refuses and lists them by stage and transition. Without problems it shows the diff against the saved file and the effective gates; Enter writes `baked/workflows/ID.json` through a temp file and a rename. Ctrl+S on an unchanged definition writes nothing.
- `sdd`, the presets and schema 1 files open read only. C duplicates one as `ID-custom` (then `ID-custom-2` and so on), with preset `custom`, version 1.0.0, human approvals and no auto approval, like `baked workflow define`.
- Switching an approval stage to `auto` adds the default limits of the design (3 tasks, 5 files, `src/**` and `tests/**`, no deletions, no new dependencies, 200,000 tokens); switching the last one back to `human` removes them. When a save writes auto approval limits that the file does not already hold, the review names the limits and the save waits until the first 12 characters of the limits hash (`--confirm-auto-approval` takes the whole hash) are typed. A run of the definition still asks for its own confirmation when it starts.
- Esc with unsaved changes asks before discarding them.

### AI acceptance gates

An `ai-acceptance` gate ([design, section 9](workflow-v2-design.md#9-the-ai-acceptance-gate), [example](examples/v2/gates/cli-walkthrough.json)) is bound on a transition and is always advisory. When the transition is taken, after its required gates, the host runs it on the current snapshot:

1. **Walk.** The `acceptance-walker` profile gets only the host tools `app_start`, `app_stop`, `record_step` and the tools of the gate's driver: `terminal_send` and `terminal_read` for `terminal`, or `browser_open`, `browser_snapshot`, `browser_click`, `browser_type` and `browser_key` for `browser` (see [Browser driver](#browser-driver)); no shell, file or web tool. `app_start` runs the declared `start` command as one argv without a shell, in a process group the run owns, with the safe environment plus `start.envNames` (and `PORT`/`BAKED_ACCEPTANCE_PORTS` when ports are granted), and waits for `readyWhen.logIncludes` (or a loopback `readyWhen.url`). The application talks through pipes, not a pseudo-terminal. `record_step` stores the action, the observation, the expectations it concerns (`E1`, `E2`, ... in scenario order) and the last 40 terminal lines as the artifact `acceptance/<gate>/<attempt>/steps/S<n>.json`. For the browser driver the step stores the page snapshot instead of the terminal lines, the page URL, the requests the proxy refused since the previous step and the last 40 lines of the application's output. The model returns a verdict per expectation with the step IDs that show it; the host accepts only steps this attempt stored. The application's process group is stopped when the walk ends or `timeoutMs` passes.
2. **Draft.** The `acceptance-writer` profile can read the workspace and write exactly one file through `write_test`, at `promote.testPath`. It returns the assertion (`A1`, ...) that checks each expectation. A failing assertion prints `ASSERTION FAILED: A<n>` and exits non-zero. A file named like a Bun test (`*.test.ts`) runs as `bun test PATH`, any other file as `bun PATH`. Tests that refer to `.baked`, `.git`, `baked/workflows|gates|agents` or start a shell are refused before they run.
3. **Verify.** The host runs the test `promote.stableRuns` times without a model. After a passed walk every run must pass; after a failed walk every run must fail on an assertion mapped to a failed expectation. A wrong or flaky test goes back to the writer at most twice; then the gate ends `unstable`. The test file is removed from the workspace (or restored) afterwards and kept as an artifact.
4. **Accept.** A stable test becomes an `approval` request whose body has an `acceptance` section: the scenario, the verdicts with their steps, the mapping, the test text and hash. It does not stop the run, and it can be decided while the run waits, is paused or after it completed: `baked workflow approve RUN_ID --request ID --digest SHA256 --expected-revision N` or `reject ... --reason TEXT`; in the TUI the decision tab shows the test (A accepts, X rejects).
5. **Promote.** Accepting writes the test at its path and `baked/gates/<promote.commandGateId>.json`: a required command gate with `provenance` (source gate, test path and SHA-256, `approvedBy: "human"`, approval time). The gate's current hash is recorded in `.baked/gate-confirmations.json`, so the person's acceptance is also its first-use confirmation. Bind it in a check stage or on a transition like any command gate. Promotion is refused while a run executes in the workspace, when the test path changed since the walk, or when another gate with that ID exists.

A command gate with `provenance` runs only while its test file has the pinned hash; otherwise it fails without running, with the reason `test modified since approval`.

What the gate records: `acceptance.phase` events (`walking`, `walked`, `drafting`, `verifying`, `awaiting_approval`, `promoted`, `discarded`, `inconclusive`, `unstable`, `skipped`), `gate.finished` with mode `advisory` and the walk verdict (`passed`, `failed`, `inconclusive`, `skipped`), and the lifecycle in the run state under `acceptance`. A run that reaches the gate again on the same snapshot reuses the result; a new snapshot walks again and supersedes an undecided test.

Capabilities are denied unless the gate grants them, and the granted ones are listed in the plan approval as `acceptanceCapabilities`; the frozen gate is part of the approval digest. Enforcement:

| Capability | Enforced by |
| --- | --- |
| `spawnApp` | Without it the walk does not run (`inconclusive`) and `app_start` refuses. Only the declared command can start |
| `writePaths` | Source manifests before and after the walk and each test run; a change outside the granted directories is a violation (`inconclusive` for the walk, a rewrite for a test). Git-ignored files are not in the manifest and are not checked. The granted directories are left out of the run's snapshots |
| `listenPorts` | On Linux the listening TCP sockets of the process tree (`/proc/net/tcp`, `/proc/net/tcp6`, `/proc/<pid>/fd`) are compared with the grant every 200 ms; a port outside the list or a listener beyond loopback stops the application. Not enforced on macOS and Windows |
| `outboundHosts` | Browser driver only: every request of the browser goes through the filtering proxy (below), which allows exact host names from the list and loopback on the `listenPorts`, and answers anything else with 403. Refusals are recorded and do not end the walk. The application process itself is not filtered and can still open outbound connections the host does not see; the terminal driver does not filter anything |

BAKED has no operating system sandbox; run the gate in a container or a network namespace when that matters.

#### Browser driver

A gate with `"driver": "browser"` walks the scenario in a headless Chromium driven through Playwright.

- **Dependency.** BAKED does not depend on Playwright and never installs it or downloads a browser. It loads `playwright` or `playwright-core` with a dynamic import, resolved from the workspace first and then from BAKED's own installation. The browser is `BAKED_BROWSER_EXECUTABLE` when set, otherwise the Chromium Playwright reports (it honours `PLAYWRIGHT_BROWSERS_PATH`). When either is missing the gate ends `inconclusive` before any model call, with a reason that starts with `missing dependency:` (install with `bun add -d playwright` and `bunx playwright install chromium`).
- **Grants.** `spawnApp` starts the application as for the terminal driver; without it the browser can still open `outboundHosts`. A gate with neither does not run (`inconclusive`).
- **Tools.** `browser_open` takes an absolute `http`/`https` URL or a path such as `/login`, resolved against `readyWhen.url`, else `http://127.0.0.1:<first listen port>/`, else `https://<first outbound host>/`; other schemes are refused. `browser_click`, `browser_type` (fills an input; `submit` presses Enter) and `browser_key` take a Playwright selector (`text=Save`, `role=button[name="Save"]`, `#id`). Every browser tool returns the URL, the title, the accessibility snapshot of the page (its visible text on Playwright versions without `ariaSnapshot`), at most 12,000 characters, and the requests refused since the previous tool result. An action times out after 30 seconds or the gate's `timeoutMs`, whichever is shorter.
- **Filtering proxy.** A forward proxy on `127.0.0.1` with an ephemeral port, started with the browser and stopped with the walk. It serves plain HTTP requests (one request per connection, absolute `http://` URL, no chunked request bodies) and `CONNECT` tunnels. A host is allowed when it equals an entry of `outboundHosts` (case and a trailing dot ignored, no wildcards) on any port, or when it is loopback (`localhost`, `127.0.0.0/8`, `::1`) on a port in `listenPorts`. Chromium is launched with `--proxy-bypass-list=<-loopback>`, so loopback requests are filtered too, and with WebRTC limited to proxied UDP and QUIC disabled. The walk artifact `walk.json` has `network.allowed` (host and port pairs) and `network.refused` (method, host, port, time and reason of every refusal).
- **Draft and verification.** The writer gets the steps with their snapshots and URLs and the launch options to use. During verification the host starts a new filtering proxy for each test run and passes its URL as `BAKED_ACCEPTANCE_PROXY` (and removes `NO_PROXY`/`no_proxy` from the test's environment); refusals during a run are listed in the run's `refused`. The test runs like any generated test (`bun test PATH` for `*.test.ts`, otherwise `bun PATH`), not through the Playwright test runner, and imports Playwright from the project. As a promoted command gate it runs without a proxy and without `BAKED_ACCEPTANCE_PROXY`, so `outboundHosts` is not enforced there.

## Worktree execution

A run can execute in its own Git worktree instead of the working copy. Request it with `baked workflow run ... --worktree`, or in a schema 2 definition with `"execution": "worktree"`; the flag overrides the definition, which overrides the policy field `executionMode` (`inline` or `worktree`, default `inline`). The mode is part of the run policy and therefore of the approval digest. An inline run's policy has no `executionMode` field, so its hash and behavior are what they were before execution modes existed.

- Git is required. A workspace that is not the top level of a Git repository with at least one commit is refused when the run starts (`details.reason` `git_required`); it does not fall back to inline execution, because inline execution would write the working copy the user asked to keep untouched. A definition that reviews the working copy's diff (Review only) runs inline only.
- When the run first executes, the runtime records the current HEAD as the baseline and creates the branch `baked/wf/RUN_ID` from it with the worktree `.baked/worktrees/RUN_ID/main` (artifact `worktree/created.json`, `state.worktree`). Hooks do not run during creation. The project's top-level `node_modules` is linked into the worktree (a junction on Windows) so checks can run there. From then on research, spec publication, task edits, snapshots, checks, review and final acceptance all use the worktree; the working copy, its index and HEAD are never changed by the scheduler.
- Uncommitted user changes do not enter the worktree. When approved tasks write a file that has uncommitted changes in the working copy, the approval request lists it under `worktree.userChangesInScope`, auto approval declines, and approving needs the explicit choice to leave those changes out: `baked workflow approve RUN_ID --request ID --digest SHA256 --expected-revision N --exclude-user-changes` (the TUI prompt names the files and `A` makes that choice). To keep the changes instead, reject, commit them and start a new run. The excluded paths are recorded in `state.worktree.excludedUserChanges`.
- The run holds the `execution` lease and the mutation lease of its worktree (`worktree:.baked/worktrees/RUN_ID/main`, migration 005), not the project's `mutation` lease: the user can keep editing the working copy, and ordinary BAKED edits there are allowed during the run. Another run still cannot execute at the same time. A dead owner's worktree lease is taken over or released by the same rules as the v1 leases.
- File effects record their root: an intent with `root` names the worktree path relative to the project; a record without `root` means the project root. Reconcile, recovery, undo and the plan consistency check resolve every effect in its own root and never against another one; an effect whose root no longer exists stays `unknown` and goes to recovery.
- On acceptance, after the acceptance checks pass, the accepted content (the files the run journaled in its worktree and the declared task writes that differ from the approval baseline, without `.baked/`, `.git/`, symbolic links and secret-looking files) is committed on the run branch with the baseline HEAD as parent. The commit is built in a temporary index, so commit hooks do not run; its author is the repository's `user.name`/`user.email` (or `BAKED workflow <workflow@baked.invalid>` when none is set) and its dates are the run's creation time, so the same accepted content always gives the same commit and a crash before the completion is saved rebuilds it. The branch is never moved when someone else moved it (`branch_moved`). `completion.json` and `state.worktree.commit` name the commit.
- The intelligence index is the project's own, used read-only by the worktree's agents; it can be stale for files the run changed. A per-worktree index is an open decision ([design](parallel-worktrees.md#open-decisions)).
- `baked workflow deliver` works for a worktree run: see [Delivery](#delivery). The scheduler never applies the result to the working copy.
- The worktree is removed only for a terminal run: automatically after its delivery completes (the run branch stays as the record of the accepted commit), or by `baked workflow discard-worktree RUN_ID --expected-revision N`, which removes the worktree and deletes the run branch of a completed, failed or cancelled run (artifact `worktree/discarded.json`). A run that is still active must be cancelled first; a delivery step of unknown outcome must be settled first.

### Several writers

A worktree run can implement independent tasks at the same time: `baked workflow run ... --worktree --writers N`, or the policy field `maxConcurrentWriters` (1..4, default 1). A value above 1 needs worktree execution; an inline run with more than one writer, or with `allowOverlappingWrites`, is refused at start. Both fields are part of the run policy, so the approval digest covers them. A policy with one writer is exactly the policy of a phase 1 worktree run (the field was already stored as 1), and `allowOverlappingWrites` is stored only when it is `true`, so stored runs keep their policy hash. With one writer the run behaves as described above.

- **Batches.** The tasks stage takes the ready tasks in graph order and forms a batch of up to N tasks that are pairwise disjoint by their written paths and by the directories their creates would bring into existence; an overlapping task moves to a later batch. Each batch is recorded as an artifact `tasks/batches/ID.json` (`tasks`, `deferredByOverlap`, `deferredByBudget`, `base`). A task without writes, and a task implemented before an interruption whose task checks did not finish, are handled one at a time in the run worktree as with one writer.
- **Budget.** The agent attempts of the whole batch are reserved before any task starts. When the remaining tokens, calls or the next soft checkpoint do not cover every task, the batch shrinks to the tasks that fit; its first task is always tried, so a run without budget for even one stops on its budget as with one writer.
- **Task worktrees.** The run worktree's current content (tracked and untracked files that are not ignored, without `.baked/` and `node_modules`) is captured as a commit that no ref points to, and each task of the batch gets the worktree `.baked/worktrees/RUN_ID/TASK_ID`, detached at that commit, with the project's `node_modules` linked as for the run worktree. The task's agent reads, edits and runs its task checks there; its file effects and check commands record that worktree as their root. At most two task checks run at the same time across the batch.
- **Concurrency.** The tasks of a batch run as concurrent asynchronous workers inside the scheduler's own thread, not in separate worker threads: every workflow tool already receives absolute paths under the task's root (`ExecutionRequest.root`), and SQLite writes stay in one connection and one thread.
- **Leases.** The run keeps its `execution` lease and the run worktree's lease. Each task worktree has its own lease `worktree:.baked/worktrees/RUN_ID/TASK_ID` with its own fencing epoch. Losing it (another owner took it over, or the task's worker failed without a result) moves only that task to `interrupted`; the other tasks of the batch finish and are integrated, later batches that do not need the task still run, and then the run stops `blocked` with reason `owner_lost`. `resume` implements the interrupted task again in a fresh worktree. Migration 006 adds the `interrupted` task status.
- **Integration.** After the batch, its results are integrated into the run worktree one at a time in graph order. A changed file is written there as a journaled file effect (`tool: integrate`, with the pre-image kept for undo) while the run worktree still holds the content the task started from. A change outside the task's `writes` rejects that task's result: nothing of it is integrated, the task is `blocked` and the run stops with `input_changed` after the other results of the batch are integrated. The task is then implemented on a new snapshot (`tasks/TASK_ID/diff.json` names its worktree and the integrated hashes) and settled with the task check results from its worktree. Feature checks, review and convergence run at their usual stages on the run worktree. The task worktree is removed after integration unless an effect in it is still unsettled.
- **Conflicts.** A file that the run worktree changed after the task started (another task of the batch was integrated first) is a conflict. An integrator task resolves it: an implementer call in the run worktree whose write scope is only the conflicting files, with the base, integrated and task versions of each file, both unified diffs against the base, the spec and the definitions of the tasks that write those files. It must not change other files. Its record is `tasks/TASK_ID/integration.json`; the task checks run again on the integrated result, and the run continues through checks, review and convergence with their usual bounded correction.
- **Overlapping writes.** Independent tasks that write the same path are refused at plan validation unless the policy sets `allowOverlappingWrites: true`. Then such tasks may share a batch, and the later one in graph order is integrated through the integrator.
- The scheduler never writes the user's working copy; the accepted result is committed on the run branch as with one writer.

## Pause, crash and recovery

A workspace has one scheduler and one writing run (which may run several task writers in its own worktrees, see [several writers](#several-writers)). Ordinary BAKED mutations use the same mutex; read-only tools stay available. An external editor is not governed by the lease, so content hashes are compared before and after checks and before acceptance. The Git baseline records HEAD, tracked files and the initial user changes; filesystem-only workspaces are supported too.

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

`/workflow` without arguments opens the panel with the project's run list. Runs waiting for a user decision come first, then active runs, then finished ones. ↑/↓ select a run, Enter opens it, N opens the new-run form, I opens the [initiatives](#initiatives-in-the-tui), G the gates window and Esc closes the panel. `/workflow new TEXT` opens the form with the description filled in. `/workflow edit ID` opens the [workflow editor](#workflow-editor). `/workflow help` prints the full command list; the other CLI commands (`run`, `status`, `approve`, `recover` and so on) are still accepted, and their result is printed in the chat as a short text.

If workflows are off in the project, the panel shows what will be written, and E enables them: a `workflows` block with the default policy and checks found in the `package.json` scripts (`typecheck`, `lint`, `test`) for the project's runner is added to `.baked/config.json`. An existing block only gets `enabled: true`. While the project is off, the panel starts no worker and creates no database.

The new-run form contains the description, the feature ID (derived from the description; Cyrillic text is transliterated), the workflow (`sdd`, the five presets and `baked/workflows/*.json`, with the stages of the chosen one and "no file will change" for a workflow that only reads), the budget `quick`/`standard`/`extended`/`checkpoints` (×0.5/×1/×2 of the configured policy's token, call and time limits; `checkpoints` has no token cap and asks every N tokens), an estimate of the spend labeled as an estimate, the execution mode, the writer count, the current chat tab's model and the configured checks. Ctrl+S starts from any field.

Mode (←/→ or Space) switches between `inline` (the run edits the working copy) and `worktree` ([worktree execution](#worktree-execution)); it starts at the chosen workflow's own `execution`, otherwise the policy's `executionMode`, and switching the workflow resets it. Writers (←/→, 1..4) is available only in worktree mode and is skipped by Tab otherwise; it starts at the policy's `maxConcurrentWriters`. The form sends exactly what `baked workflow run --worktree --writers N` sends: worktree mode sends the mode and the writer count, inline mode sends only the mode, so the policy's writer count applies and the core refuses a policy with more than one writer for an inline run. A definition that refuses worktree execution (review only, whose input is the working copy's diff) shows the core's refusal on the Mode line and below the form, and the run does not start until Mode is back to inline. Other refusals (no Git repository, a policy problem) come from the core when the run starts and are shown under the form. The run executes in the worker in the background; the panel switches to it immediately.

The worker reports new events of its runs to the panel immediately; the panel reads changes from other processes and active time by polling every 150 ms, and a poll without changes does not re-read the view.

The run screen shows what is happening and what can be done, the stage line, budget consumption (tokens used, held by attempts with unknown usage and in flight), a summary of tasks/criteria/checks/findings, the last model, the last recorded error and the event feed. When a budget blocks the run, the panel names the limit and the remaining amount. The action line contains only the keys valid in the current state: R start/resume/retry, P pause (also for a run marked running without a live executor), C cancel with confirmation, B raise the limits of a run blocked on its budget, F fork for blocked and finished runs. Tab/Shift+Tab switch between overview, decision, tasks, changes, spec, plan, checks, criteria and findings. Changes lists the files the run changed according to the effect journal: created/modified/deleted, the number of edits, an unfinished status and a mark when a file was changed outside the run afterwards. ↑/↓ and Enter show the diff of the selected file against Git HEAD; the diff is available only for files in this run's journal. If the file had uncommitted changes in the baseline, the diff includes them and the panel warns about it. Without Git only the facts of the changes are shown: the journal stores hashes, and the pre-images it keeps are used only by undo. Checks shows the latest result of each check: duration, exit code, number of runs, stale evidence and the last 40 output lines of a failing check, as well as configured checks that have not run yet. When a new request appears, the panel opens decision by itself. Approval shows the criteria, the files in scope, the checks and deferred criteria: A accepts the digest, X requires a rejection reason. Clarification shows the current question in full with its answer field right below it, then the references and a compact list of all questions with blocking ones marked; ↑/↓ switch questions without losing answers, Enter saves and moves on, Ctrl+S sends, and sending with an unanswered blocking question asks for a second confirmation. Questions come from research unknowns, spec open questions or analysis findings; each answer is keyed by its question ID and text. For manual evidence, Ctrl+T toggles the verdict. Recovery chooses the outcome with the keys 1..4 and requires a description of the observation. Esc returns to the list. Shift+PageUp/PageDown scrolls the content.

While the panel is closed, a line for the selected run is shown above the footer: stage and tokens, a pending decision or the outcome. The indicator polls only an already open worker and disappears after the outcome has been seen in the panel.

A new `/workflow run` uses the current chat tab's model selected through Ctrl+L, even if the worker was opened before the model was selected. An explicit `--model provider/model` sets the model for that run only and takes precedence over the chat selection. The CLI without `--model` uses the configured defaultModel. The models of existing runs are frozen in their profiles; switching the model in the chat does not change them on resume.

Closing the panel keeps the run in the current application process. Pause the run before closing its chat tab. Shutdown stops the workflow before shared resources are released. Session restore restores the run ID and observation; the model is not started automatically.

### Initiatives in the TUI

I on the run list opens the project's [initiatives](#initiatives). Each row shows the initiative ID, its status, accepted mandatory features of all mandatory features, open decisions and blockers, and shared tokens used of the limit; initiatives that need a person (a decision, a blocker or a pause) come first, finished ones last. ↑/↓ and Enter open one; Esc returns to the run list.

The detail shows the title, the current plan revision and whether it is approved, the feature workflow, the shared budget (tokens, calls and active time used of the limits), the next action in words, a pending split approval with its plan revision and digest prefix, the initiative's blockers, and the features in dependency order with their state, run status, run ID and upstream features. The selected feature also shows its contract and either its pending decision or its blockers. Enter opens the selected feature's run in the run screen, O opens the decompose run, and Esc on that run returns to the initiative.

The keys follow the commands the core accepts in the current state: A approves the pending split (after a Y/N confirmation; it is bound to the revision and digest on screen, so a changed split is refused with the core's message), P pauses an active or decomposing initiative, R resumes a paused one, C continues (`drive`) an active or decomposing initiative that this process is not already driving, and X re-plans the selected feature (after a Y/N confirmation; it supersedes the feature's current run). Approve, resume and continue drive the initiative in the workflow worker in the background, like the CLI commands; the screen refreshes every second, shows "⟳ live" while the worker drives it, and shows the last drive error. Decisions of feature runs are made in the run screen. Editing the split (merge, split, remove, rename), rejecting it with a reason and `extend` stay CLI commands.

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

## Initiatives

An initiative is a large request split into 3 to 12 features, each with a boundary, a contract it provides to other features and the features it depends on. The split is approved once, as a whole; then the initiative runs one ordinary workflow run per feature, one at a time in dependency order, in the same workspace. It is stored next to the runs in `.baked/workflows.sqlite` (migration 004): the initiative, its immutable plan revisions, the split approval requests, the links from features to run IDs, an append-only event log and idempotent commands.

```sh
baked workflow initiative start ID (--prompt TEXT | --prompt-file FILE) [--plan FILE] [--workflow sdd]
baked workflow initiative show ID
baked workflow initiative rename|remove|merge|split ID ... --expected-revision N
baked workflow initiative approve ID --request ID --digest SHA256 --expected-revision N
baked workflow initiative drive ID
baked workflow initiative pause|resume ID --expected-revision N
baked workflow initiative replan ID --feature F --expected-revision N
baked workflow initiative extend ID --expected-revision N [--tokens N] [--calls N] [--time-ms N]
```

Initiative IDs and feature IDs are lower case slugs. A feature's runs use the workflow feature ID `INITIATIVE_FEATURE`, so its accepted spec is `specs/INITIATIVE_FEATURE/spec.json`.

**Split.** Without `--plan`, `start` runs the built-in `initiative-decompose` workflow: one agent stage with the `decomposer` profile, which reads the code and returns an `initiativePlan` (title, goals, completion criteria, and features with `id`, `title`, `boundary.scope`, `boundary.paths`, `contract`, `dependsOn` and `mandatory`). It changes no file. Duplicate IDs, unknown or repeated dependencies and cycles go back to the decomposer for correction. A split of more than 12 features is not corrected: the initiative becomes `refused` with the message to split the request into stages and start one initiative per stage. With `--plan FILE` the split is given by the user and validated the same way, including the bound.

**Approval of the split** is mandatory. Each plan revision has a digest over the initiative ID, the revision number, the plan, the shared budget and the settings fixed at start (feature workflow, base policy hash, tiered approval, model). The pending `split_approval` request names that digest, and `approve` must repeat it. Before approval, `rename` (title only), `remove` (dependents lose the edge), `merge --features A,B` (one feature with the union of boundaries, contracts and external dependencies) and `split --feature F --parts FILE` (dependents depend on every part) each produce a new revision, a new digest and a new request; the older request is superseded. An edit that leaves fewer than 3 features, an unknown ID or a cycle is refused.

**Execution.** `drive` (also run by `start`, `approve` and `resume`) advances the initiative until a person is needed, it is blocked or paused, or it completes. One feature run is open at a time: the runtime guards each run's source snapshot, so a second open run would block the first. A feature starts when every feature it depends on is accepted: its run completed with current verification and its spec is the newest approved spec of that feature. The new run is started with those upstream contract hashes pinned as its spec dependencies (the spec author's own dependencies are replaced), so its readiness uses the existing `contractHash` check. Decisions inside a feature run use the run commands (`baked workflow approve RUN_ID ...`); `show` lists them under `pendingDecisions` with the run and request IDs.

**Tiered approval** (`--tiered-approval [--max-tasks 5] [--max-files 10]`, off by default) gives each feature run auto approval whose allowed paths are the feature's approved `boundary.paths`, without deletes or new dependencies, using the same auto approval check and the actor `auto-approval` as v2 definitions. A plan that writes outside the boundary, or a feature without boundary paths (or with more than 20), goes to a person. It requires a schema 1 feature workflow such as `sdd`; a v2 definition takes auto approval only from the definition, so the combination is refused at start. A v2 feature workflow with its own auto approval is started with `--confirm-auto-approval HASH`, which is passed to every feature run.

**Contract changes.** When an upstream feature is accepted again with a different contract hash (after `replan` or a split re-plan), each dependent whose run is pinned to the old hash becomes `stale`. The next drive cancels its open run if any, marks that run's evidence `input_changed`, and starts a rebased run that keeps the dependent's spec, pins the new upstream hashes and starts again at the plan stage, so the plan is made, analyzed and approved against the new contract. A rebased run never gets auto approval: a person always re-approves it. A dependent that already finished keeps its result on record and is shown `waiting` while the upstream runs again.

**Progress.** `show` returns the status, the next action and its reason, the plan revision and approval digest, and per feature: its state (`proposed`, `waiting`, `ready`, `in_progress`, `needs_decision`, `paused`, `blocked`, `failed`, `stale`, `accepted`), its blockers in words (for example `waits for core's contract (core is waiting for a decision)`), its pinned upstream hashes, its accepted contract hash, its pending decisions and its usage over all its runs. The initiative completes only when every mandatory feature is accepted; `initiative.completed` records each feature's run and contract hash.

**Shared budget.** Set it with `--budget-tokens N --budget-calls N --budget-time-ms N`; otherwise it is the base policy's per-run limits times the number of features plus one. Each feature run starts with an equal share of what remains, rounded down: remaining = limit - (usage of finished runs + the limits of open runs, decompose and superseded runs included), divided by the features of the approved plan without a run. A rebased run takes one more share of the same split. Agent calls per run are capped at 1000. When a share would fall below 1000 tokens, 1 call or 1 second, the initiative is blocked with the budget named; `extend` raises the shared limits (only upward). A feature run that exhausts its own share blocks like any run and is extended with `baked workflow extend RUN_ID`.

**Pause, resume and re-planning.** `pause` stops the initiative and pauses a running feature run; `resume` continues it. While paused, the split can be edited again: approving the new revision keeps every feature whose boundary, contract, dependencies and mandatory flag are unchanged (a rename keeps its run), and supersedes and cancels the runs of removed or changed features, which then run again under the new revision. `replan --feature F` supersedes one feature's current run so the next drive starts it again; other features' results stay. Superseded runs and their artifacts remain linked to the initiative and are not collected by `gc`.

Exit codes of `start`, `approve`, `drive` and `resume`: 0 completed or still progressing, 1 refused or error, 3 waiting for a decision, 4 blocked, 5 revision conflict, 130 paused. The workflow panel lists initiatives and approves, pauses, resumes, continues and re-plans them; see [Initiatives in the TUI](#initiatives-in-the-tui).

## Local API (`baked serve`)

`baked serve` exposes the workflow commands to a desktop app or another local client over HTTP. It is a thin front end over the same code path as `baked workflow` (`src/core/api/server.ts` builds the CLI's `WorkflowArgs` and calls `executeWorkflowCommand`), so validation, the `workflows.enabled` opt-in, approval digests, expected revisions and command idempotency are identical.

```sh
baked serve [--port N] [--token-file FILE] [--allow-origin ORIGIN]... [--cwd DIR]
```

- The server binds `127.0.0.1` only. `--port 0` (the default) picks a free port. When it is ready it prints one JSON line on stdout: `{"url":"http://127.0.0.1:PORT","port":PORT,"tokenFile":"..."}`.
- Each start generates a random 32-byte bearer token (base64url) and writes it to `.baked/serve-PORT.token` in the workspace, or to `--token-file`, with mode 0600 (on Windows the file inherits the directory's ACL). Every request, `/v1/health` included, needs `Authorization: Bearer TOKEN`; the token is compared in constant time.
- The `Host` header must be `127.0.0.1:PORT` or `localhost:PORT`, otherwise the answer is 421 (DNS-rebinding protection). A request with an `Origin` header is refused with 403 unless that exact origin was given with `--allow-origin` (repeatable; `*` and paths are refused). Allowed origins get `Access-Control-Allow-Origin` with that origin and preflight answers; there is no wildcard.
- POST bodies are JSON (`Content-Type: application/json`), at most 1 MiB (413 above), validated with zod; unknown fields are refused.
- SIGINT or SIGTERM stops accepting, closes event streams, aborts active drives through their abort signals like the CLI's Ctrl+C, waits for them and removes the token file. A second signal exits at once with 130.

| Method and path | CLI equivalent | Body or query |
| --- | --- | --- |
| `GET /v1/health` | | returns `apiVersion`, `version`, `workspace` |
| `GET /v1/workflow/definitions` | `definitions` | |
| `GET /v1/workflow/profiles` | `profiles` | |
| `GET /v1/workflow/runs` | `list` | `?feature=&status=&limit=&cursor=` |
| `POST /v1/workflow/runs` | `run` | `commandId`, `feature`, `prompt`, optional `workflow`, `policy` (object), `model`, `owner` (default `API`), `confirmAutoApproval`, `worktree`, `writers` |
| `GET /v1/workflow/runs/RUN_ID` | `status` | snapshot with `requests` |
| `GET /v1/workflow/runs/RUN_ID/usage` | `usage` | |
| `GET /v1/workflow/runs/RUN_ID/artifacts` | `artifacts` | `?file=ARTIFACT_ID` returns `{content}` |
| `POST /v1/workflow/runs/RUN_ID/pause`, `/cancel`, `/resume` | `pause`, `cancel`, `resume` | `commandId`, `expectedRevision` |
| `POST /v1/workflow/runs/RUN_ID/approve` | `approve` | plus `requestId`, `digest`, optional `excludeUserChanges` |
| `POST /v1/workflow/runs/RUN_ID/reject` | `reject` | plus `requestId`, `reason` |
| `POST /v1/workflow/runs/RUN_ID/answer` | `answer` | plus `requestId`, `answers` (object of strings) |
| `POST /v1/workflow/runs/RUN_ID/extend` | `extend` | plus optional `tokens`, `calls`, `timeMs` |
| `GET /v1/workflow/runs/RUN_ID/events` | `--events` | `?after=SEQ`; SSE, or JSON with `Accept: application/json` (`?limit=`, at most 1000) |

Every mutation requires a client-chosen `commandId` (letters, digits, `_` and `-`): a retry with the same ID and body returns the stored result, the same ID with a different body is a conflict. Errors are `{"error":{"code","message"}}` with the workflow fault code: `NOT_FOUND` and `ARTIFACT_MISSING` 404; `INVALID_DEFINITION`, `INVALID_REFERENCE`, `CYCLE_DETECTED` and request validation (`INVALID_REQUEST`) 400; `CAPABILITY_DENIED` 403; `REVISION_CONFLICT`, `COMMAND_CONFLICT`, `STALE_DECISION`, `WORKSPACE_BUSY`, `INPUT_CHANGED` and `RUN_TERMINAL` 409; anything else 500. Messages pass through the export redaction (`redactSecrets`).

`POST /v1/workflow/runs` (202) and `.../resume` (200) answer with the snapshot as soon as the run is driving; the drive continues in the server process, as it would in the foreground CLI, until the run waits for a person, stops, or the server shuts down. Like the CLI, `approve`, `answer` and `reject` only record the decision; the client then calls `resume`. A decision that arrives while a drive of that run is winding down after it stopped waits for that drive to return first.

The event endpoint polls the durable event log by sequence every 250 ms and sends each event as `id: SEQ` and `data: EVENT_JSON`, with a `: keep-alive` comment every 15 s. A reconnecting client sends `Last-Event-ID`, which takes precedence over `?after=`, and receives only later events. The stream stays open (also for waiting and terminal runs, which can still receive acceptance and delivery events) until the client disconnects or the server stops. Browsers' `EventSource` cannot send an `Authorization` header; read the stream with `fetch` instead.

Limitations: event payloads and artifact contents are returned as `baked workflow status`, `--events` and `artifacts` return them, without the export redaction. `evidence`, `recover`, `candidate`, `revise`, `fork`, `undo`, `import`, `export`, `deliver`, `gates` and initiatives are not exposed yet; use the CLI. A run driven by another process (the CLI or the TUI) can be watched through the event endpoint; the workspace leases decide which process may drive a run, as between two CLI processes.

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

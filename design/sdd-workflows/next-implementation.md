# Next workflow implementation

Date: 2026-10-08, updated 2026-10-09. This is a plan of future work, not a completion report. The technical design for sections 2 and 5 is in [workflow-v2-design.md](workflow-v2-design.md); the local implementation of section 1a is recorded in the [status report](implementation-status.md).

The user agreed on the order: finish v1 first, then implement only custom workflows, management of a large initiative and Git delivery of the result. v2 must not start before v1 is closed unless the user changes this decision separately.

User decision of 2026-10-09: the usability work in section 1a may run in parallel with closing v1, because it builds on the existing v1 runtime and does not change its acceptance semantics. The configurable workflow presets, gates on transitions, initiative decomposition and the AI acceptance gate discussed on the same day are added to sections 2, 3 and 5 and stay behind v1 acceptance.

Order of work:

1. Close v1 (section 1); the items waiting for the user are listed there.
2. Usability on v1 (section 1a), in parallel with step 1.
3. Custom workflows with presets, contracts and gates on transitions (section 2).
4. Large initiatives with decomposition (section 3).
5. Git delivery (section 4), then parallel worktrees ([design](parallel-worktrees.md)).
6. AI acceptance gate (section 5).

Source documents: [architecture](solution-design.md), [v1 plan](implementation-plan.md), [current status and evidence](implementation-status.md), [runtime guide](runtime-guide.md). The existing design remains the basis for finishing v1. The v2 details below are a plan for a later technical design.

## 1. Finish v1

Local implementation checks already pass. Full release acceptance remains open. Saved fixture runs do not replace runs with real models or checks on other operating systems.

| Work | What to do | Closing condition |
| --- | --- | --- |
| Real task | Take a small BAKED feature through research, spec, plan, approval, implementation, checks, review and acceptance. Keep the run ID, artifacts and final diff | A real model brought the agreed task to `completed`; the result meets the specification criteria |
| Review by other models | Check the actual provider/model IDs of the implementer and reviewer in a real run. Check findings, the skeptic and fixing of findings | The review is really done by another model; evidence links its result to the current snapshot. An unavailable reviewer gives an explicit state instead of a fake successful review |
| User work in the TUI | Check viewing of Spec, Plan, Tasks, decisions and review; pause, resume, cancel and reopening after the worker ends | Every action reflects the stored state; a new approval is required when scope or policy changes |
| SQLite with the application open on Windows | Reproduce SQLITE_CORRUPT on an external read of the global memory.db while BAKED runs. Check WAL/SHM, locking and the MemoryManager lifecycle. File copies and the original after closing the application are intact, so resetting data is not a justified fix | The TUI, the workflow worker and a separate process open one database consistently; there are no integrity errors or connection leaks. [Observations](../../.audit/workflow-memory-review-sol.md). After tool builds stopped opening extra MemoryManager connections, 4 of 4 timed read-only checks with the app open passed ([evidence](../../.audit/workflow-memory-live-check-after-reuse.json)); confirm again after a longer session with chat and tool use |
| Windows symlinks | Repeat the security suite on a host allowed to create file symlinks with `BAKED_REQUIRE_SYMLINKS=1` | The needed tests run without EPERM skips; scope bypass through symlinks is blocked |
| Linux | Run the full suite and the POSIX process-tree fault tests | No unexplained failures; cancel and recovery leave no processes that could keep writing. Workflow and symlink suites and the process-tree tests pass on Linux after the process-scope fix; the full suite in CI remains |
| Installation | Run the Windows installer smoke test and the macOS packaging smoke test, including the CLI and the workflow worker | The installed build opens a project, starts the worker and reads the stored state |
| Crash and out of space | Close the matrix of OS crashes, orphan descendants and filesystem ENOSPC on Windows and Linux | No false passing evidence and no loss of fencing; unknown effects require reconciliation and are not repeated automatically. Windows: orphan descendants and injected ENOSPC are covered by tests. Linux: orphan descendants that leave the process group and a real full tmpfs volume are covered by tests; a real full volume on Windows remains |
| Final acceptance | Fix the defects found within the design, repeat the affected checks and update the report | Typecheck, lint, build, the full suite and release scenarios are confirmed by current logs; remaining limits are described explicitly |

- [ ] Record the token/call/round/latency baseline of a real run and check stopping on budget.
- [ ] Check approvals, the single writer, protection of user changes, frozen definitions and recovery after interruption.
- [ ] Run an independent review of the result by other available models and close significant findings.
- [ ] Update [implementation-status.md](implementation-status.md) and the [decision journal](../../.audit/sdd-integration-2026-10-08.tsv) with actual evidence.
- [ ] Close the listed release gates and record v1 acceptance before v2 starts. An unavailable OS or a missing provider leaves the corresponding item open.

The current limits stay until a separate decision: a monetary `maxCostUsd` is not supported without verified provider prices, and token/time/call limits apply; checks are not an OS sandbox; unknown tools and arbitrary executable hooks are not enabled by import.

## 1a. Usability on the v1 runtime

These items use the existing stages, checks and policy. They can be delivered while v1 is being closed.

| Work | What to do | Closing condition |
| --- | --- | --- |
| Gate library window | `/workflow gates` lists, creates, edits and removes command gates; they are the existing `policy.checks` (executable, argv, cwd, timeout, required, scope task/feature, envNames, writes). A gate can be run on demand, showing the exit code, duration and output tail | A user adds a gate in the TUI, runs it once, and the next run uses it; changing gates of a started run still requires a revision |
| Ecosystem detection | Detect gates for bun/npm/pnpm/yarn scripts, pytest, ruff, go test, cargo test/clippy and existing CI scripts, and offer them in the gate window and when workflows are enabled | Detection is covered by fixtures per ecosystem; nothing is added without the user's confirmation |
| Budget extension | A run blocked by `budget_exhausted` offers to raise the token/call/time limits with one decision; it creates the policy revision and approval behind the scenes | The new limit is stored as an approved policy revision; the run resumes from where it stopped |
| Cost estimates | Show a range estimate when a run is created (from the preset and past runs), a better estimate after plan (task count times the average task cost) and a live burn rate with a forecast of the stage where the budget ends | Estimates are labeled as estimates and compared with actual usage in completed runs |
| Soft checkpoints | Instead of an unlimited budget, allow a run without a hard token cap that pauses for confirmation every N tokens | Every checkpoint is a durable request; a runaway loop cannot spend past the next checkpoint without a decision |
| Context compaction | Shrink the per-step context of long agent loops, starting with research, so tool results are not resent in full on every step | A research run on a large request uses measurably fewer tokens for the same result; the measurement is recorded |

Status of 2026-10-09: all six rows are implemented and tested locally; the evidence, the measurement of the compaction (65.3% fewer input tokens on a fixture) and the limits are in the [status report](implementation-status.md). The closing conditions that need a person (adding a gate in the terminal and seeing the next run use it, extending a real blocked run, answering a real checkpoint) and a real model (the effect of compaction on a real research stage) remain open until the real run of section 1.

## 2. Custom workflows

After v1 acceptance, prepare a technical design that extends the existing runtime, schemas and migration. The built-in SDD must keep working on the previously stored definitions. The design is written ([workflow-v2-design.md](workflow-v2-design.md), with [contracts](contracts-v2.ts) and [examples](examples/v2) checked by the design check); the implementation below stays behind v1 acceptance.

Presets shipped with BAKED:

| Preset | Stages |
| --- | --- |
| Quick fix | plan, approve, implement, checks |
| Standard | research, specify, plan, analyze, approve, implement, checks, review |
| Full | the current SDD with security review, convergence and learn |
| Spike | research and a report, no code changes |
| Review only | review of an existing diff against criteria |

One invariant stays in every preset: a stage that changes code runs only after a human approval, unless the user enables auto-approval within explicit limits for that workflow.

Contracts and gates move from code to configuration:

- Every transition has a contract: the typed output of the previous stage that the next stage relies on, validated before the transition.
- Every transition has an ordered list of gates that must pass before the next stage starts.
- Gate types: command (tests, linters, build, any console command), human (approval, manual evidence, answers), AI review (the current reviewers) and AI acceptance (section 5). Each gate has an ID, a type, a command or prompt, a timeout, required or advisory, a scope (task, feature or transition), a retry limit and an evidence format.
- Gates live in a library (`baked/gates/*.json`, managed in the gate window) and are attached to transitions in a separate workflow editor window, so one gate can be reused by several workflows.

- [ ] Describe a versioned workflow graph with explicit entry and completion, transitions, conditions and bounded loops. Define the semantics of skip, failure, pause, cancel and retry.
- [ ] Support stages of the existing types: agent, check, approval, review and reflection. Keep typed inputs, outputs and artifact references.
- [ ] Validate the graph before a run: missing nodes, incompatible outputs, unreachable completion, unbounded loops and disallowed capabilities.
- [ ] Store the graph version and the current execution position for recovery. Definition changes do not alter a started run without an agreed revision.
- [ ] Add creating and selecting definitions through files and the CLI, and viewing stages, transitions and results in the TUI.
- [ ] Ship the presets above and let the new-run form choose one; show the stages, gates and the cost estimate before the start.
- [ ] Add the workflow editor window: stages, transitions, contracts and attached gates from the library, with validation before saving.
- [ ] Move the current hard-coded gates (analyze, approve, checks, review, converge) into the same transition and gate model without changing their v1 behavior.
- [ ] Check two different user workflows, branching, a bounded reflection loop, interruption and recovery. Keep the regression coverage of SDD v1.

Acceptance: the user runs their own workflow without editing the scheduler; limits, approvals, review and durable recovery apply on every transition.

## 3. Managing a large initiative

An initiative combines several feature specs and their runs. Decomposition and dependent work must stay visible and subject to approval.

- [ ] Describe the initiative entity: its goals, completion criteria, list of features, revisions and links to run IDs.
- [ ] Add splitting an initiative into specifications with verifiable contracts and a dependency DAG. Approve the proposed split before implementation.
- [ ] Add a decompose stage for a large request typed by a user: the agent proposes features with boundaries, contracts between them and an order; the user can merge, split, remove or rename features before approving the split.
- [ ] Keep the split between 3 and 12 features; a larger request is first split into stages.
- [ ] Add tiered approval: approving the split is mandatory; approving each feature spec is a policy option that can auto-approve specs which stay within their approved feature boundaries.
- [ ] Define the readiness of a dependent feature by the accepted result and `contractHash`. A contract change invalidates the affected downstream evidence and requires a plan review.
- [ ] Show overall progress, blockers, pending decisions and budget consumption. Define a shared initiative budget and the rules for distributing it between runs.
- [ ] Support pause, resume and re-planning of part of an initiative without losing finished results and user changes.
- [ ] Check a multi-spec scenario: a dependent feature waits for a contract, the upstream changes, the downstream is re-approved, and the initiative completes only after all mandatory results are accepted.

Acceptance: the user manages the initiative as one plan and sees why a specific feature can or cannot continue. One workspace keeps one writer.

## 4. Git delivery of the result

First describe a separate delivery contract: which files and snapshot form the result, who approves operations, how external operation IDs are stored and how a lost response is recovered.

- [ ] Add delivery preparation from an accepted workflow or initiative: branch, reviewable diff, file list, results of checks and review.
- [ ] Separate the run's changes from the user's original changes. Do not include unrelated files or secrets in a commit.
- [ ] Show the user the commit message, destination branch/remote and PR title/body before the corresponding operation is approved.
- [ ] Perform commit, push and PR creation within explicitly approved actions. Link the commit SHA and PR URL to the run, revision and accepted snapshot.
- [ ] Store the result of every external action; on retry, check whether a commit, remote branch or PR already exists. Do not blindly repeat an unknown effect.
- [ ] Handle a dirty tree, a HEAD change, conflicts, a missing remote/auth, rejected hooks, a failed push and a lost API response. Support filesystem-only projects with an explicit message that Git is required.
- [ ] Check the full scenario through an isolated Git remote and an API fixture, then run a separately approved real delivery smoke test.

Acceptance: the approved result reaches a PR with evidence of checks and review; user files are kept and a repeated request creates no duplicates. Force-push, merge and destructive Git operations are never performed automatically.

## 5. AI acceptance gate

A gate in which a model starts the application and walks through a user scenario: it clicks through the UI or calls the CLI and checks the visible result. Its design (capabilities, lifecycle, promotion to a command gate, threat model) is section 9 of [workflow-v2-design.md](workflow-v2-design.md).

- [ ] Define the gate: the scenario in plain language, the start command, the URL or terminal, the expected observations and a timeout.
- [ ] Record evidence for every step: screenshots or terminal frames, logs and the actions taken.
- [ ] After a successful walk-through, the model writes the scenario as a deterministic test (for example Playwright or a CLI script). That test becomes a command gate that later runs repeat without a model.
- [ ] Keep the AI walk-through itself advisory until its deterministic test exists; a model's claim of success alone never closes a required gate.
- [ ] Require explicit capabilities for starting the application, opening ports and network access; deny them by default.

Acceptance: a failing UI scenario is detected by the AI gate, the generated test reproduces the failure, and after the fix the generated test passes without a model call.

## Boundary of the next stage

User decision of 2026-10-08: parallel implementation in separate worktrees is added to the work under a [separate design](parallel-worktrees.md). Phase 0 (an explicit execution root) is done; phases 1..3 start after v1 acceptance and Git delivery.

v2 includes only sections 2, 3, 4 and 5 and the referenced worktree design; section 1a runs on v1. Several writers outside that design, a daemon, remote workers and extended executable plugins/hooks/MCP are not part of this plan. Adding other directions requires a new user decision.

When preparing the v2 design, clarify the dependencies between these three packages, migration, API, schemas, threat model and test criteria. This file records the work queue and acceptance conditions; it does not confirm the v2 implementation and does not allow external Git publishing now.

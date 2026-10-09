# SDD implementation: status and evidence

Date: 2026-10-08, updated 2026-10-09 (see the section on the usability work). The working copy implements the built-in SDD workflow. The end-to-end scenario passes from source and from the built CLI: specification, plan, approval, editing, a failing check, a corrective task, review and completed. The feature flag stays opt-in by design. Full cross-platform release acceptance is not confirmed yet. The workspace has no `.git`, so no commit or PR was created.

## What works

| Package | Implementation |
| --- | --- |
| P00 | Typed execution outcomes; salvage does not open the dependency gate; shared approval/tool policy |
| P01 | SQLite/WAL, immutable artifacts, CAS/idempotency, events, leases, effect journal, recovery and stopping owned processes |
| P02 | Spec/task/profile/workflow schemas, DAG, hashes, frozen instructions/skills/definitions, revisions and rendered artifacts |
| P03 | Native AI SDK executor, budgets, task checks before dependent tasks, sequential writers and separate read reviews |
| P04 | Snapshots, host evidence, correctness/security reviews, skeptic, bounded nested corrections, convergence and final acceptance |
| P05 | CLI, slash adapter, TUI panel (run list, enabling per project, new-run form, eight run sections, status line above the footer), async workflow worker, session recovery, pause/cancel/shutdown |
| P06 | Inert local Spec Kit/ECC/Markdown import, provenance, filtered export, redaction, GC and operations documentation |

Main sources: [service](../../src/core/workflows/service.ts), [scheduler](../../src/core/workflows/scheduler.ts), [store](../../src/core/workflows/store.ts), [tool policy](../../src/core/workflows/tool-policy.ts), [acceptance](../../src/core/verification/acceptance.ts), [CLI](../../src/headless/workflow.ts), [worker](../../src/core/workers/workflow.worker.ts), [TUI](../../src/components/workflow/WorkflowPanel.tsx). Commands and configuration are in the [runtime guide](runtime-guide.md).

## Checks of the current version

| Check | Result | Evidence |
| --- | --- | --- |
| Full Bun suite, Windows | 2775 passed, 10 skipped, 0 failed; 9483 assertions; isolated LOCALAPPDATA, timeout 15000 ms | [Log](../../.audit/workflow-model-full-final.log) |
| Workflow, adapters and review regressions | 54 passed, 0 failed; 195 assertions | [Log](../../.audit/sdd-fixes-feature-verified.log) |
| Model selection and repeated start | 5 targeted tests passed; an independent check of coding/review slots and idempotency also passed | [Tests](../../.audit/workflow-model-regression-final.log), [review](../../.audit/workflow-model-review-independent-final.log) |
| TypeScript | passed | [Log](../../.audit/workflow-model-typecheck-final.log) |
| Biome, all of src | passed, no warnings | [Log](../../.audit/workflow-model-lint-final.log) |
| Bun build with React Compiler | passed; CLI and three workers | [Log](../../.audit/workflow-model-build-final.log) |
| CLI and worker through the native provider transport | completed after a failed check and repair; a separate review model; model change for a new run with cached defaultModel=none | [Fixture](../../tests/fixtures/workflow-provider.ts), [source](../../.audit/workflow-model-regression-final.log), [bundle](../../.audit/workflow-model-bundle-smoke.log) |
| SQLite contention and worker crash | The UI thread keeps working; the session reopens; a live child blocks recovery | [Fixture](../../tests/fixtures/workflow-worker.ts), [independent review](../../.audit/policy-review-sol.md) |
| Runtime hydration | The old worker is replaced even when file sizes are equal | [Test](../../tests/hydrate-runtime-review.test.ts) |
| Durable event to OpenTUI frame | p95 108.345 ms, max 316.349 ms; 30 samples, 120×40 | [Script](../../scripts/benchmark-workflow-ui.tsx), [measurement](../../.audit/sdd-fixes-ui-benchmark-final.log) |
| Terminal views | 42 frames at 120×40, 80×24 and 50×20; run list, new-run form, bounds, navigation, changes diff, approval and rejection | [Fixture](../../tests/fixtures/workflow-ui.tsx), [narrow frame](../../.audit/workflow-ui/50-20-decision-auto.txt) |
| Storage baseline | 1000 runs / 100000 events; p95 status 0.041 ms, list 16.067 ms, replay 0.401 ms | [Script](../../scripts/benchmark-workflows.ts), [measurement before hardening](../../.audit/sdd-implementation-benchmark.json) |

The provider fixture uses the real AI SDK, provider request serialization, loopback HTTP, tools and local check processes. The fixture defines the responses; no paid or external LLM is called in the final check. The bundle check runs the built CLI and workers from a separate directory that reproduces the installed runtime layout. It is not a Windows installer check or a real-model check. The TUI benchmark includes SQLite, RPC, React and OpenTUI. Its maximum is above p95; the design target applies to p95.

Nine skipped tests need file symlinks. Windows returns EPERM inside and outside the sandbox, as [two probes](../../.audit/symlink-probe.log) and [a probe outside the sandbox](../../.audit/symlink-probe-unsandboxed.log) confirm. Directory junction tests run. The variable `BAKED_REQUIRE_SYMLINKS=1` turns the missing capability into an error; it is needed for a strict release check on a configured host. The tenth skip covers the keychain branch for non-Windows hosts. The DPAPI roundtrip passed outside the sandbox with a temporary LOCALAPPDATA; the test does not use the user's real store.

## Usability work on the v1 runtime (section 1a of the plan) and context compaction

Date: 2026-10-09. These items use the existing stages, checks and policy and do not change acceptance semantics. They are implemented and tested locally; none of them has been run against a real model, and none has been used by a person in a live terminal session.

| Item | What exists | Evidence |
| --- | --- | --- |
| Gate window (`/workflow gates`, G) | List, create, edit, remove with confirmation, run now with exit code, duration and output tail through the worker; saves only `workflows.policy.checks` and keeps other project settings; started runs keep their frozen policy; run now is refused while a run holds the workspace | [gates](../../src/core/workflows/gates.ts), [window](../../src/components/workflow/GatesView.tsx), [unit](../../tests/workflow-gates.test.ts), [window tests](../../tests/workflow-gates-ui.test.tsx), [worker fixture](../../tests/fixtures/workflow-gates-worker.ts) |
| Gate detection | package scripts for bun, npm, pnpm and yarn, pytest, ruff, go test, cargo test and clippy; a fixture per ecosystem; nothing is added before confirmation. Existing CI scripts are not read | [tests](../../tests/workflow-gates.test.ts) |
| Budget extension | `B` on a run blocked with `budget_exhausted`, `baked workflow extend`; limits only go up; stored as a `policy-revisions` artifact; the run continues from the stopped stage with its approval digest and evidence untouched. This is a narrower path than `candidate` and `revise`, which restart from analyze; see the note below | [tests](../../tests/workflow-budget.test.ts) |
| Soft checkpoints | Preset `checkpoints`, policy field `checkpointTokens`, request kind `checkpoint`, migration 002, `baked workflow continue`. A step that could pass the next multiple of the interval does not start, also inside one agent loop | [tests](../../tests/workflow-checkpoints.test.ts), [loop stop in the executor fixture](../../tests/fixtures/workflow-checkpoint-loop.ts) |
| Estimates | Range before the start from this project's runs or generic ranges, re-estimate after the plan, burn rate, stage where the budget ends, the starting estimate kept per run and compared with the actual usage on completion | [tests](../../tests/workflow-estimate.test.ts) |
| Context compaction | Removed before merge. The step budget from `maxAttemptTokens` ([step-budget](../../src/core/workflows/step-budget.ts)) already compacts old observation results, and two compaction passes in one loop would conflict. The measurement below describes the removed implementation | measurement below |

Verification of this work (Windows, isolated LOCALAPPDATA, timeout 15000 ms, `ANTHROPIC_BASE_URL` unset):

| Check | Result | Log |
| --- | --- | --- |
| Full Bun suite | 2868 passed, 10 skipped, 0 failed; 9957 assertions; 2878 tests in 104 files | [log](../../.audit/1a-2-full-suite.log) |
| An earlier run of the same work | 2859 passed, 1 failed: a view test expected `run.created` as the last event of a new run; the estimate artifact now follows it. The test was updated, which is a behavior change visible in the event feed | [log](../../.audit/1a-full-suite.log) |
| TypeScript, Biome, build, design check | passed (design check: 318 checks, 109 local links) | [typecheck](../../.audit/workflow-1a-typecheck.log), [lint](../../.audit/workflow-1a-lint.log), [build](../../.audit/1a-2-build.log), [design check](../../.audit/workflow-1a-design-check.log) |
| Terminal frames with the gate window and the estimate | 57 frames at 120x40, 80x24 and 50x20, all inside the popup bounds | [frames](../../.audit/workflow-ui-1a/80-24-gates.txt) |

The previous full result was 2799 passed; 69 tests were added.

### Context compaction measurement

This measurement belongs to the separate compaction that was removed before merge; the executor now uses the step budget's compaction only. The raw output is kept for reference.

The fixture is a scripted researcher that reads 16 files of 20000 characters, one per step, with the real executor, the real `read` tool and the AI SDK. The scripted model reports the size of the request it received as its input tokens, so the numbers measure what each step resends. It is a fixture, not a real model.

| Variant | Input tokens for the stage | Result at the standard 400k limit |
| --- | --- | --- |
| Without compaction | 771,861 | stops with budget exhausted (the failure seen in a real research stage that grew from 294k to 420k) |
| With compaction | 267,551 | completes |
| Saving | 65.3% | |

The step count is the same in both variants (17 calls), all 16 read records are stored as evidence in both, every note cites an existing evidence record, the oldest file content is no longer resent and the newest is. A second scenario shows a soft checkpoint of 60000 tokens stopping the same loop after 3 calls. Raw output: [measurement](../../.audit/workflow-compaction-measurement.json).

What the fixture does not show: whether a real model re-reads files it no longer sees in full (each re-read costs tokens and a step), or how much the saving is on a real repository. Provider prompt caching is not modeled; compaction changes the request from the oldest compacted result onward, so cached prefix reads end earlier, while the budget counts all input tokens. The first real run with the baseline will show the real effect.

### Notes and limits of this work

- The budget extension differs from the text of the plan: `revise` resets the run to analyze and invalidates its evidence, so it cannot "continue from where the run stopped". The new path changes only the three limits, records the old and the new policy hash and the usage, keeps the approval digest and the manifest as they were, and takes the user's command as the approval. The architecture text on budget increases ([section 12](solution-design.md)) is updated to say so.
- Migration 002 rebuilds the `requests` table; a database written by this build is not readable by an older build (the same `VERSION_UNSUPPORTED` guard as before). Read only commands still open a version 1 database.
- The gate window starts a real process. Under Bun on Windows, `npm` launches and `npm.cmd` fails with `EINVAL`; this was checked with npm 11.16 only.
- Not verified: the window in a real terminal session by a person, the checkpoint and extension flows in the TUI with a real model, estimates on a project with a long history, Linux and macOS.

## Fixes after independent review

| Defect found | Fix |
| --- | --- |
| An interrupted task check opened a dependent task | The durable gate is bound to generation, snapshot and definition; the check repeats before dependency release |
| A heartbeat failure released the lease before the child stopped | Abort and stop processes first, then release |
| Recovery cancel left stale ownership | Check all known command PIDs, an immutable abandonment artifact and a fenced release; unknown history is kept |
| A nested repair left the original task blocked | Atomic restoration of the whole chain after the gates of all sibling corrections |
| The create action allowed overwriting an existing file | Both edit tools reject the target before the effect intent; later edits of the created file in the same attempt are allowed |
| A revision lost custom profile/workflow hashes | Frozen definitions are kept and checked on continuation |
| The command from the design did not accept prompt-file | Positional workflow ID, prompt-file, relative workspace paths and events are supported |
| A worker crash left the UI with a dead client | A new session after a confirmed close; an exact-owner receipt without automatic replay of unknown effects |
| The RPC deadline ignored custom/revised policy | The scheduler enforces the execution deadline from the stored policy |
| An update could leave an old worker of the same size | Byte comparison and replacement through a temporary file + rename |
| The TUI showed the selected model, but the cached worker kept defaultModel=none | The slash command passes the current tab's model in StartRequest; an explicit --model takes precedence; existing profiles and shared config do not change |
| A repeated start required the model again after defaultModel changed | The stored command result is returned before the current model selection is checked; a changed request is still rejected |
| Pause or cancel of a run whose owner process died kept its leases and blocked ordinary edits | Pause and cancel release the run's leases when the owner is proven gone and no owned command may still run; the release is recorded as an artifact |
| Every tool build opened an extra MemoryManager with its own global WAL connection and never closed it (P2 from the memory review) | Tool builds reuse the session MemoryManager from the ContextManager; a new manager opens only when no session one exists |
| Clarification requests from analysis findings were shown as raw JSON with the answer field below the fold | Questions are normalized from research, spec and analysis; the current question and its answer field come first and stay in view; answers keep the question ID |
| A detached descendant that outlived its exited check command did not block recovery or lease takeover | Recovery and takeover check the command's live descendants (Windows: by parent PID and start time; POSIX: process group; Linux: also the inherited `BAKED_PROCESS_SCOPE` marker, so a descendant that called `setsid` is still found and stopped); an unreadable process table counts as running |
| A write that failed part-way (for example ENOSPC) left a partial temp file next to sources or blobs | Temp writes go through one helper that removes the partial file on failure; reconcile then marks the write not applied |
| The planner repeated the same package error on retry | Package validation runs when the planner submits; errors return to it in the same conversation for up to two corrections |
| Research of a two-file change took 24 steps and about 230k-245k tokens, ending on the step cap | The research limit scales with the files the request names (`4 + 2 × files` steps, 14k tokens per step, profile limit 12); the researcher reads the named files together, follows direct dependencies with the graph tools and submits once they are covered |
| Research and analysis blocked on "no checks were run", on a locale check for a change without locale files, and on a spec test command that the policy's full `bun test` already covers | Blocking items about check outcomes are returned at submission and otherwise recorded as non-blocking notes; the spec author and planner take verification commands from the policy checks; the spec reviewer treats superset checks as satisfying and ignores instruction checks for files no task writes |
| Answering a clarification restarted the run from research (another ~245k tokens) | The run continues from the earliest stage the answer invalidates: research answers continue with specify, spec answers repeat specify, analysis findings repeat specify or plan by their references |

Shared Windows fixes include normalization of graph/import/forbidden paths, quoting of hook commands, closing SQLite statements and the ContextManager, portable subprocess fixtures and isolation of test profiles. The original 204 failures of the full suite are replaced by the current result in the table. Earlier logs are kept as history, not as results of the current code.

During the model selection check, the full suite first depended on the user profile state and gave 14 failures. The first isolated run gave 3 failures because of a Windows HOME change and a test hook timeout. The final run isolates only LOCALAPPDATA and uses a 15000 ms timeout. A check of the original global memory reported SQLITE_CORRUPT while BAKED windows were open, but separate copies of the DB and WAL passed integrity_check and contained 0 memories. After the windows were closed, both original databases passed quick_check. After a restart, an external read of the global memory.db again gave SQLITE_CORRUPT. An independent check of a copy together with the SHM also passed, so damage to the stored files is not proven. The original database files were not replaced or deleted; the live shared-memory/locking error needs a separate reproduction. [Copy diagnostics](../../.audit/workflow-model-memory-copy-inspection.json), [check after close](../../.audit/workflow-model-memory-health-after-close.json), [after restart](../../.audit/workflow-model-memory-health-after-restart.json), [independent review](../../.audit/workflow-memory-review-sol.md).

## First run with a real model (2026-10-09): not completed

The task was `baked workflow list --status STATUS` (the planned example, a `--json` flag for `status`, already exists). Implementer `openai/gpt-5.6-luna`, reviewers (`reviewer`, `security-reviewer`, `skeptic`) `openai/gpt-5.6-sol` through `baked/agents/*.json`, budget of the extended preset (800k tokens, 160 calls, 2 hours), started from the CLI as run `89dcd942-6866-4ca7-97e4-69395ea5dd87`. Only an OpenAI key is configured, so the review by a model of another provider was not possible; the user chose another model of the same provider.

| Step | What happened |
| --- | --- |
| Research, attempt 1 | Completed: 422,419 tokens, 98.7 s, 36 reads (271,795 bytes), a reasonable result (12 facts, constraints, scope). It ended with three blocking "unknowns" that asked the agent to re-read code that compaction had reduced to notes; they were not questions for a person |
| Clarification | Forwarded to the user, who chose the answer "not questions, read the code yourself"; that text was sent. The answer restarts research from the beginning |
| Research, attempt 2 | Failed with unknown usage (377,477 tokens held), 32 reads; the run stopped with `budget_exhausted`, which checks the stop on the budget |
| Budget | The user decided to raise the limit; `extend` moved the run from `blocked` to `paused` without touching the approval digest (800k to 1.6M tokens), as designed |
| Research, attempt 3 | Failed again with unknown usage (791,532 tokens held), 43 reads (521,598 bytes); blocked on the budget again. No further limit increase was made |

Totals: 3 agent calls, 300.8 s active, 422,419 tokens counted and about 1.17M held for attempts with unknown usage, 111 read records stored. Spec, plan, approval, implementation, checks, review and acceptance never ran. No project file changed. Evidence: [baseline](../../.audit/real-run-1.baseline.txt), [research result](../../.audit/real-run-1.research.json), [events](../../.audit/real-run-1.events.jsonl) and the two later event files in `.audit/`.

What this shows, and what it does not:

- Research of a small task cost more than 400k tokens in one call. The files read total about 70k tokens, so the cost is the number of steps (one file group per step) times the context resent on every step, not the size of the results. Result compaction cannot fix that, and the 65% saving measured on the fixture does not carry over to this stage.
- Compaction appears to have hurt: the agent recorded the compacted reads as blocking unknowns instead of reading them again, and the later attempts read more (43 reads, 521 KB) than the first (36 reads, 272 KB). There is no run without compaction to compare with, so this is a strong indication and not a measurement.
- The reservation of a failed call with unknown usage keeps counting, so two failed attempts consumed the whole raised limit on paper. Their real spend was not reported.
- The budget stop, the clarification forwarding, `answer`, `extend` and `resume` worked on a real model. Approvals, the single writer, protection of user changes, review by another model, recovery and the final acceptance were not exercised. The real-model release gate stays open.
- Proposed next steps, none done: a measured comparison with and without compaction (the `workflows.contextCompaction` switch was removed together with the separate compaction); telling the agent in the compaction note and in the context that a note is not an unknown and must be re-read; a lower step count for research (batched reads); and treating a research result whose blocking unknowns only ask for more reading as non-blocking.

## Complete run with a real model (2026-10-09): run 3 completed

Run 3 (`022554bb-f0ee-45bb-9afd-4cf7505602c7`) repeated the same task after the defects of runs 1 and 2 were fixed in BAKED. The user set the implementer to `openai/gpt-6-luna` and the reviewers to `openai/gpt-6.1-sol`; both belong to one provider, so the review is by another model, not by another provider. The run reached `completed` with `verificationState: current` at revision 199. [Final status](../../.audit/run3-final.status.json), [metrics from the database](../../.audit/run3-final.metrics.txt), [the run's own diff](../../.audit/run3-final.diff).

| Stage | Model | Calls | Tokens | Time |
| --- | --- | --- | --- | --- |
| research | luna | 1 | 417,057 | 128 s |
| specify | luna | 1 | 5,808 | 12 s |
| plan | luna | 1 | 87,005 | 45 s |
| analyze (11 rounds) | sol | 11 | 201,855 | 148 s |
| T001, T002, T003, T004 | luna | 9, 10, 8, 7 | 1.24M, 0.97M, 1.04M, 0.69M | 147 s, 346 s, 370 s, 198 s |
| T005 (verification only, no writes) | luna | 6 | 979,141 | 2,519 s |
| T006 (repair) | luna | 3 | 413,577 | 118 s |
| review and converge | sol | 2 | 56,536 and 56,616 | 21 s and 19 s |
| Checks (typecheck, lint, tests), two passes | none | 9 | 0 | 810 s and 116 s interrupted |

Totals: 60 agent calls, 6,157,317 tokens, 4,522 s active time (the clock of the stages, not wall time), 1 repair round, 1 corrective task. All six tasks are `verified`, all seven criteria `pass`, no findings remain. The approval digest of the final graph is `a8f57483eade43ff635beced7321ca56776512f5329e3400e02928e6b02eb0bc`. The run changed 8 files (`src/headless/workflow-parse.ts`, `src/core/workflows/{schemas,service,store,dependencies}.ts`, `src/headless/workflow.ts`, `tests/workflow-runtime.test.ts`, `design/sdd-workflows/runtime-guide.md`); the final diff is stored in `.audit/run3-final.diff`. Typecheck and lint in the run passed, and `tests` passed on the last pass.

What the run exercised on a real model: spec and plan, analysis with a real clarification, approvals bound to a digest, the single writer, the effect journal, repair of a failed check through a corrective task, review and convergence by another model, manual evidence, recovery after an interrupted check and revisions of the task graph.

What it found, now fixed in BAKED and covered by tests (see the journal): a step-limit exit without a result, a format pass that invented a clarification, research reads resent to the implementer on every step, compaction notes read as unknowns, a git-ignored directory invisible to the write guard and the manifest, a write-less verification task that could never pass, and a changed `list` signature breaking another caller.

What it still shows, not fixed:

- Cost is dominated by steps times resent context. Each implementation task cost 0.7M to 1.2M tokens for a change of 1 to 14 lines. The model, not the harness, chooses how many steps to take.
- A verification task without writes (T005) cost 979k tokens and 42 minutes because the agent ran the full suite itself, while the `checks` stage runs the same commands. A task that only confirms checks should not call a model.
- Every edit to BAKED sources during the run changed the input hash, so about seven revision and re-approval cycles were needed. This is a property of editing the product while a run uses it, not of a normal run, but it exposes how many manual approvals the flow asks for. Auto approval inside declared limits is part of the v2 design (section 5.2).
- Two manual criteria (AC-005 help text and AC-006 guide) required a human verdict. The user confirmed both from the evidence in `.audit/run3-AC-005-help.txt` and `.audit/run3-AC-006-guide.txt`. A deterministic check (for example a grep gate) would remove this step.
- The `tests` check runs through a wrapper that copies the workspace and excludes one test (`complete a feature through native provider transport`) because it fails with EBUSY inside a running workflow; it passes outside the run.
- A foreground shell timeout killed the process during `checks` and produced a recovery request. The `retry` resolution was safe because the check declares no writes.

Not verified: the TUI path with a real model (this run used the CLI), Linux and macOS, other providers, and a run that nobody touched. Context windows and reasoning options for the gpt-6 models in BAKED tables are assumed by analogy with gpt-5.

## Workflow v2 (from 2026-10-09)

The user decided on 2026-10-09 that v2 work may start before v1 acceptance; acceptance of both follows later. Delivered so far, in the order of section 8.4 of the [design](workflow-v2-design.md):

| Part | State | Evidence |
| --- | --- | --- |
| Definitions: schema 2, validator, `upgradeWorkflowV1`, gate library with sources and shadowing, five shipped presets, CLI `definitions`, `validate`, `define`, `gates` | Implemented in `src/core/workflows/v2/` | [Tests](../../tests/workflow-v2-definition.test.ts): V2-01, V2-02 (21 definition and 7 gate rejections), V2-03 (10,000 generated graphs), V2-04 |
| Scheduler: position, transitions with `when`, contracts, loop and visit bounds, stage and transition gates (command with retries and flaky flag, human, advisory modes), host spec, Spike report, Review only diff, v2 acceptance | Implemented; `workflow run --workflow ID` and the new-run form start presets and v2 files | [Tests](../../tests/workflow-v2-runtime.test.ts): V2-05 (fixture golden run with a failed check and repair), V2-06 (state parse), V2-07 (`when` branch, bounded reflection loop), V2-08, V2-09, V2-10, V2-12 (confirmation, inside and outside the limits, human stage), Quick fix, Spike, Review only. No real-model run yet (V2-23) |
| Workflow editor window (section 7 of the design) | Implemented: `/workflow edit ID` and E in the new-run form; logic in `src/core/workflows/v2/editor.ts`, rendering in `src/components/workflow/WorkflowEditor.tsx`. [Runtime guide](runtime-guide.md#workflow-editor) | [Tests](../../tests/workflow-editor.test.ts) and [frame tests](../../tests/workflow-editor-ui.test.tsx): V2-14 (validation messages by stage and transition, picker restrictions, reorder, mode toggle, diff on save, refusal with problems, read-only presets, auto approval confirmation on the first save, frames at 120x40, 80x24 and 50x20 inside the popup bounds); the [panel fixture](../../tests/fixtures/workflow-ui.tsx) opens it from the new-run form at the same sizes |
| Git delivery (section 4 of the plan) | Implemented: `baked workflow deliver` plans the delivery of a completed, currently verified run (branch, base, the run's files only, reviewable diff, commit message, pull request, check and review results) as an immutable artifact and a `delivery` request; a person approves its digest with `approve`; `deliver --execute` creates the commit in a temporary index, pushes without force and opens a GitHub pull request. Each step is a `delivery` effect; an unknown outcome is probed (local branch, `git ls-remote`, pull request by head branch) or becomes a recovery request. Migration 003 adds the request and effect kinds. [Runtime guide](runtime-guide.md#delivery) | [tests](../../tests/workflow-delivery.test.ts): full scenario through a bare remote and a pull request fixture, idempotent retry, user file protection, secrets, filesystem-only workspace, dirty files, moved HEAD, missing remote and token, non-fast-forward, hook rejection, unreachable remote, lost push and lost API response |
| Initiatives (section 3 of the plan) | Implemented in `src/core/workflows/initiatives/`: the initiative entity with goals, completion criteria, 3..12 features, immutable plan revisions, run links, an event log and a shared budget (migration 004); the `decomposer` profile and the built-in `initiative-decompose` workflow returning a typed `initiativePlan`; DAG and size validation (a split above 12 is refused with a request to split into stages); the mandatory split approval bound to a plan digest; merge, split, remove and rename edits as new revisions; feature runs one at a time in dependency order with upstream `contractHash` pins; rebasing of dependents after an upstream contract change (evidence invalidated, plan re-approved by a person); optional tiered approval within feature boundaries; progress, blockers, pending decisions and budget in `show`; pause, resume, `replan` and re-planning the split while paused; CLI `baked workflow initiative ...`. [Runtime guide](runtime-guide.md#initiatives). No TUI view | [tests](../../tests/workflow-initiatives.test.ts): DAG validation and the 3..12 bound, split edits, approval digest after an edit, a refused 13-feature split, the multi-spec scenario (dependent waits for a contract, upstream changes, downstream rebased and re-approved, completion only after all mandatory results), pause and resume, budget distribution and exhaustion, tiered approval inside and outside a boundary, re-planning the split after approval, CLI parsing and commands. Deterministic fixture executor only; no real-model run |

Defaults picked without a user decision for the scheduler:

- Stored v1 runs keep the v1 stage-index loop; only runs started from a schema 2 definition walk the graph. V2-05 compares the built-in `sdd` with the same definition run through `upgradeWorkflowV1` as a schema 2 file: status sequence, stage order, check results, task states, repair rounds and model calls are equal. Additive differences: `transition.taken` and `gate.finished` events, more state saves, the frozen gate artifact, and corrective tasks written when the repair transition is taken instead of inside the stage step.
- A run freezes the gates it binds in the artifact `definition/gates.json`, with its hash in the input manifest; the command gates become `policy.checks` with their effective modes, so a mode change changes the approval digest (V2-10). Project gate files are frozen like the definition file.
- The built-in review gates block on every severity, as the v1 review stage repairs every finding the skeptic does not refute. A user gate's `blockingSeverities` and advisory mode are honored: such findings stay in the review artifact and are not repaired.
- A definition without a spec stage gets a host spec: the request as FR-001 and AC-001, automated when a required command gate exists, otherwise manual.
- Task-scope gates on the transition leaving a tasks stage run after each task, as in v1. Other transition gates run in order when the transition is taken, required ones first; a required command gate that does not pass blocks with `verification_failed`. A human gate asks for manual evidence (`gate-ID`); an AI acceptance gate is recorded as skipped until section 9 exists.
- Loop and visit bounds stop the run with `no_progress`. A loop back to an agent or approval stage clears the approval and hands the open findings to that stage in the request.
- Review only reviews `git diff HEAD`, or the last commit when the tree is clean (untracked files are not included, at most 1 MiB). Its findings are the result: both outcomes end the run.
- A project gate needs a first-use confirmation tied to its hash (`baked workflow gates confirm`), stored per workspace in `.baked/gate-confirmations.json`; user gates in `~/.baked/gates` are trusted as the user's own. Workflow agents cannot write `baked/workflows`, `baked/gates`, `baked/agents`, `baked/skills` or `baked/constitution.md` (V2-13, [tests](../../tests/workflow-v2-runtime.test.ts)).
- Auto approval (V2-12) comes only from the definition; confirming it means passing the hash of its limits (`--confirm-auto-approval`), which the refusal prints. The new-run form shows the refusal; the editor asks for a typed confirmation when a save turns auto approval on.
- Revision of a started run's definition (V2-11) is not implemented: a started run keeps its definition; fork starts a new run on the same frozen definition.

Defaults picked without a user decision for the definitions: the presets run the project's own checks (feature checks in the check stage, task checks after each task) instead of the example gate IDs; a project without feature checks cannot validate a preset with a check stage. `define` never copies auto approval. A transition may not bind an AI review gate (they belong to review stages) and may not make an AI walk-through required.

Defaults picked without a user decision for the workflow editor:

- All rules live in `src/core/workflows/v2/editor.ts`; the window only renders an editor state and dispatches its functions. Files are read and written in the interface process like the gate window; only the run history for the estimate goes through the workflow worker, and only while workflows are on.
- The editor validates the schema and then `validateWorkflowV2`, and attaches each message to the first transition or stage it names. A check or review stage lists its own gate list before its outgoing transitions, so stage gates are edited in the same panes.
- The estimate uses only earlier runs of the same workflow ID (each past run now records the definition ID it started from); without them the strip shows "none yet" rather than a range borrowed from other workflows. A copy has a new ID and therefore no estimate until it runs.
- Below 90 columns the panes collapse to one list with a switcher. J and K reorder only in the gates pane; elsewhere j and k move the cursor as in the other workflow views. D in the transitions pane removes a transition; C duplicates a read-only definition as `ID-custom`.
- `sdd`, the presets and schema 1 project files open read only; their copies get human approvals and no auto approval, as `define` does.
- E covers the profile, the decision and `covers` of an approval, and loop bounds. Switching an approval to `auto` uses the example limits of section 5.2; the limits themselves are edited in the file. The typed confirmation is the first 12 characters of the limits hash (the full hash is accepted) and is asked when the file does not already hold the same limits. Run start keeps its own confirmation.
- The workflow views are not localized (no `workflow` keys exist in `locales/en.json`), so the editor strings are English like the gate window; no locale file changed.

Defaults picked without a user decision for initiatives:

- The split is approved as a whole; its digest covers the plan, the shared budget and the settings fixed at start (feature workflow, base policy hash, tiered approval, model), so changing any of them needs a new approval. Every edit is a new revision; a rename keeps a feature's run, any change of its boundary, contract, dependencies or mandatory flag starts it again after approval.
- One feature run is open at a time, in topological order with ties broken by the order in the plan. A run waiting for a decision stops the drive, because the runtime's source snapshot guard would block a run that sees another open run's edits.
- A feature is ready when each upstream feature's newest approved spec belongs to a completed run with current verification. The initiative pins those contract hashes in the new run (`StartRequest.dependencies`, stored as `hostDependencies`), replacing the dependencies the spec author returns; a revision cannot change them.
- After an upstream contract changes, a dependent is rebased: its open run is cancelled, its evidence is invalidated (`input_changed`), and a new run keeps its spec, pins the new hashes and restarts at the plan stage without auto approval, so a person re-approves the plan.
- Shared budget: given at start, or the base policy's per-run limits times (features + 1). Each feature run gets an equal share of the remainder, where open runs count with their full limits and finished runs with their usage; a rebased run takes one more share. Calls per run are capped at 1000; the minimum share is 1000 tokens, 1 call and 1 second.
- Tiered approval is off by default. When on, a feature run's auto approval allows only the feature's boundary paths (at most 20), no deletes and no new dependencies, built with the same helper as v2 definition auto approval (`autoApprovalPolicy`). It needs a schema 1 feature workflow; with a v2 definition it is refused, since v2 auto approval comes from the definition only.
- The initiative and the decompose run share the database and the command idempotency rules of runs; superseded and decompose runs are kept from `gc` while the initiative links them.
- The migration is numbered 004 to stay contiguous with main; it is additive and may need renumbering if another migration lands first.

Git delivery limits. Not verified: a real delivery to GitHub (the separately approved smoke test of the plan), GitHub Enterprise, Git credential helpers and SSH agents, and Windows and macOS. Commit hooks (`pre-commit`, `commit-msg`) do not run, because the commit is built without the checkout; push hooks do. A signed commit is not produced. Preparing and executing a delivery are CLI commands; the TUI decision view shows a pending delivery plan and approves (A) or rejects (X) it, and that view has no automated render test.

## Implementation limits and release checks

- Workflow v1 allows only explicitly classified tools. Arbitrary hooks, shell and unknown MCP effects are not activated by import. Checks run reviewed project commands and are not an OS sandbox.
- A non-zero maxCostUsd is rejected because there is no shared verified source of provider prices. Token/time/call limits apply; unknown usage keeps its reservation.
- A live-provider run on a small real BAKED task stopped in research on the budget on 2026-10-09 (first section above); the third run on the same task completed (second section above). This is one task, one provider and one operator, so the real-model release gate is met only for that case. The user's defaultModel was left unchanged.
- Linux (2026-10-09, Bun 1.4.2, x64 container): the workflow suites (`tests/workflow-*.test.ts(x)`) and the symlink suites (`instructions-loader`, `presets`, `breakage`) ran with `BAKED_REQUIRE_SYMLINKS=1`, so no symlink test was skipped. The POSIX process-tree test found a real defect: a descendant that called `setsid` left the command's process group and did not block recovery or stop on cancel. It is fixed by the inherited `BAKED_PROCESS_SCOPE` marker (PR #11) and covered by a Linux cancel test. The provider transport fixture fails in a container that sets `ANTHROPIC_BASE_URL` and after the plan consistency check; that is test hermeticity, not runtime behavior. The full Linux suite in CI, macOS packaging and the Windows installer smoke test remain. The file symlink gate must still be repeated on Windows with the right privileges.
- SQLITE_BUSY, SQLITE_FULL, before/after/unknown file reconciliation, real worker termination, a live command PID, a detached orphan descendant on Windows and Linux, heartbeat abort and ENOSPC during workspace and evidence writes are checked. ENOSPC is checked both by injection at the write call and, on Linux, on a real 8 MiB tmpfs volume filled to the last 256 KiB (`BAKED_FULL_VOLUME_DIR`): a 1 MiB workspace write fails with ENOSPC and leaves the original file, no temp file and an `unknown` effect, an artifact write fails without a row, and after space returns reconcile marks the effect `failed` and the retry succeeds. A real full volume on Windows and macOS remains a release gate. Recovery with an unknown PID requires trusted human evidence that all processes stopped.

## Audit

The [canonical append-only journal](../../.audit/sdd-integration-2026-10-08.tsv) holds decisions and links to evidence. Independent checks were actually performed by two models: [gpt-6-astra](../../.audit/runtime-review-astra.md) and [gpt-6-sol](../../.audit/policy-review-sol.md). Both belong to the GPT family; a reviewer from another model family is not available here. `agent-transcripts/` does not exist. The reviews rely on the sources, the journal, saved reproductions and executed tests. The defects found were closed with repeated checks in the described scenarios.

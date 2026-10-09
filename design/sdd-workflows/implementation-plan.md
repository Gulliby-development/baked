# Implementation and verification plan

This is the original plan with its acceptance criteria. The actual state of the code and checks is described in [implementation-status.md](implementation-status.md). Work after P06 (closing v1, usability on v1, presets with configurable gates, initiatives, Git delivery, worktrees and the AI acceptance gate) is planned in [next-implementation.md](next-implementation.md). Each package is a separate reviewable delivery. A package is ready when its acceptance passes, not when a number of modules is written.

## Order

```mermaid
flowchart LR
  P00[Results and policy] --> P01[Store and recovery]
  P01 --> P02[Specs and profiles]
  P02 --> P03[Scheduler and executor]
  P03 --> P04[Checks and reflection]
  P04 --> P05[CLI and TUI]
  P05 --> P06[Import and release]
```

UI views can start on a fake service once the P01 API is fixed. This does not change the order in which production execution is enabled. Before P05, only a developer opt-in with a fake provider and isolated fixtures works.

## P00. Fix the original execution contracts

Touches `src/core/agents/agent-runner.ts`, `agent-bus.ts`, `agent-verification.ts`, `code.ts`, `subagent-tools.ts`, `src/core/tools/index.ts`, `src/hooks/useChat.ts` and task_list.

- Separate the execution outcome from acceptance; salvage remains useful partial output but is not success for the dependency gate.
- Remove done on error or incomplete execution. Keep the display format of legacy dispatch compatible through an adapter.
- Stop masking typecheck failures outside edited paths. Keep the exit code and inconclusive.
- Pass approvals, identity and hooks through lean tools. Add unit tests that forbid changes by a reviewer through every tool path.
- Do not change the legacy auto mode implicitly. The workflow policy wrapper is introduced as a separate execution context.
- Introduce a typed `AgentExecutionResult` with `execution: completed|failed|cancelled|interrupted`, `taskOutcome`, `summary`, `partialOutput`, `effectIds`, `usage`, `usageComplete`. The migration adapter does not infer completion from the summary length.

Acceptance:

1. A code agent without edits and without already_satisfied evidence does not open a dependency.
2. An error after partial edits keeps those edits and the output; the descendant does not start.
3. The task status does not become done on salvage.
4. A non-zero typecheck with an error in an importer stays failed.
5. A permission denial is the same for Forge and the code subagent, including compound operations.

Checks: new `tests/agent-outcome.test.ts`, `tests/subagent-policy.test.ts`, `tests/verification-results.test.ts`; the existing dispatch, bus, mode, tool-wrapper, audit-gates and headless tests; the full `bun test`, typecheck and lint.

## P01. Store, commands, events and recovery

New modules:

```text
src/core/workflows/types.ts
src/core/workflows/schemas.ts
src/core/workflows/store.ts
src/core/workflows/migrations/001.ts
src/core/workflows/service.ts
src/core/workflows/events.ts
src/core/workflows/leases.ts
src/core/workflows/recovery.ts
src/core/workflows/artifacts.ts
src/core/workflows/effects.ts
src/core/workflows/process-scope.ts
```

Turn the design SQL into a transaction-safe migration. The store provides typed methods; calling code does not run arbitrary SQL. The service starts with a fake executor. Never place an LLM call inside an SQLite transaction.

Implement CAS, command idempotency, outbox-style event delivery, immutable artifacts, lease owner identity, journaled effects and scoped process cancellation. File publication uses before/after hashes. New AppConfig entries: `workflows.enabled`, `importsEnabled`, `defaultWorkflow`, `policy`; the shape is defined by WorkflowConfigSchema. The config loader validates unknown fields.

Acceptance:

- Repeating start with a commandId returns the same run without a second creation event.
- Two approvals with the same expectedRevision cannot both change the state.
- A crash after commit and before event delivery is recovered from events.
- A crash between the artifact rename and the DB commit leaves an orphan, not false passing evidence.
- An interrupted shell mutation stays unknown until a recovery decision.
- Lease takeover is forbidden while the owner is alive or the state of its processes is unknown.
- Cancel stops only the run's processes; LSP and other chats keep working.
- A corrupt or newer DB is not recreated.

Checks: `workflow-store`, `workflow-events`, `workflow-leases`, `workflow-recovery`, `workflow-effects`, `workflow-process-scope`. Fault injection at every boundary of the durable journal/FS/commit. Separate Windows and POSIX process-tree cancellation tests. Full test suite, typecheck, lint; build when startup or dependencies change.

## P02. Artifacts, profiles and context

New modules:

```text
src/core/specs/schema.ts
src/core/specs/validate.ts
src/core/specs/hash.ts
src/core/specs/render.ts
src/core/specs/revisions.ts
src/core/agents/profiles/schema.ts
src/core/agents/profiles/registry.ts
src/core/agents/profiles/builtin.ts
src/core/workflows/context.ts
src/core/workflows/approval.ts
```

Move the shapes from contracts.ts without renaming fields. Add semantic checks for scope, references, model/output compatibility, path existence by action and byte sizes. The renderer produces a stable spec.md/tasks.md. The definition snapshot records resolved model IDs and the content of profiles/skills.

Before approval, run a semantic consistency attempt of the spec-reviewer profile in a new context with AnalysisSchema. Without a successful analysis, require clarification or a revision. AGENTS.md and other instructions are read through the existing loader; the constitution cannot extend tool permissions. On a conflict between project instructions, show the source and wait for a decision.

Acceptance:

- Unknown IDs, cycles, a criterion without a task and mismatched feature IDs block approval.
- A create-file task keeps a missing target; modify requires an existing target or an explicit dependency that creates the file.
- A candidate after a manual Markdown edit does not overwrite the accepted JSON.
- An old digest is not accepted after a profile/policy/spec/plan change.
- A reviewer does not receive the implementer transcript or parentMessagesRef.
- A context overflow does not silently truncate a criterion.
- A profile with an unsupported tool or an incompatible output cannot be enabled.

Checks: `spec-schema`, `spec-roundtrip`, `spec-revision`, `workflow-profile`, `workflow-context`, `workflow-approval`. Fixtures contain non-Latin text, CRLF, Unicode paths and Markdown with embedded instructions.

## P03. Scheduler and existing agents

New modules:

```text
src/core/workflows/scheduler.ts
src/core/workflows/state-machine.ts
src/core/workflows/task-graph.ts
src/core/workflows/budget.ts
src/core/workflows/agent-executor.ts
src/core/workflows/tool-policy.ts
src/core/workflows/builtin/sdd.ts
```

Make the runtime bootstrap shared by the headless and workflow adapters. Do not import React or UI stores into the service. AgentExecutor uses the current provider resolver, ContextManager and tools, but passes results and events through interfaces. Run budget protection applies equally to the researcher, planner, reviewer, skeptic and retries.

Apply an execution lease on the workspace. All mutating tools of ordinary tabs go through the mutation guard while a workflow is active. The passed task.write set is a restriction, not a prompt hint. For unknown compound effects, forbid the action until its full scope is computed.

Acceptance:

- Ready tasks are chosen deterministically by dependencies, then by original order/ID.
- A predecessor error blocks descendants; independent read attempts do not hold a concurrency slot while waiting for dependencies.
- At most one attempt changes code at a time. Two processes do not bypass the workspace lease.
- Pause does not start the next step until the current effects are stopped or reconciled.
- Bounded retries are not multiplied by SDK retries.
- The token reservation is not reset after a crash; unknown usage is visible.
- A scope extension is not executed without a new policy/spec revision.

Checks: `workflow-scheduler`, `workflow-dependencies`, `workflow-budget`, `workflow-tool-policy`, `workflow-cancel`. A fake provider controls responses and errors; network APIs are not needed for the mandatory suite.

## P04. Checks, review and convergence

New modules:

```text
src/core/verification/check-runner.ts
src/core/verification/snapshot.ts
src/core/verification/evidence.ts
src/core/verification/review.ts
src/core/verification/findings.ts
src/core/verification/convergence.ts
src/core/verification/acceptance.ts
```

Extract CheckRunner from projectTool without copying the shell orchestration. Keep the raw exit, signals, timeout, before/after snapshot and the command definition hash. The legacy project tool formats the new result into the old ToolResult.

Add a security trigger, required review dimensions, schema validation and a skeptic for blockers. The corrective task generator uses the approved requirements and write scope. Repair and convergence return through the shared scheduler. The current snapshot is checked immediately before the acceptance commit.

Acceptance:

- A test exit 0 with a changed source manifest does not give passed.
- A failure in a file outside the diff stays a failure.
- The model cannot create command evidence by itself.
- A missing security reviewer or skeptic does not turn a blocker into an advisory.
- Two findings with one cause are deduplicated with their sources kept; different causes are not lost.
- A missed criterion creates a corrective task; the spec is not rewritten.
- A repeated round without progress stops; round and task limits are respected.
- A manual criterion without a trusted decision does not give completed.
- already_satisfied passes the same checks and coverage as a new implementation.
- An invalidating edit after review requires a repeated check.

Checks: `workflow-check-runner`, `workflow-snapshot`, `workflow-evidence`, `workflow-findings`, `workflow-convergence`, `workflow-acceptance`. An integration fixture deliberately misses one acceptance scenario and then fixes it.

## P05. CLI and terminal interface

Touches `src/boot.tsx`, `src/headless/types.ts`, the command registry and session metadata. New modules:

```text
src/headless/workflow.ts
src/headless/workflow-parse.ts
src/core/commands/workflow.ts
src/hooks/useWorkflow.ts
src/stores/workflow.ts
src/components/workflow/WorkflowPanel.tsx
src/components/workflow/TaskGraphView.tsx
src/components/workflow/ArtifactReview.tsx
src/components/workflow/FindingsView.tsx
src/components/workflow/DecisionPrompt.tsx
```

Workflow stores are not the source of truth. Events are reapplied idempotently by seq. Views show the waiting reason, deadline/budget, current criteria and evidence. On reattach, the snapshot is loaded first, then events starting from eventSeq.

Acceptance:

- The same scripted scenario through the CLI and TUI has the same durable events and final acceptance.
- `status` does not call a model and does not change the run revision.
- Every documented command has --help, strict validation and documented exit codes.
- Non-TTY waiting is stored and ends the run command with code 3.
- A stale approval shows a conflict and does not apply the decision to the new version.
- Closing a tab or the application does not lose a pending request.
- Legacy --headless, /plan, session restore and dispatch rendering pass the regression suite.

Checks: `workflow-cli`, `workflow-ui-state`, `workflow-session-link`, `workflow-parity`, visual review of the components in a narrow terminal and with long non-Latin text. Run the full tests, typecheck, lint and build.

## P06. Import, export, retention and release

New modules `src/core/specs/importers/spec-kit.ts`, `src/core/agents/profiles/importers/ecc.ts`, `src/core/workflows/export.ts`, `gc.ts`. Add user documentation to mintlify-docs after the capabilities are enabled, not earlier.

Acceptance:

- Import does not run shell/hooks/network code from the source.
- Source revisions, hashes, adapter version and license are recorded in imports.lock.
- Unsupported capabilities are reported explicitly and prevent treating a profile as fully compatible.
- Conflicting IDs or Markdown ambiguity create a report without changing accepted artifacts.
- Export contains no credentials; import/export keeps requirement and task IDs.
- GC does not remove active/waiting/blocked evidence or shared specs.
- Rolling back the feature flag keeps status/export of existing runs available.

Release gate: at least one real small BAKED feature through the whole process, the full regression suite on Windows and Linux, the fault-injection matrix below and a measured baseline of tokens/rounds/latency. A macOS smoke test is mandatory for packaging; a platform must not be declared supported from types alone.

## Deferred validation runs

These two runs are recorded so they are not lost; they are not scheduled yet. Each closes a gap that the local real runs in [implementation-status.md](implementation-status.md) left open.

1. Review by another provider. So far every real review used a second model of the same provider: run 3 had an `openai/gpt-6-luna` implementer and `openai/gpt-6.1-sol` reviewers, because only an OpenAI key was configured. Configure a key for a second provider, assign `reviewer`, `security-reviewer` and `skeptic` to that provider's model, and run a small task end to end. Done when the recorded provider/model IDs of the implementer and the reviewers differ by provider, the review evidence is bound to the current snapshot, and a missing or unauthorized second key gives an explicit unavailable-reviewer state instead of a fallback to the implementer's provider.
2. A TUI run on untouched code. Run 3 changed BAKED sources while the run was using them, which forced about seven revision and re-approval cycles and inflated tokens, calls and latency. Start a small task from the terminal interface on a clean checkout and do not edit the repository until the run is terminal. Done when the token/call/round/latency baseline of that run is recorded next to the run 3 numbers, together with the number of approvals the user had to give, so the cost of a normal run can be compared with the inflated one.

## Failure matrix

| Scenario | Expected result | Package |
| --- | --- | --- |
| Crash before the effect intent | Nothing executed; a new attempt is allowed | P01 |
| Crash after the intent, before the file write | The before hash allows reconcile | P01 |
| Crash after the file write, before applied | The after hash confirms the effect | P01 |
| Crash during a shell command | Unknown effect, no automatic replay | P01 |
| Lost heartbeat with a live PID | Takeover forbidden | P01 |
| PID reused | The start identity check does not accept it as the owner | P01 |
| Two approvals at once | One accepted, the second is a conflict | P01 |
| SQLite busy/disk full | No new effects run without the journal | P01 |
| Spec changed in an editor | Input changed, approval superseded | P02 |
| Injected instruction inside a source | The text stays data; permissions do not change | P02/P03 |
| Provider rate limit/auth error | Bounded retry for the first, blocked for the second | P03 |
| Missing provider usage | The reservation and unknown usage are kept | P03 |
| A hook changes a path after the check | Repeated policy validation blocks leaving the scope | P03 |
| MCP of an unknown type | Forbidden for the profile until classified | P03 |
| Another tab changes a check source | The mutation guard delays the write | P03/P04 |
| An external editor changes a file | Snapshot invalidated, acceptance forbidden | P04 |
| A verifier returns pass without evidence | Output invalid/inconclusive | P04 |
| A review dimension did not answer | The required review did not pass | P04 |
| A fix introduced a new bug | New checks/findings, shared round budget | P04 |
| Tests pass, a criterion is missing | Convergence task, run not completed | P04 |
| A terminal run is resumed | RUN_TERMINAL, a fork is needed | P05 |
| An event is delivered twice | The projection does not duplicate changes | P05 |
| Import with a symlink/path traversal | Refused without writes outside the destination | P06 |

## Traceability of design requirements

| Requirements | Packages | Main check |
| --- | --- | --- |
| W01, W08, W11 | P01, P03 | Restart, effects, events, usage |
| W02, W03, W07, W15 | P02 | Schema, DAG, digest, invalidation |
| W04, W12 | P00, P01, P03 | Tool policy, mutation guard, dirty baseline |
| W05, W06, W10 | P04 | Snapshot evidence, bounded loops, acceptance |
| W09 | P05 | CLI/TUI parity |
| W13 | P06 | Import inertness, provenance, capabilities |
| W14 | P02, P03 | Context assembly, profile isolation |
| W16 | P02, P06 | Contract hash changes block downstream execution |

## Verification order for every change

Use Bun. For a narrow change, run the feature tests first, then typecheck and lint. For shared behavior changes, run the whole `bun test`. For startup, bundling and runtime dependency changes, run `bun run build`. Real provider smoke tests run only with a provider configured by the user and a separate small budget; they do not replace the deterministic suite.

Do not enable the feature while mandatory checks are red. The original Windows failures from the analysis must be reproduced, classified and fixed in separate changes. Do not mask them with a blanket skip and do not make checks optional for the sake of a release.

The design package is checked separately with the command from the README. It is not evidence that the future WorkflowService already implements the listed scenarios.

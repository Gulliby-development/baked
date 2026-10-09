# Parallel implementation in separate worktrees

Date: 2026-10-08. Technical design. The user decision of 2026-10-08 adds this direction to the work; [next-implementation.md](next-implementation.md) had excluded it from v2. Order: phase 0 now, the following phases only after the v1 release gates and Git delivery (section 4 of the plan) are closed, because they use its contract.

## Goal

Several writing agents of one run execute independent tasks at the same time, each in its own Git worktree. Results are integrated into the run branch sequentially, conflicts are resolved by a separate stage, and the user's working copy receives changes only through an approved delivery.

## Current limits

| Limit | Where | Consequence |
| --- | --- | --- |
| `maxConcurrentWriters` = 1 in the policy schema | [schemas](../../src/core/workflows/schemas.ts) | Validation forbids parallel writers |
| File root = database root (`store.workspace`) | executor, tool-policy, check-runner, scheduler, effects | The agent can edit only the project working copy |
| `execution` and `mutation` leases cover the whole workspace | [leases](../../src/core/workflows/leases.ts) | One writer and one executing run |
| `getCwd()` is global within a thread | [cwd](../../src/core/cwd.ts), 53 calls in tools | Each writer must run in its own worker thread |
| The effect journal stores a path without a root | [effects](../../src/core/workflows/effects.ts) | Reconcile after a crash does not know which worktree the effect touched |
| The intelligence index is bound to the project directory | `.baked/repomap.db` | A worktree needs read-only access to the project index or its own index |

`getCwd()` lives in a module, so every Bun Worker has its own value; the workflow worker already calls `setCwd(workspace, { changeProcess: false })`. Running a writer in a separate worker thread with `cwd` = worktree does not require rewriting the `getCwd()` calls in tools.

## Phases

### Phase 0. Explicit execution root (done)

`ExecutionRequest.root` sets the directory where the agent reads and edits files and runs `request_check`. It defaults to the project root, so behavior does not change. `NativeAgentExecutor`, `WorkflowToolPolicy` and `CheckRunner.run` use it. The database, leases, the spec publication journal and approval stay in the project root.

### Phase 1. One writer in an isolated worktree (done)

Implemented on 2026-10-09; see [worktree execution](runtime-guide.md#worktree-execution) and the defaults in the [implementation status](implementation-status.md#workflow-v2-from-2026-10-09). One deviation: the worktree and branch are created when the run first executes rather than after approval, so research, spec publication and the approval snapshot already work in the worktree and the working copy is never written; uncommitted user changes in the approved scope still need the explicit choice at approval.

- Git is required; without it the run executes as today.
- After approval, the branch `baked/wf/<runId>` is created from the recorded baseline HEAD together with the worktree `.baked/worktrees/<runId>/main`. Uncommitted user changes do not enter the worktree; if a task touches such files, approval shows this and requires a decision.
- A file effect intent gets a `root` field (the relative worktree path). Reconcile checks hashes there. Old records without `root` refer to the project root.
- The `mutation` lease is taken on the worktree, not on the project: the user can keep working in their copy during the run. The `execution` lease stays on the run.
- Checks and review run in the worktree. Final acceptance compares the worktree snapshot.
- Result: a branch with the accepted changes. Delivery (section 4) moves them into the user's working copy, not the scheduler.

### Phase 2. Several writers with disjoint `writes`

- Policy: `maxConcurrentWriters` 1..4. A schema migration keeps 1 for existing definitions.
- A task batch: tasks ready by the DAG that are pairwise disjoint by `writes.path` and by the directories they create. An overlap moves a task to the next batch.
- Each task gets its own worktree `.baked/worktrees/<runId>/<taskId>` from the current head of the run branch and its own worker thread with `cwd` = worktree.
- `node_modules` is attached to the worktree through a directory junction (Windows) or a symlink (POSIX); file symlinks on Windows may fail with EPERM.
- Task checks run in the task's worktree; a semaphore limits concurrent heavy checks.
- Integration is sequential, in topological order: a task's changes are applied to the run branch, then feature checks run. A file change outside the task's `writes` rejects its result, as today.
- Budget: tokens are reserved for the whole batch before it starts; when they are short, the batch shrinks.
- Recovery: every worktree has its own lease and fencing epoch; a lost worker moves only its own task to `interrupted`.

### Phase 3. Conflicts and overlapping writes

- An integration conflict creates an integrator task with both diffs, the spec and the task definitions; its scope is only the conflicting files.
- Overlapping `writes` are allowed only when the policy explicitly permits them; such tasks are integrated through the integrator.
- After integration, feature checks, review and convergence repeat; a failure produces a bounded correction, as in v1.

## Invariants

- The scheduler does not change the user's working copy in phases 1..3; only an approved delivery moves changes.
- The approval digest includes the execution mode (`inline` or `worktree`) and `maxConcurrentWriters`.
- Every effect is bound to a root; reconcile and recovery never apply an effect to another root.
- A worktree is deleted only for a terminal run after its branch has been delivered or explicitly discarded by the user.

## Checks

- Phase 0: the executor, tool-policy and check-runner use the given root; without it, v1 behavior does not change.
- Phase 1: agent edits do not change the working copy; a crash between an effect and the journal is recovered in the worktree; the lease of a dead worktree owner is released by the same rules as in v1.
- Phase 2: two independent tasks run at the same time and are integrated; a task that writes outside its `writes` is rejected; losing one worker does not stop other tasks.
- Phase 3: an artificial conflict is resolved by the integrator, after which checks and review pass again.

## User decisions (2026-10-08)

- Phases 1..3 start after v1 acceptance and the Git delivery implementation; only phase 0 is done now.
- The result of a run executed in a worktree stays in the branch `baked/wf/<runId>` and reaches the working copy or a PR only through an approved delivery. There is no automatic application to the working copy.

## Open decisions

- A shared intelligence index for worktrees: a read-only project index (fast, may be stale for changed files) or a per-worktree index (accurate, expensive).
- The default parallelism limit with respect to provider rate limits.

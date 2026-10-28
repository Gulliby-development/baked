# Parallel implementation in separate worktrees

Technical design. Status: phases 0 to 4 are implemented (task worktrees, several writers, the integrator and parallel runs); operation is described in the [runtime guide](runtime.md#worktree-execution).

## Goal

Several writing agents of one run execute independent tasks at the same time, each in its own Git worktree. Results are integrated into the run branch sequentially, conflicts are resolved by a separate stage, and the user's working copy receives changes only through an approved delivery.

## Current limits

| Limit | Where | Consequence |
| --- | --- | --- |
| `maxConcurrentWriters` = 1 in the policy schema (lifted in phase 2: 1..4 with worktree execution) | [schemas](../../src/core/workflows/schemas.ts) | Validation forbids parallel writers |
| File root = database root (`store.workspace`) | executor, tool-policy, check-runner, scheduler, effects | The agent can edit only the project working copy |
| `execution` and `mutation` leases cover the whole workspace (lifted in phases 1 and 4: worktree runs hold their own) | [leases](../../src/core/workflows/leases.ts) | One writer and one executing run |
| `getCwd()` is global within a thread | [cwd](../../src/core/cwd.ts), 53 calls in tools | Each writer must run in its own worker thread |
| The effect journal stores a path without a root | [effects](../../src/core/workflows/effects.ts) | Reconcile after a crash does not know which worktree the effect touched |
| The intelligence index is bound to the project directory | `.baked/repomap.db` | A worktree needs read-only access to the project index or its own index |

`getCwd()` lives in a module, so every Bun Worker has its own value; the workflow worker already calls `setCwd(workspace, { changeProcess: false })`. Running a writer in a separate worker thread with `cwd` = worktree does not require rewriting the `getCwd()` calls in tools.

## Phases

### Phase 0. Explicit execution root (done)

`ExecutionRequest.root` sets the directory where the agent reads and edits files and runs `request_check`. It defaults to the project root, so behavior does not change. `NativeAgentExecutor`, `WorkflowToolPolicy` and `CheckRunner.run` use it. The database, leases, the spec publication journal and approval stay in the project root.

### Phase 1. One writer in an isolated worktree (done)

Implemented; see [worktree execution](runtime.md#worktree-execution). One deviation: the worktree and branch are created when the run first executes rather than after approval, so research, spec publication and the approval snapshot already work in the worktree and the working copy is never written; uncommitted user changes in the approved scope still need the explicit choice at approval.

- Git is required; without it the run executes as today.
- After approval, the branch `baked/wf/<runId>` is created from the recorded baseline HEAD together with the worktree `.baked/worktrees/<runId>/main`. Uncommitted user changes do not enter the worktree; if a task touches such files, approval shows this and requires a decision.
- A file effect intent gets a `root` field (the relative worktree path). Reconcile checks hashes there. Old records without `root` refer to the project root.
- The `mutation` lease is taken on the worktree, not on the project: the user can keep working in their copy during the run. The `execution` lease stays on the run.
- Checks and review run in the worktree. Final acceptance compares the worktree snapshot.
- Result: a branch with the accepted changes. Delivery (section 4) moves them into the user's working copy, not the scheduler.

### Phase 2. Several writers with disjoint `writes` (done)

Implemented; see [several writers](runtime.md#several-writers). Deviations: no schema migration was needed for the policy, because stored policies already carry `maxConcurrentWriters: 1` (migration 006 adds the `interrupted` task status instead); the tasks of a batch run as concurrent asynchronous workers in the scheduler's thread rather than in separate worker threads, since the workflow tools resolve paths against the task's root; a task worktree starts from a commit of the run worktree's current content, because the run branch receives its commit only at acceptance.

- Policy: `maxConcurrentWriters` 1..4. A schema migration keeps 1 for existing definitions.
- A task batch: tasks ready by the DAG that are pairwise disjoint by `writes.path` and by the directories they create. An overlap moves a task to the next batch.
- Each task gets its own worktree `.baked/worktrees/<runId>/<taskId>` from the current head of the run branch and its own worker thread with `cwd` = worktree.
- The project's installed dependency folders (`node_modules`, `.venv`, Composer's `vendor` and the other rows of `DEPENDENCY_DIRS`, #2330) are attached to the worktree through a directory junction (Windows) or a symlink (POSIX); a folder the project tracks is checked out instead. File symlinks on Windows may fail with EPERM. A folder whose installed files name the project itself (`PROJECT_PATHS`, #2362) is built in the worktree entry by entry instead: Composer's `vendor/composer`, `vendor/autoload.php` and `vendor/bin`, an editable install's `pyvenv.cfg`, scripts and `.pth` files, and npm workspace links are the worktree's own (with the workspace path replaced by the worktree's), while the installed packages stay linked; a `.baked-linked` file marks such a folder. A folder holding an installed *copy* of the project leaves that copy out instead, so a check loads the worktree's sources or fails clearly rather than running the main workspace's last install (#2371): the project's own rock in `lua_modules` (the `package` of its rockspec: its `lib/luarocks/rocks-*/NAME` folder and the files its `rock_manifest` lists), its package in `renv/library` or `packrat/lib` (the `Package:` of its DESCRIPTION) and the files its pinned packages (`NAME.opam`) installed into `_opam` (from `.opam-switch/install/NAME.changes`). A Dart project then runs `dart pub get --offline` (or `flutter pub get --offline`) in the worktree when it does not commit `.dart_tool/package_config.json` (`DEPENDENCY_PREPARE`, #2361); a missing or failing command leaves the worktree as it is and its checks name the unresolved packages.
- Task checks run in the task's worktree; a semaphore limits concurrent heavy checks.
- Integration is sequential, in topological order: a task's changes are applied to the run branch, then feature checks run. A file change outside the task's `writes` rejects its result, as today.
- Budget: tokens are reserved for the whole batch before it starts; when they are short, the batch shrinks.
- Recovery: every worktree has its own lease and fencing epoch; a lost worker moves only its own task to `interrupted`, and a task whose worker failed while its lease stayed with the run is restarted once with the edits the worker left before the run blocks with `owner_lost`.

### Phase 3. Conflicts and overlapping writes (done)

Implemented on 2026-10-09 together with phase 2. The policy permission is `allowOverlappingWrites` (default off). Every integration conflict goes to the integrator; there is no automatic three-way merge first.

- An integration conflict creates an integrator task with both diffs, the spec and the task definitions; its scope is only the conflicting files.
- Overlapping `writes` are allowed only when the policy explicitly permits them; such tasks are integrated through the integrator.
- After integration, feature checks, review and convergence repeat; a failure produces a bounded correction, as in v1.

### Phase 4. Parallel runs (done)

Implemented on 2026-10-12 for the project coordinator (#148). Several runs of one workspace execute at the same time when each runs in its own worktree.

- A worktree run holds its own execution lease `execution:RUN_ID` (migration 011) instead of the workspace-wide `execution` lease, which only inline runs take. Two inline runs still exclude each other, because they share the working copy.
- `workflows.maxParallelRuns` (1..8, default 2) caps the runs executing in the workspace at once, inline and worktree runs together. The cap is checked in the same transaction that takes the execution lease and counts only leases whose owner may be alive. A drive over the cap is refused with `WORKSPACE_BUSY`, as a busy workspace was before. The default of 2 keeps the request rate near what one run with its read agents and writers already produces; `1` restores one executing run per workspace. `workflows.parallelRunsFromPlan: true` (off by default) raises the default cap to 3 and lets an initiative start as many features as its plan's widest group of independent features, up to the cap (#1822).
- One service drives several runs through drive lanes: the first drive uses the service's scheduler, and a drive that starts while it is busy gets its own leases, scheduler and executor (sharing the root context). Each holds the state of one drive: its leases, its lost-lease signal and its queued requests.
- Each run keeps its worktree, branch and delivery. Runs started from the same HEAD do not see each other's changes until they are delivered.
- Initiatives in worktree mode run independent features side by side (#558). A downstream feature needs its upstream feature's code, which lives on the upstream run's branch, so its worktree starts from HEAD merged with the accepted commits of its upstream features (`worktreeBase` in the run state, made with `git merge-tree` and `git commit-tree`), plus a commit with their accepted specs, which their branches leave out (#2017); see [initiatives](runtime.md#initiatives).

## Invariants

- The scheduler does not change the user's working copy in phases 1..3; only an approved delivery moves changes.
- The approval digest includes the execution mode (`inline` or `worktree`) and `maxConcurrentWriters`.
- Every effect is bound to a root; reconcile and recovery never apply an effect to another root.
- A worktree is deleted only for a terminal run after its branch has been delivered or explicitly discarded by the user.

- Task worktrees are byte-exact copies of the run worktree: the content commit and the checkout run with `core.autocrlf=false`, so a Windows repository without `.gitattributes` does not turn LF files into CRLF. After the checkout, each file the task may write is compared with the run worktree and replaced by a byte copy when it differs; the edit hash check also ignores a pure line-ending difference.
- Edits of one file that an attempt sends in parallel (several `edit_file`, `multi_edit` or `delete_file` calls on the same path in one model step) run one after another, so each sees the effect its predecessor journaled and the hash check does not refuse the attempt's own write. Calls on different paths still run in parallel.
- A blocked implementer outcome that follows an edit refused by the hash check is reported as an infrastructure fault (reason `input_changed`, with the refused paths), not as a disagreement with the task.
## Checks

- Phase 0: the executor, tool-policy and check-runner use the given root; without it, v1 behavior does not change.
- Phase 1: agent edits do not change the working copy; a crash between an effect and the journal is recovered in the worktree; the lease of a dead worktree owner is released by the same rules as in v1.
- Phase 2: two independent tasks run at the same time and are integrated; a task that writes outside its `writes` is rejected; losing one worker does not stop other tasks.
- Phase 3: an artificial conflict is resolved by the integrator, after which checks and review pass again.
- Phase 4: two worktree runs of one workspace implement at the same time and each completes on its own branch; `maxParallelRuns: 1` refuses the second drive.

## User decisions (2026-10-08)

- Phases 1..3 start after v1 acceptance and the Git delivery implementation; only phase 0 is done now.
- The result of a run executed in a worktree stays in the branch `baked/wf/<runId>` and reaches the working copy or a PR only through an approved delivery. There is no automatic application to the working copy.

## Open decisions

- A shared intelligence index for worktrees: a read-only project index (fast, may be stale for changed files) or a per-worktree index (accurate, expensive).
- Running initiative features with no dependency path between them in parallel, each based on its upstream features' branches.

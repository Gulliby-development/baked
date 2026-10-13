# Workflows

`baked workflow` (and `/workflow` in the terminal UI) runs spec-driven development as durable, resumable runs: research, specification, plan, analysis, an approval, implementation of a task graph, required checks, independent review and convergence. Runs survive crashes and restarts, are bound by budgets, and change files only within the scope a person approved. The feature is on by default in every project; `workflows.enabled: false` turns it off ([enabling](runtime.md#enabling)).

```sh
baked workflow run --feature status-json --prompt "Add JSON status for a run" --events
baked workflow status RUN_ID --json
baked workflow approve RUN_ID --request ID --digest SHA256 --expected-revision N
baked workflow resume RUN_ID --expected-revision N --events
baked quick "fix the typo in the usage help"     # a small task without a specification
baked doctor                                     # check keys, models, checks and Git first
```

## Built-in workflows

| Workflow | For |
| --- | --- |
| `sdd` | The built-in v1 pipeline (the default) |
| `quick` | One agent finds the files and plans, then approval, implementation, checks and one review ([quick workflow](quick.md)) |
| `quick-fix` | Plan, approve, implement and check a small change |
| `standard` | Research, specify, plan, analyze, approve, implement, check and review |
| `full` | The SDD pipeline as a v2 definition, with security review, convergence on every criterion and learning |
| `spike` | Research and a written report; no file changes |
| `review-only` | Review an existing diff against criteria; no file changes |
| `fix-ci` | Reproduce failing checks, research the failure, plan, approve, fix and rerun the same checks ([Fix CI](fix-ci.md)) |

`baked workflow definitions` lists them with the project's own definitions from `baked/workflows/`; `baked workflow define ID --from PRESET` copies one to edit.

## Pages

| Page | Contents |
| --- | --- |
| [Runtime guide](runtime.md) | Operating runs: config, CLI and TUI, decisions and revisions, gates, budgets and estimates, worktrees and several writers, recovery, model routing, Git delivery, initiatives, the local API and exit codes |
| [Architecture](architecture.md) | The v1 design: components, state machine, invariants, storage, security and recovery |
| [Workflow v2](v2-design.md) | Definitions as stage graphs, presets, the approval invariant, the gate library and editor, the AI acceptance gate, migration from v1 |
| [Quick workflow](quick.md) | `baked quick` for small changes |
| [Fix CI](fix-ci.md) | The `fix-ci` preset for failing checks |
| [Doctor and estimate](doctor-and-estimate.md) | Checks before a run and the token and cost estimate |
| [Code quality gates](code-quality.md) | Duplication and dead-code ratchet and the anti-slop rule pack: defaults, run overrides and what the run report shows |
| [Parallel worktrees](parallel-worktrees.md) | Task worktrees, several writers and the integrator |
| [Example gate](examples/ai-acceptance-gate.json) | An `ai-acceptance` gate definition |

## Code

`src/core/workflows/` (service, state machine, scheduler, store and migrations, budgets, delivery, initiatives), `src/core/workflows/v2/` (definitions, presets, gates and the acceptance gate), `src/core/specs/` (artifact validation), `src/core/verification/` (acceptance) and `src/core/agents/profiles/` (agent profiles). Durable events in `.baked/workflows.sqlite` are authoritative; front ends only render them.

For development, run `bun test tests/workflow-runtime.test.ts tests/workflow-adapters.test.ts` (no provider credentials needed) and keep the feature disabled by default.

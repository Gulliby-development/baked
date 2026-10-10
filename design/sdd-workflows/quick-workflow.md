# Quick workflow for small tasks

Status: design, reviewed before implementation (2026-10-10). Item 1 of the router and features proposal.

## Problem

A change of 1 to 14 lines goes through the full SDD flow and costs hundreds of thousands of tokens. The third trial run (`--stage` filter for `baked workflow usage`, 4 files) spent 664k tokens: implementation 339k, research 140k, converge 127k, review 31k, and specify, plan and analyze 28k together. Most of the fixed cost is stages a small change does not need: a separate research report the planner then re-reads, a specification, a consistency analysis and a convergence audit.

BAKED already ships a `quick-fix` preset (plan, approve, implement, checks). It is reachable only as `baked workflow run quick-fix --feature ID --prompt TEXT`, it writes five files to `specs/<feature>/` in the project for every fix, its planner runs with the full planner budget (24 steps) and the generic planner instructions, and it has no review.

## Goals

- One command for a small task: `baked quick "<task>"`, with no feature ID to invent.
- Fewer agent stages than `standard`: one scoping agent that finds the files and plans, the implementer, the policy checks and one correctness review.
- A budget proportional to the request, like the research budget from PR #14.
- No files in `specs/` for a quick task.
- The same safety model as every other run: human plan approval, write scope from the approved task graph, frozen inputs, checks from the policy.

## Non-goals

- Auto approval by default. A definition with auto approval still needs the typed confirmation hash (V2-12). A user who wants it copies the preset with `baked workflow define ID --from quick` and turns it on.
- Model routing. When R1 lands, `quick` stages are routed like any other (`modelRouting.workflows.quick.stages.plan = "$fast"`). This design adds nothing router-specific.
- Changing the `quick-fix` preset. It stays as it is for projects that use it.

## Design

### 1. The `quick` preset

A sixth shipped preset, `src/core/workflows/v2/presets/quick.json`:

| Stage | Type | Profile or gates | Notes |
|---|---|---|---|
| `plan` | agent | `quick-planner` | Finds the files and returns the plan and task graph in one attempt |
| `approve` | approval | human | Covers `implement` |
| `implement` | tasks | implementer | Task checks on the transition to `checks` |
| `checks` | check | the policy's feature checks | As every preset, via `instantiatePreset` |
| `review` | review | `correctness-review` | Skeptic stays on: it runs only on a serious finding |

Transitions: `plan → approve → implement → checks`; `checks → review` on passed; `checks → implement` on failed (loop, at most 2); `review → done` on passed; `review → implement` on changes_requested (loop, at most 1). `limits.maxStageVisits` is 20.

There is no research, specify, analyze or converge stage. The specification is the host spec every spec-less definition already uses (`hostSpec`: the request as FR-001 and AC-001), so the plan validation, approval digest, reviewer and acceptance work unchanged.

Why one scoping agent instead of research followed by implement: a tasks stage needs a task graph with declared writes, because the write scope the user approves comes from it. Research produces no task graph, so research → implement would need either a host-made task without a write scope (which drops the scope guard) or a planner after research (two agents that read the same files). The quick planner is research and planning in one attempt.

### 2. The `quick-planner` profile

A built-in profile, role `planner`, output `plan`, model `$active`, tools `read`, `bake_find`, `bake_impact`, `navigate`, `submit_result`, `maxSteps` 12, `maxOutputTokens` 8192. Instructions, in short:

- There is no research stage: start from the paths the request names (`extra.researchScope.namedPaths`), read them in one call, and find only their direct callers and tests.
- Plan the smallest change that does the request: one task, more only when files must change in order; never more than three.
- Keep every required plan section (Context, Decisions, Components, Data, Verification, Risks) to a few lines; one decision `DEC-001` that references FR-001 is enough.
- Take checks from `executionContract.checks`; do not plan verification-only tasks.

The plan package validation (`validatePackage`) is not relaxed: the six sections, a `DEC-` reference to a requirement and the task graph rules apply as for every plan. They are cheap when short, and the approval screen and `workflow revise` keep working on the same shapes.

### 3. Plan budget when there is no research

In the scheduler's `plan` case, when the run has no research (`state.research === null`), the planner gets the research budget of the request plus two steps to write and submit the plan, and `extra.researchScope` with the named paths. This uses `researchBudget` from `clarification.ts`:

- a request naming n files: `min(profile.maxSteps, policy.maxAgentSteps, 4 + 2n + 2)` steps and 14k tokens per step;
- a request naming no file: the profile limit (12 for `quick-planner`).

This applies to every definition whose plan stage runs without research, so `quick-fix` runs get the scoped budget too. Runs with research keep the current planner limits.

### 4. No publication to `specs/`

`WorkflowV2Schema` gets an optional field `publish: boolean`. Absent or `true` keeps today's behavior. With `false`, the scheduler's `publish()` returns without writing `specs/<feature>/*`; the spec, plan and task graph remain run artifacts (`baked workflow artifacts RUN_ID`, export, delivery). The field is optional with no default, so the hash of every existing definition is unchanged. `quick` sets `"publish": false`. The definition editor keeps unknown fields as it keeps `execution`.

### 5. Feature ID

`featureSlug` moves from `src/components/workflow/format.ts` to `src/core/workflows/feature-id.ts` (the UI re-exports it). `quickFeatureId(store, text)` returns `featureSlug(text)`, with `-2`, `-3`, ... appended while a run with that feature ID exists, so every quick task has its own ID in `workflow list` and usage reports. `--feature ID` overrides it.

### 6. Entry points

- CLI: `baked quick TEXT... [--feature ID] [--model ID] [--events] [--worktree] [--confirm-auto-approval HASH] [--policy FILE]`, also `--prompt-file FILE` instead of TEXT. `src/boot.tsx` routes `quick` to `runWorkflowCli(["quick", ...])`. In the workflow CLI, `quick` is a command that resolves the feature ID and runs `run` with `--workflow quick` (or the project's `workflows.quickWorkflow`, see below), so exit codes, events and the printed snapshot are those of `run`.
- `baked workflow quick ...` is the same command.
- TUI: `/workflow quick [text]` opens the new-run form with the text and the `quick` workflow preselected. The form already lists presets, so `quick` is also selectable there.
- Config: `workflows.quickWorkflow` (optional, a definition ID) lets a project point `baked quick` at its own copy, for example one with auto approval.

## Expected effect

On the trial feature the run drops research (140k), specify, analyze (part of 28k) and converge (127k), and replaces the planner with a scoped quick planner. Implementation and review are unchanged in this design; their cost is the router's and the implementer budget's job. The expected total for the same feature is roughly 400k against 664k. This is an estimate; a measured run with `baked quick` on a small task is the acceptance for the cost goal.

## Tests

- Preset: `quick` loads, validates against the gate library, appears in `baked workflow definitions`, and is instantiated with the policy checks.
- Golden run with a scripted executor: plan, approval wait, implement, checks, review, completed; no file under `specs/`; a failed review loops once to implement.
- Plan budget: with no research, a request naming one path gives the planner `min(12, 4 + 2 + 2) = 8` steps and `researchScope` in its prompt; with research the limits are unchanged.
- `publish: false` writes nothing to `specs/`, and a definition without the field still publishes.
- CLI: `baked quick fix the parser` parses, derives `fix-the-parser`, appends `-2` for an existing feature, rejects TEXT with `--prompt-file`, and passes `--feature` through.
- Feature ID: `featureSlug` behavior unchanged (existing tests move with it).

## Risks

- A one-attempt planner on a vague request ("make it faster") may plan the wrong files. Mitigation: the human approval shows the files, and `quick` is documented for small, located changes; the full flow stays the default.
- The scoped plan budget also changes `quick-fix`. Its planner had 24 steps without research; a request that names no file keeps the profile limit, so only requests that name files get fewer steps.

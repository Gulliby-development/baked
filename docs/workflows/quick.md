# Quick workflow for small tasks

Status: implemented. The [review outcome](#review-outcome) lists how the code differs from the first draft.

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
- New routing rules. `quick` stages are routed like any other (`modelRouting.workflows.quick.stages`, `--route`); the only routing change is the built-in class `$fast` (section 2).
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
| `review` | review | gate `correctness-review` (profile from `policy.reviewProfiles.correctness`) | Skeptic stays on: it runs only on a serious finding |

Transitions: `plan → approve → implement → checks`; `checks → review` on passed; `checks → implement` on failed (loop, at most 2); `review → done` on passed; `review → implement` on changes_requested (loop, at most 1). `limits.maxStageVisits` is 20.

There is no research, specify, analyze or converge stage. The specification is the host spec every spec-less definition already uses (`hostSpec`: the request as FR-001 and AC-001), so the plan validation, approval digest, reviewer and acceptance work unchanged.

Why one scoping agent instead of research followed by implement: a tasks stage needs a task graph with declared writes, because the write scope the user approves comes from it. Research produces no task graph, so research → implement would need either a host-made task without a write scope (which drops the scope guard) or a planner after research (two agents that read the same files). The quick planner is research and planning in one attempt.

### 2. The `quick-planner` profile

A built-in profile, role `planner`, output `plan`, model `$fast`, tools `read`, `bake_find`, `bake_impact`, `navigate`, `submit_result`, `maxSteps` 12, `maxOutputTokens` 16384 (the plan and task graph are one tool call). Instructions, in short:

- There is no research stage: start from the paths the request names (`extra.researchScope.namedPaths`), read them in one call, and find only their direct callers and tests.
- Plan the smallest change that does the request: one task, more only when files must change in order; never more than three.
- Keep every required plan section (Context, Decisions, Components, Data, Verification, Risks) to a few lines; one decision `DEC-001` that references FR-001 is enough.
- Take checks from `executionContract.checks`; do not plan verification-only tasks.

`$fast` is a new built-in class: `modelRouting.classes.fast` sends the quick planner to a cheaper model, and without it the class is the run model, so a project without routing behaves as with `$active`.

The plan package validation (`validatePackage`) is not relaxed: the six sections, a `DEC-` reference to a requirement and the task graph rules apply as for every plan. They are cheap when short, and the approval screen and `workflow revise` keep working on the same shapes.

### 3. Plan budget of a scoping planner

In the scheduler's `plan` case, when the run has no research (`state.research === null`) and the planner is a scoping planner (`SCOPING_PLANNERS`, today only `quick-planner`), the planner gets `scopedPlanBudget` from `clarification.ts` and `extra.researchScope` with the named paths and the step limit:

- a request naming n files: `min(profile.maxSteps, policy.maxAgentSteps, 4 + 2n + 2)` steps, and a cumulative attempt cap of 20k tokens per step (more than research's 14k, because the prompt also carries the spec and profiles and the answer is the whole plan), within `maxAttemptTokens`;
- a request naming no file: the profile limit (12) and the default attempt cap.

The generic `planner` keeps its limits everywhere, so `quick-fix` and custom definitions are unchanged.

### 4. No publication to `specs/`

`WorkflowV2Schema` gets an optional field `publish: boolean`. Absent or `true` keeps today's behavior. With `false`, the scheduler's `publish()` writes nothing to `specs/<feature>/*` and only takes the source snapshot; the spec, plan and task graph remain run artifacts (`baked workflow artifacts RUN_ID`, export, delivery). The field is optional with no default, so the hash of every existing definition is unchanged. `quick` sets `"publish": false`. The definition editor keeps unknown fields as it keeps `execution`.

### 5. Feature ID

`featureSlug` moves from `src/components/workflow/format.ts` to `src/core/workflows/feature-id.ts` (the UI re-exports it). `quickFeatureId(store, text)` returns `featureSlug(text)`, with `-2`, `-3`, ... appended while a run with that feature ID exists, so every quick task has its own ID in `workflow list` and usage reports. `--feature ID` overrides it.

### 6. Entry points

- `quick` is added to `PRESETS` and `builtinPresets`, so `workflow definitions`, the editor and the new-run form list it.
- CLI: `baked quick TEXT... [--feature ID] [--model ID] [--events] [--worktree] [--confirm-auto-approval HASH] [--policy FILE]`, also `--prompt-file FILE` instead of TEXT. `src/boot.tsx` routes `quick` to `runWorkflowCli(["quick", ...])`. In the workflow CLI, `quick` is a command that resolves the feature ID and runs `run` with `--workflow quick` (or the project's `workflows.quickWorkflow`, see below), so exit codes, events and the printed snapshot are those of `run`. It refuses to start when the policy has no feature check, with a message that names `workflows.policy.checks`, instead of the schema error an empty check stage would give.
- `baked workflow quick ...` is the same command.
- TUI: `/workflow quick [text]` opens the new-run form with the text and the `quick` workflow preselected. The form already lists presets, so `quick` is also selectable there.
- Config: `workflows.quickWorkflow` (optional, a definition ID) lets a project point `baked quick` at its own copy, for example one with auto approval.

## Expected effect

On the trial feature the run drops research (140k), specify, analyze (part of 28k) and converge (127k), and replaces the planner with a scoped quick planner. Implementation and review are unchanged in this design; their cost is the router's and the implementer budget's job. The trial ran the v1 `sdd` flow, which has converge; `standard` does not. The expected total for the same feature is roughly 400k against 664k, which is the default `maxTotalTokens`, so a run on the default policy may stop on its budget and need `extend`. This is an estimate; a measured run with `baked quick` on a small task is the acceptance for the cost goal.

## Tests

- Preset: `quick` loads, validates against the gate library, appears in `baked workflow definitions`, and is instantiated with the policy checks.
- Golden run with a scripted executor: plan, approval wait, implement, checks, review, completed; no file under `specs/`; `quick-fix` still publishes.
- Plan budget: a request naming one path gives `quick-planner` `min(12, 4 + 2 + 2) = 8` steps, 160k tokens and `researchScope` in its prompt; the generic planner of `quick-fix` keeps 24 steps and no scope.
- `publish: false` writes nothing to `specs/`, and a definition without the field still publishes.
- CLI: `baked quick fix the parser` parses, derives `fix-the-parser`, appends `-2` for an existing feature, rejects TEXT with `--prompt-file`, and passes `--feature` through.
- Feature ID: `featureSlug` behavior unchanged (existing tests move with it).

## Risks

- A one-attempt planner on a vague request ("make it faster") may plan the wrong files. Mitigation: the human approval shows the files, and `quick` is documented for small, located changes; the full flow stays the default.
- AC-001 is automated only when a required check exists. With only advisory checks it is manual, and acceptance waits for evidence from a person.
- The workflow `quick` and the budget preset `quick` of the new-run form share a name; the runtime guide says they are different things.

## Review outcome

An independent review of this design against the code found no blockers and confirmed that a definition without research, specify, analyze and converge runs end to end (approval skips analysis when none is produced, acceptance needs convergence only with a reflection stage, delivery and revise do not depend on published files). Changes made from it:

- The scoped plan budget applies only to scoping planners instead of every plan stage without research, so `quick-fix` keeps its planner limits.
- The step formula adds the submit steps before the cap, the token cap is recomputed from the final step count, and a plan step is budgeted at 20k tokens.
- `quick-planner` has `maxOutputTokens` 16384, like `planner`.
- `baked quick` refuses a policy without feature checks with a clear message.
- `quick` is registered in `PRESETS`, the new-run form gets an initial-workflow prop for `/workflow quick`, and the docs name the six presets and the clash with the budget preset.

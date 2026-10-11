# Role: implementer

You build one app with BAKED, exactly as a user would, and record what it cost and where BAKED needed help. You are a driver and a recorder, not a developer: you never write app code yourself. The numbers you record are the loop's main measurement, so they must be complete and honest.

## Inputs

- `rounds/RNN/apps/<app>/brief.md` (new app), `rounds/RNN/apps/<repo>-update/brief.md` (update) or `controls/<app>.md` (control app, A and B prompts)
- `rounds/RNN/round.json`: runner path and commit, the model for this app, whether it is a control, a new app, an update or the round's experiment
- `config.json` (`runs.*`, `budgets.*`)
- `ledger/workflow-map.md`: workflow preset and settings for the app's task type
- BAKED docs in the runner: `docs/workflows/runtime.md`, `docs/workflows/README.md`, `docs/headless.md`

## Output (in `rounds/RNN/apps/<app>/`)

- `run.json` (shape in `templates/run.json`): run ids, BAKED commit, workflow, settings, models per stage, outcome, tokens, steps, active time, wall time, interventions, corrections, estimate vs actual, notes
- `interventions.jsonl`: one line per intervention
- `workflow-report.md` from `baked workflow report RUN_ID --output ...`
- `usage.json` from `baked workflow usage RUN_ID --json`
- the app itself in `C:\Project\baked-bench\RNN\<app>` (a Git repo)

## Procedure

1. **Workspace.** Create `appsRoot\RNN\<app>`, `git init`, an empty first commit, and the project config BAKED needs: workflows enabled, the round's policy (`clarification`, `sizing`, budgets, auto-approval limits with `allowedPaths` covering `src/**`, `tests/**`, `docs/**`, `README.md`, the stack's config files), and checks for the stack (TypeScript: `bun test`, `bun run typecheck` or `tsc --noEmit`, a formatter/linter with a named fixer; Python: `pytest`, `ruff check` with `ruff check --fix` as fixer). Use the same config for every app of a stack; it lives in `templates/` once the first round fixes it, and a change to it is an experiment.
2. **Preflight.** `baked doctor` and `baked workflow estimate` in the workspace; store the estimate in `run.json`. A refusal is a finding; fix only the config you own (never BAKED code), else stop with `blocked`.
3. **Run.** Start the run with the runner's CLI from the app folder:
   `bun run <runner>/src/boot.tsx workflow run <workflow> --feature <app> --prompt-file brief.md --worktree --writers 3 --clarification assume --model <model> --events`
   (or the built `baked` binary of the runner). Control apps: run A, then B on a copy of A's result when `controlRunsB` is true and A completed. The B run uses a NEW feature ID (for example `url-expiry`), never the A run's feature ID, because the A result's `specs/<feature>/` is already on the default branch. Before B, merge the A run branch into the app repo's default branch.
4. **Drive it to an end.** Watch the events. When the run stops and waits:
   - approval within auto-approval limits happens on its own; any approval you give is an intervention;
   - budget stop: `workflow extend RUN --tokens N --resume` up to `selfRaiseTokensUpTo` (8M) total; beyond that, stop with `budget_cap` and tell the orchestrator;
   - clarification: answer with the most conventional default and the reason, as a careful user would; never answer by expanding scope. Answer an analysis clarification with facts about the workspace (the scaffold files that exist), never by adding scope;
   - provider out of credits or failing: `workflow reroute RUN --model <fallback> --resume` to another configured provider; record it;
   - recovery requests: follow the runtime guide's recommended outcome;
   - repeated identical stops (the same request or error twice after your action): stop the run as `blocked`; looping wastes tokens and hides the finding.
   Every one of these is a line in `interventions.jsonl`:
   `{"ts": ..., "runId": ..., "stage": ..., "category": "resume|extend|answer|approve|recover|reroute|cancel|evidence|other", "why": "...", "evidence": "event id or artifact"}`.
   The category `evidence` is manual evidence supplied after inspecting the code.
5. **Never rescue by hand.** No editing app files, no running fixers yourself, no deleting run state. If BAKED cannot finish, the run is `blocked` and that is a finding.
6. **Record.** After the run ends (completed, blocked, failed, cancelled): `workflow report`, `workflow usage --json`, `workflow status --json`, the estimate, and fill `run.json`. Commit the app result on the app repo's default branch if the run is completed and verified by its own checks (the worktree run branch stays as BAKED left it).
7. **Clean up.** Leave the app folder; remove only stale BAKED worktrees of finished runs through BAKED's own retention commands.

## Updates (brownfield)

An update adds a feature to an existing public repository (`group: "update"`). The procedure differs from a new app in these steps; everything else (preflight, run flags, drive-to-end rules, intervention counting, never rescuing by hand, recording) is the same.

1. **Workspace.** `git clone` the repository's current default branch into a fresh folder `appsRoot\RNN\<repo>-update`. Do not reuse an earlier clone. Add the BAKED project config for its stack (the same scaffold checks as a new app: workflows enabled, the round's policy, `allowedPaths`, the stack's checks and fixer). Keep the repository's own README, tests and linter config as they are; add the BAKED config files in a way that is easy to leave out of the pull request (`.baked/` is not committed; list any other added file in `run.json` notes).
2. **Baseline.** Before the run, install and run the repository's whole test suite and its static checks. Record the result in `run.json` `baseline` (tests passed, failed, total, checks). A red baseline is not rescued by hand: record it, run anyway only if the failing tests are unrelated to the feature, and tell the verifier.
3. **Run.** `workflow run sdd --feature <repo>-<feature-slug> --prompt-file brief.md` with the same fixed settings as every other app (`--worktree --writers 3 --clarification assume --model <model> --events`).
4. **Extras.** BAKED builds the feature. A logo, topics and description named in the brief are produced by the publisher, not by the BAKED run; a `LICENSE` or workflow file named in the brief is part of the run.
5. **Record.** Same files as a new app. `run.json` has `group: "update"`, `repo`, and `baseline`; metrics rows use `group` `update`.

## Outcome values

`completed` (run completed, its checks green), `blocked` (stopped and cannot continue without a change to BAKED or a person), `failed` (runtime error), `budget_cap` (needs more than 8M), `cancelled` (with reason), `skipped` (round budget or wall clock).

## Done

Return `ok` with `run.json` path and outcome, or `blocked`/`failed` with one sentence. The verifier and analyst take over.

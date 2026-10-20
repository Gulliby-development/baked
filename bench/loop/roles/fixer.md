# Role: fixer

You implement issues from the round's fix set in the BAKED repository, as any contributor would, and get them merged. The next round's runs will measure whether your fix worked.

## Inputs

- one issue number from `rounds/RNN/backlog.md` (one fixer call per issue)
- BAKED checkout `paths.dev` (never the runner)
- BAKED's root `AGENTS.md`, `CONTRIBUTING.md` and `docs/`
- the finding's evidence in `rounds/RNN/apps/*/` (run ids, artifacts)

## Output

- a merged PR that says `Closes #N` (or `Refs #N` for part of it), or an open PR with a comment on what blocks it
- a line in `rounds/RNN/backlog.md` under the issue: PR link, merge commit, what to measure next round

## Procedure

1. Read the issue and its evidence. Reproduce the cause when you can: a failing test from the run's inputs is the best start. The issue's **Where** and **Sweep** sections (from the [file-issue skill](../../../.agents/skills/file-issue/SKILL.md)) list every place with the same defect; all of them are in scope. When the issue has no sweep, run steps 1 to 3 of the skill first. A fix for a language-bound bug covers every language the issue's `Languages:` line marks as reproducing.
2. `git fetch origin && git checkout -b feature/<name>` (or `bugfix/<name>`) from fresh `origin/main` in `paths.dev`.
3. Implement the smallest change that fixes the cause; for a broad feature, the smallest complete version of it. Keep core logic in `src/core/` and ship every surface the issue names (TUI, headless CLI, desktop through `baked serve`); open a follow-up issue on the board for a surface you cannot do in this branch.
4. Add or update tests (`bun:test`, hermetic: no home directory, global hooks or provider environment variables). For a P0 or P1 finding, one test is a scripted scenario of the situation from the run: a scripted host or executor (see `ScriptedHost` and `ScriptedExecutor` in `tests/`) gives the model answers that led to the problem (for example a test task reporting a defect in another task's file, or a review with no findings and an inconclusive criterion), and the test fails without the fix. Add one case for each path, stage or toolchain the sweep put in scope, not only the one the run hit. A gate or toolchain fix adds its failing cell to the gate matrix (#854) instead, once that exists. When the finding has an `escapedLayer` other than `round`, the fix adds its check at that layer (a unit or scenario test, a gate-matrix cell, a mini-suite task), and the PR says which. Update the matching page in `docs/`.
5. Run `bun run lint`, `bun run typecheck` (or `typecheck:tsc` on Bun < 1.4.3), `bun test`, `bun run build`. Commit intermediate states after typecheck.
6. Run the sweep searches again on the branch (step 5 of the skill). A new place with the same defect is fixed in this PR, or gets its own issue linked from the PR.
7. Push and open a PR (description: Before / After / How, a `## Sweep` section, `Closes #N`, the finding's run ids, and "Found by the bench loop, round NN"). The Sweep section lists each place from the issue as fixed, each new place from the second sweep (fixed here or its issue), and the places checked and not affected; the `PR description` CI check fails without it.
8. Drive CI to green: read failures, fix, push; at most `fix.maxPrAttemptsPerIssue` (3) rounds. A failure that is red on `main` too is not yours: say so on the PR and take the next issue.
9. When CI is green and `fix.mergeAfterGreenCi` is true, merge (merge commit, as the repository does). Otherwise leave it for the owner and record it.

## Rules

- One issue per branch and PR. No unrelated changes or formatting.
- Never touch the runner checkout, tags, releases, versions, provider keys or `AGENTS.md` rules.
- Respect issues in progress elsewhere: if an open PR or another branch already works on it, stop and record that.
- If the fix turns out larger than the issue said, do the part that removes the observed problem, and file the rest as a new issue linked from the PR.
- Don't break comparability on purpose: a fix that changes defaults the control runs depend on (budgets, workflow defaults, prompts) is fine, but say in the PR and in `backlog.md` which metric it should move.

## Done

Return `ok` with the PR link and merge commit, or `blocked` with the reason.

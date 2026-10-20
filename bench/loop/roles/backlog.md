# Role: backlog

You turn the round's findings and scout ideas into GitHub issues on the BAKED project board, without duplicates, and choose what the fixer builds this round.

## Inputs

- `rounds/RNN/apps/*/findings.md`, `rounds/RNN/scout.md`
- `ledger/findings.jsonl`
- open and recently closed issues of `Gulliby-development/baked`
- `config.json` (`budgets.maxFixIssuesPerRound`, `budgets.minBroadFeaturesPerRound`)

## Output

- issues created or updated on GitHub, each on the board https://github.com/orgs/Gulliby-development/projects/2
- `rounds/RNN/backlog.md`: every finding and idea with its issue number and action (`created`, `commented`, `skipped: reason`), then the **fix set** for this round
- `ledger/findings.jsonl` updated with issue numbers

## Issue rules (from BAKED's AGENTS.md)

- Search first (title keywords, error text, file names). If an open issue covers the cause, add a comment with the new evidence (round, app, run id, numbers) instead of a new issue. If a closed issue's fix did not hold, reopen it with the evidence or file a new Bug that links it.
- Type: Bug (BAKED misbehaves), Feature (new capability or broader option), Task (measurement, cleanup, verification).
- Labels: `area:workflow|tui|desktop|api|ci|release`, plus `verification` for checks needing a real model/device/account, `idea` for large ideas not yet ranked (the backlog role ranks them, see below), `needs-gulliby` only for what only the owner can do or decide (accounts, money, organization settings, security reports). Add `bench-loop` to every issue the loop files.
- Body: first line `Priority: P0|P1|P2`; then Kind (`invariant`, `recovery` or `model-behavior`, with `Seen on` and `Confirmation` from the finding), Fault origin and Escaped layer, Problem (with evidence), Cause, Point fix, Broader option, Expected effect, Surfaces, and the marker `<!-- bench-loop: RNN/<finding-id> -->` so reruns of this step find it.
- For every Bug, follow the [file-issue skill](../../../.agents/skills/file-issue/SKILL.md) first: root cause, sibling sweep and, when the bug is bound to a language or toolchain, the sweep of every supported language. A language that needs its own fix gets its own issue, linked from the finding's issue.
- Board: add the issue with `gh project item-add`, set Status `Backlog` (or `Ready` when it is in this round's fix set) and Priority with `gh project item-edit`.
- Findings with `status: "watch"` get no issue: list them in `backlog.md` under "Watching" with the models they were seen on. When a watched finding is seen again or reproduced on another model, file it.
- Treat open issues labelled `smoke` (filed by the cloud smoke runs) like this round's findings: dedupe against them and rank them for the fix set.
- A finding's point fix and broader option may be one issue (when the broad option is the fix) or two linked issues (Bug + Feature).

## Choosing the fix set

Pick up to `maxFixIssuesPerRound` (6) issues, in this order:
1. P0 issues: anything blocking runs, CI or the runner build.
2. Issues that caused interventions in this round's control apps (they move the main metric).
3. P1 issues seen in 2 or more apps.
4. At least `minBroadFeaturesPerRound` (1) broad feature, the one with the largest expected effect. `idea`-labelled large ideas (scout ideas included) compete here: rank them with the same rules as other issues (expected effect on the main metrics, evidence in this round's findings, size). The top one goes into the fix set when there is room, as the round's broad feature. The loop triages ideas; the owner is not asked to pick.
5. Other P1, then P2 quick wins.

Hot modules ([`.github/hot-modules.json`](../../../.github/hot-modules.json), [error budget](../../../docs/bench-loop.md#hot-modules)): take at most one behavior change per hot module into the fix set; others on the same module wait for the next round. When this round had two or more stops caused by last round's fixes, the fix set takes only reverts and regression fixes in those modules, and `backlog.md` says so.

Skip issues labelled `needs-gulliby` or `deferred`, issues another thread or person is working on (assigned, linked open PR, "In progress" on the board), and and issues that only the owner can decide. `idea` items are not skipped: ranked ideas that do not fit this round stay `idea` on the board, listed in `backlog.md` with their rank.

## Done

Return `ok` with counts (created, commented, skipped) and the fix set as issue numbers.

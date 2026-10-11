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
- Labels: `area:workflow|tui|desktop|api|ci|release`, plus `verification` for checks needing a real model/device/account, `idea` for undecided large ideas, `needs-gulliby` only for what only the owner can do or decide. Add `bench-loop` to every issue the loop files.
- Body: first line `Priority: P0|P1|P2`; then Problem (with evidence), Cause, Point fix, Broader option, Expected effect, Surfaces, and the marker `<!-- bench-loop: RNN/<finding-id> -->` so reruns of this step find it.
- Board: add the issue with `gh project item-add`, set Status `Backlog` (or `Ready` when it is in this round's fix set) and Priority with `gh project item-edit`.
- A finding's point fix and broader option may be one issue (when the broad option is the fix) or two linked issues (Bug + Feature).

## Choosing the fix set

Pick up to `maxFixIssuesPerRound` (6) issues, in this order:
1. P0 issues: anything blocking runs, CI or the runner build.
2. Issues that caused interventions in this round's control apps (they move the main metric).
3. P1 issues seen in 2 or more apps.
4. At least `minBroadFeaturesPerRound` (1) broad feature, the one with the largest expected effect, if it is not `idea`-labelled as needing the owner's choice.
5. Other P1, then P2 quick wins.

Skip issues labelled `needs-gulliby` or `deferred`, issues another thread or person is working on (assigned, linked open PR, "In progress" on the board), and issues needing the owner's decision. Large `idea` items need the owner's pick: list them in the round report instead.

## Done

Return `ok` with counts (created, commented, skipped) and the fix set as issue numbers.

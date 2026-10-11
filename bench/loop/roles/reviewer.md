# Role: reviewer

You decide which candidate apps the round builds and whether each update idea is ready. You are the last check before BAKED spends 1–2M tokens per app and before an app or a change can become public. Be strict: a vague brief costs a blocked run; a useless app costs a public repo nobody wants.

## Inputs

- `rounds/RNN/ideas.md`
- `ledger/ideas.jsonl`, `ledger/published.jsonl`
- `config.json` (`round.newApps`, default 2; `round.ideaCandidates`, default 5; `round.updateApps`, default 3)
- GitHub search access (read-only) to check names

## Output

1. `rounds/RNN/review.md`: one section per candidate and per update idea with a verdict and reasons.
2. For each accepted app, `rounds/RNN/apps/<name>/brief.md`: the final prompt BAKED gets (you may tighten the ideator's brief; record every change). For each accepted update, `rounds/RNN/apps/<repo>-update/brief.md` (see Updates below).
3. Update each candidate's line in `ledger/ideas.jsonl` to `accepted`, `rejected` (with reason) or `revise`.

## Checklist per candidate

Score each item pass / fail with one sentence:

| Check | Fails when |
|---|---|
| Useful | No believable user or situation; a clone of a ubiquitous tool with nothing added; a tutorial app |
| Feasible in one run | More than ~8 source files, external services, accounts, network, GPU, platform-specific APIs, or a domain needing large data |
| Testable | Tests would need network, real time, randomness without injection, or a browser for logic that could be a pure module |
| Brief is precise | Inputs, outputs, flags, exit codes, error cases or accepted formats (with examples) are missing or ambiguous; anything a reviewer would later argue about |
| Cross-platform | Behavior differs on Windows, macOS, Linux and the brief doesn't say how (paths, line endings, shells) |
| Safe and legal | Misuse potential, trademarked names, copying a non-permissive project |
| Name is free | A repository `Gulliby-development/<name>` exists, or the name is a well-known package in the app's ecosystem |
| Adds to the round | Same task type as two others already accepted, or nothing in "why it tests BAKED" |

Verdicts: **accept** (all pass), **revise** (fixable in the brief: list exact changes), **reject** (useful or feasible fails).

## Procedure

1. Score every candidate.
2. Accept the best `newApps` (2) of the new app candidates by usefulness first, then by what they test.
3. If fewer than `newApps` are accepted, return `revise` with the list of what is missing (e.g. "need one UI app, one Python app"). The ideator gets one more call with your review. After 2 revise loops, accept what you have and record the shortfall; the round runs with fewer new apps.
4. Write the final briefs. Add to each, unchanged across rounds, first this fixed sentence (briefs written as noun phrases were narrowed to README + LICENSE by BAKED's spec stage in 4 of 5 round-1 apps): "Build this application in full: the working program with its source code, automated tests, README.md and LICENSE. Do not reduce the task to documentation; the source code and tests are the main deliverable." Do not say that the repository starts empty: the benchmark scaffold already holds package.json or pyproject.toml, a linter config, .gitignore and a heading-only README; if the brief mentions the starting state, say it holds only a minimal project scaffold. Then these three lines:
   - "Write a README.md: what it is, who it is for, install, usage with examples, development (how to run tests)."
   - "Use an MIT LICENSE file." (the publisher replaces holder and year)
   - "Keep the project cross-platform (Windows, macOS, Linux)."

## Updates

Review each update idea separately. Score every item pass / fail with one sentence:

| Check | Fails when |
|---|---|
| Useful | Nobody using the tool would miss the feature |
| Small | More than 3 source files, a new dependency, a rewrite, or a change that cannot be tested in one run |
| Testable | Needs network, real time or randomness without injection |
| Brief is precise | What the feature does, flags, outputs, exit codes, error cases, the README change (section and example) or the version or changelog line (when the repository has one) is missing or ambiguous |
| No duplicate | An open issue, an existing flag or an earlier ledger entry already covers it (check `gh issue list --repo Gulliby-development/<repo>` and the repository's README) |
| No breaking change | Existing flags, output formats or exit codes change |
| Public repository | The repository is not public, is a fork, is archived, or is BAKED itself |

A CI pipeline is a valid feature only when the repository has no `.github/workflows`; it must use the repository's real commands and a three-OS matrix, and the brief must name them.

**Optional extras** are small hygiene items bundled as a side part of an update, never as the whole update. Each extra the ideator proposes must be listed in the brief, and each must be justified by the repository's current state: an MIT `LICENSE` only where the repository has no license at all (never replace or edit an existing license); a logo or icon when the README has none; GitHub topics and a description when the repository has none; a README badge or section only when clearly missing. Reject an extra that the repository already has, and reject an update whose extras are bigger than its feature.

Verdicts as for new apps: accept, revise (list exact changes), reject. A rejected or unfixable update leaves the repository out of this round; record it, and do not replace it with another pick (the pick is reproducible from the seed).

Write `apps/<repo>-update/brief.md` for each accepted update. Do NOT use the fixed "build in full" sentence (that is only for new apps). The brief starts with exactly this sentence: "Add this feature to the existing project in the current folder. Keep every existing behavior and test passing; add tests for the feature and update README.md. Do not change anything unrelated." Then the feature description, flags, outputs, exit codes, error cases, the README change, the version or changelog line when the repository has one, and the list of optional extras (the logo, topics and description are produced by the publisher; the brief says what they should be about). Do not ask for a new README from scratch.

## Done

Return `ok` with the accepted new app names and accepted updates, or `revise` with what is missing.

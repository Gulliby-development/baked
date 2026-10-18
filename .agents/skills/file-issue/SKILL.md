---
name: file-issue
description: Use every time you open or update a GitHub issue for a BAKED bug or finding. Finds the root cause, sweeps the code for every other place with the same or a neighbouring defect, and files one issue that covers all of them.
---

# File an issue with a sibling sweep

A fix that changes only the place where a bug showed up leaves its siblings behind: the same logic copied into another stage, another toolchain, another provider or another front end. An audit of one week of fixes (84 PRs) found 31 such siblings (#1405 to #1435). This skill makes the issue name every affected place before anyone starts the fix.

Run it before you create or extend any Bug issue, including issues filed by the bench loop, smoke runs and review findings. Keep the sweep small: about 15 minutes or 20 tool calls. It is research, not a fix.

## 1. Name the root cause

Read the code at the point of failure until you can say in one sentence which rule or computation is wrong, not only what the symptom was. For example, "a glob boundary is counted as one path", not "the estimate was too low".

## 2. Sweep for every occurrence

Search current `main` for each kind of sibling below. Use `rg` on the helper, constant, regex, error text and field names involved.

- **Copies of the computation.** Other call sites that compute the same thing their own way instead of through the helper. For example, `boundary.paths.length` next to `literalPathCount`, or `pathsInOutput` next to `failingPathsInOutput`.
- **Parallel paths.**
  - Stages: research, spec, plan, task, checks, review, convergence, integrator, acceptance.
  - Fresh start vs resume, rebase or undo.
  - Planned tasks vs correctives.
  - Timers and background loops next to the one that failed.
- **Toolchains.** bun, jest, vitest, node:test, pytest, mypy, ruff, black, go, cargo, dotnet, Maven and Gradle. Check output parsers, failure lines, count summaries, module and import rules, and command spellings (`npx`, `bunx`, `uv run`).
- **Providers.** Codex, Claude Code, Claude API, OpenAI, GitHub Copilot and GitHub Models.
- **Surfaces.** TUI, headless CLI, `baked serve` API and the desktop app. Also check Windows, macOS and Linux.
- **Branches of the same decision.** Every case of the switch, every mode (assume, ask, tiered) and every cause or status, not only the one that was hit.
- **Changes made by the host vs by a person.** Budget, cap or policy growth the host makes itself, compared against something a person approved.
- **Inputs that arrive later.** Decisions taken before sequencing, clarification answers, edits made during the attempt, or a policy another attempt already changed.
- **Edge cases of earlier fixes.** Check `git log -S<symbol>` and recent `bugfix/` merges on the same code for an off-by-one, an empty list, double counting or a first-match-wins lookup.

Sort each place you check into one of three groups:
- **same defect:** it goes into this issue's scope;
- **related but different:** it gets its own issue, linked from this one;
- **checked, not affected:** list it with the reason.

## 3. Check for duplicates

Search open issues and those closed in the last two weeks by symbol, file and error text. If a closed fix did not hold, link it and say which sibling it missed.

## 4. Write the issue

Follow the rules in `AGENTS.md`: the type, labels, the board and the `Priority: P0|P1|P2` first line. The body has these sections:

- **Problem:** the root cause in one or two sentences, with the evidence (run, numbers, output).
- **Where:** every affected `file:line` on current `main`, with the sibling places included.
- **Scenario:** concrete inputs or state that lead to the wrong behaviour.
- **Sweep:** what you searched, the same-defect places, the linked related issues, and the places checked and not affected.
- **Suggested fix:** prefer one shared helper or rule that all the places use over separate patches at each site.
- **Tests:** a test that fails without the fix. For P0 and P1 bench findings this is a scripted scenario test. Add one case per affected toolchain or path from the sweep.

## 5. When you fix an issue filed this way

Fix every place listed under **Where**. Before opening the pull request, run the sweep searches again on the branch. A new place gets fixed in the same pull request, or gets its own issue linked from the pull request.

Report it in a `## Sweep` section of the pull request description:

- each place from **Where**, fixed;
- each new place the second sweep found: fixed in this pull request, or the new issue's number;
- the places you checked that are not affected, with the reason.

The `PR description` workflow fails a pull request that closes a Bug issue (issue type Bug or label `bug`) when this section is missing or empty. Edit the description to fix it; no new push is needed.

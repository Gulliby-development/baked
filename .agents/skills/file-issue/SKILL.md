---
name: file-issue
description: Use every time you open or update a GitHub issue for a BAKED bug or finding. Finds the root cause, sweeps the code for every other place with the same or a neighbouring defect, including every supported language when the bug is bound to one, and files issues that cover all of them.
---

# File an issue with a sibling sweep

A fix that changes only the place where a bug showed up leaves its siblings behind: the same logic copied into another stage, another toolchain, another provider or another front end. An audit of one week of fixes (84 PRs) found 31 such siblings (#1405 to #1435). This skill makes the issue name every affected place before anyone starts the fix.

Run it before you create or extend any Bug issue, including issues filed by the bench loop, smoke runs and review findings. Keep the sweep small: about 15 minutes or 20 tool calls, plus about 10 more for the language sweep when the bug is bound to a language. It is research, not a fix.

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
- **Languages.** When the bug is bound to a language, run the language sweep in step 3 as well.
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

## 3. Sweep every supported language

A bug is bound to a language when the failing code branches on a language, a file extension, a manifest, a toolchain or a test-file convention, or when the bug showed up only in a project of one language. Fixes for such bugs tend to patch the one language the run used and leave the others with the same hole. So for each language BAKED supports, decide whether the same failure reproduces there.

Take the list of languages from the code on current `main`, not from memory, because it grows:

- `src/core/intelligence/types.ts` (`EXT_TO_LANGUAGE`): every language BAKED detects by extension.
- `src/core/intelligence/language-traits.ts` (`LANGUAGE_TRAITS`): code, source, test-file and manifest rules per language.
- `src/core/workflows/gates.ts` (`detectGates` and the `*Gates` helpers): the toolchains whose checks BAKED proposes and whose output it parses.
- `src/core/workflows/language.ts` (`detectLanguages`): the project languages that get a language review profile.
- `src/core/intelligence/backends/lsp/server-registry.ts` and `src/core/intelligence/backends/tree-sitter.ts`: language servers and grammars.
- Other per-language tables the failing code reads: comment syntax, import and module rules, scope patterns in the regex backend, quality rules in `src/core/workflows/quality/`.

For each language, decide from the code (and from a quick scripted check when it is cheap, such as a fixture in a temporary directory or a test case in `tests/language-traits.test.ts`, `tests/cross-language.test.ts` or `tests/gate-matrix.test.ts`) which group it is in:

- **reproduces:** the same input shape fails there too, or the code shows it would (the same table entry is missing, the same parser ignores that toolchain's output, the same regex misses that convention);
- **different defect:** a neighbouring failure with its own cause;
- **not affected:** the language takes another code path, with the path named;
- **not supported:** BAKED has no support for the feature in that language yet; link the open issue if one exists (for example the deferred per-language issues).

Then file:

- When one shared fix covers every language that reproduces (one table, one helper), keep them in this issue: each language's place goes under **Where** and gets its own case under **Tests**.
- When a language needs its own fix (its own parser, toolchain, manifest or convention), file a separate Bug issue for it with this skill, titled with the language, and link it from this issue and back. Do not leave a reproducing language only as a note.
- A **different defect** gets its own issue too, as in step 2.

Record the result in the issue's **Sweep** section under a `Languages:` line that names every language and its group. A bug that is not bound to a language says `Languages: not language-bound` with the reason in a few words.

## 4. Check for duplicates

Search open issues and those closed in the last two weeks by symbol, file and error text. If a closed fix did not hold, link it and say which sibling it missed.

## 5. Write the issue

Follow the rules in `AGENTS.md`: the type, labels, the board and the `Priority: P0|P1|P2` first line. The body has these sections:

- **Problem:** the root cause in one or two sentences, with the evidence (run, numbers, output).
- **Where:** every affected `file:line` on current `main`, with the sibling places included.
- **Scenario:** concrete inputs or state that lead to the wrong behaviour.
- **Sweep:** what you searched, the same-defect places, the linked related issues, the places checked and not affected, and the `Languages:` line from step 3.
- **Suggested fix:** prefer one shared helper or rule that all the places use over separate patches at each site.
- **Tests:** a test that fails without the fix. For P0 and P1 bench findings this is a scripted scenario test. Add one case per affected toolchain, language or path from the sweep.
- **Maintainability:** when the suggested fix adds a shared helper, table or registry that later code must use or extend, name the rule that keeps it complete: a line in `AGENTS.md`, or a skill under `.agents/skills/` linked from it when the rule is large (see "Keep extension points maintainable" in `AGENTS.md`). Otherwise write `None`.

## 6. When you fix an issue filed this way

Fix every place listed under **Where**. If the issue names a rule under **Maintainability**, add that rule to `AGENTS.md` (or the linked skill) in the same pull request. Before opening the pull request, run the sweep searches again on the branch. A new place gets fixed in the same pull request, or gets its own issue linked from the pull request.

Report it in a `## Sweep` section of the pull request description:

- each place from **Where**, fixed;
- each new place the second sweep found: fixed in this pull request, or the new issue's number;
- the places you checked that are not affected, with the reason;
- a `Languages:` line: the languages the fix covers and how each was checked, the linked issues for languages that need their own fix, or `Languages: not language-bound` with the reason.

The `PR description` workflow fails a pull request that closes a Bug issue (issue type Bug or label `bug`) when this section is missing, empty or has no `Languages:` line. Edit the description to fix it; no new push is needed.

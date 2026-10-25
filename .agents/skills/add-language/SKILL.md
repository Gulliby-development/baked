---
name: add-language
description: Use when adding a language to BAKED (a new entry of SUPPORTED_LANGUAGES) or filling the `none` rows of a supported one (gate detector, test runner, formatter, reviewer, the per-language issues #1489-#1500), before writing code and again before opening the pull request.
---

# Adding or completing a language

A language in BAKED is not one switch. It is a row in about twenty per-language tables plus a dozen detectors and parsers that still keep their own lists. Every earlier language fix that was written against the one run that exposed it left the same defect in the other languages (see [Lessons](#lessons)). This skill is the checklist that keeps a language pull request from stepping on the same rakes again.

One pull request per language (or per toolchain of a language), on a `feature/<language>-language-support` branch from fresh `main`, closing its issue. Remove the issue's `deferred` label when you take it.

## 1. Find what is missing

1. Read the language's issue and the issues it links. Its `file:line` references may be stale: the tables moved to `LanguageRecord`s in #1717 and #1733, and #1488, #1749 and #1753 filled several rows since. Re-check every claimed gap on current `main`.
2. List the language's empty rows: `grep -rn "^\s*<language>: none(" src`. Each `none(reason)` is either a real "this language has no such thing" (keep it) or a "not done yet" (the reason names an issue or says "yet"/"not read"/"not recognized"): those are the gaps.
3. Walk the layers below that are not `LanguageRecord`s. They do not fail the compiler or the parity test when a language is missing, so check each by hand.
4. Run the language's fixture through `tests/language-parity.test.ts` (`bun run test tests/language-parity.test.ts`); a golden that still says `null` for a row you fill must change in the same branch.

## 2. The layers

### Records (the compiler and `tests/language-parity.test.ts` ask for them)

| Record | File | What a row holds |
|---|---|---|
| `TEST_CONVENTIONS`, `TEST_MARKERS`, `MANIFEST_NAMES` | `src/core/intelligence/language-traits.ts` | test file names; what a test file holds when the name is a plain word (#1848); manifests by file name |
| `GATE_TOOLCHAINS` + `TOOLCHAIN_GATES` | `src/core/workflows/gates.ts` | which detectors the language gets, in order |
| `FILE_FORMATTERS` | `src/core/workflows/format-written.ts` | the formatter gate's file-scoped check and write forms, `range` form and `probe` |
| `TEST_RUNNERS` (+ `TEST_COUNTERS`, `FAILED_TESTS`) | `src/core/verification/output-counts.ts` | test count with `ran`, failed test names, a stable failure signature |
| `TEST_GATES` | `src/core/workflows/test-gates.ts` | build gates a test file declares (features, tags) and the flag that turns them on |
| `DEPENDENCY_MANIFESTS` | `src/core/workflows/quality/manifests.ts` | dependency reader with `fields` (executable fields, #1793) |
| `ENTRY_POINTS` | `src/core/verification/entry-points.ts` | how a command the project installs is launched |
| `PLACEHOLDERS` | `src/core/workflows/quality/builtin-rules.ts` | unimplemented-body idioms, and not the language's legitimate look-alikes |
| `MASK_SYNTAX` | `src/core/workflows/quality/code-mask.ts` | comments and strings, including raw strings and long brackets |
| `CALL_SYNTAX` | `src/core/intelligence/call-context.ts` | call and import spellings |
| `NUMERIC_LIMITS` | `src/core/verification/edge-inputs.ts` | the integer and float edges worth a probe |
| `MUTATION_TOOLS`, `PROPERTY_LIBRARIES`, `PACKAGE_CONTENTS` | `src/core/workflows/quality/` | mutation tool, property libraries, package build |
| `INLINE_HARNESS` + `TEMPLATES` (keyed by test framework) | `src/core/workflows/acceptance-rows-inline.ts`, `acceptance-rows.ts` | acceptance rows of a new test framework, both modes (#1763) |

Every row you fill gets its golden in `tests/fixtures/languages/<language>.json`.

### Lists outside the records (check each by hand)

- **Extension and grammar**: `EXT_TO_LANGUAGE`, `BARE_FILENAME_TO_LANGUAGE` (`src/core/intelligence/types.ts`), the tree-sitter queries (`backends/tree-sitter.ts`), imports in `repo-map.ts`. A grammar that `tree-sitter-wasms` lacks goes in `vendor/tree-sitter/` with a README row (source, version, how it was built) and its license file; `resolveWasm`, the bundles and `postinstall.mjs` already copy that folder (#1499). Vendor the `.wasm`, never an npm grammar package that runs node-gyp on install.
- **Syntax check**: `CHECKED_GRAMMARS` in `src/core/intelligence/syntax-check.ts`. Add a grammar only after it parses real projects without false errors: run it over the files of a few real packages that the language's own compiler accepts (`luac -p`, `ruby -c`), measured on a real corpus (published packages of the language), not on the fixture. A grammar that lags the language stays out, with a comment and the count (Kotlin; Ruby 5 of 2,618 files; Lua 374 of 1,133; tree-sitter-powershell 27 of 98 real scripts, #1498).
- **Language server**: `SERVER_CANDIDATES` and `SERVER_PROJECT_STATE` in `backends/lsp/server-registry.ts`, the installer. A server that writes project files into the checkout (jdtls `.project`, #1508) gets its files in `SERVER_PROJECT_STATE`.
- **Agent profile and edit-time format**: `detectToolchain` in `src/core/tools/project.ts`, read by `tools/auto-format.ts`; build it from the gate detector (`composerGates`, `luaGates`) so the agent runs what the checks run, and give the formatter a stdin probe in `formatProbeCommand`, or an edited file is never formatted. Read the tool's config from every place the tool reads it (ruff in `pyproject.toml`, #1537; prettier in `package.json`, rustfmt's edition, #1681).
- **Language reviewer**: `ProjectLanguage`, `detectLanguages`, `LANGUAGE_FILE` in `src/core/workflows/language.ts`, and the `language-reviewer` profile text (`src/core/agents/profiles/builtin.ts`) for the language's platform pitfalls.
- **Check routing**: `STATIC_COMMAND`, `WHOLE_UNIT_COMMAND`, `fixerCommand` and the style-claim lists in `src/core/workflows/check-policy.ts` (a tool named in `FORMAT_CLAIM` or `LINT_CLAIM` also needs `FORMAT_COMMAND` or `LINT_COMMAND`, or a passing gate never shows the claim; PHP missed it, #1495); `isTestCheck` in `quality/mutation.ts` (a check-mode flag such as Pint's `--test` is not a test run); the program behind an interpreter or runner in `toolchainCommand` (`src/core/workflows/toolchain.ts`); `CHECK_COMMAND` in `src/core/verification/criteria-cases.ts` (#1427); `noTestsCollected` and `MISSING_PATH_LINES` in `src/core/verification/convergence.ts` (#1208, #1913); `timedOutFailure` in `check-runner.ts` (#1424); `REPLAY_TARGETS` in `quality/baseline-replay.ts` (#2020); `diagnosticCount` in `output-counts.ts` (#1791, #1326).
- **Scoped tests**: `src/core/workflows/affected-tests.ts`: its own `isTestFile` and `isCompiledTestFile` (which files a task's written-tests check runs; Ruby's runner branches landed without them, so no written spec ran until #1495), the value-taking flags `flagsOnly` keeps, the runner's file or filter form in `affectedTestCheck`, and the per-test timeout in `test-timeout.ts` (#1655).
- **Test integrity and code rules**: the skip markers (`SKIPS`, or a framework's own `skips` in `src/core/intelligence/test-frameworks.ts`), `CAPABILITY` guards and `SUPPRESSIONS` in `src/core/workflows/test-integrity.ts`, with their lists in the diff-check paragraph of `docs/workflows/runtime.md`, the assertion forms of the language's frameworks (#1651), and the `lint-suppression` rule in `quality/builtin-rules.ts` with its row in `docs/workflows/code-quality.md`.
- **Workspace and baseline**: `workspace-facts.ts`, sizing manifests (`sizing.ts`), `TOOL_CACHES` (`src/core/verification/snapshot.ts`) and `FIRST_RUN_OUTPUTS` (`tests/helpers/baseline-created-files-scenario.ts`) for files a first build writes (Cargo.lock, #1815).
- **Manifest approval**: `requestedManifestEdits` in `auto-approval.ts` (#1552, #1428) and the toolchain-selecting files (wrapper distribution, SDK pin, #1963).
- **Repro and examples**: `reproExecutables` in `src/core/verification/repro.ts` adds the language's runtime for its build tool (#1529); a documented example that needs a build is built first (#1035).

## 3. Rakes we already stepped on

Each line is a past bug. A new detector, parser or table row answers it before review does.

1. **Windows wrappers.** `gradlew.bat`, `mvnw.cmd`, LuaRocks and Composer `vendor\bin\*.bat` run through `cmd /d /c`, which `launchedCommand` unwraps (#1749). Give every command a Windows form and a gate-matrix cell for it.
2. **Whole unit or per file.** A linter or analyzer that resolves imports cannot pass in a task's isolated worktree: it is whole-unit (#584, #799, #1753). A formatter is per file, and its fixer takes the task's file, never `.` or the whole crate (#587, #840, #1228, #1269, #1593).
3. **Formatter flags and configs.** A range or file flag that older releases lack sets `probe` (#1907). Edit-time format reads the project's own config and never reformats a whole file that was not clean (#1582), within the 30 s limit (#1429).
4. **Failure signatures.** Strip durations, timings and pass counts so the same red check is recognized again (#1189, #1425, #1678).
5. **Failure lines and files.** The runner's failed-test and failing-file lines feed correctives, waits and hangs (#1419, #1420, #1424). Read only failing files, not every file the output names.
6. **Empty and missing.** The runner's "no tests" output and exit code (pytest 5, #1208, #1031, #1864) and its "path does not exist" line (#1913) are read, so a task that runs before its tests exist is not corrected.
7. **Diagnostics.** Count errors and warnings only, from the tool's default output format (#1791, #1326).
8. **Gated tests.** A test file gated by a feature, tag or build condition that the command does not turn on runs zero tests: `TEST_GATES` and `requireTests` (#1832).
9. **Test file names.** A plain-word name (`PermTest`, `FeatureSpec`) names domain code too, so it needs a `TEST_MARKERS` match outside a test folder (#1683, #1848).
10. **Placeholders and idioms.** Recognize the language's "not implemented" forms (#1679, #951) without flagging its legitimate look-alikes (Ruby's abstract `NotImplementedError`, Java's read-only `remove()`).
11. **Properties and assertions.** Recognize the language's property libraries and loops (#1064, #1686) and assertion frameworks (#1651).
12. **Manifests.** Read every form of the manifest (tables, extras, groups, catalogs, #1682), and register new projects or modules a later task adds (#1684, #1299, #1412).
13. **Host-written code must be clean.** The acceptance rows the host writes pass the language's formatter and linter as configured, carry no raw control characters or BOM, and keep one type per file where the language expects it (#1927, #1942, #1995, #1804, #1961).
14. **Tools that write into the checkout.** Language servers and first builds leave files (#1508, #1815): list them, or the run blocks `input_changed`.
15. **Runtimes for examples.** The README of a project builds and runs with the language's runtime, not only its build tool (#1529, #1035).
16. **Detectors replace the runner fallback.** `detectGates` offers a Makefile, justfile or CI step only when no toolchain detector found anything, so a detector that fires on a config file of a side tool (a `.shellcheckrc` in a C project) would hide `make test`. Shell gates are added on top for that reason (#1497); a new detector for a side tool does the same.
17. **Shared runners carry their totals.** A harness that several languages run through (TAP::Harness behind `prove` and `pg_prove`) prints a summary with totals and CPU times; strip them in `GROWING_COUNTS`, or the same red check never matches again (#1499).
18. **Grammar ERROR nodes.** A grammar that cannot parse part of the language (PL/pgSQL bodies in tree-sitter-sql) turns that part into `ERROR` nodes; match the declaration inside the `ERROR` node too, or its symbols vanish from the call graph (#1499).
19. **A linter that passes broken files.** A linter run at error severity can still pass a file that does not parse (PSScriptAnalyzer needs `ParseError` next to `Error,Warning`); give its gate-matrix cell a file with a syntax error (#1498).
20. **Every runner in the replay table.** `tests/workflow-baseline-replay.test.ts` holds a `FAILURES` and a `BUILD_ERRORS` row for every runner in `BUILD_FAILURES`; a new runner adds both (#1498).
21. **Tools that survive HOME isolation.** Tests run with a temporary HOME, so a tool installed for the current user (PowerShell modules in CurrentUser scope, pip user site) vanishes in them: install CI and device tools for all users (#1498).
22. **Output on a CI runner.** A runner that detects CI (`GITHUB_ACTIONS`, `TF_BUILD`) can change its output: Pester prefixes failed tests with `::error::`. Turn that mode off in the gate's command and run the real gate-matrix cell with `GITHUB_ACTIONS=true` before pushing (#1498).
23. **Build trees are not sources.** A check that writes into the checkout on every run (a CMake `build/` folder) makes every later check `source_changed` unless the project ignores it; `sourceManifest` skips a folder holding `CMakeCache.txt` (#1490). A tool that needs a configure or build step first gets that step as its own gate, in order, since a check runs without a shell.
24. **Preprocessor lines are code.** The integrity and rule scanners treat a line that starts with `#` as a comment; `#if`, `#ifdef` and `#elif` stay code, so a C or C++ skip under `#ifdef _WIN32` reads as guarded (#1490); Swift's `#if os(...)` guards and `#expect`/`#require` assertions are code too (#1492).
25. **Bench files the root `.gitignore` hides.** `bin/`, `build/` and the like are ignored at the root, so a bench task's `seed/bin/` or `solution/bin/` is never committed: run `git status --ignored bench/` before the pull request and `git add -f` them (#1497).
26. **A framework's own skip spellings.** RSpec's `xit`, ScalaTest's `ignore`, package:test's `skip:` go in the framework's `skips` column of `test-frameworks.ts`, not in the shared `SKIPS`, so they never match another language's code (#1493, #1494, #1496).
27. **Output flags are not static checks.** A flag that only picks the output format (`rspec --format`) leaves the check a test run in `isStaticCheck` (#1493).
28. **Load failures in the summary.** A runner that counts a test file that did not load as a failure (`dart test`'s `loading x_test.dart [E]`) needs it subtracted from the test count and read as a build failure, not a failed test (#1494).
29. **Shared assertion rows.** A shared row (the JavaScript `expect`) can misread another language's argument order; add a scoped row whose calls come first (#1494).
30. **Formatters that exit 0 on a missing path.** `dart format` prints `No file or directory found` and exits 0: it needs a `MISSING_PATH_LINES` entry, or a task that formats a file it has not written passes (#1494).
31. **Runners that print no totals.** Gradle prints no test count; read the reports it writes (`build/test-results/**/*.xml`) and append them to the check output (#1489).
32. **The first run compiles.** sbt and SwiftPM print compile and build-step lines only on the run that compiles; strip them from the failure signature, or a repeated failure looks new (#1496, #1492).
33. **Build-tool formatters.** A formatter that runs through the build tool (`sbt scalafmtOnly`) needs a fixer that passes the file inside the same build command, not as a separate argument (#1496).
34. **Real output only.** Parser cases are pasted from a real run of the tool. In the cloud, Maven Central's Google mirror (`maven-central.storage-download.googleapis.com/maven2`) and Docker images (`sbtscala/scala-sbt`, `swift`) give real JVM and Swift tools where the default downloads are blocked (#1496, #1492).
35. **One table, all languages.** When a fix for this language touches a shared rule, sweep it across every supported language (the [file-issue skill](../file-issue/SKILL.md), step 3), and prefer a table row over a wider regex.

## 4. Tests

- The language's fixture `tests/fixtures/languages/<language>.json` with goldens for every row you fill (`bun run test tests/language-parity.test.ts` prints a missing golden ready to paste).
- A `describe("gate matrix: <toolchain> (#issue)")` block in `tests/gate-matrix.test.ts`, like the #1749 and #1753 blocks: detection from each manifest (and its absence), the Windows wrapper form, routing (`isWholeUnitCheck`, `fixerCommand` on the task's file, `coveringChecks`), `noTestsCollected`, the test count and a stable `failureSignature`, and the "path does not exist" line.
- A real-tool cell under `describe.skipIf(!toolchains)("gate matrix: toolchains")` with `test.skipIf(!available([[tool, "--version"]]))`, so CI and the laptop run it where the tool is installed.
- Parser cases from real tool output, pasted from a real run, never written from memory.
- A bench-suite task `bench/suite/tasks/<language>-<toolchain>-<what>/` (see the [bench-suite skill](../bench-suite/SKILL.md)) so the nightly suite and the bench loop run the language.
- The estimate backtest (#1649) when the pull request changes sizing, estimates or forecasts (a language weight, a test-task price).

## 5. Surfaces and docs

- A row in the gate table of `docs/workflows/runtime.md` ("Gates, budgets and estimates"), and the test-integrity, baseline and reviewer sections that list languages.
- The feature registry (`src/core/features/registry.ts`) only when the pull request adds a slash command, `/v1` route or desktop screen. Gate detection reaches the TUI gate editor, `baked workflow gates` and the desktop Gates window through the same `detectGates`; check that a new gate id renders there and say so in the pull request.
- A Windows, macOS or Linux difference (no shell tools on Windows, bash 3.2 on macOS) is handled in the detector, not left to the user.

## 6. After the merge

- Tell whoever runs the bench loop that the language is merged, with the toolchain the laptop needs, so the loop adds it to its language rotation.
- A toolchain the cloud containers lack (.NET, PHP, Swift and others) is checked on a device before its bench-suite task graduates.

## Lessons

Sources of the rakes above, worth a re-read before a language pull request:

- #1488 and #1717 (one language table, exhaustive per-language records and fixtures) and #1733 (the remaining tables converted).
- The 2026-10-17 sibling audit, #1405-#1435: toolchain coverage is uneven, and one fix leaves the other copies of a computation.
- The 2026-10-20 language sweep, #1678-#1686: fixes written for the language of the run that exposed them missed the other languages.
- Closed Bug issues on toolchains: #587, #1208, #1228, #1326, #1424, #1425, #1508, #1529, #1537, #1582, #1593, #1749, #1753, #1791, #1815, #1832, #1848, #1907, #1913, #1963, #1995.
- The 2026-10-25 language lines (Ruby #2120, Kotlin #2122, Dart #2127, Scala, Swift): rakes 26-34.

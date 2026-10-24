# Code quality gates

Quality gates of workflow runs measure the code a run writes beyond what its checks and reviewers test. Each gate has a default for new runs, set per project or for all projects, and every run freezes its value in the run policy, so the approval digest covers it and a later change of the default does not change a running run.

| Gate | Policy field | Values | Default |
| --- | --- | --- | --- |
| [Duplication and dead-code ratchet](#duplication-and-dead-code-ratchet) | `duplication` | `off`, `warn`, `ratchet` | `warn` |
| [Anti-slop rule pack](#anti-slop-rule-pack) | `qualityRules` | rules turned off, severities, ast-grep rule files | every built-in rule on |
| [Dependency check](#dependency-check) | `registryLookups` | `false` turns lookups off | on |
| [Semgrep](#semgrep) | `sast`, `sastConfig` | `auto`, `off`; a Semgrep `--config` | `auto`, `p/default` |
| [Property-based tests](#property-based-tests) | `propertyTests` | `auto`, `off` | by preset: `auto` for `standard` and `full` (the `sdd` workflow), `off` otherwise |
| [Mutation gate](#mutation-gate) | `mutation`, `mutationThresholds`, `mutationBudgetMs`, `mutationEngine` | `off`, `advisory`, `required`; percent per path; time; `auto`, `built-in` | by preset: `advisory` for `full` (the `sdd` workflow), `off` otherwise; `auto` |
| [Baseline replay](#baseline-replay) | `baselineReplay` | `on` (absent is off) | off |
| [Package contents](#package-contents) | `packageContents` | `on` (absent is off) | off |
| [Finding chain rewrite](runtime.md#finding-chains) | `chainRewrite` | `on` (absent is off) | off |
| [Misquote host fix](runtime.md#test-integrity) | `misquoteFix` | `on` (absent is off, recorded in shadow) | off |

Where the defaults are set:

- terminal UI: `/code-quality` (or **Code Quality** in `/settings`), saved to the project or the global config;
- desktop: Settings, Chat settings, **Code quality** page;
- local API: `PATCH /v1/settings` with `quality.duplication`, `quality.disabledRules`, `quality.registryLookups`, `quality.sast`, `quality.propertyTests`, `quality.mutation`, `quality.mutationEngine`, `quality.baselineReplay`, `quality.packageContents`, `quality.chainRewrite` and `quality.misquoteFix` ([chat settings](../desktop/api.md#chat-settings));
- config file: `quality` in `.baked/config.json` or `~/.baked/config.json`.

A run can override the default at start: `baked workflow run --duplication off|warn|ratchet`, `--sast auto|off`, `--property-tests auto|off` and `--mutation off|advisory|required`, or `duplication`, `sast`, `propertyTests` and `mutation` in `POST /v1/workflow/runs`. The order is the run flag, then the policy's own field (`--policy FILE` or `workflows.policy`), then the `quality` setting, then the built-in default.

## Duplication and dead-code ratchet

AI-written code tends to copy instead of reuse. The ratchet compares the run's code with the code it started from:

1. **Baseline.** When the plan is approved, before any task edits a file, the host reads the code files of the source snapshot and records `quality/baseline.json`: the counts below, the token windows that already occur more than once, and the declarations that are already unused. A revised plan keeps the first baseline.
2. **Comparison.** In each checks stage, after the command checks pass, the host measures the code again and records `quality/duplication.json` with the counts before and after, the copies the run added and the unused declarations it added.
3. **Verdict.** Under `ratchet` each added copy and each added unused declaration becomes a blocking finding, and the run corrects it like a failed check: the finding names the original (`Duplicated code: src/report.ts:1-8 copies src/range.ts:1-8`) and asks to reuse it. Once a later comparison finds nothing new, the earlier findings are resolved. Under `warn` the same results are kept as notes; they never block. `off` skips both measurements.

What is counted:

- **Duplicated lines.** Runs of at least 50 tokens over at least 5 lines that occur more than once in non-test code (comments ignored, identifiers and literals compared as written). A copy is reported when it is in a file the run changed and the window occurs more often than at baseline; the original is an occurrence in a file the run did not change when there is one.
- **Unused declarations.** Top-level functions, classes and arrow-function constants (JS/TS), `def` and `class` (Python), `func` (Go) and `fn` (Rust) whose name appears nowhere else in the code, tests included. Entry files (`index`, `main`, `mod`, `lib`, `cli`, `app`, `server`, `__init__`, `__main__`, `setup`, `conftest`), `export default`, declarations under a decorator or attribute, and names a runtime calls by convention (`main`, `init`, `Test*`, `test*`, `Benchmark*`) are not counted.
- **Complexity.** Branch points (`if`, loops, `case`, `catch`/`except`, `&&`, `||`, `?`) in non-test code. Reported only, never blocking.

Test files are read, so a function only a test calls is used, but are not counted as copies: tests repeat their setup. The analysis is built in and needs no tool on the machine; files above 256 KB are left out, and a repository with more than 32 MB of code is skipped with a note (never blocking).

The planner is told to search for an existing helper before a task adds one and to name it in the task's read hints; the implementer is told to import code that exists instead of copying it.

The [run report](runtime.md#run-report) has a **Code quality** section with the mode, the verdict (`clean`, `noted` or `blocking`), the deltas (`duplicated lines 120 -> 134 (+14)`, unused declarations, complexity) and a table of what the run added. `baked workflow report`, the TUI run report, `GET /v1/workflow/runs/RUN_ID/report` and the desktop run page show the same report; the two artifacts are listed with the run's other artifacts.

## Anti-slop rule pack

Agents often leave code that passes the tests but hides failures. The rule pack is always on. In each checks stage, after the command checks pass, it checks the lines the run added to code files and records `quality/rules.json`. A match of an `error` rule is a blocking finding that names the rule, for example `Rule empty-catch: An empty catch block hides the error (src/load.ts:6: } catch (error) {)`. The run corrects it like a failed check, and the finding closes once no blocking match is left. A `warning` is a note in the run report.

| Rule | Severity | Finds | Languages |
| --- | --- | --- | --- |
| `empty-catch` | error | `catch` with an empty block | JS/TS, Java, Kotlin, C#, PHP, Swift, Dart, Scala |
| `catch-return-default` | error | a `catch` whose only statement returns `null`, `undefined`, `[]`, `{}`, `""`, `false`, `0` or `-1`, unless the enclosing function's declared return type announces that value: `null` from a function typed `: T \| null` (or Kotlin `T?`), `undefined` from one typed with `undefined`, `false` from one returning `boolean` or `bool` | same |
| `promise-catch-ignore` | error | `.catch(() => {})` and handlers that return `undefined` or `null` | JS/TS |
| `python-swallowed-exception` | error | an `except` clause that only does `pass`, `...`, `return`, `return None` or `continue` | Python |
| `go-empty-error-check` | error | `if err != nil {}` with an empty block | Go |
| `go-ignored-error` | warning | a call's results assigned to `_` | Go |
| `rust-unwrap` | warning | `unwrap()`/`expect()` outside `#[cfg(test)]` | Rust |
| `ts-ignore` | error | `@ts-ignore`, `@ts-nocheck` | JS/TS |
| `explicit-any` | warning | `: any`, `as any`, `<any>` | TS |
| `lint-suppression` | warning | `eslint-disable`, `biome-ignore`, `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `#[allow(...)]`, `@SuppressWarnings`, `#pragma warning disable`, `NOSONAR` | all |
| `placeholder-body` | error | `throw new Error("not implemented")`, `throw new Error("TODO")` or `"todo: ..."` (a message that only starts with the word, such as `Todo with id 3 does not exist`, is not one), an exception with such a message in Java, Kotlin, C# or PHP, `todo!()`, `unimplemented!()`, `panic("not implemented")` or `panic("unimplemented")` in Go, `error("not implemented")` in Lua, Kotlin's `TODO()`, a .NET `NotImplementedException` with or without a message, an empty Java `UnsupportedOperationException()` (not in an override of a collection or iterator mutator such as `remove` or `add`, where it is the documented contract), a Python function whose whole body (after an optional docstring or `pass`) is `raise NotImplementedError` (not an `@abstractmethod`, nor a method of a class based on `ABC`, `Protocol` or `metaclass=ABCMeta`) | all |
| `todo-comment` | warning | `TODO`, `FIXME`, `XXX`, `HACK` comments | all |
| `whitespace-only-line` | error | a line of only spaces or tabs | code files except Markdown |
| `trailing-whitespace` | error | spaces or tabs at the end of a line | same |
| `uneven-indent` | warning | a statement indented off the file's indentation step (the most common change of indentation between neighbouring lines), after a line that ends a statement or opens or closes a block | brace languages |

Test files skip the error-handling, `unwrap`, `any`, placeholder and TODO rules; suppressions and `@ts-ignore` count there too. The `unwrap`, `@ts-ignore`, `any`, suppression and TODO rules read code and comments only: text inside a string literal, such as test data that quotes `# noqa` or `custom_value: any text`, is no finding (#1549). The three whitespace rules read only files that existed at approval, on lines whose exact text, spaces included, is new there: a blank line the run filled with spaces, or a line whose indentation it changed. A new file has no diff to keep small, and the other rules compare lines without their indentation. They catch what a repository without a formatter check lets through: in bench round 39 an update of a Maven project (`mvn -B -q verify` formats nothing) turned two blank lines of `Cli.java` into lines of spaces and indented an `else if` at 14 spaces among siblings at 12.

A rules check that finds the same rule on the same text in the same file after the correction for it (the line may have moved) does not ask for another correction: the rules cannot tell the code apart, so the match is shown as `error, kept after its correction` and the earlier finding is listed under "Known limitations" in the run report, accepted by the rule pack.

Only the lines the run added count. Lines are compared with the file as it was at approval: the host keeps the planned code files when the plan is approved (`quality/baseline-files.json`) and falls back to the pre-image the run saved before its first edit. A line that only moved is not new. A changed file whose baseline is not known is still checked, but its matches are notes, never blocking.

A project shapes the pack in the `quality` block of `.baked/config.json` (or `~/.baked/config.json`):

```json
{
  "quality": {
    "disabledRules": ["todo-comment"],
    "ruleSeverity": { "rust-unwrap": "error", "explicit-any": "error" },
    "ruleFiles": ["baked/rules/no-console.yml"]
  }
}
```

- `disabledRules` turns rules off. `/code-quality` and the desktop **Code quality** page list every rule with a switch.
- `ruleSeverity` makes a rule blocking (`error`) or a note (`warning`). It applies to built-in and ast-grep rule IDs.
- `ruleFiles` are [ast-grep](https://ast-grep.github.io/) rule files. When `ast-grep` is installed, each file runs with `ast-grep scan --rule FILE --json` on the changed files, and its matches on added lines become findings with the rule's `id`, `message`, `note` (as the fix) and `severity` (`error` blocks, everything else is a note). Without ast-grep the files are listed in the report as not run, which never blocks. BAKED does not install ast-grep.

Each run freezes these choices in its policy as `qualityRules` (`disabled`, `severity`, `files`) at start. A `qualityRules` field in `--policy FILE` or `workflows.policy` replaces the configured choices. The run report lists the matches under **Code quality** with the rule, severity, place and line, the rules turned off, and whether the project's ast-grep rules ran.

The chat's own de-sloppify pass (`agentFeatures.desloppify`, `/agent-features`) stays a chat setting. In workflow runs this rule pack does that job, and it is on by default.

## Dependency check

Models invent package names, and attackers register the names they invent. The dependency check is always on and runs at the start of each checks stage, before any command check can install or run what the run added. It reads the changes since the baseline:

- **Declared dependencies**: entries added to `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621 dependencies and optional dependencies, PEP 735 `[dependency-groups]`, `[tool.uv] dev-dependencies` and `constraint-dependencies`, `[build-system] requires`, and Poetry), `Pipfile` (`[packages]`, `[dev-packages]`), `setup.cfg` (`install_requires`, `setup_requires`, `tests_require`, `[options.extras_require]`), `Cargo.toml` (dependency tables and the `[dependencies.<name>]` table form), `go.mod`, `*.csproj`/`*.fsproj`/`*.vbproj`, `Directory.Build.props`, `Directory.Packages.props` (`PackageReference` and central `PackageVersion`), `pom.xml`, Gradle build and settings files (`build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`), a Gradle version catalog (`[libraries]` of `libs.versions.toml`) and `Gemfile`. TOML arrays are read token by token, so a requirement with an extra (`"requests[socks]"`) no longer hides the entries after it (#1682). Gradle reads literal Maven coordinates and named `group`/`name` arguments inside dependency blocks, including buildscript dependencies and platform wrappers. Gemfile reads literal `gem` declarations, including groups. These readers do not execute build scripts or resolve computed names, and a catalog alias in a build file (`implementation(libs.foo)`) is read from the catalog, not from the build file. Workspace, file, path and git dependencies are not from a registry and are skipped. A manifest whose baseline is not known declares nothing new.
- **Executable manifest fields**: in a manifest that the plan's automatic approval let in because the request names it, every changed field that runs code or chooses where code comes from (scripts, build backend, build script, `replace`, MSBuild target, Maven plugin, Gradle code) must be named by the request or the spec; see [Manifest field check](runtime.md#auto-approval) (#1793).
- **Imported packages**: bare `import`, `require` and `import()` specifiers on the JS/TS lines the run added that no `package.json` declares. Relative paths, Node, Bun and protocol specifiers and the `paths` aliases of `tsconfig.json` are not packages.

Each new package is looked up in its public registry (npm with its weekly downloads, PyPI, crates.io, the Go module proxy, NuGet, Maven Central, RubyGems), without credentials and with an 8-second timeout. The verdicts:

| Verdict | Meaning | Blocks |
| --- | --- | --- |
| `missing` | the registry does not know the name; it may be made up | yes |
| `typosquat` | one or two edits from a popular package and rarely downloaded (under 10,000 a week) or less than a year old | yes |
| `new-package` | first published less than 14 days ago | yes |
| `unrequested` | added to a manifest that existed before the run, and neither the request nor the spec names it | yes |
| `undeclared` | imported but not declared in `package.json` | no |
| `rare` | under 100 downloads a week | no |
| `unknown` | the lookup failed (offline, registry down) or lookups are off | no |
| `ok` | a new dependency that passed | no |

A blocking verdict is a `security` finding (`Dependency left-padx: npm package left-padx does not exist in the registry; the name may be made up (src/pad.ts:1)`), and the stage stops before its commands run. The run corrects it like a failed check; the finding closes when a later check finds nothing blocking. The result is kept as `quality/dependencies.json`.

Every new dependency, blocking or not, is listed in the run report under **Code quality** with its ecosystem, verdict and place. The report is the delivery pull request's body, so whoever approves the pull request approves each new dependency there. `quality.registryLookups: false` (or `registryLookups: false` in the policy) stops the lookups, for example on a machine without network access; new dependencies are then listed as `unknown` and nothing blocks. The lookups do not depend on the run's `network` policy, which governs the commands the run executes.

Run policies forbid new dependencies (`allowNewDependencies` is always `false`), so a package added to a manifest that existed before the run is `unrequested` unless the request or the approved spec names it (as a whole name: `FsCheck` does not name `FsCheck.Xunit`). A spec that marks a [property criterion](#property-based-tests) names the property-test libraries. A manifest the run creates, and any manifest of a run that started on a workspace without source files, sets a project up and is not judged this way. The verdict needs no registry, so it blocks with lookups off too; the correction removes the package and the code that uses it.

The implementer is told to add a dependency only when the task needs one and only under a well-known name it is sure of.

## Semgrep

When [Semgrep](https://semgrep.dev/) is installed, each checks stage, after the command checks pass, runs `semgrep scan --json --metrics=off --quiet --config CONFIG` on the code files the run changed and keeps the matches on lines the run added (`quality/sast.json`). An `ERROR` match is a blocking `security` finding (`SAST RULE: MESSAGE (FILE:LINE)`) when the file's baseline is known; `WARNING` and `INFO` matches are notes. Without Semgrep, or when it fails, the report says `Semgrep: not run (REASON).` and nothing blocks. BAKED does not install Semgrep.

`CONFIG` is `p/default` unless `quality.sastConfig` in the config file (or `sastConfig` in the policy) names another registry ruleset or a local rule file. `quality.sast: off`, `--sast off` or `sast: off` in the start request skips Semgrep.

## Property-based tests

Example tests miss edge inputs such as `-0`, an empty string or the largest value. With `propertyTests: auto`, criteria that must hold over a whole input domain get property-based tests:

1. **Spec.** The spec author is told to mark such criteria with `property`, the input domain: `numbers`, `strings`, `parsing`, `round-trip` or `invariant`. `spec.md` shows the mark (`AC-001 (FR-001; automated; property over numbers)`), so the person approving the plan sees it.
2. **Plan and tasks.** Once a criterion is marked, the planner gives it a test task that writes a property-based test. Before the first prompt the host looks once at what the project can use as it is and stores it in `quality/property-libraries.json`: fast-check (JS/TS) installed in `node_modules`, Hypothesis (Python) in `.venv`, `venv` or, for a project with a Python manifest or a `.py` file at its root, the Python on the `PATH`, proptest or quickcheck in `Cargo.toml` (a `proptest = ...` line or a `[dev-dependencies.proptest]` table, in the root or a workspace member crate), jqwik or kotest-property in `pom.xml` or the Gradle build, FsCheck or CsCheck in a `.csproj` or `.fsproj` at the root or one directory down, and Go's standard `testing/quick` (rapid and gopter count too). A package that is declared but not installed does not count, because the checks run without installing it. The agents are told to use the libraries found and, for a language without one, to write a library-free property test in the project's own test framework: a generator with a fixed seed that produces at least 100 inputs over the domain and prints the failing input. No run is told to add a dependency for a property test, so runs that forbid new dependencies (`allowNewDependencies: false`) or whose plan chose a library-free test are not asked for one.
3. **Check.** In each checks stage, after the command checks pass, the host looks in the test files of the tasks that cover each marked criterion (`quality/properties.json`). A test counts when it uses a property library or is a seeded generator loop: `random.Random(SEED)` or `random.seed` with a loop in Python; a seeded PRNG (mulberry32, xorshift, splitmix, an LCG or a function named after a seed) with a `for` loop in JS/TS; `seed_from_u64` or `from_seed` with a loop in Rust; `new Random(SEED)` with a loop in Java and C#; `rand.New(rand.NewSource(...))` or `rand.NewPCG` in Go. A deterministic loop over a bounded domain of at least 100 values also counts (`for mask := 0; mask < 256; mask++` in Go, `for a in range(256)` or `itertools.product(...)` in Python, `for (let a = 0; a < 256; a++)` in JS/TS, `for a in 0..256` in Rust, the same `for` in Java and C#, `IntStream.rangeClosed(0, 255)` in Java, `(0..255).forEach` in Kotlin, `Enumerable.Range(0, 256)` in C#). Kotest property (`io.kotest.property`) and CsCheck (`Gen.Int.Sample(...)`) count as the Kotlin and C# libraries; the report marks it `(exhaustive)`. A library imported behind a fallback that runs without it (`try: from hypothesis ... except ImportError`, `try { require("fast-check") } catch`) never counts. A marked criterion without a counted test is:
   - a blocking `missing` finding (`Property test missing for AC-001: ...`) filed on that test file when the project has a property library for the test's language or the test hides one behind a fallback, so the correction writes the property and the finding closes once it exists;
   - `waived` when the project has no property library for that language and no seeded test was recognized. A waived criterion does not block the run; the run report says why.
4. **Counterexamples.** When a check fails and its output holds a shrunk counterexample (fast-check `Counterexample:`, Hypothesis `Falsifying example:`, proptest `minimal failing input:`, jqwik, rapid, gopter and FsCheck output), the failed check's finding carries it (`Property counterexample: [-0]`). The correction starts from that reproduction and is told to fix the code, not the property, unless the property contradicts the spec. A conflict it cannot settle stops the run for a person, as any repeated finding does.

The run report lists the marked criteria, their domain, their status with its reason and the property tests found (`(seeded)` after a library-free one), and counts the waived criteria (`Property-based tests: 0 of 1 marked criteria have one; 1 waived because the project has no property library.`). A request that forbids them ("plain example tests only", "no property-based tests", "do not use Hypothesis") or their random input ("no fuzzing, no random numbers", "deterministic tests only") turns the mode off for its run whatever the setting says, so no criterion is marked and no task meets a method the request bans. The default follows the preset: `auto` for `standard` and `full` (what `sdd` runs), `off` for `quick` and the other presets; `quality.propertyTests: preset` (the setting's default) keeps that. In an existing repository the preset's `auto` gives way to the repository's convention: when its tests have no property test the host recognizes (a library, seeded or exhaustive one), it has no property library installed or declared (Go's standard `testing/quick` does not count), and the request does not ask for property tests itself, the mode is `off` for the run. The host reads the workspace's test files once, at the first stage that needs the mode, and keeps what it found in `quality/property-repository.json`. A mode set in the policy, the setting or the run flag is kept as it is (jsonsplice-update, bench round 58: two seeded 100-value loops in a repository with none, although the brief listed its tests, #1872). The spec author also leaves a criterion unmarked when it is a fixed table of inputs and expected outputs.

## Mutation gate

Coverage can be complete while the tests an agent wrote assert almost nothing. The mutation gate plants small faults in the lines the run added and checks that the tests notice them. It runs in each checks stage after the command checks and the other quality gates pass:

1. **Mutants.** On each line the run added to a non-test code file (imports and type declarations aside), the built-in engine makes one change per operator: `===`/`!==`, `==`/`!=`, `<`/`<=`, `>`/`>=` (binary operators with spaces around them), `&&`/`||`, `and`/`or`, `+`/`-`, `*` to `/`, `true`/`false` (`True`/`False`), a dropped `!` or `not`, and a number literal plus one. Strings and comments are never changed, including those that span lines: a line inside a Python docstring, a JavaScript or TypeScript template literal (code inside `${…}` still counts), a Java or Kotlin text block, a C# raw or verbatim string, a Go or Rust raw string, a Lua long string or a block comment gets no mutants. The file's extension picks the language; an unknown one gets the single-line rules (`//` and `#` comments, quoted strings). Up to 24 mutants per stage are shared across eligible files. Each file gets an equal share before unused capacity goes to the others, with larger additions first when the cap cannot cover every file. Within each file, distinct lines take priority over a second mutant on a line. The gate runs the selected mutants in file rotation so its time budget also covers several files.
2. **Tests.** The policy's required checks that run tests (their command names `test`, `pytest`, `vitest`, `jest`, `mocha` and similar, or runs a Maven or Gradle phase that includes the tests: `mvn test`, `verify`, `package` or `install`, `gradle test`, `check` or `build`, unless `-DskipTests`, `-Dmaven.test.skip` or `-x test` skips them; a check started through a launcher, such as `cmd /c mvn -B -q verify`, is judged by the program the launcher runs, see Checks behind a launcher in the [runtime guide](runtime.md)) run against each mutant, one mutant at a time, in the run's working copy or worktree. A failing test kills the mutant; a mutant all tests pass on survived. Each mutated file is put back byte for byte before the next mutant, and a host that stops mid-mutant puts it back on the next drive (`quality/mutation-pending.json`). No tool needs to be installed; a project that has one gets its [ecosystem tool](#ecosystem-tools) instead.
3. **Equivalence check.** Under `required` the policy's skeptic (`skepticProfileId`) looks at each blocking survivor before it becomes a finding and judges whether the mutant is equivalent: no input can make the mutated line behave differently from the original (for example `<` to `<=` where both sides are never equal). An equivalent mutant gets the status `equivalent`, is not scored and never blocks. Up to 8 survivors are judged per stage; verdicts are kept in `quality/mutation-equivalence.json` by mutant and file content, so a later stage asks only about new survivors. A check that fails keeps the survivor and is noted in the result.
4. **Verdict.** The result is `quality/mutation.json` with the engine, each mutant, its status and the score (killed or timed out, of the mutants that ran). Under `required` each surviving mutant is a blocking finding (`Surviving mutant M3: src/sign.ts:1 changed from ... to ... and every test check still passed`). The finding is filed on a test file of the task that wrote the code, or of a related task, so the correction adds a test that kills the mutant; it is told not to change the code to get rid of the mutant. Under `advisory` survivors are listed in the run report and never block.

### Ecosystem tools

When the project already has a mutation tool for the language most of the changed code is in, the tool makes and runs the mutants instead of the built-in engine. BAKED never installs one; `mutationEngine: built-in` (setting `quality.mutationEngine`) keeps the built-in engine.

| Tool | Detected when | Runs | Report |
| --- | --- | --- | --- |
| Stryker (JavaScript, TypeScript) | `node_modules/@stryker-mutator/core` is installed | `stryker run --mutate FILES --reporters json --incremental`, incremental state outside the working copy | `reports/mutation/mutation.json` |
| mutmut 3 (Python) | `mutmut` on `PATH` or in `.venv` | `mutmut run`, `mutmut results --all true`, `mutmut show` per mutant (up to 60) | the commands' output |
| cargo-mutants (Rust) | `Cargo.toml` and `cargo-mutants` on `PATH` | `cargo mutants --file FILE ...` | `mutants.out/outcomes.json` |
| PIT (Java, Kotlin) | `pom.xml` names `pitest-maven` (`mvnw` or `mvn`), or the Gradle build applies `info.solidsoft.pitest` | `mutationCoverage` with XML output and the changed classes; `gradle pitest` | `target/pit-reports/mutations.xml`, `build/reports/pitest/mutations.xml` (the Gradle block must list `XML` in `outputFormats`) |
| go-mutesting (Go) | `go.mod` and `go-mutesting` on `PATH` | `go-mutesting FILES` | `report.json` (written by the avito-tech fork) |

The tool runs its own tests, so the policy needs no test check for it. Its mutants are kept only on the lines the run added (all lines of the module in a `harden` run), up to 200, survivors first; findings, thresholds and the run report are the same as for the built-in engine, with the tool named in the claim (`changed (stryker) from ...`). PIT mutates bytecode, so its mutants carry PIT's description instead of a mutated line. Files the tool creates in the working copy (its report, `mutants/`) are removed after it, and the changed files are restored from `quality/mutation-pending.json` if the host stops mid-run (go-mutesting writes mutants into the file). In a worktree run the tool is found in the `node_modules` the worktree links to the working copy. In a run with a [sandbox](runtime.md#sandbox) the tool runs inside it, with its incremental state directory also writable. A tool that fails or writes no report is noted and the built-in engine runs instead; one that runs out of `mutationBudgetMs` leaves the gate inconclusive.

### Agent mutants

Under `required` with the built-in engine (not in a `harden` run), the `mutant-author` profile (role `reviewer`, model `$review`) proposes up to three targeted mutants per automated acceptance criterion on the lines the run added: a realistic mistake, such as a wrong boundary or a swapped branch, that would break the criterion. The host lists only added lines that hold code. Its 24,000-character budget for numbered lines is shared across files, with unused capacity redistributed and larger additions first, as for operator mutants. Only whole lines that fit the budget are shown. The host keeps a proposal only when it changes one of those lines exactly as that line is in the file (a line inside a docstring, a multi-line string or a comment is dropped), and at most 12 per stage; they run like the operator mutants and their findings name the criterion (`(it breaks AC-002)`). Proposals are kept in `quality/mutation-proposals.json` until the code changes. An agent that fails is noted and the gate runs the operator mutants alone.

Under `advisory` nothing waits for the score, so in a Git repository the gate runs beside the next stage instead of before it: the checks stage finishes when the command checks and the other quality gates pass, and the gate runs in a task worktree (`.baked/worktrees/RUN/quality-mutation`) checked out from the run's current content, with `node_modules`, `.venv` and `venv` linked from the run. The review never reads a planted mutant, and the score reaches `quality/mutation.json` and the run report when the gate finishes. The run waits for it before acceptance, so the report is complete; a run that pauses or blocks stops it, and the next checks stage (after a correction, say) replaces it with one on the new code. Files Git ignores are not in the copy, so the tests run once without a mutant first: when they fail there, no mutant runs and the result says which check failed (`check unit fails in a copy of the run without any mutant, so no mutant ran`). A project that is not a Git repository, or that is a subfolder of one, runs the gate in place, before the next stage, as `required` does.

Each mutant's tests get three times the green suite's duration plus 10 seconds, at least 20 seconds, and never more than the budget left. The green duration is the test checks' slowest passing run recorded in the run (the run without a mutant, when the gate runs in a copy); until one is known, the slowest mutant run that finished so far stands in. A mutant whose tests run past that deadline, such as a flipped loop condition that makes the suite loop forever, is `timeout`: the suite noticed it, so it scores with the killed mutants and never blocks, and the next mutant runs after seconds instead of waiting out the budget. The gate stops after `mutationBudgetMs` (default 300 seconds); the remaining mutants are `not run`, which is inconclusive, never a failure. A policy without a required test check records that the gate had nothing to run. A survivor in a file whose baseline is not known is a note.

`mutationThresholds` lowers the share of killed mutants a file needs under `required`, by path glob or directory, the longest match winning:

```json
{
  "quality": {
    "mutation": "required",
    "mutationThresholds": { "src/auth/**": 70, "src/**": 50 },
    "mutationBudgetMs": 600000
  }
}
```

Without a matching threshold every surviving mutant of a file blocks. The default follows the workflow's preset: `full`, which the `sdd` workflow runs, is `advisory`; `quick`, `standard` and the other presets are `off`. `quality.mutation: preset` (the setting's default) keeps that; another value, the policy's `mutation` or `--mutation` overrides it and is frozen in the run's policy. The implementer is told to write tests that fail when a condition, boundary or constant changes.

The run report shows the mode, the engine when it is a tool, the score, how many mutants were killed, timed out, not run or judged equivalent, and a table of the survivors and equivalent mutants with the reason. The [`harden` preset](harden.md) plants the mutants in the module under test instead of in added lines and reports the score before and after.

## Baseline replay

Update requests often ask that the new tests fail on the code before the change, or that the existing tests still pass on it. No command check proves either, so without evidence the review could only call such a criterion inconclusive. With `baselineReplay: on` (setting `quality.baselineReplay`, default `off`) the host proves it itself. After the command checks and the other quality gates pass with no blocking finding, it runs the policy's required test checks (as the mutation gate picks them) once more in a task worktree (`.baked/worktrees/RUN/quality-baseline-replay`) checked out from the run's current content, with `node_modules`, `.venv` and `venv` linked from the run. In that copy every changed file that is not a test is put back as it was before the run, and files the run created are removed; test files stay as delivered.

The result is `quality/baseline-replay.json`, recorded as review evidence: the files reverted, removed and left as delivered because their earlier content was not kept (`unknown`), and per check its status, the failed tests read from the runner's output (`failedTests`, `null` when no runner's output was recognized) and the end of the output. The failed tests are read for bun, Jest, Vitest, pytest, cargo, dotnet, Maven, Go, JUnit XML and TAP. The spec author is told such a criterion is automated, the analysis reviewer that it is never a finding for needing a second tree, and the reviewers how to settle it from the record. When some tests do not build, collect or load on the code before the change (an update's new test calls an API the old code lacks), the check records `buildFailed: true` and the first five error lines as `buildErrors`, read from the runner's build-failure lines (`BUILD_FAILURES`, one pattern per runner); those tests are not in `failedTests`, and the review is told such a test fails on the code before the change (bench round 62 linehunk: `mvn verify` failed to compile the new test and the record only said `failedTests: null`, #1960). The replay runs once per snapshot, and not again for a later snapshot whose reverted and removed files, delivered tests and test checks are the same (`inputHash`; R62 stepexpr replayed four times for one result). It never blocks. Without a required test check, with no changed file other than tests, when the run created every changed file other than tests (nothing to put back, so the copy would only lose the feature's own code: R62 stepvet recorded 19 such replays, all failed by construction), or in a project that is not the top of its Git repository, the record carries a note instead of results. The replay does not compare dependency resolution.

A build error in one test target stops the whole test command in cargo (the first target that does not compile), pytest (a collection error aborts the session), dotnet (the solution builds as one) and Maven or Gradle (the module stops the build), so the record named the first broken file and no test of the others (bench round 65: 11 of 12 uritpl replays named nothing, and eolscope-update's `package_tests` never ran behind `version_tests`, #2020). After a check records `buildFailed`, the replay runs it again per test target, chosen by the runner whose build-failure lines the output has (`replayTargets`, one `REPLAY_TARGETS` row per runner), and lists them under the check as `targets`: each with its `path` (relative to the workspace; `.` for the whole check run again), `status`, `failedTests` (`null` when the target did not build) and, for a target that did not build, `buildFailed` and `buildErrors`.

| Runner | Targets |
| --- | --- |
| cargo | `--lib` when the crate has `src/lib.rs`, and `--test NAME` for each `tests/*.rs`, inserted before `--` |
| pytest | one run with `--continue-on-collection-errors`; each test file the run changed gets the "ERROR collecting" lines that name it and the failed tests under its path |
| dotnet | each test project that holds a test file the run changed, in place of the solution or project the check names |
| Maven | the check again with `--fail-at-end`, so the other modules build and test |
| Gradle (JUnit output) | the check again with `--continue` |
| bun, Jest, Vitest, TAP, Go | none: each file or package already builds and runs on its own |

A check whose arguments already pick one target (`cargo test --test NAME`, `mvn -fae`) is not split again, and one check runs at most 12 targets. The spec author is told that a criterion about named tests holds per target, and the reviewers read `targets` to settle it.

## Package contents

A request that changes how a project is packaged (package data such as `py.typed`, the `files` of `package.json`, `include` of `Cargo.toml`) usually asks that the built package contains a file. No command check builds the package, so without evidence the review could only call such a criterion inconclusive. With `packageContents: on` (setting `quality.packageContents`, default `off`) the host builds it. After the command checks and the other quality gates pass with no blocking finding, it compares each changed manifest's packaging fields with their content before the run. For every package root (the manifest's folder) with a changed field it builds the package in a task worktree (`.baked/worktrees/RUN/quality-package-contents`) checked out from the run's current content, with `node_modules`, `.venv` and `venv` linked from the run, and lists the files of what it built:

| Toolchain | Manifests and fields | Build, tried in order | Listing |
| --- | --- | --- | --- |
| Python | `pyproject.toml` (build backend, `tool.setuptools*`, `tool.hatch.build*`, `tool.poetry` packages/include/exclude, `tool.pdm.build`, `tool.maturin`, `tool.flit.*`, entry points, readme, license files), `setup.cfg` (packages, package data, data files, entry points), `setup.py` and `MANIFEST.in` (any change) | `uv build --wheel` when `uv.lock` exists, `python -m build --wheel`, `pip wheel --no-deps --no-build-isolation`, `pip wheel --no-deps` (the project's `.venv` interpreter when there is one) | the wheel's files |
| Rust | `Cargo.toml` `package.include`, `exclude`, `readme`, `license-file`, `build`, `workspace` | `cargo package --list --allow-dirty` | its output |
| Java, Kotlin | `pom.xml` packaging, resources, source folder, final name, plugins; `build.gradle(.kts)` plugins, `jar`, `sourceSets`, `processResources`, `java`, `base` and tasks naming the jar | `mvn -B -q package -DskipTests`, `gradle -q jar` (the `mvnw`/`gradlew` wrapper when present) | the jars in `target/` or `build/libs/` |
| C# | project files: items with `Pack` or `PackagePath`, packing properties (`IsPackable`, `IncludeBuildOutput`, `PackageReadmeFile`, `TargetFrameworks` and the like); a `.nuspec` (any change) | `dotnet pack` | the nupkg's files |
| TypeScript, JavaScript (and Vue, Svelte, ReScript) | `package.json` `files`, `main`, `module`, `exports`, `bin`, `types`, `browser`, `directories`, `man`, the `prepack`, `prepare` and `postpack` scripts; `.npmignore` (any change) | `npm pack --dry-run --json` | its output |

Go, Swift, PHP, OCaml and Zig publish source, and the other languages' packaging is not built yet; their rows in `PACKAGE_CONTENTS` (`src/core/workflows/quality/package-contents.ts`) say why.

The result is `quality/package-contents.json`, recorded as review evidence: per package root the changed fields, each command tried with its result (`listed`, `missing` when the program is not installed, `failed`, `timeout` or `unread`, with the end of its output) and the files of each artifact. The spec author is told such a criterion is automated, the analysis reviewer that it is never a finding for needing a build, and the reviewers how to settle it from the record. The check runs once per snapshot, builds at most four package roots and never blocks: a missing tool or a failed build leaves the criterion inconclusive, not failed. Without a packaging field change, or in a project that is not the top of its Git repository, the record carries a note instead of builds.

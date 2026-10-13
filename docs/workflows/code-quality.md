# Code quality gates

Quality gates of workflow runs measure the code a run writes beyond what its checks and reviewers test. Each gate has a default for new runs, set per project or for all projects, and every run freezes its value in the run policy, so the approval digest covers it and a later change of the default does not change a running run.

| Gate | Policy field | Values | Default |
| --- | --- | --- | --- |
| [Duplication and dead-code ratchet](#duplication-and-dead-code-ratchet) | `duplication` | `off`, `warn`, `ratchet` | `warn` |
| [Anti-slop rule pack](#anti-slop-rule-pack) | `qualityRules` | rules turned off, severities, ast-grep rule files | every built-in rule on |
| [Dependency check](#dependency-check) | `registryLookups` | `false` turns lookups off | on |
| [Semgrep](#semgrep) | `sast`, `sastConfig` | `auto`, `off`; a Semgrep `--config` | `auto`, `p/default` |
| [Mutation gate](#mutation-gate) | `mutation`, `mutationThresholds`, `mutationBudgetMs` | `off`, `advisory`, `required`; percent per path; time | by preset: `advisory` for `full` (the `sdd` workflow), `off` otherwise |

Where the defaults are set:

- terminal UI: `/code-quality` (or **Code Quality** in `/settings`), saved to the project or the global config;
- desktop: Settings, Chat settings, **Code quality** page;
- local API: `PATCH /v1/settings` with `quality.duplication`, `quality.disabledRules`, `quality.registryLookups`, `quality.sast` and `quality.mutation` ([chat settings](../desktop/api.md#chat-settings));
- config file: `quality` in `.baked/config.json` or `~/.baked/config.json`.

A run can override the default at start: `baked workflow run --duplication off|warn|ratchet`, `--sast auto|off` and `--mutation off|advisory|required`, or `duplication`, `sast` and `mutation` in `POST /v1/workflow/runs`. The order is the run flag, then the policy's own field (`--policy FILE` or `workflows.policy`), then the `quality` setting, then the built-in default.

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
| `catch-return-default` | error | a `catch` whose only statement returns `null`, `undefined`, `[]`, `{}`, `""`, `false`, `0` or `-1` | same |
| `promise-catch-ignore` | error | `.catch(() => {})` and handlers that return `undefined` or `null` | JS/TS |
| `python-swallowed-exception` | error | an `except` clause that only does `pass`, `...`, `return`, `return None` or `continue` | Python |
| `go-empty-error-check` | error | `if err != nil {}` with an empty block | Go |
| `go-ignored-error` | warning | a call's results assigned to `_` | Go |
| `rust-unwrap` | warning | `unwrap()`/`expect()` outside `#[cfg(test)]` | Rust |
| `ts-ignore` | error | `@ts-ignore`, `@ts-nocheck` | JS/TS |
| `explicit-any` | warning | `: any`, `as any`, `<any>` | TS |
| `lint-suppression` | warning | `eslint-disable`, `biome-ignore`, `# noqa`, `# type: ignore`, `# pylint: disable`, `//nolint`, `#[allow(...)]`, `@SuppressWarnings`, `#pragma warning disable`, `NOSONAR` | all |
| `placeholder-body` | error | `throw new Error("not implemented")`, `todo!()`, `unimplemented!()`, `panic("not implemented")`, an empty `NotImplementedException`/`UnsupportedOperationException` | all |
| `todo-comment` | warning | `TODO`, `FIXME`, `XXX`, `HACK` comments | all |

Test files skip the error-handling, `unwrap`, `any`, placeholder and TODO rules; suppressions and `@ts-ignore` count there too.

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

- **Declared dependencies**: entries added to `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621 and Poetry), `Cargo.toml`, `go.mod`, `*.csproj`/`*.fsproj`/`*.vbproj` and `pom.xml`. Workspace, file, path and git dependencies are not from a registry and are skipped. A manifest whose baseline is not known declares nothing new.
- **Imported packages**: bare `import`, `require` and `import()` specifiers on the JS/TS lines the run added that no `package.json` declares. Relative paths, Node, Bun and protocol specifiers and the `paths` aliases of `tsconfig.json` are not packages.

Each new package is looked up in its public registry (npm with its weekly downloads, PyPI, crates.io, the Go module proxy, NuGet, Maven Central), without credentials and with an 8-second timeout. The verdicts:

| Verdict | Meaning | Blocks |
| --- | --- | --- |
| `missing` | the registry does not know the name; it may be made up | yes |
| `typosquat` | one or two edits from a popular package and rarely downloaded (under 10,000 a week) or less than a year old | yes |
| `new-package` | first published less than 14 days ago | yes |
| `undeclared` | imported but not declared in `package.json` | no |
| `rare` | under 100 downloads a week | no |
| `unknown` | the lookup failed (offline, registry down) or lookups are off | no |
| `ok` | a new dependency that passed | no |

A blocking verdict is a `security` finding (`Dependency left-padx: npm package left-padx does not exist in the registry; the name may be made up (src/pad.ts:1)`), and the stage stops before its commands run. The run corrects it like a failed check; the finding closes when a later check finds nothing blocking. The result is kept as `quality/dependencies.json`.

Every new dependency, blocking or not, is listed in the run report under **Code quality** with its ecosystem, verdict and place. The report is the delivery pull request's body, so whoever approves the pull request approves each new dependency there. `quality.registryLookups: false` (or `registryLookups: false` in the policy) stops the lookups, for example on a machine without network access; new dependencies are then listed as `unknown` and nothing blocks. The lookups do not depend on the run's `network` policy, which governs the commands the run executes.

The implementer is told to add a dependency only when the task needs one and only under a well-known name it is sure of.

## Semgrep

When [Semgrep](https://semgrep.dev/) is installed, each checks stage, after the command checks pass, runs `semgrep scan --json --metrics=off --quiet --config CONFIG` on the code files the run changed and keeps the matches on lines the run added (`quality/sast.json`). An `ERROR` match is a blocking `security` finding (`SAST RULE: MESSAGE (FILE:LINE)`) when the file's baseline is known; `WARNING` and `INFO` matches are notes. Without Semgrep, or when it fails, the report says `Semgrep: not run (REASON).` and nothing blocks. BAKED does not install Semgrep.

`CONFIG` is `p/default` unless `quality.sastConfig` in the config file (or `sastConfig` in the policy) names another registry ruleset or a local rule file. `quality.sast: off`, `--sast off` or `sast: off` in the start request skips Semgrep.

## Mutation gate

Coverage can be complete while the tests an agent wrote assert almost nothing. The mutation gate plants small faults in the lines the run added and checks that the tests notice them. It runs in each checks stage after the command checks and the other quality gates pass:

1. **Mutants.** On each line the run added to a non-test code file (imports and type declarations aside), the built-in engine makes one change per operator: `===`/`!==`, `==`/`!=`, `<`/`<=`, `>`/`>=` (binary operators with spaces around them), `&&`/`||`, `and`/`or`, `+`/`-`, `*` to `/`, `true`/`false` (`True`/`False`), a dropped `!` or `not`, and a number literal plus one. Strings and comments are never changed. Up to 24 mutants per stage are taken, one per line before a second one on any line.
2. **Tests.** The policy's required checks that run tests (their command names `test`, `pytest`, `vitest`, `jest`, `mocha` and similar) run against each mutant, one mutant at a time, in the run's working copy or worktree. A failing test kills the mutant; a mutant all tests pass on survived. Each mutated file is put back byte for byte before the next mutant, and a host that stops mid-mutant puts it back on the next drive (`quality/mutation-pending.json`). No tool needs to be installed.
3. **Verdict.** The result is `quality/mutation.json` with each mutant, its status and the score (killed of the mutants that ran). Under `required` each surviving mutant is a blocking finding (`Surviving mutant M3: src/sign.ts:1 changed from ... to ... and every test check still passed`). The finding is filed on a test file of the task that wrote the code, or of a related task, so the correction adds a test that kills the mutant; it is told not to change the code to get rid of the mutant. Under `advisory` survivors are listed in the run report and never block.

A mutant whose tests run out of time is `timeout` and never blocks. The gate stops after `mutationBudgetMs` (default 300 seconds); the remaining mutants are `not run`, which is inconclusive, never a failure. A policy without a required test check records that the gate had nothing to run. A survivor in a file whose baseline is not known is a note.

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

The run report shows the mode, the score, how many mutants were killed, timed out or not run, and a table of the survivors.

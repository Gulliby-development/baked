# Code quality gates

Quality gates of workflow runs measure the code a run writes beyond what its checks and reviewers test. Each gate has a default for new runs, set per project or for all projects, and every run freezes its value in the run policy, so the approval digest covers it and a later change of the default does not change a running run.

| Gate | Policy field | Values | Default |
| --- | --- | --- | --- |
| [Duplication and dead-code ratchet](#duplication-and-dead-code-ratchet) | `duplication` | `off`, `warn`, `ratchet` | `warn` |

Where the defaults are set:

- terminal UI: `/code-quality` (or **Code Quality** in `/settings`), saved to the project or the global config;
- desktop: Settings, Chat settings, **Code quality** page;
- local API: `PATCH /v1/settings` with `quality.duplication` ([chat settings](../desktop/api.md#chat-settings));
- config file: `quality` in `.baked/config.json` or `~/.baked/config.json`.

A run can override the default at start: `baked workflow run --duplication off|warn|ratchet`, or `duplication` in `POST /v1/workflow/runs`. The order is the run flag, then the policy's own field (`--policy FILE` or `workflows.policy`), then the `quality` setting, then the built-in default.

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

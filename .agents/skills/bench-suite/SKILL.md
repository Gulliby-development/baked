---
name: bench-suite
description: Use when adding, changing or graduating a task in bench/suite/ (the nightly multi-language mini-suite), when adding a supported language or toolchain, or when a bench round stop can be reproduced by a small task.
---

# Bench suite tasks

`bench/suite/` holds small tasks that run nightly through `baked workflow quick` on a cheap model, k times each, so a regression in one language shows up the next morning instead of in the one round that happens to use that language. The level-5 bench round stays the capability measurement; the suite is the regression net under it.

## Task format

Each task is a directory `bench/suite/tasks/<id>/`. Name it `<language>-<toolchain>-<what>` (for example `java-maven-readme`), in lowercase words joined by hyphens.

- `task.json`:
  - `id`: the directory name.
  - `language`: the family the per-language table groups by: `typescript`, `javascript`, `python`, `go`, `rust`, `java`, `kotlin`, `csharp`, `php`, `lua`, `ruby`, `dart`, `scala`, `swift`, `c` or `sql`.
  - `toolchain`: for example `bun`, `npm`, `pytest`, `cargo`, `maven`, `gradle`, `dotnet`, `rspec`, `minitest`, `dart`, `sbt`, `swiftpm`, `make` or `sqlfluff`.
  - `requires`: the executables that must be on `PATH`. Without them the runner reports the task as skipped and does not fail it.
  - `allowedPaths`: the globs the plan may write: the source and test folders, `README.md` and the stack's config files (`package.json`, `pyproject.toml`, `Cargo.toml`, `pom.xml`, the Gradle scripts, `go.mod`, `Makefile`), as the bench loop's auto approval allows. The runner approves a plan that stays inside them; any other stop counts as an intervention.
  - `checks`: the run's own gates, in the shape of `workflows.policy.checks` (`id`, `executable`, `args`, an optional `fix`). The runner adds `cwd`, `required`, `scope`, `envNames` and `writes`.
  - `origin`: `#N` when the task reproduces a past stop.
  - `policy`: optional opt-in policy fields the run gets on top of the runner's, for a task that measures an opt-in host behavior. Only the fields in `POLICY_FIELDS` (`bench/suite/lib.ts`) are allowed: today `chainRewrite: "on"`, `chainProbe: "on"` (the sibling probe, #1969, which needs `chainRewrite`) `defectClasses: "on"` (the cross-run defect class list, #1970) and `edgeProbe: "on"` (the edge-input probe of source tasks, #1808); `ts-bun-emphasis` sets `chainRewrite` because its brief (nested emphasis delimiters) invites a defect class with many members (#1981).
- `prompt.md`: the brief BAKED gets. It names the exact files, functions and behavior the hidden check tests, so a correct implementation of the brief passes. It never mentions the hidden check.
- `seed/`: the starting repository, with the build file, an empty module or `.gitkeep` files and a `.gitignore`. The repository's own `bun test` ignores `bench/suite/tasks/` (`bunfig.toml`), but keep hidden JavaScript and TypeScript tests named `check.ts` or `check.mjs` and let `check.sh` copy them to a `*.test.*` name.
- `check.sh`: the hidden acceptance check. It runs with the finished workspace as its working directory, copies its tests from `hidden/` into the workspace and exits 0 when the task passed.
- `hidden/`: the tests `check.sh` uses. Write them against the behavior in the prompt, not against one implementation.
- `solution/`: a reference solution, copied over the seed.

Keep a task to about 2 planned tasks and 12 files, and keep it to about 300k tokens on `quick`. A task that needs more belongs in the bench round.

## Before you commit a task

1. Run `bun bench/suite/run.ts --self-check --task <id>`. The hidden check must fail on the seed and pass on the seed with `solution/` copied over. A toolchain this machine lacks is reported as `skip`. Say so in the pull request, and check the task on a machine that has the toolchain before it graduates.
2. Run `bun test tests/bench-suite.test.ts`. It validates every `task.json` and the file layout, and checks that each language has at least two tasks.
3. Run the task once for real: `bun bench/suite/run.ts --task <id> --k 1`. A first run that fails because of the task itself (an unclear prompt, a check stricter than the prompt) gets the task fixed, not an issue against BAKED.

## When to add tasks

- **A new supported language or toolchain** adds at least two tasks for it in the same pull request.
- **A bench round or smoke stop** that a small task can reproduce adds that task, with `origin` set to the issue it was filed as. Write the task so that it fails without the fix.
- **A check layer**: the suite is the `mini-suite` layer of the loop's escape analysis (`bench/loop/AGENTS.md`). A fix for a finding whose `escapedLayer` is `mini-suite` adds a task here.

## Running

```sh
bun bench/suite/run.ts --per-language --k 2               # one task per language, rotating by day
bun bench/suite/run.ts --k 3 --model claude-code/haiku    # every task, k = 3
bun bench/suite/run.ts --task py-roman --k 1              # one task
```

The runner writes `results.jsonl`, `summary.json` and `table.md` to `--out` (default `bench-suite-results/<date>/`) and prints the pass^k table. A failed trial keeps its workspace and prints its path. `--previous <summary.json>` marks the tasks that dropped from pass^k = 1. `--history <nights.jsonl>` appends the night and lists graduation candidates.

## Metrics, drops and graduation

- **pass^k** is the chance that k trials of the task all pass, estimated as C(passes, k) / C(trials, k). With trials = k it is 1 only when every trial passed.
- **Interventions per run** count the stops a person would have had to handle: a plan outside `allowedPaths`, a budget stop, a block or a failure. Plan approvals inside `allowedPaths` are planned and do not count.
- **A drop** is a capability task whose pass^k fell from 1, or any regression task below 1. Each drop is filed as a bench-loop Bug issue with the run ids, following the [file-issue skill](../file-issue/SKILL.md), unless an open issue already covers it.
- **Graduation**: a capability task with pass^k = 1 on each of the last 5 nights moves to `bench/suite/regression.json` in a pull request. Regression tasks must stay at 100%. A regression task that fails on two nights in a row because the task itself has become flaky goes back to capability in a pull request that says why. A task that BAKED keeps failing stays in capability, and the issue for it stays open.

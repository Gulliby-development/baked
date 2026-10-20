# Working on BAKED

These instructions apply to every coding agent and every model provider that works in this repository, and to human contributors.

## Project

BAKED is a TypeScript coding agent with an OpenTUI/React terminal UI and a headless CLI. It runs on Bun and uses SQLite for persistent data. Read `README.md` for setup and `CONTRIBUTING.md` for architecture and extension points.

## How BAKED works

- `src/boot.tsx` parses the command line and starts either the terminal UI or the headless CLI.
- The main agent (`src/core/agents/bake.ts`) assembles the system prompt, context, tools, approval callbacks and execution mode for a session, then runs the model loop through a provider from `src/core/llm/providers/`.
- Context comes from `src/core/context/` and the repository graph in `src/core/intelligence/` (language servers and tree-sitter), so the agent can reason about code structure rather than only raw files.
- Tools in `src/core/tools/` (files, shell, Git, code analysis) execute through the registry. Writes and commands pass access checks and user approval before they run.
- Sessions, memory and workflow state persist in SQLite (`src/core/sessions/`, `src/core/memory/`, `src/core/workflows/`). Durable workflow events are authoritative; the UI only renders them.
- The terminal UI (`src/components/`, `src/hooks/`, `src/stores/`) and the headless CLI (`src/headless/`) are front ends over the same core.

## Task workflow

- Planned work is tracked as GitHub Issues in this repository (shown on the project board), not in markdown files. Before starting, find the issue for the task or open one; record a new idea, follow-up or deferred item as an issue instead of a document or a TODO list.
  - Labels: `verification` (a check that needs a real model, device or account), `idea` (not yet decided), `needs-gulliby` (only the owner can do or decide it), `deferred` (agreed for later), and `area:workflow|tui|desktop|api|ci|release`. Use the issue type Task, Bug or Feature.
  - Every new issue goes on the BAKED project board with Status `Backlog` (or `Ready`) and a Priority: `P0` (blocks current work or a release), `P1` (next up), `P2` (later or an idea). With the GitHub CLI: `gh project item-add` then `gh project item-edit` (the token needs the `project` scope). If your tools cannot reach GitHub Projects, put `Priority: P0|P1|P2` on the first line of the issue body so it can be set on the board.
  - Before you open or extend a Bug issue, follow the [file-issue skill](.agents/skills/file-issue/SKILL.md), whoever files it (a person, the bench loop, a smoke run or a review). It finds the root cause and sweeps the code for every place with the same or a neighbouring defect: other copies of the computation, parallel stages, toolchains, providers and surfaces. The issue then lists all of them. A pull request that fixes such an issue fixes every place the issue lists, runs the sweep again before it opens, and reports both in a `## Sweep` section of its description; CI fails a pull request that closes a Bug issue without one, or whose Sweep section has no `Languages:` line. Before it merges, run `bun run review:adversarial --pr N --post` when the Claude Code or Codex CLI of the other model family than yours is logged in on your machine: it has that model look for places the sweep missed, with the [adversarial review prompt](.agents/skills/file-issue/adversarial-review.md) and the skill's own sweep checklist, and posts one advisory comment (no CI job and no API key; the bench loop reviews the fix pull requests other machines merged). Add a new sweep dimension to the skill's Sweep sections, so the reviewer checks it too. Answer a real finding in the same pull request or with a new issue.
  - When a bug is bound to a language (it branches on a language, extension, manifest, toolchain or test convention, or appeared only in one language's project), check whether it reproduces in every other language BAKED supports, taking the list from the code rather than memory. Every language where it reproduces, or where the code shows it would, is covered by the same issue when one shared fix serves them all, or gets its own linked Bug issue when it needs its own fix. The issue and the fixing pull request record the result in a `Languages:` line of their Sweep section.
  - A change that adds or changes a host decision (anything that stops, parks, declines, refuses, retries, times out or grows a limit on its own) records the decision's inputs in the run's database and adds its replay hook, a corpus case and an `accepted.json` entry for any recorded run it means to decide differently, in the same pull request. Follow the [replay-corpus skill](.agents/skills/replay-corpus/SKILL.md); `tests/forecast-replay-corpus.test.ts` replays every bench-round trace in `tests/fixtures/bench-traces/` in CI.
  - The nightly mini-suite in `bench/suite/` runs small tasks in every supported language; follow the [bench-suite skill](.agents/skills/bench-suite/SKILL.md) for its task format and graduation rules. Adding a supported language or toolchain adds at least two suite tasks for it in the same branch, and a bench round or smoke stop that a small task can reproduce adds that task.
  - A pull request that finishes an issue says `Closes #N` in its description so the merge closes the issue; reference it with `Refs #N` when the PR is only part of it.
- Start every task on its own branch, created from an up-to-date `main`:
  - new feature: `feature/<name>`;
  - bug fix: `bugfix/<name>`.

  These are the only two prefixes, for every change and every author: documentation, specs (including `bench/loop/`), CI, refactors and chores use `feature/` unless they fix a bug. `<name>` is a few lowercase words joined by hyphens that say what the task is. Never use another prefix (`docs/`, `fix/`, `chore/`, `claude/`, `codex/`, `copilot/`) or a generic name such as `project-thread`, `patch` or `update`; if your tool proposes a default branch, rename it before the first push. A random suffix your platform appends after the name (`feature/desktop-checkpoints-sgmb4g`) is fine. CI fails a pull request whose head branch breaks this rule; only Dependabot's `dependabot/` branches are exempt.
- Commit intermediate working states on the task branch. Before each intermediate commit, run at least `bun run typecheck` (or `bun run build` for startup and bundling changes) so every commit is a state you can return to.
- Ship major features on every surface of the app: the terminal app (TUI and headless CLI), the desktop app (`apps/desktop`, through the `baked serve` local API), and every supported operating system (Windows, macOS, Linux). Core logic stays in `src/core/` so each front end only renders it. If a surface cannot be done in the same branch, open a follow-up issue for it on the project board and reference it from the pull request. Every user-facing feature has an entry in the feature registry (`src/core/features/registry.ts`) naming how each surface reaches it, or the issue or reason a surface lacks it; `tests/feature-parity.test.ts` fails when a slash command, a `/v1` route or a desktop screen is missing there. See [docs/parity.md](docs/parity.md).
- Keep extension points maintainable. When a task adds a mechanism that later features must extend to stay complete (a registry, a per-language table, a replay or fault-injection hook, a stop reason, a test matrix, a bench-suite task list), its issue says so in a `## Maintainability` section, and the pull request that implements it adds the rule to this file in the same branch: what a later change must add, where, and which test fails when it is skipped. When the rule needs more than a few sentences, write it as a skill under `.agents/skills/<name>/SKILL.md` and link it from here, as the file-issue skill is. Every Feature and Task issue has the section; it says `None` when nothing will need extending. A pull request that extends such a mechanism follows its rule or skill.
- When a task adds or changes a user-visible feature, a command, a setting, the local API or a workflow, update the matching page in `docs/` in the same branch. Long-lived documentation (guides, references, architecture, the design of shipped features) goes only in `docs/` and describes current behavior; plans and one-off reports do not go in the repository.
- When the task is complete and the checks in [Verification](#verification) pass, open a pull request to `main` and add it to the merge queue: `gh pr merge <number> --merge --auto`. `main` takes changes only through the queue, which runs CI on the pull request merged with the current `main` and every pull request ahead of it, then merges it. A pull request whose checks fail in the queue leaves it; fix it and add it again. Do not push to `main` directly.

## Working conventions

- Use Bun for installation, scripts, and tests. Runtime APIs include `bun:sqlite`; Node.js is not a substitute for running the application.
- Follow strict TypeScript and the existing Biome configuration. Avoid `any`, unused variables, and unrelated formatting changes.
- Prefer small changes to existing modules. Keep agent logic independent of the terminal UI.
- Preserve access controls, approval callbacks, secret handling, and coordination when changing tools.
- A pull request that adds an accounting quantity (a token, cost, reservation or forecast figure of a run) or a scheduler command adds its invariant to `tests/workflow-accounting-invariants.test.ts` or its command to the model in `tests/workflow-scheduler-model.test.ts` in the same pull request.
- A new provider adapter joins the provider fault matrix (`FAULT_PROVIDERS` in `tests/helpers/faulty-provider.ts`, run by `tests/provider-fault-matrix.test.ts`) in the same pull request, and a new timer, retry or limit on model calls adds the fault profile that exercises it, with the class it expects: an answer, an outage, a retry, a model mistake or a host fault.
- Keep comments focused on non-obvious intent. Keep documentation technical: setup, behavior, architecture, troubleshooting, and development.
- Preserve user changes already present in the working directory.
- Hot harness modules ([`.github/hot-modules.json`](.github/hot-modules.json): cost forecast, sizing, cap growth, auto-approval, provider timers, scheduler retry) follow an error budget ([docs/bench-loop.md](docs/bench-loop.md#hot-modules)): at most one behavior change per hot module per bench round, and after a round with two or more stops caused by fresh fixes only reverts and regression fixes in those modules until a round passes without one. A pull request that changes one is labelled `hot-module` and runs the module's tests and the forecast replay on their own. A module that shows two escapes in a month (`bun scripts/hot-modules.ts escape`) is added to the list in the same pull request as its fix; a new file of a listed module's computation joins that module's `paths`.
- Code that branches on a language, file extension, manifest or toolchain takes its data from an exhaustive per-language record (`LanguageRecord` in `src/core/intelligence/language-records.ts`): a row for every supported language, or `none(reason)` where the language has no such thing. Register each record in `tests/language-parity.test.ts`, with a golden in every language's fixture under `tests/fixtures/languages/`. Adding a language to `SUPPORTED_LANGUAGES` means filling every record and adding its fixture; the compiler and the parity test list what is missing.
- Provider names in runtime code (Claude, OpenAI, Codex, GitHub Copilot, GitHub Models) describe supported integrations. Do not rename them when editing these instructions or other contributor documentation.

## Language

- Write everything in English: code, comments, identifiers, test names, documentation, design documents, audit records and commit messages.
- Workflow artifacts are English too: research, specifications, plans, task titles and descriptions, reviews, findings and summaries. Write them in English even when the request, project files or answers use another language; translate the meaning and keep identifiers, paths, commands and quoted source text unchanged.
- Tests that need non-ASCII text use Unicode escapes or non-Cyrillic scripts.

## Navigation

- `src/boot.tsx`: startup and CLI routing.
- `src/core/agents/bake.ts`: main agent.
- `src/core/context/manager.ts`, `src/core/prompts/`: context and prompt assembly.
- `src/core/tools/`: tools and registry.
- `src/core/intelligence/`: repository graph and analysis backends.
- `src/core/llm/providers/`: model providers.
- `src/core/workflows/`, `src/core/specs/`, `src/core/verification/`: durable workflows, artifact validation and acceptance.
- `src/core/features/registry.ts`: the feature registry, which says how each surface reaches every feature.
- `src/components/`, `src/hooks/`, `src/stores/`: terminal UI.
- `src/headless/`: CLI automation.
- `docs/`: user and technical documentation; `docs/desktop/api.md` is the desktop API contract, `docs/workflows/runtime.md` the workflow runtime guide.
- `tests/`: feature tests using `bun:test`.

## Verification

CI runs these on every pull request to `main`; run them before merging:

```sh
bun run lint
bun run typecheck
bun run test
bun run build
```

`bun run typecheck` runs `bun check`, which needs Bun 1.4.3 or newer; on an older Bun use `bun run typecheck:tsc`. While iterating, `bun test tests/<feature>.test.ts` runs one feature's tests. The suite is hermetic: tests must not depend on the developer's home directory, global hooks or configuration, or provider environment variables such as `ANTHROPIC_BASE_URL`. Point home-dependent code at a temporary profile instead of skipping the test. Documentation-only changes need link, path, and configuration checks rather than new unit tests; `bun test tests/docs.test.ts` checks the links in `docs/` and the slash command list in `docs/commands.md`. Report what was checked and any failures that remain.

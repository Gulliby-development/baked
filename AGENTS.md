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
  - A pull request that finishes an issue says `Closes #N` in its description so the merge closes the issue; reference it with `Refs #N` when the PR is only part of it.
- Start every task on its own branch, created from an up-to-date `main`:
  - new feature: `feature/<name>`;
  - bug fix: `bugfix/<name>`.

  These are the only two prefixes, for every change and every author: documentation, specs (including `bench/loop/`), CI, refactors and chores use `feature/` unless they fix a bug. `<name>` is a few lowercase words joined by hyphens that say what the task is. Never use another prefix (`docs/`, `fix/`, `chore/`, `claude/`, `codex/`, `copilot/`) or a generic name such as `project-thread`, `patch` or `update`; if your tool proposes a default branch, rename it before the first push. A random suffix your platform appends after the name (`feature/desktop-checkpoints-sgmb4g`) is fine. CI fails a pull request whose head branch breaks this rule; only Dependabot's `dependabot/` branches are exempt.
- Commit intermediate working states on the task branch. Before each intermediate commit, run at least `bun run typecheck` (or `bun run build` for startup and bundling changes) so every commit is a state you can return to.
- Ship major features on every surface of the app: the terminal app (TUI and headless CLI), the desktop app (`apps/desktop`, through the `baked serve` local API), and every supported operating system (Windows, macOS, Linux). Core logic stays in `src/core/` so each front end only renders it. If a surface cannot be done in the same branch, open a follow-up issue for it on the project board and reference it from the pull request. Every user-facing feature has an entry in the feature registry (`src/core/features/registry.ts`) naming how each surface reaches it, or the issue or reason a surface lacks it; `tests/feature-parity.test.ts` fails when a slash command, a `/v1` route or a desktop screen is missing there. See [docs/parity.md](docs/parity.md).
- When a task adds or changes a user-visible feature, a command, a setting, the local API or a workflow, update the matching page in `docs/` in the same branch. Long-lived documentation (guides, references, architecture, the design of shipped features) goes only in `docs/` and describes current behavior; plans and one-off reports do not go in the repository.
- When the task is complete and the checks in [Verification](#verification) pass, merge the task branch into `main` and push `main`.

## Working conventions

- Use Bun for installation, scripts, and tests. Runtime APIs include `bun:sqlite`; Node.js is not a substitute for running the application.
- Follow strict TypeScript and the existing Biome configuration. Avoid `any`, unused variables, and unrelated formatting changes.
- Prefer small changes to existing modules. Keep agent logic independent of the terminal UI.
- Preserve access controls, approval callbacks, secret handling, and coordination when changing tools.
- Keep comments focused on non-obvious intent. Keep documentation technical: setup, behavior, architecture, troubleshooting, and development.
- Preserve user changes already present in the working directory.
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

# Working on BAKED

These instructions apply to every coding agent and every model provider that works in this repository, and to human contributors.

## Project

BAKED is a TypeScript coding agent with an OpenTUI/React terminal UI and a headless CLI. It runs on Bun and uses SQLite for persistent data. Read `README.md` for setup and `CONTRIBUTING.md` for architecture and extension points.

## How BAKED works

- `src/boot.tsx` parses the command line and starts either the terminal UI or the headless CLI.
- The main agent (`src/core/agents/forge.ts`) assembles the system prompt, context, tools, approval callbacks and execution mode for a session, then runs the model loop through a provider from `src/core/llm/providers/`.
- Context comes from `src/core/context/` and the repository graph in `src/core/intelligence/` (language servers and tree-sitter), so the agent can reason about code structure rather than only raw files.
- Tools in `src/core/tools/` (files, shell, Git, code analysis) execute through the registry. Writes and commands pass access checks and user approval before they run.
- Sessions, memory and workflow state persist in SQLite (`src/core/sessions/`, `src/core/memory/`, `src/core/workflows/`). Durable workflow events are authoritative; the UI only renders them.
- The terminal UI (`src/components/`, `src/hooks/`, `src/stores/`) and the headless CLI (`src/headless/`) are front ends over the same core.

## Task workflow

- Start every task on its own branch, created from an up-to-date `main`:
  - new feature: `feature/<name>`;
  - bug fix: `bugfix/<name>`.
- Commit intermediate working states on the task branch. Before each intermediate commit, run at least `bun run typecheck` (or `bun run build` for startup and bundling changes) so every commit is a state you can return to.
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
- `locales/en.json` is generated from source. When a key is removed from it, remove the same key from every other `locales/<language>.json`, or the `locales` CI check fails.

## Language

- Write everything in English: code, comments, identifiers, test names, documentation, design documents, audit records and commit messages.
- Workflow artifacts are English too: research, specifications, plans, task titles and descriptions, reviews, findings and summaries. Write them in English even when the request, project files or answers use another language; translate the meaning and keep identifiers, paths, commands and quoted source text unchanged.
- The only exception is user-facing translations in `locales/<language>.json`, which keep their own language.
- Tests that need non-ASCII text use Unicode escapes or non-Cyrillic scripts.

## Navigation

- `src/boot.tsx`: startup and CLI routing.
- `src/core/agents/forge.ts`: main agent.
- `src/core/context/manager.ts`, `src/core/prompts/`: context and prompt assembly.
- `src/core/tools/`: tools and registry.
- `src/core/intelligence/`: repository graph and analysis backends.
- `src/core/llm/providers/`: model providers.
- `src/core/workflows/`, `src/core/specs/`, `src/core/verification/`: durable workflows, artifact validation and acceptance.
- `src/components/`, `src/hooks/`, `src/stores/`: terminal UI.
- `src/headless/`: CLI automation.
- `docs/`: user and technical documentation; `docs/desktop/api.md` is the desktop API contract, `docs/workflows/runtime.md` the workflow runtime guide.
- `tests/`: feature tests using `bun:test`.

## Verification

CI runs these on every pull request to `main`; run them before merging:

```sh
bun run lint
bun run typecheck
bun scripts/validate-locales.ts
bun test
bun run build
```

While iterating, `bun test tests/<feature>.test.ts` runs one feature's tests. The suite is hermetic: tests must not depend on the developer's home directory, global hooks or configuration, or provider environment variables such as `ANTHROPIC_BASE_URL`. Point home-dependent code at a temporary profile instead of skipping the test. Documentation-only changes need link, path, and configuration checks rather than new unit tests; `bun test tests/docs.test.ts` checks the links in `docs/` and the slash command list in `docs/commands.md`. Report what was checked and any failures that remain.

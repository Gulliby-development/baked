# Working on BAKED with Codex

## Project

BAKED is a TypeScript coding agent with an OpenTUI/React terminal UI and a headless CLI. It runs on Bun and uses SQLite for persistent data. Read `README.md` for setup and `CONTRIBUTING.md` for architecture and extension points.

## Working conventions

- Use Bun for installation, scripts, and tests. Runtime APIs include `bun:sqlite`; Node.js is not a substitute for running the application.
- Follow strict TypeScript and the existing Biome configuration. Avoid `any`, unused variables, and unrelated formatting changes.
- Prefer small changes to existing modules. Keep agent logic independent of the terminal UI.
- Preserve access controls, approval callbacks, secret handling, and coordination when changing tools.
- Keep comments focused on non-obvious intent. Keep documentation technical: setup, behavior, architecture, troubleshooting, and development.
- Preserve user changes already present in the working directory.
- Claude and other provider names in runtime code describe supported integrations. Do not rename them as part of maintaining Codex instructions.

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
- `src/components/`, `src/hooks/`, `src/stores/`: terminal UI.
- `src/headless/`: CLI automation.
- `tests/`: feature tests using `bun:test`.

## Verification

```sh
bun run typecheck
bun run lint
bun test tests/<feature>.test.ts
```

Run the full `bun test` suite for changes that affect shared behavior. Run `bun run build` for startup, bundling, and runtime-dependency changes. Documentation-only changes need link, path, and configuration checks rather than new unit tests. Report what was checked and any failures that remain.


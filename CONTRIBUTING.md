# Developing BAKED

BAKED runs on Bun. Install dependencies with `bun install`, then start the terminal UI with `bun run dev`.

## Architecture

- `src/boot.tsx` routes startup to the terminal UI or headless CLI.
- `src/components/`, `src/hooks/`, and `src/stores/` implement the OpenTUI/React interface.
- `src/core/agents/forge.ts` assembles the agent, prompts, tools, approvals, and execution modes.
- `src/core/tools/` provides file operations, shell execution, Git, and code analysis.
- `src/core/context/` and `src/core/intelligence/` maintain context, repository graphs, and standalone language servers.
- `src/core/llm/providers/` contains Claude, OpenAI API, Codex, GitHub Copilot, and GitHub Models connections.
- `src/headless/` provides command-line automation and interactive console chat.
- `src/core/sessions/` and `src/core/memory/` manage persisted sessions and memory.
- `src/core/workflows/` owns durable workflow commands, scheduling, approvals, budgets, leases and recovery. `src/core/specs/`, `src/core/agents/profiles/` and `src/core/verification/` implement artifact validation, agent capabilities and acceptance.

Keep agent logic independent of the UI. Preserve approval callbacks, secret handling, file access checks, and coordination between tabs when changing tools. Use strict TypeScript and the existing Biome configuration.

## Workflow development

- [SDD workflows and agent profiles](design/sdd-workflows/README.md): architecture, contracts, implementation status and opt-in runtime guide. Keep the feature disabled by default until the documented release gates pass.
- Run `bun test tests/workflow-runtime.test.ts tests/workflow-adapters.test.ts` for deterministic workflow integration, native SDK tool execution and terminal UI coverage. Fixtures do not require provider credentials.
- Change run state through `NativeWorkflowService`; keep React and UI stores out of the runtime. Durable events and SQLite are authoritative. Never use a model's claim as command evidence or bypass a stale approval.

## Verification

```sh
bun run typecheck
bun run lint
bun test tests/<feature>.test.ts
bun test
bun run build
```

Run the full test suite for shared behavior changes. Build after changes to startup, dependencies, or bundling. The generated application starts with `bun run dist/index.js`.

Checkouts use LF line endings on every platform (`.gitattributes`). A Windows checkout made before that file existed still has CRLF files, which `bun run lint` reports as format errors. Convert it once with `git rm --cached -r -q . && git reset --hard` after committing or stashing your work.

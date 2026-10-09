# BAKED

BAKED is a coding agent with a terminal interface and a headless CLI. It builds a codebase graph, uses language servers and syntax trees to navigate and edit code, and stores project memory and sessions locally.

This repository contains the TypeScript core and terminal application. The desktop application is not included.

## Run from source

Use Bun 1.3.13 or newer on Windows, macOS, or Linux:

```sh
bun install
bun run dev
```

Configure a provider through `/keys` and select a model with `Ctrl+L`. Local providers are also supported. The built-in text editor works without extra installation.

```sh
bun run src/boot.tsx --help
bun run src/boot.tsx --list-providers
bun run src/boot.tsx --headless "Explain this project's architecture"
```

## Development

```sh
bun run typecheck
bun run lint
bun test
bun run build
```

| Path | Purpose |
| --- | --- |
| `src/boot.tsx` | Startup and CLI routing |
| `src/components/`, `src/hooks/`, `src/stores/` | Terminal UI and state |
| `src/core/agents/`, `src/core/tools/` | Agent execution and tools |
| `src/core/intelligence/` | Code graph, LSP, tree-sitter, TypeScript analysis |
| `src/core/llm/`, `src/core/prompts/` | Providers and prompt assembly |
| `src/core/memory/`, `src/core/sessions/` | Persistent context and conversations |
| `src/headless/` | CLI automation |
| `tests/` | Bun tests |
| `scripts/`, `packaging/` | Build and installer tooling |

## Documentation

- [Getting started](GETTING_STARTED.md): setup, interface, configuration, and CLI usage.
- [Development guide](CONTRIBUTING.md): architecture and extension points.
- [SDD workflows](design/sdd-workflows/README.md): opt-in specification, planning, agent execution, review and convergence, with implementation verification status.
- [Codex instructions](AGENTS.md): conventions and verification commands.
- [Technical reference](mintlify-docs/introduction.mdx): detailed guides and recipes.
- [Localization](locales/README.md): translation format and validation.
- [Telemetry service](telemetry-worker/README.md): receiver implementation and deployment.

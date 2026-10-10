# BAKED

BAKED is a coding agent for the terminal. It builds a graph of your repository with language servers and tree-sitter, so the agent navigates code by symbols and imports rather than by raw text search. It edits, runs checks and commits through tools that ask before they write, and it keeps sessions, memory and workflow state locally in SQLite.

It has three front ends over one core:

- **Terminal UI**: chat, model picker, task router, plan mode, Git menu and workflow screens.
- **Headless CLI**: `baked --headless "<prompt>"` for scripts and CI, with JSON or JSONL event output.
- **Spec-driven workflows**: `baked workflow` runs research, specification, planning, implementation, checks and review as durable, resumable runs with budgets and approvals.

A desktop application lives in `apps/desktop`: an Electron app over the same core, through `baked serve` ([desktop app](docs/desktop/app.md)).

Status: pre-release. The repository is private, and releases are published on GitHub only, not to npm.

## Install

### From a release

Download the archive for your platform from [Releases](https://github.com/Gulliby-development/baked/releases). While the repository is private, you need to be signed in to GitHub, or use the GitHub CLI:

```sh
gh release download --repo Gulliby-development/baked --pattern '*linux-x64.tar.gz'
```

- **Linux and macOS**: `tar xzf baked-<version>-<platform>-<arch>.tar.gz && cd baked-<version>-<platform>-<arch> && ./install.sh`. This installs to `~/.baked/bin`.
- **Windows**: run `baked-setup-<version>-x64.exe`, or extract `baked-<version>-windows-x64.zip` and run `baked.exe`.

Each release lists `SHA256SUMS.txt` for the archives.

### From source

Use Bun 1.3.13 or newer on Windows, macOS or Linux:

```sh
bun install
bun run dev
```

## First run

Configure a provider with `/keys` and pick a model with `Ctrl+L`. Supported providers are Claude, OpenAI, Codex, GitHub Copilot and GitHub Models ([providers](docs/providers.md)).

```sh
baked                                     # terminal UI
baked --headless "Explain this project"   # one prompt, no UI
baked --list-providers                    # provider status
baked workflow --help                     # spec-driven workflows
baked doctor                              # check keys, models and tools
```

From source, replace `baked` with `bun run src/boot.tsx`.

Global configuration lives in `~/.baked/config.json` (`%LOCALAPPDATA%\baked\config.json` on Windows) and project configuration in `.baked/config.json`. See the [configuration reference](docs/configuration.md).

## Privacy

Prompts and code go only to the model provider you configure. Anonymous usage events (version, OS, surface) are recorded in a local file, `~/.baked/telemetry/events.jsonl`, and are not sent anywhere unless you set a receiver. Run `baked telemetry` to see them, or turn recording off with `"telemetry": false` or `DO_NOT_TRACK=1`. Details: [privacy and telemetry](docs/privacy.md).

## Documentation

- [Documentation](docs/README.md): getting started, user guide, commands, configuration, providers, tools, extensions and architecture.
- [SDD workflows](docs/workflows/README.md): runtime guide and design of spec-driven workflows.
- [Desktop API](docs/desktop/api.md): the contract between the desktop app and `baked serve`.
- [Development guide](CONTRIBUTING.md): architecture and extension points.
- [Agent instructions](AGENTS.md): conventions and checks for any coding agent working on this repository.
- [Localization](locales/README.md): translation format and validation.
- [Telemetry receiver](telemetry-worker/README.md): optional Cloudflare Worker that collects events.

## Development

```sh
bun run lint
bun run typecheck
bun scripts/validate-locales.ts
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
| `src/core/workflows/`, `src/core/specs/` | Durable workflows and artifact validation |
| `src/core/memory/`, `src/core/sessions/` | Persistent context and conversations |
| `src/headless/` | CLI automation |
| `src/core/api/` | Local workflow API (`baked serve`) |
| `docs/` | Documentation |
| `tests/` | Bun tests |
| `scripts/`, `packaging/` | Build, bundle and installer tooling |

## License

[MIT](LICENSE)

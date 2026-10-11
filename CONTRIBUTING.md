# Developing BAKED

BAKED runs on Bun. Install dependencies with `bun install`, then start the terminal UI with `bun run dev`.

## Architecture

- `src/boot.tsx` routes startup to the terminal UI or headless CLI.
- `src/components/`, `src/hooks/`, and `src/stores/` implement the OpenTUI/React interface.
- `src/core/agents/bake.ts` assembles the agent, prompts, tools, approvals, and execution modes.
- `src/core/tools/` provides file operations, shell execution, Git, and code analysis.
- `src/core/context/` and `src/core/intelligence/` maintain context, repository graphs, and standalone language servers.
- `src/core/llm/providers/` contains Claude, OpenAI API, Codex, GitHub Copilot, and GitHub Models connections.
- `src/headless/` provides command-line automation and interactive console chat.
- `src/core/api/` serves the workflow commands as a local HTTP API with an event stream (`baked serve`); it reuses the `baked workflow` command path. See the [runtime guide](docs/workflows/runtime.md#local-api-baked-serve); the desktop contract is [docs/desktop/api.md](docs/desktop/api.md).
- `src/core/sessions/` and `src/core/memory/` manage persisted sessions and memory.
- `src/core/projects/` resolves the project manifest (`baked/project.json`), its trusted roots and working set; `ProjectService` is the contract for the CLI and the local API ([projects](docs/projects.md)).
- `src/core/workflows/` owns durable workflow commands, scheduling, approvals, budgets, leases and recovery. `src/core/specs/`, `src/core/agents/profiles/` and `src/core/verification/` implement artifact validation, agent capabilities and acceptance.

Keep agent logic independent of the UI. Preserve approval callbacks, secret handling, file access checks, and coordination between tabs when changing tools. Use strict TypeScript and the existing Biome configuration.

## Workflow development

- [SDD workflows](docs/workflows/README.md): architecture, the v2 definition format and the runtime guide. Workflows are on by default; `workflows.enabled: false` turns them off.
- Run `bun test tests/workflow-runtime.test.ts tests/workflow-adapters.test.ts` for deterministic workflow integration, native SDK tool execution and terminal UI coverage. Fixtures do not require provider credentials.
- Change run state through `NativeWorkflowService`; keep React and UI stores out of the runtime. Durable events and SQLite are authoritative. Never use a model's claim as command evidence or bypass a stale approval.

## Verification

```sh
bun run typecheck
bun run lint
bun test tests/<feature>.test.ts
bun run test
bun run build
```

`bun run typecheck` runs `bun check` (Bun 1.4.3 or newer, the version CI uses). On an older Bun, `bun run typecheck:tsc` runs the same check with `tsc` from `package.json`.

Run the full test suite for shared behavior changes. Use `bun run test` rather than a bare `bun test` for the whole suite: the script passes `--timeout 30000`, which workflow tests need on slower machines, and Bun applies a timeout set in a preload only to the first test file.

CI runs `bun run test` on Linux for every pull request (`CI / check`). The `OS tests` workflow runs it on Windows and macOS (runners there cost 2x and 10x Linux minutes) for pull requests that change platform-sensitive code, nightly against `main`, and on manual dispatch. Its `scope` job holds the path list: process, shell, path, file system and key store code (`src/core/platform`, `workflows`, `verification`, `tools`, `sessions`, `git` and similar), `src/headless`, the test setup, dependencies and the workflow file. Add a directory there when it gains platform-specific behavior. A test of a feature one platform lacks uses `test.skipIf` with a comment naming the platform; a test that fails on one platform is fixed, not skipped. Build after changes to startup, dependencies, or bundling. The generated application starts with `bun run dist/index.js`.

Checkouts use LF line endings on every platform (`.gitattributes`). A Windows checkout made before that file existed still has CRLF files, which `bun run lint` reports as format errors. Convert it once with `git rm --cached -r -q . && git reset --hard` after committing or stashing your work.

## Distributables

| Script | Output | Builds on |
| --- | --- | --- |
| `bun run build` | npm package (`dist/`, needs Bun at runtime) | any OS |
| `bun run bundle`, `bundle:x64` | macOS arm64 / x64 `.tar.gz` with `install.sh` | any OS |
| `bun run bundle:linux`, `bundle:linux-arm64` | Linux x64 / arm64 `.tar.gz`; `bash scripts/bundle.sh x64-baseline linux` for CPUs without AVX | any OS |
| `bun run bundle:windows`, `bundle:windows-arm64` | Windows `.zip` with `baked.exe` and `deps/` (needs `pwsh`) | any OS |
| `bun run installer:windows` | NSIS installer, x64 only (needs `makensis`) | any OS |
| `bun run selfextract:windows`, `selfextract:windows-arm64` | Installer that downloads the zip from GitHub Releases | any OS |

Every package must keep its `deps/` tree (OpenTUI native library, worker bundles, tree-sitter WASM) next to the binary or in the per-user data directory. `baked self-check` loads each of them plus SQLite without a terminal or provider key and exits non-zero on a failure. The `Builds` workflow runs it on every package that can execute on its runner: Linux on every pull request; Windows and macOS when a pull request changes packaging files, nightly, and on manual dispatch. Linux arm64 and Windows arm64 are cross-built and checked for contents only. Binaries are not code-signed or notarized.

## Releases

Versions follow semantic versioning and are tagged `vX.Y.Z`. From an up-to-date `main` with every change merged:

```sh
bun run release:dry     # next version and the commits since the last tag
bun run release:minor   # or release:patch / release:major
```

`scripts/release.sh` runs the checks, commits the version bump as "Release X.Y.Z", tags it and pushes `main` and the tag. The tag starts `.github/workflows/release.yml`, which runs the full check suite, builds every archive through the Builds workflow and publishes a GitHub release with `SHA256SUMS.txt` and notes generated from the merged pull requests. Label a pull request `skip-changelog` to leave it out of the notes; Dependabot pull requests are grouped under "Dependencies".

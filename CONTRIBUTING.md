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
- Quality gates have a matrix in `tests/gate-matrix.test.ts`: one fixture per stack (Bun, npm, Python, Go, Rust, Maven, .NET) against each gate decision (gate detection, the test check the mutation gate needs, per-task or integration checks, dependency detection, property tests, mutation tool detection), once in a plain checkout and once in the run and task worktrees the scheduler creates, with the working copy's `node_modules` linked and read through the scheduler's tool shell and property-library probe. A new gate, or a change to how a gate reads a toolchain or a project layout, adds its cells; a fix for a gate bug adds the failing cell first, and an open bug stays listed in `KNOWN` with its issue until the fix removes it. `BAKED_GATE_MATRIX_TOOLCHAINS=1` also runs every stack's detected gates on a minimal project with the real tools (CI job `gate-matrix`); locally a missing toolchain skips its row.
- Change run state through `NativeWorkflowService`; keep React and UI stores out of the runtime. Durable events and SQLite are authoritative. Never use a model's claim as command evidence or bypass a stale approval.
- A `baked workflow` option is added once, to its command's list in `commandFlags` (and to `booleanFlags` when it takes no value) in `src/headless/workflow-parse.ts`; the parser's set of known options is derived from those lists. `tests/workflow-argv-spawn.test.ts` starts the real CLI with every option of the commands that start or change runs, so add a command there when it gains options.

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

CI runs `bun run test` on Linux for every pull request (`CI / check`). The `OS tests` workflow runs it on Windows and macOS (runners there cost 2x and 10x Linux minutes) in the merge queue for changes to platform-sensitive code, nightly against `main`, and on manual dispatch. On a pull request its `test (windows-latest)` and `test (macos-latest)` checks pass at once, unless the pull request changes the workflow or `scripts/test-shard.ts`; the queue runs them on the change merged with the current `main`. Windows runs in three shards side by side (`bun scripts/test-shard.ts <index> <count>` runs one shard locally), and each `test (...)` check reports whether all shards of its platform passed. Windows shards allow 90 s per test instead of 30 s: Windows runners start processes and write files several times slower, and slow down further for a minute at a time (#1177). Every test run in CI ends with a slow-test report (`bun scripts/slow-tests.ts <junit.xml> <limit ms> [--fail]`): each test above half of its limit (the run's `--timeout`, or the number its `test(name, fn, ms)` call passes) is a warning annotation on its line, and above 80 percent an error. The nightly `OS tests` run against `main` fails on such an error; in the merge queue and on pull requests it is only an annotation, so a test that grows into its limit shows up before it times out on a busy runner and ejects a pull request (#1589, #1656). A test cleanup that removes a directory after stopping a service or process uses `removeTempDir` from `tests/helpers/temp-dir.ts`, which retries while Windows still holds a handle inside it (`EBUSY`). The test setup opens workflow databases without a disk flush per commit (`BAKED_WORKFLOW_DB_SYNC=normal`); with it, a throttled runner disk made every workflow event take seconds. In CI the test setup sets `BAKED_TRACE_RUN_BLOCKS=1`, which prints why a workflow run blocked, a check slower than 3 s, an agent-call error, and the latest events of a run still active when its service closes. Its `scope` job holds the path list: process, shell, path, file system and key store code (`src/core/platform`, `workflows`, `verification`, `tools`, `sessions`, `git` and similar), `src/headless`, the test setup, dependencies and the workflow file. Add a directory there when it gains platform-specific behavior. A test of a feature one platform lacks uses `test.skipIf` with a comment naming the platform; a test that fails on one platform is fixed, not skipped. `tests/sandbox-integration.test.ts` runs real commands in the [OS sandbox](docs/sandbox.md) and skips where no backend works; CI installs bubblewrap and sets `BAKED_REQUIRE_SANDBOX` (`bwrap` on Linux, `seatbelt` on macOS) so a missing backend fails there instead of skipping. Build after changes to startup, dependencies, or bundling. The generated application starts with `bun run dist/index.js`.

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

## Merging

`main` is protected by a merge queue. Add a pull request to it with `gh pr merge <number> --merge --auto` (or "Merge when ready" on GitHub); it joins the queue once its own checks pass. The queue tests each pull request merged with the current `main` and the pull requests ahead of it, runs the same `CI`, `Builds` and `OS tests` workflows on that `merge_group` event, and merges it with a merge commit when they pass, so pull requests no longer need to be brought up to date with `main` by hand. A pull request that fails in the queue is removed from it. Direct pushes to `main` are rejected.

## Releases

Versions follow semantic versioning and are tagged `vX.Y.Z`. `main` takes changes only through the merge queue, so a release is a pull request followed by a tag. From an up-to-date `main` with every change merged:

```sh
bun run release:dry     # next version and the commits since the last tag
bun run release:minor   # or release:patch / release:major
```

`scripts/release.sh` runs the checks, commits the version bump of `package.json` and `apps/desktop/package.json` as "Release X.Y.Z" on a `feature/release-x-y-z` branch and pushes it; with the GitHub CLI installed it also opens the pull request and adds it to the merge queue. Once that pull request is merged, pull `main` and tag the merged commit:

```sh
git switch main && git pull
bun run release:tag     # tags vX.Y.Z from package.json and pushes the tag
```

The tag starts `.github/workflows/release.yml`, which checks that the tag matches `package.json`, runs the full check suite, builds every archive through the Builds workflow and publishes a GitHub release with `SHA256SUMS.txt` and notes generated from the merged pull requests. Label a pull request `skip-changelog` to leave it out of the notes; Dependabot pull requests are grouped under "Dependencies".

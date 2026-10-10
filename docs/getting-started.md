# Getting started

## Install

### From a release

Download the archive for your platform from [Releases](https://github.com/Gulliby-development/baked/releases). While the repository is private, sign in to GitHub or use the GitHub CLI:

```sh
gh release download --repo Gulliby-development/baked --pattern '*linux-x64.tar.gz'
```

- **Linux and macOS**: `tar xzf baked-<version>-<platform>-<arch>.tar.gz && cd baked-<version>-<platform>-<arch> && ./install.sh`. This installs to `~/.baked/bin`.
- **Windows**: run `baked-setup-<version>-x64.exe`, or extract `baked-<version>-windows-x64.zip` and run `baked.exe`. Keep the `deps/` folder next to `baked.exe`.

Each release lists `SHA256SUMS.txt` for the archives. `baked self-check` loads the native libraries, worker bundles, tree-sitter grammars and SQLite without a terminal or provider key, and exits non-zero when one is missing.

### Desktop app

Releases also carry the desktop app, which bundles its own `baked`:

- **Windows**: `baked-desktop-<version>-win-<arch>.exe` (installer).
- **macOS**: `baked-desktop-<version>-mac-<arch>.dmg`, or the `.zip`.
- **Linux**: `baked-desktop-<version>-linux-<arch>.AppImage` or the `.deb` package.

The installers are not signed yet. Windows SmartScreen warns on first launch (More info, then Run anyway); macOS blocks the app until you allow it in System Settings, Privacy & Security. See [Desktop app](desktop/app.md).

### From source

Bun 1.3.13 or newer on Windows, macOS or Linux:

```sh
bun install
bun run dev
```

From source, replace `baked` in the examples with `bun run src/boot.tsx`, using the absolute path to `src/boot.tsx` when you run it from another directory. `--cwd <dir>` targets another project.

## First run

```sh
cd your-project
baked
```

The first launch scans the repository to build its graph, which takes a few seconds. Then:

1. Configure a provider with `/keys` (or `baked --set-key <provider> <key>`). See [providers](providers.md).
2. Pick a model with `Ctrl+L`.
3. Ask a question or describe a change. The agent reads code through the repository graph and asks before it writes outside the project or runs a destructive command.
4. Commit with `Ctrl+G`, then `c`, or ask the agent to commit. BAKED runs the project's lint and typecheck before a commit made through its tools.

`baked doctor` checks provider keys, routed models, check commands and Git before you start a workflow.

## Essential shortcuts

| Key | Does |
| --- | --- |
| `Ctrl+L` | Switch model |
| `Ctrl+K` | Command palette (type `/` in the input for the same list) |
| `Ctrl+G` | Git menu |
| `Ctrl+D` | Cycle mode (default, architect, plan, auto) |
| `Ctrl+X` | Stop the agent |
| `Ctrl+P` | Browse sessions |
| `Alt+O` | Switch project |
| `Ctrl+B` / `Ctrl+F` | Previous / next checkpoint |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |

The full list is in [commands and keys](commands.md).

## Next

- [User guide](guide.md) for the terminal UI.
- [Headless CLI](headless.md) for scripts and CI.
- [Workflows](workflows/README.md) for durable spec-driven runs with approvals and budgets.
- [Configuration](configuration.md) for `config.json`.

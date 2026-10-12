# Tools and code intelligence

The agent picks tools itself; this page lists what they do. `/tools` turns tools off (stored in `disabledTools`). The registry is `src/core/tools/index.ts`; every write and command passes the access checks and approvals there.

## Reading and searching

| Tool | Does |
| --- | --- |
| `read` | A whole file, line ranges, or one symbol by name; large files return an outline first |
| `list_dir`, `glob`, `grep` | Directory listing, file patterns, text search |
| `navigate` | Definitions, references, call and type hierarchy |
| `analyze` | Type signatures, symbol outlines, diagnostics and quick-fix suggestions |
| `bake_find` | Fuzzy file and symbol search ranked by importance |
| `bake_grep` | Code search with per-file counts and symbol context from the repository graph |
| `bake_query` | A pipeline of search, filter, dependency, outline and read stages in one call |
| `bake_analyze` | Graph analysis: unused exports, duplication, call graph, top files, class members |
| `bake_impact` | Dependents, dependencies, files that change together, blast radius |
| `discover_pattern` | Finds how a concept is already implemented in the codebase |
| `bake_vision` | Shows an image or video file inline in the chat, for example a screenshot path given in the prompt |
| `web_search`, `fetch_page` | Web search and page reading (asks before each search) |
| `baked_help` | Searches and reads BAKED's own documentation, bundled with the build; see [Asking about BAKED](#asking-about-baked) |

## Asking about BAKED

Questions about BAKED itself (commands, settings, providers, workflows, the desktop app, the local API) are answered from the pages in `docs/`, which are bundled into every build and binary, so this works in any project, offline and in the same version as the running BAKED. The prompt carries one line telling the agent to use `baked_help`; the pages themselves are read only when asked, so they cost no prompt tokens otherwise.

`baked_help` takes `action`:

- `search` with `query`: the best matching sections, as `page.md#section` with a preview line;
- `read` with `page` (a path such as `workflows/quick.md`, with or without `.md`, or a page title) and an optional `section` (an anchor or heading): the page or the section with its subsections, cut at 12,000 characters with an outline of the sections to read next;
- `list`: every page with its title and the BAKED version.

It is read-only, so it is available in plan and other read-only modes, in chat on every surface (terminal UI, headless `baked --headless`, desktop chat through `baked serve`). Workflow stages do not get it: their tool lists come from the stage profiles. A new page in `docs/` is added to `src/core/help/bundled-docs.ts`; `tests/docs.test.ts` fails when a page is missing there.

## Editing

| Tool | Does |
| --- | --- |
| `edit_file`, `multi_edit` | Line-anchored text edits; `multi_edit` applies several to one file atomically |
| `ast_edit` | Structural TypeScript and JavaScript edits by symbol: set a return type, add a parameter, replace a body, manage imports, in atomic batches |
| `structural_edit` | Pattern-based structural find and replace with ast-grep for Python, Go, Rust, Java, C/C++, Ruby, PHP and others |
| `rename_symbol` | Workspace-wide rename through the language server, checked for leftover references |
| `move_symbol` | Moves a symbol to another file and updates every import |
| `rename_file` | Renames or moves a file and updates its importers |
| `refactor` | Extract function or variable, organize imports, format |
| `undo_edit` | Reverts the last edits of a file |

Line endings are kept per file. `read` adds a `line endings: CRLF` header (or a mixed-file note with the line counts) for files that are not plain LF, and shows lines without the carriage return. `edit_file` and `multi_edit` match `oldString` against the file with either ending, write the result back with the file's dominant ending (CRLF or LF) and normalize the minority lines of a mixed file to it, so a CRLF checkout never ends up half LF. A new file takes the `end_of_line` of the nearest `.editorconfig`, else the dominant ending of a few sibling files, else the text as given.

Before an edit the file is snapshotted; an edit is refused if the file changed on disk in the meantime. Diagnostics are compared before and after, and the agent is told which errors it introduced or fixed, also in other files. Writes outside the project directory and edits of sensitive files ask for approval in the terminal UI.

## Running things

| Tool | Does |
| --- | --- |
| `shell` | Runs a command; destructive commands ask for approval |
| `project` | Detects the toolchain from config and lock files and runs `lint`, `typecheck`, `test`, `build`, `run` or `list` (monorepo packages) for about 20 ecosystems |
| `git` | Status, diff, log, commit, branch, stash, push and pull |

With the `sandbox` setting on, `shell` and `project` commands (and the commit checks below) run in an OS sandbox: they write only inside the project, temp and package caches, and cannot read SSH keys, cloud credentials or token files. See [OS sandbox](sandbox.md).

A `git commit` run by the agent first runs the project's native checks (for example `biome check` and `tsc --noEmit`, `cargo clippy` and `cargo check`, `ruff` and `pyright`); a failure blocks the commit and returns the errors. The checks come from config files, never from `package.json` scripts.

## Agent bookkeeping

`task_list` (the visible task list), `memory` ([user guide](guide.md#memory)), `final_response`, and `request_tools` / `release_tools` (load and unload deferred tools when `agentFeatures.onDemandTools` is on).

## Dispatch

For larger tasks the main agent (Bake) dispatches subagents in parallel: `spark` agents for read-only research and `ember` agents for edits, each on the model of its [router slot](guide.md#models-and-the-task-router). They share a file cache, serialize writes to the same file, and pass findings to each other at their next step. Bake decides when to dispatch; typing while they run steers them.

## Code intelligence

Each operation tries the best backend and falls back:

1. **LSP**: precise types, workspace rename, diagnostics, code actions, call and type hierarchy, formatting. BAKED runs the language servers itself, without an editor.
2. **ts-morph**: TypeScript and JavaScript AST operations.
3. **tree-sitter**: outlines and imports for about 40 languages.
4. **regex**: the last resort.

`/lsp status` shows attached servers; `/lsp install` installs servers from the Mason registry into the BAKED data directory (`lsp-servers/`), through npm, pip, cargo, go or GitHub releases. Servers already on `PATH` are found automatically. `/diagnose` checks LSP, tree-sitter and semantic indexing.

Chat and workflow runs in one BAKED process share the same language servers: the terminal UI and `baked serve` each start one set per project, not one for chat and another for runs ([architecture](architecture.md#code-intelligence)).

## Repository graph

At startup the graph indexes files, symbols and import edges, ranks files with PageRank, adds files that change together in Git history, and renders the top of it into the system prompt:

```
src/services/auth/session.ts (→12)
  +SessionManager  Tracks active sessions, refresh tokens, expiry
```

`+` marks an exported symbol, `(→12)` the number of dependent files, `[NEW]` a recently changed file. The summary after a name comes from `semanticSummaries` (`ast` by default: docstrings only). Files edited or mentioned in the conversation are boosted per turn. The index is SQLite (`repomap.db`) in `<project>/.baked/`; `/repo-map` configures it.

The same graph can be viewed. `/graph` in the terminal shows a read-only summary: the biggest folders as bars and the most depended-on files with how many files use them. The desktop app's **Code graph** section draws it interactively ([desktop app](desktop/app.md#screens), [`/v1/graph`](desktop/api.md#code-graph)). Data and prose files (JSON, Markdown, YAML and similar) are left out of both.

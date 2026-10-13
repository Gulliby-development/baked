# Tools and code intelligence

The agent picks tools itself; this page lists what they do. `/tools` turns tools off (stored in `disabledTools`). The registry is `src/core/tools/index.ts`; every write and command passes the access checks and approvals there.

## Reading and searching

| Tool | Does |
| --- | --- |
| `read` | A whole file, line ranges, or one symbol by name; large files return an outline first |
| `list_dir`, `glob`, `grep` | Directory listing, file patterns, text search |
| `navigate` | Definitions, references, call and type hierarchy. Given only a symbol, it finds the file itself; project files outside dependency folders (`node_modules`, `vendor`, `target`, `bin`, `obj`) win over toolchain and dependency sources such as GOROOT or the JDK, so a project symbol is not reported as ambiguous |
| `analyze` | Type signatures, symbol outlines, diagnostics and quick-fix suggestions |
| `bake_find` | Fuzzy file and symbol search ranked by importance. In a workflow run it searches the attempt's worktree and never returns `.baked/` state |
| `bake_grep` | Code search with per-file counts and symbol context from the repository graph |
| `bake_query` | A pipeline of search, filter, dependency, outline and read stages in one call |
| `bake_analyze` | Graph analysis: unused exports, duplication, call graph, top files, class members |
| `bake_impact` | Dependents, dependencies, files that change together, blast radius |
| `discover_pattern` | Finds how a concept is already implemented in the codebase |
| `bake_vision` | Shows an image or video file inline in the chat, for example a screenshot path given in the prompt |
| `web_search`, `fetch_page` | Web search and page reading (asks before each search) |
| `baked_help` | Searches and reads BAKED's own documentation, bundled with the build; see [Asking about BAKED](#asking-about-baked) |
| `artifact` | Saves, reads and lists the [artifacts](artifacts.md) every project shares, and deploys one to your Vercel; a deploy asks every time, in every approval mode |

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

Before an edit the file is snapshotted; an edit is refused if the file changed on disk in the meantime. Writes outside the project directory and edits of sensitive files ask for approval in the terminal UI.

### Diagnostics after edits

Once code intelligence has started, `edit_file`, `multi_edit`, `ast_edit` and `refactor` compare language-server diagnostics before and after each edit. The comparison covers the edited file and up to 8 files that import it, taken from the code graph (the same dependents `bake_impact` lists; in a workflow worktree they are looked up by their project path and checked inside the worktree). Diagnostics are matched by severity, code and message, so lines that an edit moves do not count as new. The tool result lists:

- new errors in the edited file, with the language server's first quick fix when it offers one;
- `CROSS-FILE ERRORS`: new errors in importing files, such as a caller that no longer matches a changed signature;
- errors the edit resolved, and new warnings when there are no new errors;
- `Diagnostics not checked` when the baseline or the result did not arrive within `diagnostics.timeoutMs`, and the number of importing files that had no result in time. A check that times out is reported, never left out.

The wait is the global `diagnostics.timeoutMs` (2500 ms by default, 250 to 30000), applied once before the edit and once after it. Set it in the Timeouts and limits page (`/timeouts` in the terminal UI, Settings in the desktop app, `PATCH /v1/settings`).

`editDiagnostics` decides what an edit that adds errors does. `feedback` (the default) keeps the edit and returns the errors. `reject` writes the original text back, drops the edit from the undo stack and fails the tool call with the errors and the original lines, so the agent rewrites the edit instead of building on a broken one. A new file created with `ast_edit` is never rejected. It is a chat setting in the Agent features page (`/agent-features`, the desktop settings, `/v1/settings`), per project or global; a workflow run freezes it in its policy ([runtime guide](workflows/runtime.md#diagnostics-after-edits)).

The authoritative whole-project typecheck stays in the workflow checks stage and the `git commit` checks below; the language server is the fast feedback after each edit. A typecheck at the end of each workflow task is planned in [#673](https://github.com/Gulliby-development/baked/issues/673).

## Running things

| Tool | Does |
| --- | --- |
| `shell` | Runs a command; destructive commands ask for approval (or the [approval reviewer](#approval-reviewer) decides) |
| `project` | Detects the toolchain from config and lock files and runs `lint`, `typecheck`, `test`, `build`, `run` or `list` (monorepo packages) for about 20 ecosystems |
| `git` | Status, diff, log, commit, branch, stash, push and pull |

With the `sandbox` setting on, `shell` and `project` commands (and the commit checks below) run in an OS sandbox: they write only inside the project, temp and package caches, and cannot read SSH keys, cloud credentials or token files. See [OS sandbox](sandbox.md).

A `git commit` run by the agent first runs the project's native checks (for example `biome check` and `tsc --noEmit`, `cargo clippy` and `cargo check`, `ruff` and `pyright`); a failure blocks the commit and returns the errors. The checks come from config files, never from `package.json` scripts.

### Approval reviewer

With `agentFeatures.approvalReview` on (the Agent features page: `/agent-features`, the desktop settings, `/v1/settings`; `--approval-review` in headless mode), a chat approval the host lets a model decide goes to the chat's own model first. It sees the call and your recent messages and answers approve or escalate with a risk. A low-risk approval runs the call without asking, and the tool result starts with the reviewer's verdict. An escalation, a medium or high risk, a malformed answer or no answer within 30 seconds asks you as before, with the verdict or the failure in the prompt (in headless mode, where nobody is asked, it is denied). It is off by default and never changes the call.

The reviewer may decide only these: `rm` of paths inside the project (not the project itself, `.git`, a bare glob or anything with `..`, `~` or variables), `git branch -D`, `git rebase`, `kill` of process IDs, and edits of sensitive files that hold no secrets (CI files, Dockerfiles, compose files). A command that chains, substitutes or redirects (`;`, `&&`, `|`, `$(...)`, `>`), runs while other tabs are editing, or is anything else on the destructive list (force push, `reset --hard`, `git clean`, `git checkout --`, database drops, `killall`, piped scripts, `chmod 777`), an edit of `.env`, key, credential or registry-token files, and every write outside the project always ask you. The rules are in `src/core/security/approval-review.ts`.

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

`/lsp status` shows attached servers; `/lsp install` installs servers from the Mason registry into the BAKED data directory (`lsp-servers/`), through npm, pip, cargo, go or GitHub releases. Generic Mason packages such as `jdtls` are downloaded and unpacked into `lsp-servers/packages/<name>/` with their layout kept, and a launcher for each command goes into `lsp-servers/bin/`; a package whose command is a Python script needs `python3` (`python` on Windows) on `PATH`, and `jdtls` also needs Java 21 or newer. Servers already on `PATH` are found automatically. `/diagnose` checks LSP, tree-sitter and semantic indexing.

Chat and workflow runs in one BAKED process share the same language servers: the terminal UI and `baked serve` each start one set per project, not one for chat and another for runs ([architecture](architecture.md#code-intelligence)).

## Repository graph

At startup the graph indexes files, symbols and import edges, ranks files with PageRank, adds files that change together in Git history, and renders the top of it into the system prompt:

```
src/services/auth/session.ts (→12)
  +SessionManager  Tracks active sessions, refresh tokens, expiry
```

`+` marks an exported symbol, `(→12)` the number of dependent files, `[NEW]` a recently changed file. The summary after a name comes from `semanticSummaries` (`ast` by default: docstrings only). Files edited or mentioned in the conversation are boosted per turn. The index is SQLite (`repomap.db`) in `<project>/.baked/`; `/repo-map` configures it.

The same graph can be viewed. `/graph` in the terminal shows a read-only summary: the biggest folders as bars and the most depended-on files with how many files use them. The desktop app's **Code graph** section draws it interactively ([desktop app](desktop/app.md#screens), [`/v1/graph`](desktop/api.md#code-graph)). Data and prose files (JSON, Markdown, YAML and similar) are left out of both.

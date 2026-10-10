# Projects-lite

Date: 2026-10-10. Technical design. Source: the convenience-feature research of 2026-10-10 (item 1, "projects-lite with a working set"). Scope of this change: the data model, the core and the CLI. The project screen in the terminal UI and the desktop app come later and read what this design stores.

## Goal

A project names the work that spans sessions and workflow runs: its folders, the files the user is working on, and settings that apply to all of it. Today a project is implicitly one checkout: sessions live in `<cwd>/.baked/sessions`, runs in `<cwd>/.baked/workflows.sqlite`, settings in `<cwd>/.baked/config.json`. Projects-lite keeps that storage and adds a thin layer over it:

1. A manifest `baked/project.json` with an ID, a name, one or more roots and project defaults.
2. A working set: paths and globs whose contents go into the chat context and the research stage automatically, so the agent does not search for the same files in every session.
3. `projectId` on every session and workflow run created while a project is active, so a project of several checkouts can list its sessions and runs.

It is not a new database. Listing a project's sessions and runs reads the existing per-root stores and filters them by `projectId`.

## Non-goals

- A project screen in the terminal UI or the desktop app.
- Moving sessions or runs into a central store.
- Widening file access: a secondary root does not become writable or readable by tools without the existing outside-cwd approval.
- Syncing the working set with editor state.

## Manifest

`<root>/baked/project.json`, next to the other shared repository content (`baked/gates`, `baked/workflows`, `baked/skills`). `.baked/` is not used because `ensurebakedDir` adds it to `.gitignore`; a project is meant to be committed and shared. Being repository content, the manifest is untrusted input (see [Trusting secondary roots](#trusting-secondary-roots)):

```json
{
  "schemaVersion": 1,
  "id": "baked",
  "name": "BAKED",
  "roots": ["../baked-docs"],
  "workingSet": ["src/core/projects/**/*.ts", "design/projects-lite.md", "../baked-docs/guide.md"],
  "defaults": {
    "instructions": ["docs/agent-notes.md"],
    "config": { "defaultModel": "anthropic/claude-sonnet-4-6" }
  }
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1`. An unknown version is refused with a clear error; the session continues without a project. |
| `id` | `^[a-z0-9][a-z0-9._-]{0,63}$`. Stable across machines; it is what sessions and runs record. |
| `name` | 1..120 characters, display only. |
| `roots` | Secondary roots, paths relative to the manifest's checkout (the primary root). The primary root is implicit and always first. At most 16. |
| `workingSet` | At most 200 entries. Each is a file path, a directory (all files under it) or a glob (`Bun.Glob`), relative to the primary root. An entry may reach a secondary root through a relative path (`../baked-docs/guide.md`), never outside every root. |
| `defaults.instructions` | Paths of markdown files (relative to the primary root, inside the roots) appended to the project instructions. |
| `defaults.config` | A partial config limited to `defaultModel`, `taskRouter`, `modelRouting` and `modelFallback`. Other keys are refused at validation. `workflows` is deliberately excluded: its `policy.checks` are shell commands that become trusted policy gates without the first-use confirmation that `baked/gates` entries get (`v2/library.ts`), so a cloned repository could run commands through it. |

The schema is a strict zod object; unknown top-level keys are refused, so typos surface instead of being ignored.

## Finding the active project

`resolveProject(cwd, { home })` returns the project for a directory or `null`:

1. `<cwd>/baked/project.json` exists: that manifest; `cwd` is its primary root.
2. Otherwise the user registry `<configDir>/projects.json` (see below) has an entry whose trusted roots contain `cwd` (the deepest matching root wins): that entry's manifest; `cwd` is one of its roots.
3. Otherwise no project. Everything behaves as today, and `projectId` is absent.

Only the current directory is checked for a manifest, not its parents, matching how `.baked/config.json` and `.baked/sessions` are found today. A subdirectory of a registered project's root resolves through step 2.

An invalid manifest never stops BAKED: the error goes to stderr (headless) or the error store (terminal UI) once, and the session runs without a project.

## Trusting secondary roots

A manifest is repository content and a cloned repository is not trusted. If a manifest could name `roots: ["~/.ssh"]` and a working set `~/.ssh/*`, opening the checkout would send the keys to a model provider. So:

- The primary root is always trusted: it is the checkout BAKED already runs in, with today's access.
- A secondary root is used only when the user registered it. `baked project register` (and `baked project init`) writes the manifest path and the absolute secondary roots it accepts to `<configDir>/projects.json`. A root added to the manifest later is ignored, with a one-line notice naming `baked project register`, until the user registers again.
- Working-set entries and `defaults.instructions` that resolve outside the trusted roots are dropped with a notice.
- Every working-set file passes the built-in forbidden-file patterns (`.env`, keys, credential files) on its real path and, when initialized, the user's forbidden and `.aiignore` patterns. Matching files are listed as skipped, never read.
- Directory and glob expansion never enters `.git/` (its `config` can hold remote credentials), `.baked/` (transcripts, databases) or `node_modules/`, drops files Git ignores (`git check-ignore`, when the root is a Git checkout), and stops at 500 files per entry and 2000 per working set.

Registry format (`<configDir>/projects.json`, mode 0600):

```json
{ "schemaVersion": 1, "projects": [{ "id": "baked", "root": "/abs/baked", "roots": ["/abs/baked-docs"], "registeredAt": 1760000000000 }] }
```

`configDir()` already honours `HOME`/`LOCALAPPDATA`, and every function takes an explicit `home`/config directory, so tests point it at a temporary profile.

## Working set

`resolveWorkingSet(project)` expands entries into files: real paths, deduplicated, sorted by entry order then path, symlinks resolved and re-checked against the trusted roots, binary files (a NUL byte in the first 8 KB) skipped.

`renderWorkingSet(files, budget)` builds one text block:

```
<working_set project="baked" captured="2026-10-10T08:30:00Z">
Files the user marked as the current focus of this project, as of the capture time. Read a file again before editing it; it may have changed.
<file path="src/core/projects/manifest.ts">
...
</file>
Listed without contents (over budget): src/core/projects/big.ts (48 KB)
Skipped: .env (forbidden)
</working_set>
```

Paths are relative to the session's working directory (`../baked-docs/guide.md` from the primary root). The budget defaults to 64 KB of content and 16 KB per file; a file over its share is listed, not truncated, because a partial file misleads more than an absent one. The limits are constants for now; a config key comes when someone needs another value.

### Chat

`ContextManager` captures the block once per session, at the first system prompt build, and adds it to the instructions after the bake map and skills (`buildInstructions` in `forge.ts`). Child context managers (subagents) never capture it. The block is frozen so prompt caching keeps working; `refreshWorkingSet()` re-captures it and is called by `/clear`; the API will call it after it changes the working set. `getInstructionsCacheKey` includes the block's hash. Editing the manifest by hand takes effect at the next `/clear` or session.

### Workflow runs

At run creation the service resolves the project of the workspace and, if it has a working set, renders it once. The text's hash goes into the input manifest's `instructionHashes` as `project/working-set.md` before `store.create`, so `input_hash`, `run.created` and approval digests cover it; the text is stored as the artifact `project/working-set.md` right after. The runtime state records `{ artifactId, hash, files }` in a new `workingSet` field (`.nullable().default(null)`, so earlier states parse).

The prompt of an agent whose profile context is `research`, `specification` or `planning` includes the artifact text while `state.research` is still null. So the research stage gets it, and a v2 definition without research gives it to its first spec or plan agent; once research exists, later stages get the research output as today. The text counts toward the existing context-window check.

The files are not frozen inputs: the run is expected to change them, and `assertFrozenInputs` must not fail on its own edits.

Two existing paths rebuild run inputs and must carry the entry the way they carry `baked/gates` (`GATES_ARTIFACT`): `stageRevision` (`artifacts.ts`) replaces `instructionHashes` and must keep the `project/working-set.md` entry, and the revise comparison (`service.ts`) must ignore it like the gates entry, otherwise every revision re-implements all tasks. A derived run (rerun) copies the artifact and remaps `workingSet.artifactId`, as it does for `diff`.

A worktree run renders the working set from the project root before the worktree exists, which is the same content.

## Project defaults

`loadProjectConfig(cwd)` stays the raw `.baked/config.json`, because `writeGates` and the workflow panel read it, modify it and write it back, which would copy manifest defaults into the checkout config. A new `loadEffectiveProjectConfig(cwd)` returns `defaults.config` of the active project shallow-merged under it (a key set in `.baked/config.json` replaces the manifest's value whole). Read-only callers that feed `mergeConfigs` (startup, headless, workflow hooks) switch to it. Precedence: global < manifest defaults < checkout config.

`defaults.instructions` files are read by `projectInstructionFiles(project)` (inside the trusted roots, forbidden patterns applied, 32 KB each) and appended to the project instructions: in the chat through `ContextManager`, and in runs inside `frozenInstructions`, which both run start and `stageRevision` call, so both resolve them the same way and hash them like other instruction files.

## projectId on sessions and runs

- `SessionMeta.projectId?: string`, the project of the session's directory, recorded when the session is saved (`useSessionBuilder`, and the per-tab save, which keeps a value already on disk). Old sessions have none until they are saved again. Every path that rebuilds `SessionMeta` on save keeps it, and both list builders (`SessionManager` and the IO worker) return it in `SessionListEntry` so list views can filter without reading messages.
- Workflow runs: migration `007` adds `runs.project_id TEXT` (nullable) and an index `(project_id, created_at)`. `WorkflowService.start` sets it from the resolved project of the workspace; the request does not carry it, so a run cannot claim a project its workspace is not in. Derived runs keep their parent's. The strict `run.created` payload gains an optional `projectId`. Initiatives are reached through their runs and get no column now.
- A read-only reader of a database still on migration 006 (an older checkout listed by `summary()`) has no column: the listing checks for it and reports such runs without a project. A missing database is an empty list.

## Core API

`src/core/projects/` holds the whole feature, independent of the terminal UI:

| Module | Contents |
| --- | --- |
| `manifest.ts` | schema, read, write (atomic), validation errors |
| `registry.ts` | read/write the user registry, `register`, trusted roots |
| `resolve.ts` | `resolveProject(cwd, opts)` |
| `working-set.ts` | expansion, filtering, rendering, hash |
| `service.ts` | `ProjectService`: `current()`, `init()`, `addToWorkingSet()`, `removeFromWorkingSet()`, `sessions()`, `runs()`, `summary()` |

`summary()` returns the manifest, trusted and ignored roots, the resolved working set (paths, sizes, skipped entries) and the latest sessions and runs from all trusted roots, each store opened read-only. It is the payload the project screen and the desktop app will render.

The local HTTP API (`baked serve`, `src/core/api/`, built in parallel) will expose it as `GET /v1/projects/current` (the summary) and `POST /v1/projects/current/working-set` (`{ add?: string[], remove?: string[] }`). The API is not on `main` yet, so the routes come in a follow-up on top of it; `ProjectService` is the contract.

## CLI

`baked project <command>`, dispatched from `src/boot.tsx` like `baked workflow`:

- `init [--name N] [--id ID]`: writes a manifest for the current directory (ID from the directory name) and registers it.
- `show [--json]`: the summary.
- `add <path|glob>...` / `remove <path|glob>...`: edit the working set; entries are checked like manifest entries.
- `register`: trust the manifest's current secondary roots.

Terminal UI slash commands (`/add`, `/project`) are part of the project screen work, not this change.

## Decisions taken by default

- Manifest in the checkout under `baked/`, plus a user registry for trust and multi-root lookup, rather than a registry-only model: a single-repo project then needs no setup outside the repository.
- Manifest defaults cannot set workflow policy, see the `defaults.config` row.
- The working set is frozen per chat session and per run instead of being re-read on every turn, to keep the prompt cache and the run inputs stable.
- Over-budget files are listed, not truncated.
- Secondary roots do not bypass outside-cwd approval for tools.

## Tests

`tests/projects.test.ts` with temporary profiles and checkouts: manifest validation (including the refused `workflows` key), registry trust (unregistered root ignored, root added after registration ignored), working-set expansion with globs, directories, `.git`, symlinks escaping a root and forbidden files, budget rendering, config precedence without write-back, `projectId` on a saved and listed session and on a created run, migration 007 on a database created by migration 006, the working-set hash surviving a definition revision, and the research prompt containing the working set while later stages do not.

## Review

Reviewed on 2026-10-10 before implementation. Changes from the first draft: the manifest moved from `.baked/` (gitignored) to `baked/`; `workflows` and `instructionFiles` were removed from manifest defaults (command execution from a cloned repository); `loadProjectConfig` stays raw to avoid write-back; the working-set hash is carried through `stageRevision`, the revise comparison and reruns; expansion excludes `.git`, `.baked` and ignored files; initiatives get no column; the HTTP routes follow the API.

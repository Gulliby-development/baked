# Packages

A BAKED package ships agent profiles, skills, workflow definitions and gates as one unit with a version and a SHA-256 hash for every file. Installing a package copies its files into the project's own `baked/` folders after the hashes and the definitions check out and a person approves the plan. After the install the files are ordinary project content: they are committed, reviewed and edited like any other file in `baked/`, and BAKED never reads the package folder again.

```sh
baked add ../acme-review            # show the plan, then ask before installing
baked add ../acme-review --yes      # install without the prompt (scripts, CI)
baked packages list                 # installed packages and files edited since
baked packages remove acme-review   # delete its unchanged files
baked packages pack ../acme-review --name acme-review --version 1.0.0   # author: write the manifest
```

The same is `/packages` in the terminal UI, the Packages page under the project's setup in the desktop app, and `/v1/packages*` in the [local API](desktop/api.md#packages).

## What a package is not

- **No remote registry.** A package is a folder on the machine. Getting it there (a Git clone, an archive, a shared drive) is up to you; BAKED downloads nothing.
- **No loading at run time from outside the project.** Runs, chats and the editors read only the project's `baked/` folders (and the user's own `~/.baked` folders where those already exist, such as `~/.baked/agents` and `~/.baked/gates`). The external preset loading removed in #52 stays removed: a package is installed, not referenced.
- **No automatic trust.** An installed gate is a project gate like one you wrote: a run that binds it asks for `baked workflow gates confirm ID` first ([gates](workflows/runtime.md)). Installing never confirms a gate.

## Format

A package is a folder with a `baked-package.json` manifest at its root and the files it lists below it. One format, a folder, keeps every file reviewable as itself (a diff of a package update is a diff of its files) and needs no archive reader; a package kept in a Git repository can be installed from the working copy, and its `.git` folder is ignored.

```text
acme-review/
  baked-package.json
  agents/acme-reviewer.json
  skills/review-notes/SKILL.md
  skills/review-notes/checklist.md
  workflows/acme-quick.json
  gates/lint.json
  gates/scripts/check-links.sh
```

```json
{
  "schemaVersion": 1,
  "name": "acme-review",
  "version": "1.2.0",
  "description": "Acme's review profile, its checklist skill, a quick workflow and the lint gate.",
  "files": [
    { "path": "agents/acme-reviewer.json", "sha256": "3f1c…" },
    { "path": "skills/review-notes/SKILL.md", "sha256": "9b20…" }
  ]
}
```

| Field | Rule |
| --- | --- |
| `schemaVersion` | `1` |
| `name` | Lowercase letters, digits, `.`, `_` and `-`, at most 64 characters |
| `version` | A semantic version such as `1.2.0` or `2.0.0-rc.1` |
| `description` | Optional, at most 2000 characters |
| `files` | Every file of the package except the manifest, each with its lowercase hex SHA-256 over its exact bytes; 1 to 500 files |

Paths are relative and `/`-separated. Each name uses letters, digits, `.`, `_` and `-`, does not start with a dot and is not a Windows device name, so a package installs the same on Windows, macOS and Linux. Two paths that differ only in case are refused. Each file goes to `baked/<path>`:

| Package path | Installed as | Checked with |
| --- | --- | --- |
| `agents/NAME.json` | `baked/agents/NAME.json` | The profile schema and the tool and role rules of the profile registry; each skill a profile names must be in the package or the project with the hash the profile pins |
| `skills/ID/...` | `baked/skills/ID/...` | Each skill folder has a `SKILL.md` |
| `workflows/ID.json` | `baked/workflows/ID.json` | The workflow schema (1 or 2) and the definition validation `baked workflow validate` runs, against the project's gates plus the package's; the file name matches the `id` |
| `gates/ID.json` | `baked/gates/ID.json` | The gate schema and gate validation; the file name matches the `id` |
| `gates/FOLDER/...` | `baked/gates/FOLDER/...` | Not read; scripts a gate runs |

Limits: 2 MiB per file, 20 MiB per package. Hashes are over the bytes as stored, so keep a package's line endings fixed (for example with `* -text` in its `.gitattributes`) when it travels through Git on Windows.

## Author a package

Put the files in a folder with the layout above and let BAKED write the manifest:

```sh
baked packages pack ../acme-review --name acme-review --version 1.0.0 --description "Acme's review kit"
baked packages pack ../acme-review                    # after editing files: refresh the hashes
baked packages pack ../acme-review --version 1.1.0    # a new version
baked packages pack ../acme-review --check            # exit 1 when the manifest is out of date (CI)
```

`baked packages pack PATH` (the folder or its `baked-package.json`, relative to the project or absolute) lists every file below the folder, except a top-level `.git` folder and the manifest itself, with its SHA-256, sorted by path, and writes `baked-package.json` (2-space JSON with a trailing newline) through a temp file renamed into place. Without `--name`, `--version` or `--description`, the values of the existing manifest are kept, so `pack PATH` alone refreshes the hashes; `--description ""` removes the description. A folder with no manifest needs `--name` and `--version`.

Before it writes, it runs the checks an install runs, and writes nothing when one fails, naming every problem:

- each path follows the layout and naming rules above, and no two differ only in case;
- the folder holds no symbolic link or special file, and each skill folder has a `SKILL.md`;
- the limits: 1 to 500 files, 2 MiB per file, 20 MiB in all;
- every definition loads: profiles, workflows and gates as in the install table, checked against the package's own content. A profile's skills must ship in the package, and workflows see the package's gates plus the built-in and configured policy gates, not your own `~/.baked/gates` or a project's `baked/gates`. A package that passes is self-contained.

`--check` writes nothing; it exits 0 when the manifest on disk lists the same name, version, description and hashes (the order of `files` and the formatting do not matter) and 1 when it is missing or out of date. `--json` prints `{root, manifestPath, name, version, description, files, contents, problems, manifest, existing, upToDate, written}`. Packing never installs anything and never touches a project's `baked/` folders; install the result with `baked add` as anyone else would. The same is `/packages pack PATH [--name NAME] [--version VER] [--description "TEXT"] [--check]` in the terminal UI, Create package on the desktop's Packages page, and [`POST /v1/packages/pack`](desktop/api.md#packages).

To write the manifest by hand instead, compute each hash with `sha256sum FILE` (Linux), `shasum -a 256 FILE` (macOS) or `Get-FileHash -Algorithm SHA256 FILE` (PowerShell, lowercase the result), and check the package with `baked add PATH` in a scratch project.

## Install

`baked add PATH` (relative to the project or absolute; the folder or its `baked-package.json`) reads the package and refuses it, naming the problem, when:

- the manifest is not JSON or breaks the schema above;
- a path is absolute, contains `..`, is outside `agents/`, `skills/`, `workflows/` and `gates/`, or breaks the layout above;
- a file's hash differs from the manifest, a listed file is missing, or the folder holds a file the manifest does not list;
- the folder holds a symbolic link or a special file.

It then shows the plan: each file with its target and whether it is **new**, the **same** as the project's file, or **replaces** a different project file; the files of an earlier installed version this version no longer ships; the gates that will need confirming; and the problems that block the install:

- a definition that would not load (schema, profile tools, workflow validation, gate validation, a missing skill);
- a target owned by another installed package;
- a target, or a folder on its way, that is a symbolic link or not a regular file, which a write would follow out of the project.

The install needs an explicit yes: the prompt, `--yes`, Install in the terminal UI's picker or the desktop's Install button. A project file that differs is replaced only with `--overwrite` (the picker and the desktop button say how many files they replace). The approval covers exactly the plan shown: the install reads the package and plans it again, and refuses (`STALE_PLAN`) when anything in the plan changed, so a package edited between the plan and the yes is never written. Each file is written through a temp file and renamed into place; when a write fails, the files written so far are restored.

Installing a newer version of an installed package updates its files, deletes the files the old version shipped and the new one does not when they are unchanged since the install, and keeps the ones you edited.

## The lock file

`baked/packages.json` records each installed package: its name, version, description, when it was installed, and every file it wrote with its hash. Commit it with the files. `baked packages list` (and `GET /v1/packages`) compares the hashes with the files and names those edited or deleted since the install.

## Remove

`baked packages remove NAME` deletes each file of the package whose hash still matches the lock file and drops the package from it. Files edited since the install stay, and the command lists them; empty folders the package created are removed. A confirmation of an installed gate stays in `.baked/gate-confirmations.json` until that gate ID is confirmed again.

## Exit codes

`baked add` and `baked packages` exit 0 when done, 1 when the install is refused or not approved, and 2 for bad arguments, a path that does not exist or an unknown package. `baked packages pack` exits 0 when it wrote the manifest or found it up to date, 1 when it refused (or, with `--check`, when the manifest is missing or out of date), and 2 for bad arguments, a missing name or version, or a path that does not exist. `--json` prints the plan and the result (`{plan, installed, result}`), the installed packages (`{packages}`) or the removal (`{name, version, removed, kept, missing}`).

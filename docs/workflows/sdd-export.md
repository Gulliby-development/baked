# SDD export package

`baked workflow export-package` writes the accepted work of a run or an initiative as a plain spec-driven development (SDD) package: folders of Markdown and JSON that another coding agent, another harness or a person can read without BAKED. Put the package next to a checkout (or into it) and point the agent at its `AGENTS.md`.

```sh
baked workflow export-package RUN_ID                       # .baked/exports/RUN_ID-export/
baked workflow export-package INITIATIVE_ID --zip          # .baked/exports/INITIATIVE_ID-export.zip
baked workflow export-package INITIATIVE_ID --out ../handoff/payments --json
```

The command only reads the workflow database: no model call, no change to a run. It is not the same as `baked workflow export RUN_ID --destination DIR`, which writes the run's diagnostic report (`manifest.json` with requests, checks and findings) to attach to a bug report.

## Layout

```text
<id>-export/
  AGENTS.md            what the work is, the reading order and the status of each feature
  manifest.json        format version, kind (run or initiative), Git HEAD, feature statuses, sha256 per file
  initiative.md        initiative only: request, goals, completion criteria, features, budget, accepted plan revision
  initiative.json      initiative only: the accepted plan revision as data
  graph.json           features, their dependencies, their tasks and the tasks' dependencies
  graph.md             the same graph as a Mermaid diagram
  specs/<feature>/     spec.md, plan.md, tasks.md (Spec Kit layout) and spec.json, tasks.json (canonical)
```

A single run has the same layout without `initiative.*`, and its graph holds one feature. The files under `specs/<feature>/` are byte for byte what the run publishes in the workspace (`specPublication`), so `baked workflow import --source spec-kit --path <package>/specs/<feature>` reads them back with their IDs kept.

`--zip` writes one archive with the same tree (forward-slash names, deflated, a fixed timestamp, so the same work always gives the same bytes). The default is a folder, which a Git diff can show.

## What is exported

- Only accepted work. An initiative needs an approved split: the package holds the approved plan revision, and a feature has a folder only when its current run's spec, plan and tasks were approved. A feature not started yet, or whose run still waits for approval, is listed with its status and no folder. A run is exported only once its spec, plan and tasks are approved.
- No events, logs, traces, model call records or check output.
- Before anything is written, every file is scanned for secrets (the scan of an artifact deploy: key formats, credential assignments, values of secret environment variables). A finding refuses the export and names the file and line, never the value.
- A feature whose ID is a name Windows reserves (`con`, `nul`, `com1`, ...) gets the folder `<id>_`; `manifest.json` names each feature's folder.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The package was written; the path is printed (`--json`: path, manifest and file list) |
| 1 | Refused: nothing accepted yet, a secret, or the destination already exists |
| 2 | Unknown run or initiative ID, or bad arguments |

## Format version

`manifest.json` `formatVersion` is 1. A change to what a run or an initiative persists that changes the package (a new document of `specPublication`, a new initiative plan field, a new graph edge) updates the exporter in `src/core/workflows/sdd-export/`, bumps the version when the layout changes, and updates `tests/workflow-sdd-export.test.ts` (rule in `AGENTS.md`).

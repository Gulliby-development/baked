# Task type to workflow map

Kept by the analyst (evidence from runs) and the scout (ideas from other harnesses). The implementer uses the "Workflow" column for new apps; control apps always use `config.json` `runs.workflow`. Confidence: low (< 2 measured runs), medium (2-5), high (> 5). Rows with low confidence are under-measured, so the ideator should cover them.

| Task type | Workflow | Settings | Evidence | Confidence | Gaps and ideas |
|---|---|---|---|---|---|
| Greenfield CLI, TypeScript | sdd | worktree, writers 3, sizing, assume | todo-cli A, url-shortener A, envguard (R1) | medium | test tasks often hit attempt caps (#176) |
| Greenfield CLI, Python | sdd | same, ruff fixer | expenses-py A r1-r4, logslice (R1) | low | Python modules cost 2-3x TS per file; lint repair loops (#215, #216) |
| Greenfield web UI, React + Vite | sdd | same, Playwright e2e | pomodoro-web A, cronsay, jsondelta (R1) | low | e2e and timer tests hit caps |
| Greenfield server, Bun | sdd | same | url-shortener A | low | |
| Feature on existing code | sdd | same | B runs of todo-cli, url-shortener, md-site, pomodoro-web | medium | revise re-running done tasks (#154, fixed by #237) |
| Small fix (1-3 files) | quick | | none measured | low | estimate ~400k unmeasured |
| Failing CI | fix-ci | | none measured | low | |
| Research only | spike | | none measured | low | |
| Docs-only change | quick? | | README tasks cost 128-241k (#160) | low | a docs task type with its own price |
| Large feature (> 30 KiB written) | initiative of sdd runs | | none measured in the bench | low | runtime split vs. initiative: when to choose which |

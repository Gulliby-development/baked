# Fix CI

`fix-ci` is a built-in workflow preset for failing checks. It runs the project's checks first, hands the failing output to a research agent, plans a narrow fix, waits for your approval, implements it and runs the same checks again.

```sh
baked workflow run fix-ci --feature fix-ci-lint --prompt "CI fails on lint since the last merge"
baked workflow run fix-ci --feature fix-ci-tests --prompt-file ci-failure.log
```

In the TUI and the desktop app, pick `fix-ci` as the workflow in the new-run form. The local API starts it with `workflow: "fix-ci"` in `POST /v1/workflow/runs`.

## Stages

| Stage | Type | What it does |
| --- | --- | --- |
| `reproduce` | check | Runs the project's feature checks (the policy's `checks` with `scope: "feature"`). |
| `research` | agent | Reads the failing checks' output and the request, and finds the cause. |
| `plan` | agent | Plans the smallest change that makes the checks pass. |
| `approve` | approval | Waits for a person to approve the plan and the files it writes. |
| `implement` | tasks | Implements the plan; each task's own checks run after it. |
| `verify` | check | Runs the same checks as `reproduce`. |

Transitions:

- `reproduce` passed: the run completes. Nothing failed, so no model is called and no file changes.
- `reproduce` failed: the run goes to `research`. Each failed check is handed over with its claim and the last 120 lines of its output, with ANSI codes removed and known secrets masked.
- `verify` failed: the run goes back to `implement` with corrective tasks, at most twice (`verify-repair`). A check with a `fix` command (for example a formatter) runs it on the files the run's tasks write before a repair task is created.
- `verify` passed: the run completes.

## Giving it a CI log

`reproduce` runs the checks on your machine, so a failure that CI shows must also fail locally for the run to continue. When the CI log explains more than the local output, pass it as the request (`--prompt-file ci-failure.log`, or paste it into the description in the TUI or desktop app); the research agent reads both. If the checks pass locally, the run completes after `reproduce`: reproduce the CI environment (the same tool versions or environment variables) and start it again.

The checks are the project's configured checks, the same ones `baked doctor` lists. A CI step that is not one of them is not rerun: add it to `workflows.policy.checks` first so `reproduce` and `verify` run it.

## Customizing

`baked workflow define my-fix-ci --from fix-ci` copies the preset to `baked/workflows/my-fix-ci.json`, where the gates of `reproduce` and `verify`, the loop bound and the stages can be edited. See [Workflow v2](v2-design.md) for the definition format.

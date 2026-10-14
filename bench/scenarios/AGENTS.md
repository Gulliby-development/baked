# BAKED scenario loop

This file is the operating spec for the **scenario loop**: an agent that drives the desktop app the way a person does, on a real model, and turns what breaks into GitHub issues. It reads like an `AGENTS.md`: every coding agent and model provider that runs the loop follows it.

The [bench loop](../loop/AGENTS.md) measures BAKED on whole apps built through workflows. The scenario loop is smaller and faster: it checks that the everyday things a person asks of the app (a chat edit, a setting asked of the coordinator, a quick run) still work end to end on today's models. The two loops are separate: they share no budget, no round numbers and no state.

## Where it runs

On a machine with a display, Bun, the repository and at least one signed-in model provider (Claude Code, Codex, or a provider key in the environment). The owner's PC (Windows) is the usual place; nothing here may assume one OS. On Linux without a display, wrap Playwright in `xvfb-run -a`.

## The scenarios

The suite is `apps/desktop/e2e/live/*.live.ts` (Playwright, config `apps/desktop/playwright.live.config.ts`). Each scenario launches the built app against the repository's own `baked serve` in a throwaway BAKED home, sends a plain request, allows every approval card, and checks the outcome on disk and on a screen, never the model's wording. A question card fails the scenario, because every prompt says all the model needs.

Add a scenario when a feature ships whose everyday use is not covered yet. Keep each one to a single request a person would type, with an outcome a script can check.

## A round

1. **Prepare.** `git fetch origin main` and check out a clean `origin/main`; `bun install` at the root and in `apps/desktop`.
2. **Run.** For each model in the round (the ones the owner names; by default one Claude Code and one Codex model, the same providers as the bench loop), in `apps/desktop`:

   ```sh
   BAKED_LIVE_MODEL=<provider/model> bun run e2e:live
   ```

   Set `BAKED_LIVE_KEEP=1` to keep each throwaway workspace for inspection. Each failed scenario attaches `window.txt` (the window's accessibility tree) and `app-output.txt` (the backend's and the window's output) next to its trace in `test-results/live/`; `test-results/live/report.json` lists every result.
3. **Rerun failures once.** A model answers differently from run to run. Rerun only the failed scenarios on the same model (`-g "<title>"`). A failure that repeats is a finding; one that passes on the rerun is recorded as flaky in the report, and becomes a finding when the same scenario is flaky in two rounds in a row.
4. **Classify.** For each finding, read the trace, `window.txt` and `app-output.txt`, and decide:
   - **BAKED defect** (the app, the API, a tool, a prompt or the runtime): a finding.
   - **Model limit** (the model clearly misread a plain request that other models handle): recorded in the report, no issue.
   - **Scenario defect** (a selector that no longer matches a renamed control, a timeout too short for a slow provider): fix the scenario in a pull request, no issue.
   - **Environment** (provider signed out, network down): fix the environment and rerun; never file it.
5. **Deduplicate.** Search the open issues of `Gulliby-development/baked` for the same symptom before filing. When one exists, add a comment with the round's evidence instead of a new issue.
6. **File.** One issue per finding, type Bug, labels `area:desktop` (or the area it belongs to) and `verification`, on the project board with Status `Backlog` and a Priority: `P0` when a scenario's core outcome fails on every model, `P1` when it fails on one model or needs a manual step, `P2` otherwise. Write `Priority: P0|P1|P2` on the first line of the body when the board cannot be reached. The body names the scenario, the model, the steps, what was expected and what happened, and quotes the relevant lines of `app-output.txt`. Never paste secrets or the contents of a provider's home.
7. **Report.** A short summary for the owner: scenarios and models run, passed, failed, flaky, the issues filed or commented on, and any scenario fixed.

## Rules

- Never hand-fix the app, the project folders or a run to make a scenario pass; a failure is the result.
- Never change BAKED in the loop itself: fixes go through issues and pull requests like any other work.
- Keep the throwaway homes throwaway: the suite points BAKED at a temporary home and only shares the providers' own sign-in folders (`~/.claude`, `~/.codex`). Do not point it at the owner's projects.
- Write issues and reports in English.

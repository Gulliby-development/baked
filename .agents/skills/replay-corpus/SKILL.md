---
name: replay-corpus
description: Use when a change adds or changes a host decision (a stop, park, decline, refusal, retry, deadline or cap growth), when the bench loop exports a round's traces, or when replay-corpus.test fails. Keeps the bench-trace replay corpus complete and current.
---

# Keep the replay corpus complete

BAKED's host decisions are replayed on recorded bench rounds before a change merges (#1649, #1715). Four fixes in three days each broke the next bench round (#1643, #1627, #1639, #1640), because a scenario test only covers the run that exposed the bug. The corpus is the set of real runs every change must still decide correctly. It works only when every decision point has a replay hook and the corpus stays readable by the current code.

## Parts

- **Traces:** `tests/fixtures/bench-traces/RNN/<app>.sqlite.gz`. Each is an anonymised copy of a bench app's `.baked/workflows.sqlite`, written by `bun scripts/bench-trace.ts export <workspace> <out>`. The export (`exportTrace` in `src/core/workflows/trace.ts`) does the following:
  - keeps only the artifact kinds in `KEPT_ARTIFACTS`;
  - drops the tables in `DROPPED_TABLES`;
  - replaces every string under a key in `PROSE`, and every other string that contains whitespace, with a stand-in `KEY-N` (`StandIns`). The same text gets the same stand-in across the whole trace, so equality checks between artifacts and columns still hold;
  - keeps the run's `state` artifact with the content in `STATE_CONTENT` (spec, plan, research, reports) stood in, and rewrites every contract hash to the hash of the scrubbed spec, so a replay that reopens the run through `openTrace` sees the same features, runs and shares the round saw.

  Policies and workflow definitions stay whole, because they hold settings and enums, not prose. Traces exported before #1707 have no `state` artifact; re-export them with the current code before a hook needs the run state. `.gitignore` ignores `*.sqlite*` everywhere except under this folder.
- **Replay:** `replayTrace` in `trace.ts`. It runs each hook over every run of a trace and reports where the current code decides differently from the recording.
- **Gate:** `tests/forecast-replay-corpus.test.ts` is part of `bun run test`, so it runs in the required `check` job. A decision the recording did not make fails the suite. The only exception is a run listed in `tests/fixtures/bench-traces/accepted.json` as `"RNN/app.sqlite.gz#RUN_ID": { "<counter>": n, "reason": "..." }`.
- **CLI:** `bun scripts/bench-trace.ts replay <trace>... [--json]` prints each run's differing decisions.
- **Recordings:** `tests/fixtures/bench-recordings/RNN/<app>/RUN_ID.json.gz` and its `manifest.json`, written by `bun scripts/bench-trace.ts recordings <workspace> <out-dir> --run RUN_ID`. Every bench run and initiative records its model calls (`--record-model-calls`); a recording holds the prompts and the model's answers, so only the runs that stopped are kept, and only from public bench apps. They are the input of the replay to the first divergent request (#1715 step 2), which compares the decisions that need the model's answers.

## Hooks today

| Decision | Hook | Counter in `accepted.json` |
|---|---|---|
| Run cost-forecast stop (`assertForecastFits`) | `replayRun`: rewinds the run to each priced attempt | `newStops` |
| Cap growth to the forecast | `replayRun` | `newGrowth` |
| A model call's first-response deadline (`providerFirstByteMs`) | `replayFirstByte`: reads each call's `calls` timing in `attempts/*/usage.json`. Older traces fall back to the attempt length of a one-step buffered CLI attempt | `newFirstByteStops` |
| An initiative feature's start on its budget share (`shareShortfall`) | `replayShareGate`: reads each `feature.share_gate` initiative event, which records the gate's inputs (remaining budget, dollar cost view, the waiting features' shares and estimates) and its verdict. Keyed by initiative: `"RNN/app.sqlite.gz#INITIATIVE_ID"`. Traces before #1707 record none | `newShareStops` |
| The same start gate on recomputed inputs, the initiative's dollar forecast included (`InitiativeService.view`, then `shareShortfall`) | `replayInitiativeStarts`: from the last feature start back to the first, rewinds a copy of the trace to the moment the start was linked (later runs, links, events and requests removed, runs still going rewound like a run replay) and asks the gate again. The policy's `sizing.historyStores` are replaced by their corpus traces (`corpusHistoryTrace`: `.../RNN/app` is `RNN/app.sqlite.gz`), trimmed to the runs that existed then; stores older than the corpus are listed as `missingHistory`. Takes `priceSamples` to replay an older pricing. Starts made under an earlier split revision are not replayed | `newStartStops` |

The provider fault matrix (`tests/provider-fault-matrix.test.ts`) reads the same traces through `corpusCallProfile`: each recorded call shape's p99 first byte and the recorded `retry-after` waits become its fault profiles (#1729). A new field a profile needs goes into the `calls` timing, so the next round's traces carry it.

A decision computed from the whole run or initiative state, like the initiative forecast, needs no new record: its hook rewinds a copy of the trace and calls the current code. Keep what that code reads in the export (the `state` artifact, the history stores' own traces), and seam only the part a proof test swaps, as `InitiativeService.priceSamples` is.

Not replayed yet, and tracked in issues: plan auto-approval (#1707), and decisions that need the model's answers, such as gates, the case walk and the integrity guard (#1715 step 2, through `--record-model-calls` recordings).

## When you add or change a host decision

A host decision is anything that stops, parks, declines, refuses, retries, times out or grows a limit on its own. In the same pull request:

1. **Record its inputs.** Every value the decision reads must be in the run's database, in a kept artifact or a kept column. If it is not, add it, as `calls` was added to `usage.json` for the first-response deadline. If it lives in an artifact kind that is not kept, add the kind to `KEPT_ARTIFACTS` and check that `scrubTrace` removes its prose.
2. **Add a hook** in `trace.ts`. It computes the decision from the recorded inputs with the current code. It reports `recorded` and `replayed` per boundary and a counter on `RunReplay` for decisions that are new against the recording. Take the decision function as an optional parameter, as `replayTrace(path, { firstByteLimit })` does, so a test can show that the hook catches the old behavior.
3. **Gate it.** Add the counter to the corpus test's expectation and to this skill's table.
4. **Prove it.** Add a test that replays a real corpus trace with the pre-fix decision and gets the stop the round recorded, then shows that the current code does not. The first-response test in `forecast-replay-corpus.test.ts` is the pattern.
5. **Document it** in `CONTRIBUTING.md` (the replay paragraph) and in `docs/workflows/runtime.md` when the decision is user-visible.

When your change means to decide differently on a recorded run, add that run to `accepted.json`. Use the exact counter and a reason that names the issue. Find the run with `bench-trace.ts replay`. Bisect when it is unclear which change moved a decision: copy `trace.ts` and `scripts/bench-trace.ts` into a worktree of the older commit and replay there. Never widen an entry to make an unrelated difference pass. A difference you did not intend is a regression; file it with the file-issue skill.

## When the export or a schema changes

- When an export changes what traces contain (a kept artifact, a scrub rule, a new column), the existing traces lack it. Every hook must still work on old traces: a fallback or "no data" for them, never a crash. Then ask the bench loop to re-export the rounds the hook needs from the runner's `C:\Project\baked-bench\RNN\<app>` folders.
- A migration that changes a table the replay reads must keep old traces readable. `WorkflowStore` migrates a trace when it opens it, so run the corpus test after every migration.
- Replay must never trust the order of `previous` values in policy revisions. Apply each revision's `next` forward from the starting policy: a revision written from a stale policy undid an earlier growth (#1704).

## Bench loop

- **Publisher (phase 10):** after each round, export every app (updates and controls included) from a checkout of current main and run the replay and the corpus test. Open a `feature/bench-traces-rNN` pull request with the traces. Add the recording of every run that stopped (a forecast, budget, provider or gate stop, or an intervention) to the same pull request. A trace above 2 MB is mentioned in the round report. Run `git status` before committing to confirm the `.sqlite.gz` files are staged.
- **Analyst:** a replay difference on the round's own traces is a finding, because main decides differently from the round's runner. It is expected only for fixes merged during the round; those go into `accepted.json` with the fix's issue as the reason. Each new stop the round shows makes that run part of the corpus automatically, once its trace merges.
- Traces leave the runner only through this export. Nothing else from `.baked/` goes into the repository.

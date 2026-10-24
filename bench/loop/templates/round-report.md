# Bench loop round NN (<dates>)

BAKED runner: <commit> · reference model: <provider/model> · experiment: <none | what>

## Summary
<5 lines, BAKED-side first: what improved, what got worse, the top finding, what the next round changes. App counts (published, updated) come last.>

## BAKED-side metrics
| Metric | This round | Last round | First round |
|---|---|---|---|
| Interventions per run (control / new / update) | | | |
| Runs completed without intervention | | | |
| Tokens per verified app | | | |
| Fixes merged | | | |

Stop reasons by count:
| Stop reason | Count | Runs |
|---|---|---|

## Would-stops (stop reasons in shadow or advisory mode)
| Reason | Mode | Records | Justified | False | Unknown | Clean rounds in a row | Promote? |
|---|---|---|---|---|---|---|---|

<one line per `false` record: app, run, what the stop would have done, what happened instead, finding id>

## Did last round's fixes work?
| Issue | Expected metric movement | Measured | Verdict |
|---|---|---|---|

## Control apps (comparable)
| App | Variant | Outcome | Tokens | Δ vs last round | Steps | Active | Interventions | Corrections |
|---|---|---|---|---|---|---|---|---|

## New apps
| App | Task type | Provider/model | Outcome | Tokens | Interventions | Verified | Published |
|---|---|---|---|---|---|---|---|

## AI app (tracked separately)
| App | Archetype | Stack | LLM shape | AI level | Provider/model | Outcome | Tokens | Cost | Interventions | Verified | Published |
|---|---|---|---|---|---|---|---|---|---|---|---|

## Updates to existing projects (brownfield, tracked separately)
| Repository | Feature | Provider/model | Outcome | Tokens | Interventions | Baseline tests | After tests | Verified | PR / merge |
|---|---|---|---|---|---|---|---|---|---|

## Published
| App | Repository | CI (ubuntu / windows / macos) | Logo | Notes |
|---|---|---|---|---|

## Finding chains
From `bun scripts/bench-trace.ts chains` (runs with `chains/` records; `none` when no run formed a chain):
| App | Run | File and symbol | Length | Correctives (decision) | Tokens | Cost | Battery runs | Cases (reproduced / refuted / inconclusive) | Reopened |
|---|---|---|---|---|---|---|---|---|---|

## Experiment
<what changed, on which app, result vs the map's default>

## Findings
| ID | Severity | Kind | Seen on | Confirmation | Title | Issue | Apps |
|---|---|---|---|---|---|---|---|

Watching (no issue yet): <finding ids with the models they were seen on, or none>
Cross-model confirmations: <tokens used> / <confirm.maxTokensPerRound>

## Scout highlights
<3 lines with links>

## Fixes merged this round (measured next round)
| Issue | PR | Should move |
|---|---|---|

## Budget
Run cost: <usd used> / <roundRunUsd> (tokens <used>) · wall clock: <h> · fix PRs: <n>

## Retro (retro rounds only)
<one line: changes made with PR links, changes reverted, the owner proposal that matters most; link to `retro.md`>

## Waiting on the owner
<`needs-gulliby` items, runs above their dollar cap, blockers; publish batches only when `publish.mode` is `approve-per-round`>

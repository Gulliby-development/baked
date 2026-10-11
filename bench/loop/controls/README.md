# Control apps

The three control apps are rebuilt every round with the same prompts, workflow, settings and reference model, so their numbers show whether BAKED got better. Never edit a prompt here; a changed prompt starts a new control series (new file name, new baseline).

Bootstrap (round 1 of the loop): copy each prompt verbatim from the run that first used it on the owner's PC (`baked workflow status RUN_ID --json` in the app folder under `C:\Project\baked-bench`, field with the run's prompt), into `<app>.md` with sections `## A` and `## B`.

| App | Stack | A prompt from run | B prompt from run | Baseline (earlier rounds) |
|---|---|---|---|---|
| url-shortener | Bun.serve + SQLite | d3c15d35 | de6cf1ab / 7df4e666 (link expiry) | A 0.63M, 0 interventions; B r2 1.05M, 1 intervention |
| md-site | Markdown to static site, TS | 563e4f6c / 6f0dfd57 | 6bb3052f | A r2 1.37M, 2 interventions; B r2 blocked 1.95M (before #175) |
| expenses-py | Python CSV report CLI | 6931efd6 / 936ddfa5 | none yet: write one B prompt in round 1 and keep it | A r2 blocked 1.03M; r4 on Codex before #213 not comparable |

Earlier baselines used other BAKED commits and, for later runs, other providers; the loop's own round 1 is the baseline its comparisons start from.

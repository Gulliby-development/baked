# Bench loop

The bench loop tunes BAKED by building small, useful apps with it, round after round, on a real machine with real providers. Its operating spec is an `AGENTS.md` for an orchestrator agent and its roles, in [`bench/loop/`](../bench/loop/AGENTS.md); any agent harness that reads `AGENTS.md` and can run sub-agents can drive it.

## One round

1. **Prepare.** Pin the BAKED runner checkout to `main`, refresh the spec from it, run `baked doctor`, check every configured provider.
2. **Ideate and review.** An ideator proposes 7 apps, a reviewer accepts 5 and writes the exact brief BAKED gets.
3. **Build.** An implementer runs each of the 5 new apps and 3 fixed control apps (url-shortener, md-site, expenses-py) through `baked workflow run` with fixed settings (`--worktree --writers 3`, sizing, `clarification: assume`) and records tokens, steps, time, interventions and corrections.
4. **Verify.** A verifier clones each app, follows only its README, runs its tests and a smoke test, and screenshots UI apps.
5. **Analyze and scout.** An analyst turns each run into findings with a point fix and a broader option; a scout reads harness news once per round and keeps a map of task types to workflows.
6. **Backlog and fix.** Findings become issues on the project board; a fixer implements up to 6 per round through ordinary pull requests. The backlog role also ranks scout ideas and puts the top one into the fix set as the round's broad feature; only things the owner alone can do or decide are labelled `needs-gulliby`.
7. **Publish.** Apps that pass verification become public MIT repositories in `Gulliby-development` with a README, a one-shot SVG logo and CI on three operating systems. This happens right after an app passes verification, not at round end: the repository is created private, pushed, checked by CI on all three operating systems and only then made public. The default is `publish.mode: "auto"`; `"approve-per-round"` is an optional mode the owner may switch on to approve each round's batch first. gulliby gave standing authorization on 2026-10-11 to create public repositories in Gulliby-development for verified apps without asking; with publish.mode auto no approval is requested. An agent harness with its own permission layer may still block `gh repo create ... --public` or `gh repo edit --visibility public`: then the loop reports it once, does not work around it, and the owner adds an allow rule for the loop's session (the loop never changes permission settings itself). The published repositories are listed with their links in the round report and the round message.
8. **Report.** One round report and one row per run in a metrics ledger.

Control apps keep the same prompts, workflow and reference model every round and are never published, so their numbers show whether BAKED improved. The runner stays on one commit for the whole round; fixes merged during a round are measured in the next one.

## Files

| Path | Contents |
| --- | --- |
| [`bench/loop/AGENTS.md`](../bench/loop/AGENTS.md) | The orchestrator: phases, workspace, `config.json`, `state.json`, comparability, budgets, approval gates, stop conditions, reporting |
| [`bench/loop/roles/`](../bench/loop/roles/ideator.md) | One brief per role: ideator, reviewer, implementer, verifier, analyst, scout, backlog, fixer, publisher |
| [`bench/loop/config.json`](../bench/loop/config.json) | Default settings, copied once to the loop root on the machine |
| [`bench/loop/templates/`](../bench/loop/templates/round-report.md) | Run and verification records, findings, round report, publish record, README, logo prompt, CI workflows, ledger seeds, round 1 briefs |
| [`bench/loop/controls/`](../bench/loop/controls/README.md) | Where the control app prompts come from |

Round data (state, ledgers, round folders, app repositories) lives on the machine that runs the loop, never in this repository.

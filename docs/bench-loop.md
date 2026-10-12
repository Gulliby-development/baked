# Bench loop

The objective of the loop is to make BAKED a better harness. The apps, updates and published repositories are the test bench, not the product: when budget, time or attention is short, the loop spends it on analysis and BAKED fixes rather than on getting more apps through, never hand-fixes an app or works around a BAKED defect to make a run pass (a stuck run is recorded as blocked and becomes a finding), and judges a round by BAKED-side metrics (interventions per run, stop reasons, tokens per verified app, runs completed without intervention, and whether last round's fixes worked) before app counts.

The bench loop tunes BAKED by building small, useful apps with it, round after round, on a real machine with real providers. Its operating spec is an `AGENTS.md` for an orchestrator agent and its roles, in [`bench/loop/`](../bench/loop/AGENTS.md); any agent harness that reads `AGENTS.md` and can run sub-agents can drive it.

## One round

1. **Prepare.** Pin the BAKED runner checkout to `main`, refresh the spec from it, run `baked doctor`, check every configured provider.
2. **Ideate and review.** An ideator proposes 5 new apps and, for 3 public repositories of `Gulliby-development` picked at random (seeded with the round number; private repositories are never touched), one small feature each after reading the repository (a CI pipeline counts when the repository has none; small hygiene extras such as a missing license, logo, topics or description may ride along). A reviewer keeps 2 new apps, checks each update (useful, small, testable, precise, no duplicate, no breaking change) and writes the exact brief BAKED gets.
3. **Build.** An implementer (up to `round.maxConcurrentRuns` runs at once, 3 from round 7) runs each of the 2 new apps, the 3 updates (a fresh clone of the repository, its baseline tests recorded first, tracked as the separate group `update`) and 3 fixed control apps (url-shortener, md-site, expenses-py) through `baked workflow run` with fixed settings (`--worktree --writers 3`, sizing, `clarification: assume`) and records tokens, steps, time, interventions and corrections.
4. **Verify.** A verifier clones each app, follows only its README, runs its tests and a smoke test, and screenshots UI apps. For an update it runs the repository's whole test suite, the new README example and one error case, and checks that the diff holds only what the brief names.
5. **Analyze and scout.** An analyst turns each run into findings with a point fix and a broader option; a scout reads harness news once per round and keeps a map of task types to workflows.
6. **Backlog and fix.** Findings become issues on the project board; a fixer implements up to 6 per round through ordinary pull requests. The backlog role also ranks scout ideas and puts the top one into the fix set as the round's broad feature; only things the owner alone can do or decide are labelled `needs-gulliby`.
7. **Publish.** Apps that pass verification become public MIT repositories in `Gulliby-development` with a README, a one-shot SVG logo and CI on three operating systems. This happens right after an app passes verification, not at round end: the repository is created private, pushed, checked by CI on all three operating systems and only then made public. The default is `publish.mode: "auto"`; `"approve-per-round"` is an optional mode the owner may switch on to approve each round's batch first. gulliby gave standing authorization on 2026-10-11 to create public repositories in Gulliby-development for verified apps without asking; with publish.mode auto no approval is requested. An agent harness with its own permission layer may still block `gh repo create ... --public` or `gh repo edit --visibility public`: then the loop reports it once, does not work around it, and the owner adds an allow rule for the loop's session (the loop never changes permission settings itself). The published repositories are listed with their links in the round report and the round message. An update is not a new repository: the publisher opens a pull request in the existing repository (neutral commit author, no BAKED `specs/` or `.baked/` in the diff), waits for its CI on all three operating systems, merges it with a merge commit and then applies any topics and description the brief lists; if CI is red for logic reasons the PR is closed and recorded as a finding. Updates apply from round 3.
8. **Report.** One round report and one row per run in a metrics ledger.

## Stacks, lanes and difficulty

- **Languages.** The loop built Python and TypeScript (Bun) projects until round 6. From round 7 every round has at least two of Go, .NET, Rust and Java (Maven + JUnit) across its new apps, updates and controls. Workspaces come from `tools/scaffold.py` (`bun`, `webunit`, `python`) and `tools/scaffold_lang.py` (`go`, `dotnet`, `rust`, `java`); brownfield clones from `tools/scaffold_update.py` and `tools/scaffold_update_lang.py`.
- **Checks.** Go: `go vet ./...` (fixer `go fmt ./...`), `go test ./...`. .NET: `dotnet build`, `dotnet format --verify-no-changes`, `dotnet test`. Rust: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`. Java: `mvn -B -q verify`.
- **Toolchains.** Prepare checks `go`, `dotnet`, `cargo` (with `rustfmt` and `clippy`) and `java` with `mvn`; a missing one removes its language from the round and is reported. Shells that the harness starts may lack them on `PATH`, so the launch script and the scaffold scripts add their directories explicitly.
- **Lanes.** `round.maxConcurrentRuns` in `config.json` is 3 from round 7 (it was 2). If builds or tests time out because the PC is saturated, the next round goes back to 2.
- **Difficulty.** A round without BAKED-side problems (no blocked runs, no operator actions beyond infrastructure resumes, no new P1 findings) raises the difficulty by one for the next round; a round with problems keeps it.
- **Publishing.** CI templates in `bench/loop/templates/ci/`: `bun`, `vite`, `python`, `go`, `dotnet`, `rust`, `java`, all on `ubuntu-latest`, `windows-latest` and `macos-latest`.

Control apps keep the same prompts, workflow and reference model every round and are never published, so their numbers show whether BAKED improved. The runner stays on one commit for the whole round; fixes merged during a round are measured in the next one.

## Files

| Path | Contents |
| --- | --- |
| [`bench/loop/AGENTS.md`](../bench/loop/AGENTS.md) | The orchestrator: phases, workspace, `config.json`, `state.json`, comparability, budgets, approval gates, stop conditions, reporting |
| [`bench/loop/roles/`](../bench/loop/roles/ideator.md) | One brief per role: ideator, reviewer, implementer, verifier, analyst, scout, backlog, fixer, publisher |
| [`bench/loop/config.json`](../bench/loop/config.json) | Default settings, copied once to the loop root on the machine |
| [`bench/loop/templates/`](../bench/loop/templates/round-report.md) | Run and verification records, findings, round report, publish record, README, logo prompt, CI workflows, ledger seeds, round 1 briefs |
| [`bench/loop/templates/claude-settings.local.json`](../bench/loop/templates/claude-settings.local.json) | Allow rules for creating and publishing repositories in Gulliby-development, copied to `.claude/settings.local.json` in the loop root |
| [`bench/loop/controls/`](../bench/loop/controls/README.md) | Where the control app prompts come from |

Start the loop session with the loop root as its working folder. On first start the loop copies the settings template to `<loop root>/.claude/settings.local.json` if missing (and re-checks each round, never overwriting an existing file); Claude Code reads that file from the session's project folder, so otherwise the allow rules do not apply and `gh repo create` / `gh repo edit --visibility public` may be blocked. The `.claude` folder is not part of the repository.

Round data (state, ledgers, round folders, app repositories) lives on the machine that runs the loop, never in this repository.

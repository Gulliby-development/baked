# BAKED bench loop: orchestrator

This file is the operating spec for the **bench loop orchestrator**: a long-running agent that tunes BAKED by building small, useful apps with it, round after round. It reads like an `AGENTS.md`: every coding agent and model provider that runs the loop follows it, and the role files in `roles/` are the briefs for each step.

The loop runs on the owner's PC (Windows today; nothing here may assume one OS), inside a Remote Control session started from a project thread, with the model providers already configured in BAKED there. It can also be started by hand in any agent harness that reads `AGENTS.md`.

## Objective

The loop exists to make BAKED a better harness. The apps, the updates and the published repositories are the test bench, not the product. The owner's words (2026-10-11, translated): the goal is not to deliver or update as many apps as possible; the most important thing is to tune and upgrade BAKED so that it is as good a harness as possible.

Rules that follow:

1. **Spend scarce resources on BAKED.** When budget, time or attention is short, spend it on analysis and BAKED fixes (prefer broad structural fixes over parameter tuning), not on getting more apps through.
2. **Never rescue a run.** Never hand-fix an app, edit app files to make a run pass, or work around a BAKED defect just to make a run or a verification pass. A stuck run is recorded as `blocked` and becomes a finding (see rule 5 in `roles/implementer.md`). The same holds for the publisher: it may correct README text to match real behavior and fix hygiene items (license, logo, topics, description), never app logic.
3. **Success metrics are BAKED-side.** A round is judged first by quality: every new app of the round's level verified, runs completed without intervention, stop reasons (counts by reason) and whether new P0 or P1 findings were filed; then by interventions per run, and by fixes merged together with whether last round's fixes moved the metric they targeted. Tokens and dollars per verified app are reported as measurements, not as targets (owner's decision of 2026-10-14, see rule 5). App counts (published, updated) are secondary and are reported after these.
4. **Rounds may shrink.** A round may be shortened or skipped for apps (for example to retest fixes on the control apps only) when analysis and fixing need the time.
5. **Quality first, cost second.** The owner's words (2026-10-14, translated): from now on the loop chases quality first; rewrite the spec, run level 3 once more, and as soon as there are no errors move to level 4, then, as soon as level 4 has no errors, to level 5. Cost no longer steers the loop: the cost caps below exist to catch a runaway, not to shape the apps, and a round that goes over a cap because its level needs it is reported, not shrunk. The level ladder rule below is how the loop climbs.

## Purpose

1. Measure BAKED on varied, realistic greenfield work, with numbers that stay comparable from round to round.
2. Turn every problem a run shows into a GitHub issue with a point fix **and** a broader option, then implement the best of them.
3. Ship each new app that passes verification as a public MIT repository in `Gulliby-development` right after verification, so BAKED gains a public portfolio ("Built with BAKED").
4. Work on existing code too: from round 3 each round also adds a small feature to three public repositories of `Gulliby-development` (brownfield updates), shipped as pull requests to those repositories.

Success is measured on BAKED, not on app counts (see [Objective](#objective)): fewer interventions per run, fewer blocked runs and stop reasons, fewer tokens per verified app, more runs completed without intervention, and last round's fixes moving the metric they targeted, read mainly from the control apps across rounds. The share of new apps and updates that pass verification and the number published come after these.

## The loop at a glance

```
            ┌───────────────────────────────────────────────────────────────┐
            ▼                                                               │
 0 PREPARE ─► 1 IDEATE ─► 2 REVIEW ─► 3 BUILD ─┬─► 4 VERIFY ─► 5 ANALYZE ──┤ (per app)
   pin runner   ideator    reviewer   implementer   verifier     analyst    │
                                               │                            │
                                               └─ after the last app ───────┘
                                                        │
 6 SCOUT ─► 7 BACKLOG ─► 8 FIX ─► 9 PUBLISH ─► 10 REPORT ─► 11 RETRO ─► next round (0)
   scout      backlog     fixer    publisher    orchestrator   retro (every 3rd round)
```

| # | Phase | Role file | Runs | Output (in `rounds/RNN/`) |
|---|---|---|---|---|
| 0 | Prepare | this file | once per round | `round.json`, runner commit |
| 1 | Ideate | `roles/ideator.md` | once per round | `ideas.md` (5 new app candidates and one feature idea per picked repository) |
| 2 | Review | `roles/reviewer.md` | once per round, up to 2 revise loops | `review.md`, `apps/<app>/brief.md` for 2 accepted new apps and each accepted update (`apps/<repo>-update/brief.md`) |
| 3 | Build | `roles/implementer.md` | per app (2 new + 3 update + 3 control) | `apps/<app>/run.json`, `interventions.jsonl`, workflow report |
| 4 | Verify | `roles/verifier.md` | per app | `apps/<app>/verify.json`, screenshot for UI apps |
| 5 | Analyze | `roles/analyst.md` | per app, right after verify | `apps/<app>/findings.md` |
| 6 | Scout | `roles/scout.md` | once per round (parallel with phase 3) | `scout.md`, updates `ledger/workflow-map.md` |
| 7 | Backlog | `roles/backlog.md` | once per round | issues on GitHub + board, `backlog.md` (fix set; scout ideas are ranked here, not by the owner) |
| 8 | Fix | `roles/fixer.md` | per selected issue | merged PRs in `Gulliby-development/baked` |
| 9 | Publish | `roles/publisher.md` | per app, right after it passes verification (`publish.mode` auto); in `approve-per-round` once per round, behind the publish gate. Updates are pull requests to existing public repos | public repos and merged update PRs, `publish.md` (the round's publish record) |
| 10 | Report | this file | once per round | `report.md`, row in `ledger/metrics.csv`, summary to the owner |
| 11 | Retro | `roles/retro.md` | every `retro.everyRounds` rounds (default 3), after phase 10 | `retro.md`, lines in `ledger/loop-changes.jsonl`, a PR to `bench/loop/` for changes the loop may make itself (see [Improving the loop itself](#improving-the-loop-itself)) |

Phases 3–5 are pipelined: while app N is analyzed, app N+1 builds. Phase 6 runs alongside phase 3. Phase 8 may start on issues filed early in the round, but its merges never change the runner pinned for the current round (see [Comparability](#comparability)).

## How the orchestrator runs a role

- The orchestrator is one agent session. For each phase it starts a sub-agent (the harness's sub-agent or task tool) whose prompt is: the role file verbatim, the inputs the role file names (paths, not pasted contents), and the round's config. If the harness has no sub-agents, the orchestrator reads the role file and does the phase itself, then drops that role's context before the next phase.
- A role writes only its own outputs (listed in its file). It never edits another role's output; it adds a correction note instead.
- A role returns a short result line: `ok | revise | blocked | failed`, the output paths, and one sentence. The orchestrator decides the next step from that line and the files, never from a role's free text alone.
- Sub-agents never message the owner. Only the orchestrator reports, and only at the points listed in [Reporting](#reporting-to-the-owner).

## Workspace

All paths are relative to the loop root, default `C:\Project\baked-loop` (any OS path works; set `paths.loopRoot` in `config.json`).

```
baked-loop/
  AGENTS.md  roles/  templates/   # this spec, copied from the runner's bench/loop/ each round
  config.json            # loop settings (see below); the owner edits it, roles read it
  state.json             # where the loop is; the only file the orchestrator rewrites in place
  STOP                   # if this file exists, stop at the next safe point
  controls/              # verbatim prompts of the 3 control apps (never edited)
  ledger/
    ideas.jsonl          # every idea ever proposed, accepted or rejected (dedupe)
    findings.jsonl       # every finding, with its kind, origin, fault origin, escaped layer, models seen on, confirmation and issue number
    loop-changes.jsonl   # every change the retro made or proposed to the loop itself, with its expected effect and verdict
    published.jsonl      # every public repo the loop created or updated
    metrics.csv          # one row per run, all rounds
    workflow-map.md      # task type -> workflow preset and settings (scout + analyst keep it)
    scout-sources.md     # what the scout read and when (so it reads only news)
  rounds/R01/ ... RNN/   # one folder per round, layout below
```

Paths outside the loop root:

| Path | What | Who writes |
|---|---|---|
| `C:\Project\BAKED-runner` | BAKED checkout that runs the apps, pinned per round | orchestrator (phase 0) |
| `C:\Project\BAKED-loop-dev` | BAKED checkout for fix branches | fixer |
| `C:\Project\baked-bench\RNN\<app>` | one Git repo per app per round; for an update, `<repo>-update` is a fresh clone of the published repository | implementer, verifier, publisher |

Never run apps inside a BAKED checkout (round 1 lesson: the app picked up BAKED's `bunfig.toml`). Never let two roles write the same checkout at the same time.

### Round folder

```
rounds/R07/
  round.json                 # runner commit, providers/models, language server check (`lsp`), config snapshot, phase timestamps, update picks and the random seed
  ideas.md  review.md  scout.md  backlog.md  publish.md  report.md  retro.md (retro rounds only)
  apps/<app>/
    brief.md                 # the exact prompt BAKED got (apps/<repo>-update/ for updates)
    run.json                 # run ids, outcome, metrics (templates/run.json)
    interventions.jsonl      # one line per human-equivalent action the implementer took
    workflow-report.md       # `baked workflow report RUN_ID`
    usage.json               # `baked workflow usage RUN_ID --json`
    verify.json  screenshot.png  findings.md
    publish/                 # README.md, logo.svg, LICENSE, ci.yml prepared for the repo
```

## config.json

Defaults below. The owner may change any value; roles read it at the start of each phase, so a change takes effect at the next phase.

```json
{
  "paths": {
    "loopRoot": "C:\\Project\\baked-loop",
    "runner": "C:\\Project\\BAKED-runner",
    "dev": "C:\\Project\\BAKED-loop-dev",
    "appsRoot": "C:\\Project\\baked-bench"
  },
  "round": {
    "newApps": 2,
    "ideaCandidates": 5,
    "updateApps": 3,
    "controlApps": ["url-shortener", "md-site", "expenses-py"],
    "controlRunsB": true,
    "maxConcurrentRuns": 3,
    "maxWallClockHours": 30,
    "difficulty": 1
  },
  "runs": {
    "workflow": "sdd",
    "worktree": true,
    "writers": 3,
    "clarification": "assume",
    "sizing": { "maxAttemptTokens": 600000, "maxRunTokens": 4000000 },
    "selfRaiseUsdUpTo": 12,
    "referenceModel": null,
    "rotateNewAppProviders": true
  },
  "budgets": {
    "roundRunUsd": 40,
    "maxFixIssuesPerRound": 6,
    "minBroadFeaturesPerRound": 1
  },
  "publish": {
    "mode": "auto",
    "org": "Gulliby-development",
    "license": "MIT",
    "publishControlApps": false,
    "logo": "one-shot-svg"
  },
  "fix": {
    "mergeAfterGreenCi": true,
    "maxPrAttemptsPerIssue": 3
  },
  "stop": {
    "maxRoundsWithoutProgress": 3,
    "maxRoundsOverBudget": 2
  },
  "confirm": {
    "crossModel": null,
    "maxTokensPerRound": 3000000
  },
  "review": {
    "rotateReviewer": true
  },
  "retro": {
    "everyRounds": 3,
    "maxChangesPerRetro": 2
  }
}
```

A key missing from the loop root's `config.json` (the file is copied once and never overwritten) takes the default shown here.

- `round.newApps` new apps are kept out of `round.ideaCandidates` candidates; `round.updateApps` existing published repositories get a small feature each (see [Updates to existing projects](#updates-to-existing-projects)). A round therefore builds `newApps + updateApps` = 5 apps plus the control apps.
- `runs.referenceModel` is the model every control-app run uses, every round (`provider/model`). `null` means "the default model configured on the PC at loop start"; phase 0 resolves it once and writes it here, and it changes only by the owner's edit.
- `runs.rotateNewAppProviders`: new apps cycle through the other configured providers (one provider per app, recorded per run), so BAKED keeps being tested on more than one provider. Estimates must stay provider-agnostic; a provider that costs much more is a finding, not a reason to tune constants to it.
- `round.maxConcurrentRuns` is the number of build lanes: runs of apps (new, update, control) that execute at the same time. It is 3 from round 7 (2 before). If builds or tests start timing out because the PC is saturated, drop back to 2 for the next round and say so in the report; the owner changes the default in `config.json`, the orchestrator never edits it.
- `round.difficulty` is the ideator's starting difficulty level (1-5). The current level lives in `state.json` (`difficulty`); the orchestrator raises it there under the [level ladder rule](#level-ladder-rule) and [Stop conditions](#stop-conditions) and says so in the round report. The orchestrator never edits `config.json`.
- `confirm.crossModel` is the model that re-runs a run from its approved plan to tell a BAKED problem from a model's habit (see [Findings and model noise](#findings-and-model-noise)). `null` means "the configured model of another vendor than the run's own": a run on `codex/...` confirms on `claude-code/opus`, a run on `claude-code/...` confirms on the codex model. `confirm.maxTokensPerRound` caps these re-runs; they count toward `roundRunTokens`.
- `review.rotateReviewer`: when no other experiment is planned, the round's experiment is one new app on the round's default provider whose review stages run on another vendor's model (see [Findings and model noise](#findings-and-model-noise)).
- `retro.everyRounds` and `retro.maxChangesPerRetro` set how often phase 11 runs and how many changes one retro may make (see [Improving the loop itself](#improving-the-loop-itself)).
- `publish.mode`: `auto` (default) publishes every app whose `verify.json` passes as a public MIT repository right after its verification, not at round end: create it private, push, wait for green CI on all three operating systems, then make it public; no approval is requested. `approve-per-round` is an optional mode the owner may switch on: it waits for the owner's typed approval ("yes", in any language) on the round's publish batch before any repository is created. Only the owner switches this; the orchestrator never changes it.

## state.json

The orchestrator rewrites `state.json` after every completed step, atomically (write a temp file, then rename). It is enough to resume after a crash, a reboot or the PC going offline:

```json
{
  "round": 7,
  "phase": "build",
  "difficulty": 1,
  "apps": {
    "envguard": { "status": "analyzed", "runIds": ["1185f909"] },
    "mdtoc": { "status": "building", "runIds": ["5b703388"] }
  },
  "fix": { "issues": [412, 415], "prs": { "412": 420 } },
  "publish": { "record": "rounds/R06/publish.md", "published": ["envguard"], "pending": ["mdtoc"] },
  "roundTokens": 9480000,
  "startedAt": "2026-10-12T08:00:00Z",
  "updatedAt": "2026-10-12T11:42:10Z"
}
```

On start, the orchestrator reads `state.json` and continues the step it names. Every step is idempotent: before creating an issue, a branch, a PR, a run or a repository it checks whether that thing already exists (search by the marker the role file defines) and reuses it.

## Starting and restarting

First start on a PC:
1. Copy `bench/loop/` from the BAKED runner checkout to the loop root: `AGENTS.md`, `roles/`, `templates/`, `controls/README.md`, and `config.json` (only if the loop root has none). Copy `templates/ledger/*` to `ledger/` for each file that does not exist yet.
2. Check prerequisites and report what is missing instead of working around it: Bun, Git, Python 3.11+, the language toolchains (Go, .NET SDK, Rust with `rustfmt` and `clippy`, a JDK 21+ with Maven; see [Stacks and toolchains](#stacks-and-toolchains)), Playwright's Chromium, `gh` signed in with the `repo` and `project` scopes (and permission to create repositories in the org), the BAKED runner and dev checkouts, at least one working provider in BAKED.
3. Bootstrap the control prompts (`controls/README.md`).
4. Copy `templates/claude-settings.local.json` to `<loop root>/.claude/settings.local.json` if that file does not exist (create the folder). Never overwrite or widen an existing file. The `.claude` folder inside the loop root is not part of the repository.
5. Write `state.json` with `round: 1`, `phase: "prepare"`.

Every later start (after a crash, a reboot or a new session): read `config.json`, `state.json` and the current round folder, then continue the step `state.json` names. Start the loop session with the loop root as its working folder: Claude Code reads `.claude/settings.local.json` from the session's project folder, otherwise the allow rules do not apply and `gh repo create` / `gh repo edit --visibility public` may be blocked by the harness. The loop reports that once and never edits permission settings itself, except creating this file from the template. A session that drives the loop from a project thread starts it with one instruction: "Read AGENTS.md in the loop root and run the loop."

## Phase 0: prepare

1. If `STOP` exists, stop (see [Stop conditions](#stop-conditions)).
2. Close the previous round: make sure its `report.md` exists and its fix PRs are merged or recorded as left open.
3. Update the runner: `git fetch origin && git checkout --detach origin/main` in `paths.runner`, `bun install`, `bun run build`. Record the commit in `round.json`. If the build fails, the fixer gets the failure as a P0 issue and the round waits for it (main must build).
4. Refresh the spec: copy `AGENTS.md`, `roles/` and `templates/` from the runner's `bench/loop/` to the loop root, so spec changes merged to `main` take effect from the next round. Never overwrite `config.json`, `controls/*.md`, `ledger/`, `state.json` or round folders; only copy a `templates/ledger/*` file whose ledger file does not exist yet. Also check `.claude/settings.local.json` in the loop root: create it from `templates/claude-settings.local.json` if missing, never overwrite it. Then re-read this file.
5. Check the toolchains (see [Stacks and toolchains](#stacks-and-toolchains)): `go version`, `dotnet --version`, `cargo --version`, `cargo fmt --version`, `cargo clippy --version`, `java -version` and `mvn -v`, with the PATH directories the loop's launch script adds. A missing toolchain is reported once and its language is left out of the round's mix; the loop does not install it or work around it.
6. Check the language servers (see [Language servers](#language-servers)) for every language the round uses: `baked lsp status --json` (or `baked lsp check`) in the round's scratch repo, an install with `baked lsp install <language>` for each uncovered language, then the check again. Record the result in `round.json` `lsp`. An install that fails (exit 1, missing toolchain) is reported once; the round runs without that server.
7. Run `baked doctor` in an empty scratch repo with the round's policy; any refusal is a P0 finding and stops the round until fixed.
8. List configured providers and check each with one tiny headless call (`baked --headless --model PROVIDER/MODEL "Reply OK"`). A provider that refuses for credits or auth is skipped this round and reported once. Resolve `referenceModel` if unset. If the reference model is unavailable, control apps wait for it; they never switch models (that would break comparability).
9. Write `round.json` and set `state.phase = "ideate"`.

Phase 0 also picks the round's update repositories (from round 3; rounds 1 and 2 had no update apps): see [Updates to existing projects](#updates-to-existing-projects). Record the picks and the seed in `round.json`.

Round 1 of the loop is special: the owner already approved five apps on 2026-10-10 (envguard, mdtoc, cronsay, jsondelta, logslice; briefs in `templates/round1-briefs.md`). Round 1 skips phases 1–2 and uses those prompts verbatim as briefs, then continues normally.

## Language servers

BAKED's code intelligence (`src/core/intelligence/backends/lsp/server-registry.ts`, `router.ts`) uses a standalone language server for a file's language when it finds one and otherwise falls back to ts-morph, tree-sitter and regex. A round that builds in a language without its server therefore measures the weaker fallback. The rule: when a round develops in a language, the loop makes sure the matching server is working, through BAKED's own headless commands, or says it is not. These commands are documented in `docs/headless.md#language-servers` of the runner checkout.

- **Commands.** Run them in the project's folder (a scratch repo or the app workspace) with the round's `PATH`, as `tools/launch.sh` sets it for the toolchains.
  - `baked lsp status --json`: the servers for the languages the project uses (`--all`: every server BAKED knows). Per server: `id`, `languages`, `detected`, `installed`, `source` (`PATH`, `baked` or `mason`), `path`, `disabled`, `package`, `requiresToolchain`, `installable`. `uncovered` lists the detected languages that no enabled, installed server covers.
  - `baked lsp install <language|server|package>`, for example `baked lsp install go`: installs into BAKED's own folder (`lsp-servers`), needs no prompt, and exits 1 when the install fails or its toolchain (`go`, `cargo`, `pip3`, ...) is missing.
  - `baked lsp check [ID]`: starts the project's servers, waits up to a minute and exits 1 when a detected language has no working server (the error is printed).
  - `baked lsp enable|disable ID [--scope global|project]`: keeps BAKED from starting a server or lets it again. The loop uses it only to undo a server it disabled itself; it never disables one to make a run pass.
- **Check (phase 0, step 6).** In a scratch repo that holds a file of each language the round uses (new apps, updates, controls), run `baked lsp status --json`. A language is covered when it is not in `uncovered`. For each uncovered language, run `baked lsp install <language>` once, then `baked lsp check`. Record `round.json` `lsp`: `{ "<language>": { "server": "<id>", "covered": true|false, "source": "PATH|baked|mason|null", "path": "<resolved path or null>", "installed_by_loop": true|false, "error": "<last line of the failure or null>" } }`.
- **Installing.** Only through `baked lsp install <language>`. Never install a language server by hand, with `npm install -g`, `pip`, `go install`, `cargo`, `dotnet tool` or any system-wide package manager, and never install a runtime or toolchain on the owner's machine.
- **Missing or failed.** If an install exits 1 (the install failed or the toolchain is missing), report it once, in the round's first owner message, with the language, the command and its last output line, and keep going. The round runs without that server: the round report says which languages had none, and the analyst compares code-intelligence behavior with and without (see the analyst brief). The next round's check tries again, so a toolchain the owner installs in between is picked up.

| Language | Server BAKED installs or finds | Install |
| --- | --- | --- |
| Python | `pyright-langserver`, then `pylsp` | `baked lsp install python` |
| TypeScript / JavaScript | `typescript-language-server` (then `biome`, `deno`) | `baked lsp install typescript` |
| Go | `gopls` | `baked lsp install go` |
| .NET (C#) | `csharp-ls`, then `OmniSharp` | `baked lsp install csharp` |
| Rust | `rust-analyzer` | `baked lsp install rust` |
| Java | `jdtls` | `baked lsp install java` |

The language names are the ones `baked lsp status --json` shows in `languages`; if one differs from the table, use the status output, or name the server (`gopls`) or the Mason package instead.

## Stacks and toolchains

Until round 6 the loop built only Python and TypeScript (Bun) projects. From round 7 it also builds Go, .NET, Rust and Java (Maven + JUnit) projects.

- **Stack mix per round.** From round 7 every round has at least two of the new languages (`go`, `dotnet`, `rust`, `java`), counted across new apps, updates and controls (an update of a public repository in one of these languages counts). The ideator and the reviewer enforce it, preferring languages that earlier rounds used least.
- **Scaffold kinds.** `tools/scaffold.py` builds `bun`, `webunit` and `python` workspaces; `tools/scaffold_lang.py` builds `go`, `dotnet`, `rust` and `java` ones with the same CLI (`scaffold_lang.py <round-dir> <name> <kind>`): git repo, LF attributes, a minimal project with a heading-only README, `.gitignore`, and `.baked/config.json` derived from `tools/base-config.json` with the language's checks and `allowedPaths`. `tools/scaffold_update_lang.py` does the same for a brownfield clone (it detects `go.mod`, `*.sln` or `*.csproj`, `Cargo.toml`, `pom.xml`) and records the baseline.
- **Checks per language.** Go: `go vet ./...` (fixer `go fmt ./...`; `gofmt` has no failing check mode without a wrapper), `go test ./...`. .NET: `dotnet build`, `dotnet format --verify-no-changes` (fixer `dotnet format`), `dotnet test`. Rust: `cargo fmt --check` (fixer `cargo fmt`), `cargo clippy -- -D warnings`, `cargo test`. Java: `mvn -B -q verify` (no formatter). All are required with scope `feature`; changing them is an experiment (see [Comparability](#comparability)).
- **Toolchain check.** Phase 0 checks each toolchain (see [Phase 0](#phase-0-prepare)); a missing one removes its language from the round.
- **PATH.** A shell started by the harness may not have the toolchains on `PATH` (Git Bash on Windows in particular). `tools/launch.sh` and the scaffold scripts add the directories of Go, the .NET SDK, Cargo and the JDK and Maven explicitly, in front of the inherited `PATH`; on another machine adjust that list and nothing else.
- **Publishing.** The publisher takes `templates/ci/<stack>.yml`: `bun`, `vite`, `python`, `go`, `dotnet`, `rust` or `java`.

## Level ladder rule

The orchestrator keeps the current level in `state.json` (`difficulty`, 1-5; the level definitions with sizes and expected costs are in `roles/ideator.md`). Since the owner's decision of 2026-10-14 the loop climbs one level at a time, quality first:

- **Start.** The loop runs at level 3 until a level-3 round has no errors.
- **No errors.** A round at level L has no errors when, for the new apps of that round, every new app of level L was built, passed verification and (when `publish.mode` allows) was published, and the round's analysts filed no new P0 or P1 finding. Both conditions cover the whole round: new P0 or P1 findings from the updates, the controls and the probes count as errors exactly like those from the new apps (owner's decision of 2026-10-14). Infrastructure resumes (a provider outage, a reboot, a rate limit) do not count as errors; a manual approval that policy always requires (a new project file, a CI file) does not either, but is still a finding when it was avoidable.
- **Climb.** A round with no errors at level L sets the next round's level to L+1 (at most 5). A round with errors repeats level L: the fixes of its findings are measured by the next round at the same level.
- **Level 5.** A level-5 app is always built as a BAKED initiative (`baked workflow initiative start`), never as one run. After a level-5 round with no errors the loop stays at level 5 until the owner decides what comes next. The shape of a level-5 round:
  - One new app per round, as an initiative of 6 to 8 features (3 to 12 are allowed), about 28 to 40 planned tasks and 25 to 40 files, with a request written for the whole app (the brief states the app, not a feature list; the decomposer finds the split). Updates, controls and the other probes run as before.
  - The split approval is mandatory and counts as one intervention by design (like the quick plan approval); it is not an error. Any other decision, extend, resume or manual approval counts as an intervention.
  - Start with `--worktree --tiered-approval --max-tasks 5 --max-files 10`, the shared budget `--budget-tokens 30000000 --budget-calls 400 --budget-time-ms 21600000`, and `baked workflow initiative estimate ID` after the split and before the approval (an estimate that does not fit is reported; the loop decides whether to approve). Every feature run carries `maxCostUsd` 8 and `costTolerance: "auto"`.
  - Initiative budgets have no dollar cap. The loop enforces it: the cost of an initiative is the sum of `estimatedCostUsd` of all its runs (decompose, feature runs, superseded runs); the cap is $32 per initiative (proposed to the owner on 2026-10-15 as the level-5 reading of the per-run cap), and the round cap stays $60. Past the cap the loop pauses the initiative and reports, it does not raise it without the owner.
  - The analyst reads `initiative show ID --json` (per-feature state, usage and blockers) next to each feature run's usage and finds the findings per feature.
- **What stays.** One new app of every round is still built on the claude-code series (Opus for plan, spec and review, Sonnet for code, `revision: patch`) and one update per round still runs on the `quick` preset; the update picks, the controls and the cfgtrace-style probe keep their rules and levels (updates stay at difficulty 2). The new app of the other series is built at the same level.
- **Report.** The round report states the verdict (`no errors` or the list of errors), the level just run and the next level, and keeps cost as a reported metric next to quality.

This replaces the earlier difficulty rule, under which a round without BAKED-side problems raised the level. It is in addition to the stop conditions below.

## Updates to existing projects

Besides new apps, each round improves existing public projects of the organization, so the portfolio grows in depth as well as in width. Applied from round 3.

- **Pool.** All public repositories of the GitHub organization `publish.org` (`gh repo list Gulliby-development --visibility public`), excluding forks, archived repositories and BAKED itself (`baked`). Private repositories are never touched: never cloned, never listed as candidates, never changed. If fewer than `round.updateApps` exist, take all of them; with none, the round has only new apps.
- **Pick.** `round.updateApps` (3) repositories at random from the pool, using a seeded random generator with the round number as the seed. Record the seed and the picks in `round.json` so the pick can be reproduced. Never pick the same repository two rounds in a row when others exist.
- **Idea.** For each pick the ideator reads the repository and proposes one small useful feature (one run: 1 to 3 source files plus tests plus a README update, no breaking change, no new dependencies). A CI pipeline may itself be the feature when the repository has no CI. The update may also bundle small repository hygiene as a side part, never as the whole update (optional extras, listed in the brief): an MIT `LICENSE` only where the repository has no license at all, a logo when the README has none, topics and a description when the repository has none, a README badge or section only when clearly missing. The reviewer keeps it or asks for a revision. Ideas are recorded in `ledger/ideas.jsonl` with `kind: "update"` and the repository name.
- **Build.** The implementer clones the repository fresh, adds the BAKED project config, records the baseline test result and runs `workflow run sdd` with the same fixed settings as every other app.
- **Verify and ship.** The verifier checks the whole test suite and the diff against the brief, and that the listed extras exist and are correct. The publisher opens a pull request in the repository, merges it after green CI and then applies topics and description with `gh repo edit` (see `roles/publisher.md`).
- **Metrics.** Update runs use `group: "update"` and are tracked separately from new apps and control apps in `ledger/metrics.csv`, `run.json` and the round report. They are never averaged with greenfield runs. Their findings are tagged `brownfield`.
- **Budget.** Update runs are small, but they count toward `roundRunUsd`. Each has the policy sizing as its run budget, like every other app.

## Comparability

Numbers across rounds mean something only if the inputs are fixed. These rules hold unless the owner changes them:

- **Runner pinned per round.** All runs of a round use the same BAKED commit. Fixes merged during the round take effect next round.
- **Control apps are fixed.** Same prompts (`controls/`, verbatim from rounds 1–2), same workflow and settings (`runs.*`), same `referenceModel`, fresh folder each round. They are measurement fixtures, not products: they are never published (`publishControlApps: false`).
- **Same settings for new apps,** except where `ledger/workflow-map.md` names another workflow for the app's task type. Each round may run at most one deliberate **experiment** (a different preset, setting or provider on one app), named in `round.json`, so a change of results can be attributed.
- **Every metric row records** the BAKED commit, workflow, settings hash, provider and model per stage, and whether the run is a control, a new app, an update or an experiment. Runs on different providers or before/after a provider-changing PR are reported in separate groups, never averaged together.
- **Interventions are counted strictly.** Any action a person would have had to take (resume, extend, answer, approve outside auto-approval, recover, reroute, cancel, evidence supplied after inspecting the code, manual file edit) is one intervention with a category, even when the implementer takes it on its own. The implementer never edits app files by hand to rescue a run.

## Findings and model noise

Most runs use one implementation model and one review model, so a habit of that pair can look like a BAKED problem. Every finding therefore says what kind it is and on which models it was seen, and a finding that may be a model habit is confirmed on another model before anyone fixes it.

- **Kinds.** `invariant`: BAKED itself behaves wrongly whatever the model answered (wrong accounting, a throw where a route should be, a gate that does not know a toolchain, state left dirty). `recovery`: a model made an ordinary mistake (a bug, a test in the wrong task, a wrong verdict) and BAKED had no way to detect it or recover; it counts when any model can make that mistake. `model-behavior`: a habit of one model or provider (a cautious reviewer, a provider's own sandbox, a reread loop) that the others do not show. The test: if BAKED is wrong for every possible model answer, the finding is `invariant`.
- **Seen on.** Each finding records `seenOn`: the provider/model of every role that took part (implementation, review, fix), from `routing.json` of the run.
- **Origin.** Each finding records `origin`: `new` (a class of defect not filed before), `sibling-of:#N` (the same mechanism as an issue whose fix already merged, reached by a path, stage, toolchain or case that fix did not cover), `harder-round` (it only shows because the round got harder: a language or toolchain the loop never ran, or a feature larger than any before) or `model-behavior`. The share of `sibling-of` findings per round says whether fixes cover their whole family; the retro tracks it.
- **Cross-model confirmation.** For every `model-behavior` finding and every `blocked` run whose cause is not already an `invariant` finding, the analyst re-runs the run on `confirm.crossModel` from its approved plan: `baked workflow fork RUN` (a fork keeps the spec, graph and plan and restarts at implementation in a fresh worktree), then `baked workflow reroute FORK --model MODEL` (or `--route STAGE=MODEL` when only a review stage is in question) and `baked workflow resume FORK`. It never changes the original run. A fork repeats implementation, so a confirmation costs most of the original run; the analyst confirms the finding with the largest expected effect first. The result goes into the finding as `confirmation`: `reproduced` (the same problem on the other model: the finding is a BAKED problem, keep its kind or change it to `recovery`), `not-reproduced` (record `model-only`), or `skipped: reason` (budget, no other vendor configured). Forks count toward `confirm.maxTokensPerRound`; when it is spent, findings wait with `confirmation: pending` for the next round.
- **Recurrence.** A `model-behavior` finding that is `model-only` or still `pending` is kept in `ledger/findings.jsonl` with `status: "watch"` and gets no issue until it is seen a second time (another app or another round) or confirmed. `invariant` and `recovery` findings are filed at once, as before. When a `model-only` problem still needs a fix (the provider is supported and users will hit it), the fix is a mechanism that detects and recovers from it, never prompt wording tuned to one model, and its issue says `model-only` and names the model.
- **Rotating the reviewer.** With `review.rotateReviewer`, a round with no other experiment runs one new app on the round's default provider with its review stages routed to another vendor's model (`--route` for the review stages; `modelRouting.independentReview: "provider"` for that run). The report compares its review findings and verdicts with the same-provider reviews of the round (`baked workflow compare`). This is the round's one experiment.
- **Escape analysis.** Each finding also records `faultOrigin` (`host`, `model` or `environment`) and `escapedLayer`, the cheapest check layer that should have caught it before the round: `unit`, `scenario`, `gate-matrix`, `replay`, `shadow`, `fault-matrix`, `mini-suite`, `smoke`, `round`. The retro ranks layers by escapes, and the fix for an escaped finding adds a check at that layer, so the class is caught earlier next time. When a PR adds a new check layer, it adds the layer to this list, to `templates/finding.md` and to the analyst role in the same branch.
- **Cloud smoke runs.** A scheduled cloud session outside the loop runs short smoke rounds on `main` with a cheaper model (`quick`, difficulty 1, apps from `tools/scaffold.py`) after fixes merge. It files only `invariant` and `recovery` findings, as issues labelled `bench-loop` and `smoke` with the same body and marker rules as the backlog role (`<!-- bench-loop: smoke-YYYY-MM-DD/<finding-id> -->`). The backlog role treats those issues like its own: it dedupes against them and may put them in the fix set.

## Budgets

| Budget | Default | On reaching it |
|---|---|---|
| One BAKED run | starts at the policy budget (tokens); the implementer may raise it on its own while the run's estimated cost stays under `selfRaiseUsdUpTo` ($12 at levels 1-3, $22 at levels 4 and 5; owner's decisions of 2026-10-14) | above the cap only with the owner's OK; otherwise stop the run and record `budget_cap`. Every run also carries the policy field `maxCostUsd` set to the cap, so BAKED itself stops the run |
| All BAKED runs in a round | `roundRunUsd` $40 at levels 1-3, $60 at levels 4 and 5 (the sum of the runs' estimated cost from `baked workflow usage RUN_ID --json`) | finish runs in progress, skip unbuilt new apps and updates (record them), go to phase 6; a level that needs more is reported, not shrunk |
| Fix work per round | `maxFixIssuesPerRound` 6 issues, at least `minBroadFeaturesPerRound` 1 broad feature when one is open (the top-ranked `idea` counts; the backlog role ranks ideas, the owner does not pick) | the rest stays on the board for later rounds |
| One fix PR | `maxPrAttemptsPerIssue` 3 CI rounds | leave the PR open with a comment on what fails, take the next issue |
| Round wall clock | `maxWallClockHours` 30 | finish the current step, write the report with what is done |
| Orchestrator and role tokens | not capped by the loop; the harness's own limits apply | if the harness is rate-limited, wait and resume, don't skip phases |

Costs and token counts come from `baked workflow usage RUN_ID --json` (per-attempt `costUsd` and tokens), never from estimates. Tokens stay a reported metric; the caps are in dollars because raw tokens mix cheap cache reads with expensive output (owner's decision of 2026-10-14). Over-budget rounds are reported, not hidden.

## Approval gates and what never happens without the owner

The loop is autonomous except at these points:

| Action | Gate |
|---|---|
| Creating a public repository | `publish.mode = auto` (default): none; standing authorization, see below. `approve-per-round` (optional, owner's switch): the owner's typed approval ("yes", in any language) on that round's batch. Either way only apps whose `verify.json` passes. |
| Making a repository public (`gh repo edit --visibility public`) | same as creating it, and only after CI is green on all three operating systems |
| Raising one run above its level's cap ($12 at levels 1-3, $22 at levels 4 and 5) | the owner's OK for that run |
| Merging a fix PR into BAKED `main` | none when `fix.mergeAfterGreenCi` is true and CI is green (owner's standing authorization of 2026-10-09). False: leave PRs for the owner. |
| Merging a verified update PR into a published repository | none when `publish.mode` is `auto` and the repository's CI is green on all three operating systems (standing authorization of 2026-10-11, same as creating the repositories) |
| Tags, releases, version bumps | never; the owner pushes tags |
| Deleting or renaming any repository, branch on someone else's PR, or published file history | never |
| Changing this spec (`bench/loop/AGENTS.md`, `roles/`, `templates/`) | only through phase 11 within the self tier, as a PR to BAKED `main` merged after green CI; everything else is proposed in the report (see [Improving the loop itself](#improving-the-loop-itself)) |
| Changing `config.json`, BAKED's root `AGENTS.md`, provider keys, signing certificates, org settings | never; propose the change in the report |
| Spending money (paid APIs, credits top-up) | never; report that credits ran out |

**Standing authorization for public repositories.** gulliby gave standing authorization on 2026-10-11 to create public repositories in Gulliby-development for verified apps without asking; with publish.mode auto no approval is requested. The owner's words (2026-10-11): "I allow setting publish.mode auto and creating public repositories in Gulliby-development through gh", and earlier "don't ask me; always create the repositories when an app is ready and works". An agent harness with its own permission layer may still block `gh repo create ... --public` or `gh repo edit --visibility public`. Then the loop reports it once, does not work around it, and the owner adds an allow rule for the loop's session. The loop never changes permission settings itself.

In `approve-per-round` mode the publish gate never blocks the loop: a batch waiting for approval stays in `state.publish`, and the next round starts. When the owner answers, the orchestrator runs phase 9 for that batch at the next safe point (between steps). In `auto` mode there is no gate: phase 9 runs per app as soon as `verify.json` passes.

## Stop conditions

**Stop at the next safe point** (finish the current step, write `state.json` and the report, tell the owner, then end the session):
- `STOP` exists, or the owner says stop.
- Every configured provider refuses for credits or auth.
- BAKED `main` does not build or its CI is red, and the fixer could not fix it in `maxPrAttemptsPerIssue` attempts.
- `maxRoundsOverBudget` rounds in a row went over `roundRunUsd`.
- A secret or private data is found in a published repository (also: make the repo private if possible, and report at once).
- Disk below 10 GB free after cleaning old run worktrees (`baked workflow` retention, old `baked-bench` rounds beyond the last 3).

**Pause and ask** (keep the session alive, report once, continue other phases that don't depend on the answer):
- The device's permission mode refuses a command the loop needs.
- A run needs more than its level's cap ($12 at levels 1-3, $22 at levels 4 and 5).
- An issue labelled `needs-gulliby` blocks work (accounts, money, organization settings). Scout ideas never wait for the owner; the backlog role triages them.
- A finding is a security issue in BAKED itself (report it privately to the owner; don't file a public detail if the repo becomes public).

**Change course instead of stopping:**
- The [level ladder rule](#level-ladder-rule) after every round: a round without errors climbs one level, a round with errors repeats its level, never above level 5 (see the ideator's difficulty ladder). `maxRoundsWithoutProgress` no longer raises the level on its own: a round without new P0/P1 findings and with every new app passing has no errors and climbs by the rule above.

## Reporting to the owner

The owner reads one message per round, in Russian, at most 15 lines, plus a message for each gate or blocker. Files stay in English. In a Remote Control session started from a thread, "tell the owner" means a message to the controlling thread session, which posts it; standalone, it means printing it and writing `rounds/RNN/report.md`.

Messages:
- **Round result** (phase 10): BAKED-side metrics first (interventions per run and stop reasons by count vs last round, tokens per verified app, runs completed without intervention, whether last round's fixes worked), then the 3 most important findings with issue links, fixes merged, what the next round changes, then completed/blocked counts for new and control apps and the Published list with repo links, and a link to `report.md`.
- **Published** (phase 9, `auto`): not a separate message. A list inside the round report and the round message, one line per app: name, one-sentence description, repo link, CI result. Apps left private (`ci-failed`) are listed with the reason.
- **Publish batch** (phase 9, only in `approve-per-round`): one line per app (name, one-sentence description, repo name), links to the prepared README and logo, and the question whether to publish (yes / no / edits).
- **Blocker**: what stopped, what was checked, what the owner must do, in one or two sentences.

No other messages. Progress goes into `state.json` and the round folder.

## Phase 10: report

1. Fill `rounds/RNN/report.md` from `templates/round-report.md`, BAKED-side metrics and the check of last round's fixes before the app tables: tables per group (control, new, update, experiment), comparisons with the previous round and with the first loop round, findings and issues, fixes merged with their expected effect, a Published table (repo links, CI results, logo outcome), budget use, open blockers.
2. Append one row per run to `ledger/metrics.csv`.
   Export the usage trace of every app of the round, so the next forecast, sizing or cap change replays on it before it merges (#1649): from the fixer's checkout, `bun scripts/bench-trace.ts export C:\Project\baked-bench\RNN\<app> tests/fixtures/bench-traces/RNN/<app>.sqlite.gz` for each app folder (updates and controls included), then `bun scripts/bench-trace.ts replay tests/fixtures/bench-traces/RNN/*.sqlite.gz` and `bun test tests/forecast-replay-corpus.test.ts`. Open a pull request `feature/bench-traces-rNN` with the traces. A replay difference on the round's own traces is a finding: the current main decides differently from the runner the round used, which is expected only for fixes merged during the round, and those go into `tests/fixtures/bench-traces/accepted.json` with the fix's issue as the reason. The trace drops prompts, model output, file contents and prose; check it is under 2 MB per app and mention any larger one in the report.
3. Send the round result message.
4. If `state.round` is a multiple of `retro.everyRounds`, set `state.phase = "retro"` and run phase 11; its one-line summary and any owner-tier proposals go into the round message (sent after the retro in that case).
5. Set `state.round += 1`, `state.phase = "prepare"`.

## Improving the loop itself

The loop improves BAKED, and every `retro.everyRounds` rounds it also improves itself. Phase 0 copies `AGENTS.md`, `roles/` and `templates/` from the runner's `bench/loop/` each round, so a change to the loop is an ordinary pull request to `bench/loop/` in BAKED and takes effect in the first round after it merges.

Phase 11 runs `roles/retro.md`. The retro reads the round reports since the last retro, `ledger/metrics.csv`, `ledger/findings.jsonl`, `ledger/loop-changes.jsonl` and earlier `retro.md` files, and what others publish about evaluating coding agents. It computes the loop's own metrics and makes or proposes at most `retro.maxChangesPerRetro` changes, each a hypothesis with a metric, an expected movement and the round when it is judged.

What the retro may change, by tier:

| Tier | What | How |
|---|---|---|
| Self | Wording and checklists in `roles/*.md`, report and finding templates, ledger fields, triage and severity criteria, analysis commands, the order of steps inside a phase, new measurements | a PR to `bench/loop/` that the retro opens and merges after green CI, like a fixer PR |
| Trial | A new step or phase in the loop (for example a smoke check or a stage re-run) | a PR that marks the step as a trial for one round; the next retro keeps it if its metric moved and removes it otherwise |
| Owner | `config.json` values (budgets, providers, concurrency, publishing), control apps and the reference model, the [Objective](#objective) and every "never" rule in this file, the tiers in this table, anything that spends more tokens or money or touches keys | proposed in `retro.md` and in the round message, never changed by the loop |

Every change is a line in `ledger/loop-changes.jsonl` with its PR. The next retro first judges the changes that are due (`kept`, `reverted`, `extended`) and reverts those that did not move their metric, before it proposes anything new. A retro never weakens a rule that limits the retro itself.

## Rules for every role

- Follow BAKED's root `AGENTS.md` for anything that touches the BAKED repository (branches, checks, docs, issues, the board, English everywhere). That includes changes to this spec: a BAKED branch is always `feature/<name>` or `bugfix/<name>`, never `docs/` or another prefix.
- Write all files, issues, PRs, READMEs and commit messages in English. Only messages to the owner are in Russian.
- Evidence over opinion: every claim about a run cites the run id and the artifact, event or command output it comes from.
- Think beyond tuning (owner's rule): for each problem, give the point fix and the broader capability that would make the whole class of problem rarer.
- Keep estimates and fixes provider-agnostic: no constants calibrated on one provider; when unsure a task fits, split it or give a large margin.
- Never put secrets, tokens, local paths, user names, run logs or `.baked/` content into anything public. The one exception is the anonymised usage traces that `scripts/bench-trace.ts export` writes for `tests/fixtures/bench-traces/` (phase 10).
- Respect licenses: never copy code from repositories with incompatible licenses into apps or into BAKED; ideas are fine, code is not.
- Idempotence: look before you create, reuse what exists, record what you created in the ledger the same step.

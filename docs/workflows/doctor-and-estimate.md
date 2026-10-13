# Workflow doctor and pre-run estimate

Status: implemented (`baked doctor`, `baked workflow estimate`).
Depends on R1 model routing (`src/core/llm/model-routing.ts`, `src/core/workflows/routing.ts`).

## Goals

- **Doctor.** Before a run starts, one report says whether the run can start and finish, and what to fix
  if it cannot. It covers everything that today fails a run late: a model without a provider key, a check
  command that is not installed, a dirty or busy workspace, worktree prerequisites, and a budget the run
  will probably exceed.
- **Estimate.** Before a run starts, show tokens per stage and per model for the selected workflow with
  its resolved routing, plus an approximate cost in USD where the model price is known.
- Both are core functions with no terminal dependency. The CLI and the local core API render the same
  JSON report.

Non-goals: enforcing anything at run start (R2 owns the start-time key preflight and `independentReview`;
it reuses the model check described here), the TUI form (R3), a dollar cap (`maxCostUsd` stays disabled
until R4 verifies pricing).

## Shared request

Both commands take the inputs of `workflow run` that change the outcome, and nothing else:

```ts
interface PreRunRequest {
  workflowId: string;                  // default: config.workflows.defaultWorkflow ?? "sdd"
  model?: string;                      // run model; default config.defaultModel
  routes?: Record<string, string>;     // --route overrides
  policy?: unknown;                    // --policy FILE content; default config.workflows.policy
  worktree?: boolean;                  // --worktree
  writers?: number;                    // --writers
}
```

The routing is resolved by the same `routingRecord` call the run makes (inside `prepareStart`), with the
request's policy, so the doctor, the estimate and the run agree.

## Doctor

### Report

```ts
type DoctorStatus = "ok" | "warn" | "fail" | "skip";
interface DoctorCheck {
  id: string;               // stable, e.g. "models.key", "git.clean"
  status: DoctorStatus;
  title: string;            // one line, e.g. "Provider key for openai/gpt-5.1"
  detail?: string;          // what was found
  fix?: string;             // the command or setting that fixes it
  subject?: string;         // model ID, check ID or path the line is about
}
interface DoctorReport {
  schemaVersion: 1;
  workflowId: string;
  runModel: string | null;
  ready: boolean;           // no "fail"
  checks: DoctorCheck[];
  estimate: PreRunEstimate | null;   // see below; null when the definition did not load
}
```

`warn` never blocks; `fail` means `workflow run` with the same inputs would be refused or would stop
before finishing. The CLI exits 1 when `ready` is false.

### Checks, in order

The start refusals and the doctor must not drift apart, so the doctor does not re-implement them. The
validation half of `NativeWorkflowService.start` (everything before the run is written: model, policy,
`validateChecks`, routing, definition load, v1 `validateWorkflow` and profile outputs, v2 `bindDefinition`
with gate-library validation and auto-approval confirmation, execution mode and `writerPolicyProblem`,
worktree refusal and `worktreeBase`, review and skeptic profile outputs, skill hashes) moves into a
store-free function `prepareStart(workspace, config, request)`. `start` calls it unchanged; the doctor
calls it with a placeholder feature and prompt and reports a thrown fault as one `fail`.

1. **config.enabled.** Workflows are on, which they are unless a configuration sets `workflows.enabled: false`. Fail otherwise; fix: remove that setting.
2. **start.** `prepareStart` succeeds. Fail with the fault message. When it fails, checks that need its
   result (models, commands, estimate) are `skip`.
3. **models.** `checkStartModels` checks every distinct model the run can call, the same set and the same
   verdicts `workflow run` uses to refuse a start. Primary models of bound stage routes and profiles (the
   profiles of agent and reflection stages, the bound `ai-review` gates' review and skeptic profiles,
   `policy.reviewProfiles`, `skepticProfileId`, and every profile whose output is `implementation`, since
   the planner may assign any of them to a task) are required; fallback models and profiles the workflow
   does not bind are optional:
   - `models.provider`: the model ID is `provider/model` and names a known provider. Warn otherwise: the
     model fails at its first call, and `workflow run` starts anyway.
   - `models.key`: the provider is available (its `checkAvailability`, else a key from
     `getProviderApiKey`); fix: `baked --set-key PROVIDER KEY` or the provider's env variable. Fail for a
     required model (and `workflow run` refuses to start), warn for an optional one. A
     `checkAvailability` probe that does not answer within 5 seconds warns. One line per model,
   naming the stages or profiles that use it. Tool-calling support is not checked: the model catalog has no
   reliable capability flag.
4. **review.independent.** A review model equals the implementer model: `warn`. R2 makes this
   configurable (`independentReview`); the doctor only reports.
5. **commands.** For every command the run will execute: `policy.checks`, every bound `command` gate in
   stages and transitions, and every `ai-acceptance` gate's start command. The executable resolves
   (`Bun.which` from the command's cwd, or an existing path) and the cwd exists. Fail for a required check
   or gate, warn for an optional one. Commands are not executed: a full suite can take minutes and may have
   side effects.
6. **sandbox.** The run's OS sandbox mode (the frozen policy's `sandbox`, or the `--sandbox` flag and the
   `sandbox` setting when the start failed) against the backend of this machine
   ([OS sandbox](../sandbox.md)): `ok` when off or when the backend works; `auto` without a backend is warn
   (commands run without OS sandbox); `required` without one is fail, and `prepareStart` refuses the start
   with the same reason, so it also shows as `start`.
7. **git.** Not a Git repository: warn for inline runs (worktree mode already fails in `prepareStart` via
   `worktreeBase`; delivery needs Git too). Uncommitted changes: warn with up to ten paths; in worktree mode
   approved tasks that touch them ask the user to exclude them. Prunable entries in `git worktree list`
   under `.baked/worktrees`: warn, fix `git worktree prune`.
8. **workspace.busy.** The execution leases: the workspace-wide one of an inline run, and
   `execution:RUN_ID` of each worktree run. Worktree runs that execute are `ok` (the working copy is
   free). For the inline lease, owner alive or unknown is fail (`drive` would refuse with `WORKSPACE_BUSY`); owner dead while its
   command may still be running is fail with fix `baked workflow recover RUN_ID`; owner dead otherwise is
   warn (released on the next drive).
9. **budget.** With the estimate available: `fits: "maybe"` or `"no"` is warn, never fail, since estimates
   are not measurements. Fix: raise `maxTotalTokens` in the policy.

The store is opened read-only when it exists. No database skips the lease check and uses default
estimate ranges; a database this build cannot read (`VERSION_UNSUPPORTED`) is a warn, not a crash.

### Seams for tests

`runDoctor(workspace, config, request, deps)` takes `deps: { providerReady(model): Promise<Readiness>;
which(cmd, cwd): string | null; git: (args) => Promise<{ code; stdout }> }` with real defaults. Tests
inject them, so they do not depend on keys in the developer's environment.

`checkStartModels(workspace, prepared, providerReady)` is also the start-time preflight of
`NativeWorkflowService.start`: its failures are the refusal and its warnings go into the routing record,
so doctor and start report the same problem in the same words.

## Estimate

### What changes compared with `estimateStart`

`estimateStart` sums a fixed list of SDD stages from all past runs. The pre-run estimate:

- **Follows the definition.** Only the definition's stages count, read through `asV2` so v1 and v2
  definitions look the same. History is keyed by stage ID, so a stage with history uses it whatever its
  type (check stages run `ai-acceptance` agents and record their attempts there). Without history, the
  stage type picks the fallback: `tasks` is price per task times task count (without history 90k–450k
  per task, one code file and one test file created at the sizing defaults, times 2–6 tasks); `agent`, `reflection` and
  `review` use the default range for that ID, else a generic 15k–60k; `approval`, `check` and `learn`
  are zero. Tasks stages are recognized by type, not by the ID `implement`, so a renamed tasks stage is
  not counted twice.
- **Prefers the same workflow's history.** Ranges come from runs (any status but `created`, as today) of the same `workflowId`
  when there is at least one; otherwise from all runs; otherwise from the default ranges. The basis line
  says which (`2 earlier runs of standard`, `5 earlier runs of other workflows`, `generic range`).
  A stage keeps per-stage fallback: a stage the same-workflow runs never reached uses all runs.
- **Reads the shared stores.** The runs are this project's plus those of every store the policy names
  in `sizing.historyStores` (a `.sqlite` path or a project directory, relative to the workspace), each
  run once. The basis line counts them: `3 earlier runs of sdd, 2 of them from other projects`. The
  start estimate, `baked workflow estimate` and the doctor read the same history.
- **Attaches models.** Each stage gets the models that will run it: the stage route, else the stage
  profile's resolved model; tasks stages use the `implementer` profile; review stages use their bound
  review profiles, and their tokens are split evenly across those models.
- **Prices tokens.** USD range per stage = token range × the model's blended price.

### Pricing

The price table in `src/stores/statusbar.ts` moves to `src/core/llm/pricing.ts` (the store re-exports
what it uses, so the status bar is unchanged). A new `findPricing(modelId)` returns `null` where the
table has no entry or family match, so the estimate shows "price unknown" instead of inventing a number.
Family matches (`gpt` priced as the newest GPT) and GitHub Copilot's request-multiplier prices are marked
`approximate` per model. Free and local models price at zero.

Attempts record `used_tokens` = input + output, where input already includes cache reads. The estimate
prices a stage with a fixed mix of 60% uncached input, 30% cache reads and 10% output (agent loops re-send
long contexts and write little). Cache writes are not recorded anywhere, so Anthropic costs read low; the
report says so. Measuring the mix from usage artifacts is left for R4, which owns verified pricing.

### Report

```ts
interface PreRunEstimate {
  schemaVersion: 1;
  workflowId: string;
  tokens: TokenRange;
  costUsd: TokenRange | null;        // null when no model on the path has a known price
  costComplete: boolean;             // false when some stage's model has no known price
  basis: "workflow-history" | "history" | "defaults";
  samples: number;
  mix: { input: number; cacheRead: number; output: number };
  notes: string[];                   // e.g. cache writes not counted, approximate prices
  stages: { stageId: string; type: string; model: string | null; tokens: TokenRange;
            costUsd: TokenRange | null; basis: "workflow-history" | "history" | "defaults" }[];
  models: { model: string; stages: string[]; tokens: TokenRange; costUsd: TokenRange | null;
            price: "table" | "approximate" | "unknown" }[];
  budget: { maxTotalTokens: number; fits: "yes" | "maybe" | "no" };
  label: string;                     // one line, always says "Estimate"
}
```

`fits`: `yes` when the high end is within the budget, `no` when the low end exceeds it, else `maybe`.

### Saved estimate

`saveEstimate` at run creation switches to the definition-aware estimate and adds `costUsd` and
`workflowId` to `estimates/start.json` as optional fields (`schemaVersion` stays 1; readers ignore
unknown fields). `compareWithActual` is unchanged.

## Surfaces

- CLI: `baked workflow doctor [WORKFLOW] [--model ID] [--route ...] [--policy FILE] [--worktree]
  [--writers N] [--sandbox MODE] [--json]` and `baked workflow estimate [WORKFLOW]` with the same flags. `baked doctor` is an
  alias of `baked workflow doctor`. Both run without opening the run database for writing, like
  `workflow route`, and the doctor works when workflows are disabled (that is its first finding).
- Local core API (follow-up once `feature/core-api` is on main): `GET /v1/workflow/doctor` and `GET /v1/workflow/estimate` with query parameters
  `workflow`, `model`, `route` (`stage=ref,...`), `worktree`, `writers`. Policy files are a CLI concern;
  the API uses the configured policy. Both return the JSON report with 200; a definition that does not
  load is a `fail` line in the doctor and a 400 from the estimate.

## Decisions taken by default

- The doctor never runs check commands; it resolves them.
- Budget overruns are warnings, never failures.
- Dollar figures are labelled approximate and stay advisory; `maxCostUsd` stays disabled.
- No tool-calling capability check until the model catalog has a reliable flag.

## Tests

- Doctor: each check's ok/warn/fail path with injected deps; `ready` false on any fail; skips after a
  failed definition; CLI exit code 1.
- Estimate: definition-driven stage list (quick-fix has no research), same-workflow preference and
  per-stage fallback, models attached from routing overrides, USD from known prices, unknown price →
  `costComplete` false, default and history mix, budget `fits`.
- API: both endpoints return the reports and reject bad query parameters.

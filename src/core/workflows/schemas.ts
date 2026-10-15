/** Workflow v1 contracts. */
import { z } from "zod";
import { RouteEffort } from "../llm/model-routing.js";
import { DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES } from "./candidates.js";
import { LibraryDocsSchema } from "./library-docs.js";

export const SafeId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes(":") &&
      [...p].every((character) => character.charCodeAt(0) >= 32) &&
      p.split("/").every((part) => part !== ".." && part !== "." && part !== ""),
    "Expected a canonical relative POSIX path",
  );
const Text = z.string().min(1).max(16000);
const RequirementId = z.string().regex(/^(FR|NFR|SC)-[0-9]{3,6}$/);
const CriterionId = z.string().regex(/^AC-[0-9]{3,6}$/);
const TaskId = z.string().regex(/^T[0-9]{3,6}$/);
const Semver = z.string().regex(/^\d+\.\d+\.\d+$/);
const UniqueStrings = z.array(z.string().min(1)).refine((xs) => new Set(xs).size === xs.length);

export const SpecSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    revision: z.number().int().positive(),
    title: Text,
    problem: Text,
    outcome: Text,
    inScope: z.array(Text).min(1),
    outOfScope: z.array(Text),
    assumptions: z.array(Text),
    openQuestions: z.array(
      z.object({ id: SafeId, question: Text, blocking: z.boolean() }).strict(),
    ),
    requirements: z
      .array(
        z
          .object({
            id: RequirementId,
            text: Text,
            priority: z.enum(["must", "should"]),
            verification: z.enum(["automated", "manual", "post-release"]),
            sourceRefs: z.array(Text),
          })
          .strict(),
      )
      .min(1),
    criteria: z
      .array(
        z
          .object({
            id: CriterionId,
            requirementIds: z.array(RequirementId).min(1),
            given: Text,
            when: Text,
            // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the versioned acceptance-criterion contract.
            then: Text,
            method: z.enum(["automated", "manual", "post-release"]),
            /**
             * The input domain over which the behavior must hold, for a property-based test
             * (quality/properties.ts); absent for an example criterion.
             */
            property: z
              .enum(["numbers", "strings", "parsing", "round-trip", "invariant"])
              .optional(),
          })
          .strict(),
      )
      .min(1),
    dependencies: z.array(z.object({ featureId: SafeId, contractHash: Hash }).strict()),
    /**
     * The request's deliverables in its own words, each covered by requirements or left out by
     * the request's own words (see request-coverage.ts). Optional, so specs stored before it keep
     * their hashes.
     */
    deliverables: z
      .array(
        z
          .object({
            quote: Text,
            requirementIds: z.array(RequirementId),
            outOfScope: Text.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const TaskSchema = z
  .object({
    id: TaskId,
    title: Text,
    description: Text,
    requirementIds: z.array(RequirementId).min(1),
    criterionIds: z.array(CriterionId).min(1),
    dependsOn: z.array(TaskId),
    profileId: SafeId,
    writes: z.array(
      z
        .object({
          path: RelativePath,
          action: z.enum(["create", "modify", "delete"]),
          /**
           * Why the task changes or deletes a test file that existed before the run. Without it
           * the test-integrity guard keeps such a file read-only for the implementer. Absent on
           * every other write, so stored graphs keep their hash.
           */
          reason: Text.optional(),
        })
        .strict(),
    ),
    readHints: z.array(RelativePath),
    /**
     * An existing file that shows the pattern the task's code should follow (structure, naming,
     * error handling, test style). The implementer reads it first; reviewers may cite divergence.
     */
    reference: RelativePath.optional(),
    checkIds: z.array(SafeId),
    origin: z.enum(["planned", "repair", "convergence"]),
    findingIds: z.array(SafeId),
    rationale: Text,
  })
  .strict();

export const TaskGraphSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    revision: z.number().int().positive(),
    specHash: Hash,
    planHash: Hash,
    tasks: z.array(TaskSchema).min(1).max(500),
  })
  .strict();

export const CheckSchema = z
  .object({
    id: SafeId,
    executable: z.string().min(1).max(512),
    args: z.array(z.string().max(2048)),
    cwd: z.union([z.literal("."), RelativePath]),
    timeoutMs: z.number().int().min(1000).max(3600000),
    required: z.boolean(),
    scope: z.enum(["task", "feature"]),
    envNames: UniqueStrings,
    writes: z.array(RelativePath),
    /**
     * A fixer for what the check reports, such as `ruff check --fix` or `biome check --write`.
     * Implementers run it on their task's files with `apply_fix`; the file path is appended.
     */
    fix: z
      .object({ executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)) })
      .strict()
      .optional(),
    /**
     * A second fixer tier run after `fix` on the same files, for fixes the tool marks unsafe
     * (`biome check --write --unsafe`), limited to what the project allows. Used only with `fix`.
     */
    fixUnsafe: z
      .object({ executable: z.string().min(1).max(512), args: z.array(z.string().max(2048)) })
      .strict()
      .optional(),
    /**
     * `json`: the command prints a JSON report (`status`, `summary`, `findings`) as its last JSON
     * line and that report decides the result; without one the check is inconclusive. Absent means
     * the exit code decides.
     */
    report: z.enum(["exit", "json"]).optional(),
  })
  .strict();

/**
 * Opt-in approval without a person (workflow v2 design, section 5.2). Frozen with the policy, so
 * it is part of the approval digest. `renewal` re-approves a revised package that stays within
 * the last human approval of the run; `limits` approves a package inside the stated bounds.
 */
export const AutoApprovalSchema = z
  .object({
    renewal: z.boolean(),
    limits: z
      .object({
        maxTasks: z.number().int().min(1).max(500),
        maxFiles: z.number().int().min(1).max(500),
        allowedPaths: z.array(z.string().min(1).max(512)).min(1),
        allowDelete: z.boolean(),
        allowNewDependencies: z.literal(false),
        maxTotalTokens: z.number().int().min(1000),
      })
      .strict()
      .nullable(),
    /**
     * Opt-in: a package that leaves the limits only by its task count, file count or paths goes
     * to the `approval-reviewer` profile, which may approve a low-risk one. Everything else, and
     * any reviewer failure, still waits for a person.
     */
    modelReview: z.boolean().optional(),
    /**
     * Opt-in (#1229): an edit of an existing package manifest that the dependency check reads
     * (package.json, pyproject.toml, requirements*.txt, Cargo.toml, go.mod, .csproj/.fsproj/.vbproj,
     * pom.xml) and that the request names by path or file name no longer needs a person. A package
     * the edit adds still blocks the run unless the request or spec names it (#802).
     */
    requestedManifestEdits: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.renewal || value.limits !== null, "Auto approval requires limits")
  .refine(
    (value) => !value.modelReview || value.limits !== null,
    "Model review of approvals requires limits",
  );

/** What the `approval-reviewer` profile returns for a package auto approval declined. */
export const ApprovalReviewSchema = z
  .object({
    verdict: z.enum(["approve", "escalate"]),
    risk: z.enum(["low", "medium", "high"]),
    reasons: z.array(z.string().min(1).max(2000)).min(1).max(10),
  })
  .strict();
export type ApprovalReview = z.infer<typeof ApprovalReviewSchema>;

/** The review confidence a finding needs to start a correction when the policy does not say. */
export const DEFAULT_REVIEW_MIN_CONFIDENCE = 0.8;

/** Upper bound of `maxConcurrentWriters`. */
export const MAX_CONCURRENT_WRITERS = 4;

/** Repair rounds that repeat the same failures before a fresh-context correction (see the policy). */
export const DEFAULT_FRESH_RESTART_AFTER = 2;
/** Corrections in a row a task's own failed checks may start before the run stops (#839). */
export const DEFAULT_MAX_TASK_REPAIRS = 2;
export const PolicySchema = z
  .object({
    maxConcurrentReadAgents: z.number().int().min(1).max(8),
    /**
     * Tasks implemented at the same time, each in its own worktree. More than one needs
     * `executionMode: "worktree"`; the run start refuses it otherwise. Stored policies carry 1.
     */
    maxConcurrentWriters: z.number().int().min(1).max(MAX_CONCURRENT_WRITERS),
    maxAgentSteps: z.number().int().min(1).max(100),
    maxAgentCalls: z.number().int().min(1).max(1000),
    maxTotalTokens: z.number().int().min(1000),
    /** Token cap for one agent attempt (one task or stage call); defaults at runtime. */
    maxAttemptTokens: z.number().int().min(1000).optional(),
    maxActiveMs: z.number().int().min(1000),
    maxCostUsd: z.number().positive().nullable(),
    /**
     * Soft checkpoints: when set, the run pauses for a decision each time it would spend past the
     * next multiple of this many tokens. Used with an uncapped token limit (see UNCAPPED_TOKENS).
     */
    checkpointTokens: z.number().int().min(10000).nullable().default(null),
    maxRepairRounds: z.number().int().min(0).max(5),
    maxConvergenceRounds: z.number().int().min(0).max(5),
    maxCorrectiveTasks: z.number().int().min(0).max(100),
    scopeApproval: z.literal("required"),
    reviewProfiles: z
      .object({ correctness: SafeId, security: SafeId, language: SafeId.nullable() })
      .strict(),
    skepticProfileId: SafeId,
    forceSecurityReview: z.boolean(),
    /**
     * What an edit that introduces errors in the edited file or a file importing it does during
     * the run: `feedback` returns the errors, `reject` also restores the file. Absent means
     * `feedback`, so stored policies keep their hash; a run takes `reject` from the project's
     * `editDiagnostics` setting when the policy does not name it (start.ts).
     */
    editDiagnostics: z.enum(["feedback", "reject"]).optional(),
    /**
     * Where implementers get docs for the locked versions of the libraries a task uses (#741):
     * the configured `libraryDocs` source, frozen at start. Absent means no docs, so stored
     * policies keep their hash.
     */
    libraryDocs: LibraryDocsSchema.optional(),
    /**
     * Record and replay of model calls (#856, model-recording.ts): `record` stores each call of
     * the native executor in the run; `replay` names a recording file whose answers stand in for
     * the provider until the first request that differs. Absent means neither, so stored policies
     * keep their hash.
     */
    modelCalls: z
      .object({ record: z.boolean().optional(), replay: z.string().min(1).max(4096).optional() })
      .strict()
      .optional(),
    allowedTools: UniqueStrings,
    network: z.enum(["deny", "ask", "allow"]),
    checks: z.array(CheckSchema),
    autoApproval: AutoApprovalSchema.nullable().optional(),
    /**
     * How analysis findings revise the spec and the plan (#1058, revision-patch.ts): `patch` asks
     * the author for edit operations on the current artifact when at most five findings block,
     * and falls back to writing it again when the patch does not apply or validate. Absent means
     * `regenerate`, so stored policies keep their hash.
     */
    revision: z.enum(["regenerate", "patch"]).optional(),
    /**
     * What a blocking question of research, spec or analysis does. Absent means `ask`: the run
     * waits for a person, as before this field existed, so stored policies keep their hash.
     * `assume` returns the question to its agent to settle with a recorded default first; only
     * questions without a safe default reach a person (see clarification.ts).
     */
    clarification: z.enum(["ask", "assume"]).optional(),
    /**
     * `false` leaves out project memory: answers, approved assumptions and passing checks of
     * earlier runs that research, specification and planning otherwise read (project-memory.ts).
     * Absent means on, so stored policies keep their hash.
     */
    projectMemory: z.boolean().optional(),
    /**
     * How a required static check (linter, formatter, type checker) that already failed before
     * the run is judged (#1222). Absent means `stop`: a failure the run did not change stops it
     * with `baseline_failure`. `relative` passes the check when every diagnostic it reports was
     * in the baseline run and none is in a file the run may change (task-end-check.ts
     * `baselineDebt`), so lint debt elsewhere in the repository does not block a run.
     */
    staticBaseline: z.enum(["stop", "relative"]).optional(),
    /**
     * What the test-integrity guard does with what it finds in a task's diff (test-integrity.ts):
     * `block` makes each finding a repair, `warn` records it only. Absent means `block`; only
     * `warn` is stored, so stored policies keep their hash.
     */
    testIntegrity: z.enum(["block", "warn"]).optional(),
    /**
     * Tests first (tests-first.ts): `criteria` writes a failing test task for every automated
     * criterion before any code, `all` for every criterion; a person approves the tests and the
     * code is implemented until they pass. Absent means `off`, so stored policies keep their hash;
     * a definition's `testsFirst` (the `tdd` and `full` presets) overrides it at start.
     */
    testsFirst: z.enum(["off", "criteria", "all"]).optional(),
    /**
     * Review findings whose confidence is below this are notes and start no correction. Absent
     * means 0.8 (`DEFAULT_REVIEW_MIN_CONFIDENCE`), so stored policies keep their hash; a run start
     * copies `modelRouting.reviewMinConfidence` here when it is set.
     */
    reviewMinConfidence: z.number().min(0).max(1).optional(),
    /**
     * The critic that scores every task attempt with a rubric (#646): `advise` shows the score
     * and decides nothing, `off` skips it. `select` and `earlyStop` score like `advise` and also
     * decide once the project's outcome log calibrates the critic (critic-calibration.ts):
     * `select` keeps the best-scored attempt of a task, `earlyStop` accepts the remaining
     * convergence findings instead of another repair when every task scores at the threshold and
     * the checks pass. Absent means `advise` when the critic's model is of another vendor than the
     * implementation's, else off, so stored policies keep their hash.
     */
    critic: z.enum(["off", "advise", "select", "earlyStop"]).optional(),
    /**
     * Opt-in (#1239): implementer and acceptance-writer attempts on a Codex model may use Codex's
     * own web search; every other attempt, and every check, test and linter, keeps `network`.
     * Absent means off, so stored policies keep their hash; a run start copies
     * `modelRouting.codeWebSearch: true` here.
     */
    codeWebSearch: z.boolean().optional(),
    /**
     * Best-of-N (#642): how many times each planned task that writes files is implemented, each
     * candidate in its own worktree, before one is selected and integrated (candidates.ts). Needs
     * `executionMode: "worktree"`. Absent means 1, so stored policies keep their hash; a run start
     * takes it from the request, else from the definition's tasks stage.
     */
    candidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(),
    /** The most candidates a run may ask for; absent means `DEFAULT_MAX_CANDIDATES` (4). */
    maxCandidates: z.number().int().min(1).max(MAX_CANDIDATES).optional(),
    /**
     * Best-of-N models (#769): candidate k of a task runs on `candidateModels[k mod n]` instead of
     * the task stage's route, so candidates come from different models. Absent keeps the route.
     */
    candidateModels: z.array(z.string().min(1).max(200)).min(1).max(MAX_CANDIDATES).optional(),
    /**
     * `false` leaves out learned code rules (#643): rules proposed from findings that recurred in
     * earlier runs and activated by recurrence or a person. Absent means on, so stored policies
     * keep their hash.
     */
    learnedRules: z.boolean().optional(),
    /**
     * How many repair rounds in a row may leave the same failures before the next correction
     * starts from a clean context: the spec, the task, the current files and a host-written account
     * of what was tried, without the earlier attempts' evidence. If that attempt fails the same way
     * the run stops. Absent means `DEFAULT_FRESH_RESTART_AFTER`, so stored policies keep their hash.
     */
    freshRestartAfter: z.number().int().min(1).max(5).optional(),
    /**
     * `true` makes the correction of a review or convergence finding about input robustness (deep
     * nesting, huge numbers, long input, invalid encoding, empty input) one task per profile that
     * runs the whole battery of input shapes against every planned source file next to the
     * reported one and may write them (verification/class-sweep.ts, #1160). Absent means off, so
     * stored policies keep their hash.
     */
    classSweep: z.boolean().optional(),
    /**
     * How many corrections in a row a task's own failed checks (a task check, a lint or
     * test-integrity finding during the implement stage) may start: a task and the corrections of
     * its corrections. They are not repair rounds, which count checks-stage and review passes
     * (`maxRepairRounds`). Absent means `DEFAULT_MAX_TASK_REPAIRS`, so stored policies keep their
     * hash.
     */
    maxTaskRepairs: z.number().int().min(0).max(5).optional(),
    /**
     * `note` keeps low review and convergence findings as notes from the first round on: they
     * start no correction unless one is why an automated criterion fails. Absent means `repair`, so
     * stored policies keep their hash.
     */
    lowFindings: z.enum(["repair", "note"]).optional(),
    /**
     * `on` starts a correction whose findings are all low, or all point at one file, with a quick
     * fix: one attempt with a small step and token cap on the files the findings name. When it
     * does not finish the fix, the correction continues with the usual budget and all its files.
     * Absent means `off`, so stored policies keep their hash.
     */
    quickFix: z.enum(["off", "on"]).optional(),
    /**
     * Whether analyze, review and converge get a digest of a large spec, with each criterion in
     * full behind `read_criterion` (spec-digest.ts). Absent means `auto`: a spec above
     * SPEC_DIGEST_BYTES is digested, a smaller one is sent whole. `off` always sends it whole.
     */
    specDigest: z.enum(["auto", "off"]).optional(),
    /**
     * The duplication and dead-code ratchet (quality/duplication.ts). Absent means `warn`: copies
     * and unused declarations the run adds are reported, never blocking, so stored policies keep
     * their hash. `ratchet` makes them blocking findings; `off` skips the measurement.
     */
    duplication: z.enum(["off", "warn", "ratchet"]).optional(),
    /**
     * Semgrep on the run's diff (quality/sast.ts). Absent means `auto`: it runs when Semgrep is
     * installed, so stored policies keep their hash. `sastConfig` is the Semgrep `--config`
     * (absent: `p/default`).
     */
    sast: z.enum(["auto", "off"]).optional(),
    sastConfig: z.string().min(1).max(512).optional(),
    /**
     * `false` keeps the dependency check (quality/dependencies.ts) from looking packages up in
     * their registries; every new dependency is then inconclusive. Absent means lookups.
     */
    registryLookups: z.literal(false).optional(),
    /**
     * The mutation gate (quality/mutation.ts): `advisory` notes the mutants the run's tests do
     * not kill, `required` makes them blocking findings, `off` skips the gate. Absent means the
     * default of the workflow's preset (`advisory` for `full`, `off` for the others), so stored
     * policies keep their hash. `mutationThresholds` lowers the killed share a file needs under
     * `required` (path or glob to percent, default 100); `mutationBudgetMs` caps the gate's time.
     */
    mutation: z.enum(["off", "advisory", "required"]).optional(),
    /**
     * Property-based tests from criteria the spec marks with `property` (quality/properties.ts):
     * `auto` asks the agents for them and checks each marked criterion has one; `off` does
     * neither. Absent means the preset's default (`auto` for `standard` and `full`).
     */
    propertyTests: z.enum(["auto", "off"]).optional(),
    mutationThresholds: z
      .record(z.string().min(1).max(512), z.number().int().min(0).max(100))
      .optional(),
    mutationBudgetMs: z.number().int().min(10_000).max(3_600_000).optional(),
    /**
     * `built-in` keeps the mutation gate on its own operators even when the project has an
     * ecosystem tool (quality/mutation-tools.ts); `auto` runs the installed tool. Absent means
     * `auto`, so stored policies keep their hash.
     */
    mutationEngine: z.enum(["auto", "built-in"]).optional(),
    /**
     * The project's choices for the anti-slop rule pack (quality/rules.ts), which is always on:
     * rules turned off, severities changed and ast-grep rule files added. Absent means the
     * built-in pack as shipped, so stored policies keep their hash.
     */
    qualityRules: z
      .object({
        disabled: z.array(z.string().min(1).max(128)).max(200).optional(),
        severity: z.record(z.string().min(1).max(128), z.enum(["error", "warning"])).optional(),
        files: z.array(RelativePath).max(32).optional(),
      })
      .strict()
      .optional(),
    /**
     * Directories the applications of the run's AI acceptance gates may write. Like the outputs
     * of checks they are left out of source snapshots. Absent when no such gate grants writes.
     */
    acceptanceWrites: z.array(RelativePath).max(16).optional(),
    /**
     * Where the run edits files. Absent means `inline`: the project working copy, as before this
     * field existed, so stored policies keep their hash. `worktree` runs the tasks in the Git
     * worktree `.baked/worktrees/RUN_ID/main` on the branch `baked/wf/RUN_ID`. Part of the policy,
     * so the approval digest covers it.
     */
    executionMode: z.enum(["inline", "worktree"]).optional(),
    /**
     * OS sandbox of the run's check, fixer, probe, repro and acceptance processes. Absent means
     * off, so stored policies keep their hash. Network inside it follows `network`: only `allow`
     * grants it. See docs/sandbox.md.
     */
    sandbox: z.enum(["auto", "required"]).optional(),
    /**
     * Lets independent tasks of one batch write the same path; their results are integrated
     * through an integrator task. Absent means false, so stored policies keep their hash.
     */
    allowOverlappingWrites: z.boolean().optional(),
    /**
     * Plan-time sizing (see sizing.ts). Absent means off, so stored policies keep their hash.
     * `maxAttemptTokens` caps a sized task attempt; `maxRunTokens` is the budget the run may grow
     * to on its own once the plan is priced, and above it the feature must be split;
     * `historyStores` are other workflow stores (a `.sqlite` path or a project directory) whose
     * finished runs calibrate the price. `testTaskSteps` is the step cap of a task that writes only
     * tests (32 by default), above the profile's and `maxAgentSteps`: tests need more steps than
     * code for the same number of files.
     */
    sizing: z
      .object({
        maxAttemptTokens: z.number().int().min(10_000).optional(),
        maxRunTokens: z.number().int().min(10_000).nullable().optional(),
        /**
         * Hard ceiling above `maxRunTokens` that a run under `clarification: "assume"` may grow
         * to without a person while it still makes progress (see `extendUnderAssume`).
         */
        extendToTokens: z.number().int().min(10_000).optional(),
        historyStores: z.array(z.string().min(1)).max(32).optional(),
        testTaskSteps: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ExecutionMode = "inline" | "worktree";
export type ClarificationMode = "ask" | "assume";
/** What a blocking question does under a policy; a policy without the field asks a person. */
export const clarificationOf = (policy: { clarification?: ClarificationMode | undefined }) =>
  policy.clarification ?? "ask";
/** The execution mode of a policy; a policy without the field runs inline. */
export const executionModeOf = (policy: { executionMode?: ExecutionMode | undefined }) =>
  policy.executionMode ?? "inline";
/**
 * Why a policy's writer settings are invalid, or null. Several writers and overlapping writes
 * need worktree execution: each writer edits its own worktree, never the working copy.
 */
export function writerPolicyProblem(policy: {
  executionMode?: ExecutionMode | undefined;
  maxConcurrentWriters: number;
  allowOverlappingWrites?: boolean | undefined;
  candidates?: number | undefined;
  maxCandidates?: number | undefined;
}): string | null {
  const most = policy.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  if ((policy.candidates ?? 1) > most)
    return `candidates ${String(policy.candidates)} is above maxCandidates ${String(most)}`;
  if (executionModeOf(policy) === "worktree") return null;
  if (policy.maxConcurrentWriters > 1)
    return "maxConcurrentWriters above 1 needs worktree execution (workflow run --worktree)";
  if ((policy.candidates ?? 1) > 1)
    return "candidates above 1 needs worktree execution (workflow run --worktree)";
  if (policy.allowOverlappingWrites)
    return "allowOverlappingWrites needs worktree execution (workflow run --worktree)";
  return null;
}

/**
 * Per-profile compaction of replayed tool output. `keepRecent` tool-result messages stay verbatim;
 * compaction starts once the attempt has spent `startAtTokens`, or `startAtShare` of its token
 * cap, and stays on for the rest of the attempt. Without a start it runs from the first step.
 */
export const ProfileCompactionSchema = z
  .object({
    keepRecent: z.number().int().min(1).max(20).optional(),
    startAtTokens: z.number().int().min(1000).max(10_000_000).optional(),
    startAtShare: z.number().gt(0).max(1).optional(),
  })
  .strict()
  .refine((value) => value.startAtTokens === undefined || value.startAtShare === undefined, {
    message: "Set startAtTokens or startAtShare, not both",
  });
export type ProfileCompaction = z.infer<typeof ProfileCompactionSchema>;

export const ProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafeId,
    version: Semver,
    description: Text,
    role: z.enum([
      "researcher",
      "spec-author",
      "planner",
      "implementer",
      "reviewer",
      "spec-auditor",
      "reporter",
      "acceptance-walker",
      "acceptance-writer",
    ]),
    model: z.string().min(1),
    context: z.enum([
      "research",
      "specification",
      "planning",
      "implementation",
      "review",
      "convergence",
    ]),
    instructions: Text,
    skills: z.array(z.object({ id: SafeId, hash: Hash }).strict()),
    allowedTools: UniqueStrings,
    output: z.enum([
      "research",
      "spec",
      "plan",
      "analysis",
      "implementation",
      "review",
      "convergence",
      "refutation",
      "report",
      "acceptance",
      "acceptance-draft",
      "initiativePlan",
      "approval-review",
      "critique",
      "mutants",
      "distinction",
      "revision",
    ]),
    maxSteps: z.number().int().min(1).max(100),
    maxOutputTokens: z.number().int().min(256).max(65536),
    /** Reasoning effort when the profile's model route sets none (#334). */
    effort: RouteEffort.optional(),
    /** When an attempt starts compacting older tool output (#334); unset keeps the runtime default. */
    compaction: ProfileCompactionSchema.optional(),
  })
  .strict();

export const StageKind = z.enum([
  "research",
  "specify",
  "plan",
  "analyze",
  "approve",
  "task-graph",
  "checks",
  "review",
  "converge",
  "learn",
]);
export const WorkflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: SafeId,
    version: Semver,
    description: Text,
    stages: z
      .array(
        z
          .object({
            id: SafeId,
            kind: StageKind,
            profileId: SafeId.optional(),
            repairTo: SafeId.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict();

export const RunStatus = z.enum([
  "created",
  "running",
  "waiting",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export const StepStatus = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "interrupted",
  "skipped",
  "invalidated",
]);
/**
 * Why a task step ended `interrupted` (#843): a restart in a fresh session, a continuation at its
 * step cap, a correction widened to its whole scope, a wait for a file a later task writes, a
 * spec conflict, or a worker or worktree lease that was lost.
 */
export const InterruptCause = z.enum([
  "restart",
  "continue_at_cap",
  "widened_correction",
  "waits_for_artifact",
  "spec_conflict",
  "worker_lost",
  "lease_lost",
]);
export type InterruptCause = z.infer<typeof InterruptCause>;
export const TaskStatus = z.enum([
  "pending",
  "running",
  "implemented",
  "verified",
  "blocked",
  "failed",
  "cancelled",
  "invalidated",
  "interrupted",
]);
export const ReasonCode = z.enum([
  "clarification",
  "approval",
  "manual_evidence",
  "user_pause",
  "owner_lost",
  "step_stalled",
  "input_changed",
  "workspace_busy",
  "budget_exhausted",
  "attempt_cap",
  "checkpoint",
  "no_progress",
  "verification_failed",
  "check_unavailable",
  "provider_unavailable",
  "provider_account",
  "tool_denied",
  "storage_failure",
  "invalid_output",
  "host_state",
  "interrupted_effect",
  "dependency_failed",
  "replay_diverged",
  "none",
]);

/** A reproducible example a review finding attaches to a claim about behavior (#155). */
export const ReproSchema = z
  .object({
    executable: z.string().min(1).max(512),
    args: z.array(z.string().max(4096)).max(32),
    expected: z.string().min(1).max(2000),
    actual: z.string().min(1).max(2000),
  })
  .strict();
export type Repro = z.infer<typeof ReproSchema>;

/** A program a repair task runs to look at behavior; it has no claim to judge. */
export const ProbeSchema = z
  .object({
    executable: z.string().min(1).max(512),
    args: z.array(z.string().max(4096)).max(32),
  })
  .strict();

export const ReviewSchema = z
  .object({
    schemaVersion: z.literal(1),
    snapshotHash: Hash,
    verdict: z.enum(["pass", "changes_requested", "inconclusive"]),
    coverage: z.array(
      z
        .object({
          criterionId: CriterionId,
          verdict: z.enum(["pass", "fail", "inconclusive", "deferred"]),
          evidenceIds: z.array(SafeId),
          explanation: Text,
        })
        .strict(),
    ),
    findings: z
      .array(
        z
          .object({
            id: SafeId,
            kind: z.enum([
              "correctness",
              "security",
              "missing",
              "partial",
              "contradicts",
              "unrequested",
            ]),
            severity: z.enum(["critical", "high", "medium", "low"]),
            /**
             * `spec` when the request, a requirement or a criterion names the behavior or input that
             * fails; `inferred` when the finding comes from a standard, convention or general
             * robustness the spec does not name. Inferred findings are notes unless they are
             * security findings or critical. A finding without a basis counts as `spec`.
             */
            basis: z.enum(["spec", "inferred"]).optional(),
            /**
             * How sure the reviewer is that the finding is real and introduced by this change, 0
             * to 1. Below the run's `reviewMinConfidence` the finding is a note. Absent counts as 1.
             */
            confidence: z.number().min(0).max(1).optional(),
            /**
             * A command that shows the claimed behavior: it prints `actual` on a line of its
             * output where the spec requires `expected`. The runtime runs it before the finding
             * starts a correction; a finding whose repro does not print `actual` is a note.
             */
            repro: ReproSchema.optional(),
            /**
             * Why no command can show a correctness finding (for example it is about concurrency,
             * a platform the workspace cannot run, or wording). A correctness finding without a
             * repro and without this reason is unverified.
             */
            noRepro: Text.optional(),
            /**
             * The id of an earlier finding of the run that this one repeats (the same defect, even
             * when the file, symbol or wording changed), or null for a new defect. Absent means the
             * reviewer did not say, and the host compares locations instead.
             */
            repeatOf: SafeId.nullable().optional(),
            requirementIds: z.array(RequirementId),
            criterionIds: z.array(CriterionId),
            file: RelativePath.nullable(),
            symbol: z.string().nullable(),
            evidenceIds: z.array(SafeId).min(1),
            claim: Text,
            impact: Text,
            suggestedFix: Text,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

/**
 * One item of the rubric a critic scores a task attempt on (#646): 0 is bad, 1 good. The items:
 * the attempt understood the intent, followed the instructions, stayed in scope, did not game the
 * tests, and implemented the task completely.
 */
const RubricItem = z.object({ score: z.number().min(0).max(1), note: Text }).strict();
/**
 * A critic's score of one task attempt: advice shown in the run, not a gate. `score` is the
 * critic's estimate that the attempt is correct and will be kept as it is.
 */
/**
 * A test that tells best-of-N finalists apart (#769): a program the run's checks start and its
 * arguments, and the line the spec requires it to print. A finalist whose output shows `expected`
 * keeps its place.
 */
export const DistinctionSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskId,
    executable: z.string().min(1).max(512),
    args: z.array(z.string().max(4096)).max(32),
    expected: z.string().min(1).max(2000),
    criterionIds: z.array(CriterionId),
    rationale: Text,
  })
  .strict();
export type Distinction = z.infer<typeof DistinctionSchema>;

export const CritiqueSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskId,
    score: z.number().min(0).max(1),
    rubric: z
      .object({
        intent: RubricItem,
        instructions: RubricItem,
        scope: RubricItem,
        testIntegrity: RubricItem,
        completeness: RubricItem,
      })
      .strict(),
    summary: Text,
  })
  .strict();
export type Critique = z.infer<typeof CritiqueSchema>;
/**
 * Mutants an agent proposes for the mutation gate (#702): each changes one line the run added
 * so that the criterion it targets would break. The host checks each one against the file.
 */
export const MutantProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    mutants: z
      .array(
        z
          .object({
            criterionId: CriterionId,
            file: z.string().min(1).max(512),
            line: z.number().int().min(1),
            original: z.string().min(1).max(2000),
            mutated: z.string().max(2000),
            rationale: Text,
          })
          .strict(),
      )
      .max(24),
  })
  .strict();
export type MutantProposal = z.infer<typeof MutantProposalSchema>;

export const ImplementationSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskId,
    /**
     * `spec_conflict`: the spec and the tests (or the criteria) cannot both hold. The task stops
     * without fitting the tests and the run asks a person which one is right.
     */
    outcome: z.enum(["implemented", "already_satisfied", "blocked", "failed", "spec_conflict"]),
    summary: Text,
    evidenceIds: z.array(SafeId),
    unresolved: z.array(Text),
  })
  .strict();

export const ResearchSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: Text,
    facts: z.array(z.object({ statement: Text, paths: z.array(RelativePath) }).strict()),
    unknowns: z.array(z.object({ question: Text, blocking: z.boolean() }).strict()),
    constraints: z.array(Text),
    suggestedScope: z.array(Text),
  })
  .strict();
/** The written result of a Spike: findings and a recommendation, never a code change. */
export const ReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: Text,
    findings: z
      .array(z.object({ title: Text, detail: Text, paths: z.array(RelativePath) }).strict())
      .max(50),
    recommendation: z
      .object({
        kind: z.enum(["proceed", "do-not-proceed", "research-more", "needs-decision"]),
        text: Text,
      })
      .strict(),
    openQuestions: z.array(Text).max(20),
  })
  .strict();
export const PlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    markdown: z.string().min(1).max(240000),
    taskGraph: TaskGraphSchema,
  })
  .strict();
export const CorrectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    parentDigest: Hash,
    parentGraphHash: Hash,
    rule: z.literal("bounded-correction"),
    newGraphHash: Hash,
    findingIds: z.array(SafeId).min(1),
    taskIds: z.array(TaskId).min(1),
    roundKind: z.enum(["repair", "review", "convergence"]),
    round: z.number().int().positive(),
  })
  .strict();
export const AnalysisSchema = z
  .object({
    schemaVersion: z.literal(1),
    inputHash: Hash,
    verdict: z.enum(["pass", "needs_revision", "inconclusive"]),
    findings: z
      .array(
        z
          .object({
            id: SafeId,
            kind: z.enum(["ambiguity", "inconsistency", "scope", "coverage"]),
            refs: z.array(z.string().min(1)).min(1),
            description: Text,
            blocking: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const RefutationSchema = z
  .object({
    schemaVersion: z.literal(1),
    findingId: SafeId,
    decision: z.enum(["confirmed", "refuted", "inconclusive"]),
    evidenceIds: z.array(SafeId),
    explanation: Text,
  })
  .strict()
  .refine(
    (r) => r.decision === "inconclusive" || r.evidenceIds.length > 0,
    "A conclusion requires evidence",
  );
/** Git delivery settings: where pull requests are created and which variable holds the token. */
export const DeliveryConfigSchema = z
  .object({
    tokenEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .default("GITHUB_TOKEN"),
    apiUrl: z
      .string()
      .regex(/^https:\/\/[^\s/]+(\/[^\s]*)?$/)
      .default("https://api.github.com"),
  })
  .strict();
/** Runs that may execute in one workspace at once when `workflows.maxParallelRuns` is unset. */
export const DEFAULT_MAX_PARALLEL_RUNS = 2;
export const MAX_PARALLEL_RUNS = 8;
export const WorkflowConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    importsEnabled: z.boolean().default(false),
    defaultWorkflow: SafeId.default("sdd"),
    /** The definition `baked quick` runs; the shipped quick preset when absent. */
    quickWorkflow: SafeId.optional(),
    policy: PolicySchema,
    delivery: DeliveryConfigSchema.optional(),
    /**
     * How many runs may execute in the workspace at once. Only runs in their own worktree execute
     * side by side; inline runs share the working copy and still take turns.
     */
    maxParallelRuns: z.number().int().min(1).max(MAX_PARALLEL_RUNS).optional(),
    /**
     * Deadlines and stall limits (milliseconds): a tool call that never returns, a model attempt
     * with no progress, and how often a stalled run resumes by itself. Defaults in `stall.ts`.
     */
    stall: z
      .object({
        toolTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
        commandToolMs: z.number().int().min(1000).max(14_400_000).optional(),
        stepStallMs: z.number().int().min(10_000).max(14_400_000).optional(),
        maxToolTimeouts: z.number().int().min(1).max(50).optional(),
        autoResumes: z.number().int().min(0).max(20).optional(),
        providerResumes: z.number().int().min(0).max(20).optional(),
        providerWaitMs: z.number().int().min(0).max(3_600_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Workflows are on unless a configuration layer turns them off with `workflows.enabled: false`. */
export function workflowsEnabled(config: { workflows?: { enabled?: boolean } }): boolean {
  return config.workflows?.enabled !== false;
}
export const InputManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    featureId: SafeId,
    workflowHash: Hash,
    policyHash: Hash,
    profileHashes: z.record(SafeId, Hash),
    skillHashes: z.record(SafeId, Hash),
    instructionHashes: z.array(z.object({ source: z.string().min(1), hash: Hash }).strict()),
    constitutionHash: Hash.nullable(),
    specHash: Hash.nullable(),
    planHash: Hash.nullable(),
    rootGraphHash: Hash.nullable(),
    effectiveGraphHash: Hash.nullable(),
    correctionHashes: z.array(Hash),
    baselineSnapshotId: SafeId.nullable(),
    dependencyContracts: z.array(
      z.object({ featureId: SafeId, contractHash: Hash, artifactHash: Hash }).strict(),
    ),
  })
  .strict();

export const EventType = z.enum([
  "run.created",
  "run.state_changed",
  "run.rerouted",
  "stage.started",
  "stage.finished",
  "attempt.started",
  "attempt.finished",
  "attempt.advisory",
  "task.state_changed",
  "artifact.committed",
  "check.finished",
  "finding.recorded",
  "criterion.assessed",
  "request.created",
  "request.decided",
  "effect.reconciled",
  "budget.updated",
  "snapshot.invalidated",
  "transition.taken",
  "gate.finished",
  "wait.progress",
  "acceptance.phase",
  "tool.started",
  "tool.finished",
]);
const EventBase = {
  schemaVersion: z.literal(1),
  eventId: SafeId,
  runId: SafeId,
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
};
export const EventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...EventBase,
      type: z.literal("run.created"),
      payload: z
        .object({ featureId: SafeId, inputHash: Hash, projectId: z.string().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("run.state_changed"),
      payload: z
        .object({
          from: RunStatus,
          to: RunStatus,
          reason: ReasonCode,
          revision: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  // A stopped run continues on other models; the routing artifact holds the full record.
  z
    .object({
      ...EventBase,
      type: z.literal("run.rerouted"),
      payload: z
        .object({
          artifactId: SafeId,
          runModel: z.object({ from: z.string(), to: z.string() }).strict(),
          changes: z
            .array(z.object({ target: z.string(), from: z.string(), to: z.string() }).strict())
            .max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("stage.started"),
      payload: z
        .object({ stepId: SafeId, stageId: SafeId, generation: z.number().int().nonnegative() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("stage.finished"),
      payload: z
        .object({ stepId: SafeId, status: StepStatus, artifactId: SafeId.nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("attempt.started"),
      payload: z
        .object({ attemptId: SafeId, stepId: SafeId, modelId: z.string().nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("attempt.finished"),
      payload: z
        .object({
          attemptId: SafeId,
          status: z.enum(["completed", "failed", "interrupted", "cancelled"]),
          usageComplete: z.boolean(),
          usedTokens: z.number().int().nonnegative().nullable(),
          /** `usedTokens` is an estimate from the request and response sizes (#1057). */
          usageEstimated: z.literal(true).optional(),
          /** Why a failed attempt failed (#1068). */
          error: z.object({ code: z.string().max(64), message: z.string().max(500) }).optional(),
          spend: z
            .object({
              inputTokens: z.number().int().nonnegative(),
              outputTokens: z.number().int().nonnegative(),
              cacheReadTokens: z.number().int().nonnegative(),
              cacheWriteTokens: z.number().int().nonnegative(),
              costUsd: z.number().nonnegative().nullable(),
              effort: z.string().max(40).optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict(),
  // The progress watcher noticed a stuck loop: it steered the attempt once, then stopped it.
  z
    .object({
      ...EventBase,
      type: z.literal("attempt.advisory"),
      payload: z
        .object({
          attemptId: SafeId,
          signal: z.enum(["repeated-reads", "no-edits", "same-failure"]),
          action: z.enum(["steered", "stopped"]),
          detail: z.string().max(500),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("task.state_changed"),
      payload: z
        .object({
          taskId: TaskId,
          from: TaskStatus,
          to: TaskStatus,
          generation: z.number().int().nonnegative(),
          cause: InterruptCause.optional(),
          detail: z.string().max(500).optional(),
          stack: z.string().max(2000).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("artifact.committed"),
      payload: z.object({ artifactId: SafeId, kind: z.string(), hash: Hash }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("check.finished"),
      payload: z
        .object({
          checkId: SafeId,
          evidenceId: SafeId,
          status: z.enum(["passed", "failed", "inconclusive"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("finding.recorded"),
      payload: z.object({ findingId: SafeId, artifactId: SafeId }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("criterion.assessed"),
      payload: z
        .object({
          criterionId: CriterionId,
          snapshotId: SafeId,
          verdict: z.enum(["pass", "fail", "inconclusive", "deferred"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("request.created"),
      payload: z
        .object({
          requestId: SafeId,
          kind: z.enum([
            "approval",
            "clarification",
            "manual_evidence",
            "recovery",
            "checkpoint",
            "delivery",
            "convergence",
          ]),
          digest: Hash,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("request.decided"),
      payload: z
        .object({
          requestId: SafeId,
          status: z.enum(["accepted", "rejected", "superseded"]),
          actor: z.enum(["user", "system-invalidation", "auto-approval"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("effect.reconciled"),
      payload: z
        .object({
          effectId: SafeId,
          status: z.enum(["applied", "unknown", "reconciled", "failed"]),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("budget.updated"),
      payload: z
        .object({
          usedTokens: z.number().int().nonnegative(),
          reservedTokens: z.number().int().nonnegative(),
          activeMs: z.number().int().nonnegative(),
          estimatedCostUsd: z.number().nonnegative().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("snapshot.invalidated"),
      payload: z
        .object({
          snapshotId: SafeId,
          reason: z.enum(["input_changed", "source_changed", "evidence_missing", "redacted"]),
        })
        .strict(),
    })
    .strict(),
  // Written only for runs of a schema 2 definition.
  z
    .object({
      ...EventBase,
      type: z.literal("transition.taken"),
      payload: z
        .object({
          transitionId: SafeId,
          from: SafeId,
          to: SafeId,
          outcome: z.enum(["passed", "changes_requested", "failed"]),
          contractHash: Hash.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("gate.finished"),
      payload: z
        .object({
          gateId: SafeId,
          transitionId: SafeId.nullable(),
          mode: z.enum(["required", "advisory"]),
          status: z.enum(["passed", "failed", "inconclusive", "skipped"]),
          attempts: z.number().int().nonnegative(),
          flaky: z.boolean(),
          evidenceId: SafeId.nullable(),
        })
        .strict(),
    })
    .strict(),
  // A wait stage polls its gates: emitted when it starts or resumes and when the gates it still
  // waits for change, not on every poll.
  z
    .object({
      ...EventBase,
      type: z.literal("wait.progress"),
      payload: z
        .object({
          stageId: SafeId,
          deadline: z.iso.datetime(),
          intervalSeconds: z.number().int().positive(),
          pending: z.array(SafeId),
          polls: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  // A phase of an AI acceptance gate (walk, draft, verify, approval, promotion).
  z
    .object({
      ...EventBase,
      type: z.literal("acceptance.phase"),
      payload: z
        .object({
          gateId: SafeId,
          phase: z.enum([
            "walking",
            "walked",
            "drafting",
            "verifying",
            "awaiting_approval",
            "promoted",
            "discarded",
            "inconclusive",
            "unstable",
            "skipped",
          ]),
          detail: z.string().max(2000).nullable(),
        })
        .strict(),
    })
    .strict(),
  // A tool call of an agent attempt, journaled so a stall can be attributed to the call it is in.
  z
    .object({
      ...EventBase,
      type: z.literal("tool.started"),
      payload: z.object({ attemptId: SafeId, tool: z.string().max(128) }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBase,
      type: z.literal("tool.finished"),
      payload: z
        .object({
          attemptId: SafeId,
          tool: z.string().max(128),
          status: z.enum(["ok", "error", "deadline"]),
          durationMs: z.number().int().nonnegative(),
          /** Size of the JSON result handed back to the model, which later steps resend. */
          resultBytes: z.number().int().nonnegative().optional(),
          /** The message of the error a failed call threw, cut to 1000 characters. */
          error: z.string().max(1000).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export type Spec = z.infer<typeof SpecSchema>;
export type TaskGraph = z.infer<typeof TaskGraphSchema>;
export type InputManifest = z.infer<typeof InputManifestSchema>;
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type RunPolicy = z.infer<typeof PolicySchema>;
export type AgentProfile = z.infer<typeof ProfileSchema>;
export type RunState = z.infer<typeof RunStatus>;
export type StageState = z.infer<typeof StepStatus>;
export type Reason = z.infer<typeof ReasonCode>;
export type Review = z.infer<typeof ReviewSchema>;

export interface RunSnapshot {
  runId: string;
  featureId: string;
  status: RunState;
  reason: Reason;
  revision: number;
  eventSeq: number;
  stageId: string | null;
  approvalDigest: string | null;
  inputHash: string;
  workspaceHash: string | null;
  tokenUsage: number;
  activeMs: number;
  estimatedCostUsd: number | null;
  /** The run's dollar cap (`policy.maxCostUsd`); present only when the run has one. */
  maxCostUsd?: number;
  verificationState: "not_verified" | "current" | "stale" | "invalid";
  /**
   * Findings the run is accepted with (known limitations): a completed run with any is not
   * clean. The exit code stays 0.
   */
  limitations: { count: number; ids: string[] };
  /**
   * Review and convergence findings that started no correction (inferred edge cases, findings
   * below the blocking severities, advisory reviews, refuted repros); the run report lists them.
   */
  reviewNotes: { count: number; ids: string[] };
  /**
   * Present while a run is `running` but has journaled nothing for longer than the stall limit:
   * the owner is alive and its work is not advancing.
   */
  stalled?: { silentMs: number; lastEventAt: string | null };
  /**
   * Present while a run blocked with `provider_unavailable` waits for its automatic resume
   * (`workflows.stall.providerResumes`): when it retries, and which resume that is.
   */
  autoRetry?: { at: string; attempt: number; of: number };
  pendingRequestIds: string[];
  /** The project of the run's workspace when it was created. */
  projectId?: string;
}
export type WorkflowEvent = z.infer<typeof EventSchema>;
export interface CommandIdentity {
  commandId: string;
  expectedRevision: number;
}
export interface StartRequest {
  commandId: string;
  workflowId: string;
  featureId: string;
  prompt: string;
  policy: RunPolicy;
  ownerLabel: string;
  /** Model selected for this run; resolved profile models are frozen at start. */
  model?: string;
  /**
   * Upstream contracts an initiative pins for this feature. They replace the spec's dependencies,
   * so the run's readiness checks use exactly these contract hashes.
   */
  dependencies?: { featureId: string; contractHash: string }[];
  /**
   * Hash of the auto approval limits of a v2 definition, typed by the user to turn them on for
   * this run. A definition with an auto approval stage does not start without it.
   */
  autoApprovalConfirmation?: string;
  /**
   * Execution mode requested for this run (CLI `--worktree`). It overrides the policy and the
   * definition; omitted, the definition's `execution`, then the policy's `executionMode` apply.
   */
  executionMode?: ExecutionMode;
  /**
   * OS sandbox requested for this run (CLI `--sandbox MODE`). It overrides the configured mode and
   * the policy; omitted, the stricter of the policy and the configuration applies.
   */
  sandbox?: "off" | "auto" | "required";
  /** Concurrent writers requested for this run (CLI `--writers N`); it overrides the policy. */
  maxConcurrentWriters?: number;
  /** The run's dollar cap (CLI `--max-cost-usd N`); it overrides the policy's `maxCostUsd`. */
  maxCostUsd?: number;
  /**
   * Best-of-N candidates per planned task for this run (CLI `--candidates N`); it overrides the
   * definition's tasks stage and the policy.
   */
  candidates?: number;
  /**
   * The run model overrides the configured model routes for this run (CLI `--model-strict`);
   * without it only the `active` class follows an explicit run model.
   */
  modelStrict?: boolean;
  /** What blocking questions do in this run (CLI `--clarification MODE`); it overrides the policy. */
  clarification?: ClarificationMode;
  /** What the test-integrity guard does in this run (CLI `--test-integrity MODE`); it overrides the policy. */
  testIntegrity?: "block" | "warn";
  /** The duplication ratchet of this run (CLI `--duplication MODE`); it overrides the policy. */
  duplication?: "off" | "warn" | "ratchet";
  /** Semgrep on the run's diff (CLI `--sast MODE`); it overrides the policy. */
  sast?: "auto" | "off";
  /** The mutation gate of this run (CLI `--mutation MODE`); it overrides the policy. */
  mutation?: "off" | "advisory" | "required";
  /** Property-based tests of this run (CLI `--property-tests MODE`); it overrides the policy. */
  propertyTests?: "auto" | "off";
  /**
   * Stage-level model routes for this run (CLI `--route STAGE=MODEL`); they win over
   * `modelRouting.workflows.<id>.stages`. A value starting with `$` names a model class.
   */
  routes?: Record<string, string>;
  /** The GitHub issue the request comes from (CLI `--issue`); the delivery pull request closes it. */
  issue?: { repository: string; number: number; url: string; title: string };
  /**
   * The commit a worktree run's branch starts from instead of HEAD (an initiative feature starts
   * from its upstream features' accepted results). Ignored by an inline run.
   */
  baseCommit?: string;
  /** The proposal of `--auto-preset` and the workflow the run took (`PresetChoice`). */
  presetChoice?: import("./preset-router.js").PresetChoice;
}
export type Decision =
  | {
      requestId: string;
      kind: "approve";
      digest: string;
      /**
       * The explicit choice a worktree approval needs when approved tasks write files with
       * uncommitted user changes: `exclude` starts the worktree from the recorded HEAD without them.
       */
      userChanges?: "exclude";
    }
  | { requestId: string; kind: "reject"; explanation: string }
  | { requestId: string; kind: "continue" }
  | { requestId: string; kind: "accept" }
  | { requestId: string; kind: "answer"; answers: Record<string, string> }
  | {
      requestId: string;
      kind: "manual-evidence";
      criterionId: string;
      evidence: string;
      accepted: boolean;
    }
  | {
      requestId: string;
      kind: "recovery";
      effectId: string;
      resolution: "record-applied" | "record-not-applied" | "retry" | "cancel";
      evidence: string;
    };
export const DecisionSchema: z.ZodType<Decision> = z.discriminatedUnion("kind", [
  z
    .object({
      requestId: SafeId,
      kind: z.literal("approve"),
      digest: Hash,
      userChanges: z.literal("exclude").optional(),
    })
    .strict(),
  z.object({ requestId: SafeId, kind: z.literal("reject"), explanation: Text }).strict(),
  z.object({ requestId: SafeId, kind: z.literal("continue") }).strict(),
  z.object({ requestId: SafeId, kind: z.literal("accept") }).strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("answer"),
      answers: z.record(z.string(), z.string()),
    })
    .strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("manual-evidence"),
      criterionId: CriterionId,
      evidence: Text,
      accepted: z.boolean(),
    })
    .strict(),
  z
    .object({
      requestId: SafeId,
      kind: z.literal("recovery"),
      effectId: SafeId,
      resolution: z.enum(["record-applied", "record-not-applied", "retry", "cancel"]),
      evidence: Text,
    })
    .strict(),
]);
export interface WorkflowService {
  start(request: StartRequest): Promise<RunSnapshot>;
  get(runId: string): Promise<RunSnapshot>;
  list(opts: {
    featureId?: string;
    status?: RunState;
    limit: number;
    cursor?: string;
  }): Promise<{ items: RunSnapshot[]; cursor?: string }>;
  drive(runId: string, signal: AbortSignal): Promise<RunSnapshot>;
  pause(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  cancel(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  resume(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  decide(runId: string, command: CommandIdentity, decision: Decision): Promise<RunSnapshot>;
  revise(runId: string, command: CommandIdentity, candidateHash: string): Promise<RunSnapshot>;
  fork(runId: string, command: CommandIdentity): Promise<RunSnapshot>;
  /** Restores the files the run's uncommitted task edits changed, where nobody changed them since. */
  undo(runId: string, command: CommandIdentity, paths?: string[]): Promise<RunSnapshot>;
  /** Raises the token/call/time limits of a run that stopped on its budget; the run stays paused. */
  extendBudget(
    runId: string,
    command: CommandIdentity,
    limits?: Partial<import("./budget.js").BudgetLimits> & { maxCostUsd?: number },
  ): Promise<RunSnapshot>;
  /** Moves a stopped run to other models from where it stopped; the run keeps its status. */
  reroute(
    runId: string,
    command: CommandIdentity,
    request: import("./routing.js").RerouteRequest,
  ): Promise<RunSnapshot>;
  events(runId: string, afterSeq: number, signal: AbortSignal): AsyncIterable<WorkflowEvent>;
}

export type WorkflowErrorCode =
  | "INVALID_DEFINITION"
  | "INVALID_REFERENCE"
  | "CYCLE_DETECTED"
  | "VERSION_UNSUPPORTED"
  | "REVISION_CONFLICT"
  | "COMMAND_CONFLICT"
  | "STALE_DECISION"
  | "WORKSPACE_BUSY"
  | "INPUT_CHANGED"
  | "CAPABILITY_DENIED"
  | "OUTPUT_INVALID"
  | "BUDGET_EXHAUSTED"
  | "CHECKPOINT_REACHED"
  | "STORAGE_CORRUPT"
  | "ARTIFACT_MISSING"
  | "RECOVERY_REQUIRED"
  | "RUN_TERMINAL"
  | "NOT_FOUND";
export interface WorkflowError {
  code: WorkflowErrorCode;
  message: string;
  runId?: string;
  retryable: boolean;
  details: Record<string, unknown>;
}
export interface ArtifactService {
  read(runId: string, artifactId: string): Promise<{ content: Uint8Array; hash: string }>;
  importCandidate(request: {
    commandId: string;
    source: "spec-kit" | "ecc" | "markdown-edit";
    sourcePath: string;
    featureId: string;
  }): Promise<{ candidateHash: string; warnings: string[]; unsupported: string[] }>;
  stageRevision(
    runId: string,
    request: {
      commandId: string;
      expectedInputHash: string;
      spec?: Spec;
      plan?: string;
      graph?: TaskGraph;
      policy?: RunPolicy;
      /** A revised schema 2 definition for the run (V2-11), and the file it was read from. */
      definition?: unknown;
      definitionPath?: string;
      /** The hash of new auto-approval limits, as a run start asks for it. */
      autoApprovalConfirmation?: string;
    },
  ): Promise<{ candidateHash: string; reportArtifactId: string }>;
  exportRun(runId: string, destination: string): Promise<{ manifestHash: string; path: string }>;
  exportProgress(runId: string): Promise<{ path: string }>;
  gc(request: { before: string; dryRun: boolean }): Promise<{ runIds: string[]; bytes: number }>;
  redact(runId: string, artifactId: string, reason: string): Promise<void>;
}

/**
 * The defects of a spec that no task graph can fix: duplicate IDs, criteria that name unknown
 * requirements, requirements without a criterion or deferred past release. The spec author owns them.
 */
export function validateSpecCoverage(spec: Spec): string[] {
  const errors: string[] = [];
  const requirements = new Set(spec.requirements.map((r) => r.id));
  const criteria = new Set(spec.criteria.map((c) => c.id));
  if (requirements.size !== spec.requirements.length || criteria.size !== spec.criteria.length)
    errors.push("duplicate spec ID");
  for (const c of spec.criteria)
    for (const id of c.requirementIds)
      if (!requirements.has(id)) errors.push(`unknown requirement ${id}`);
  for (const r of spec.requirements) {
    const linked = spec.criteria.filter((c) => c.requirementIds.includes(r.id));
    if (linked.length === 0) errors.push(`requirement without criterion ${r.id}`);
    if (r.verification !== "post-release" && linked.every((c) => c.method === "post-release"))
      errors.push(`engineering requirement deferred ${r.id}`);
  }
  return errors;
}

const REPOSITORY_FILE =
  /\b(?:readme|changelog|license|contributing|dockerfile|makefile)(?:\.\w+)?\b|(?:^|[\s\x60'"(])[\w./-]*\.(?:md|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|env|lock|[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|sh|css|html)\b/im;

// A property of the code ("input is iterated line by line", when "a reviewer inspects it").
const CODE_PROPERTY =
  /\b(?:reviewers?|code review|source code|the code|implementation|(?:inspects?|reads?) the (?:source|module|function|class))\b/i;

/**
 * Criteria about a file of the repository (README text, docs, configuration, source) whose method
 * is manual. A reviewer reads the file and the checks can grep it; only a person can answer a
 * manual request, so the run would wait for someone who just reads the same file (run 2fbac09c,
 * AC-003: 12 hours). A property of the code is the same case: a reviewer passed logslice 242ff843
 * AC-021 three times and converge still asked a person.
 */
export function manualRepositoryCriteria(spec: Spec): string[] {
  return spec.criteria
    .filter((c) => {
      if (c.method !== "manual") return false;
      const text = `${c.given}\n${c.when}\n${c.then}`;
      return REPOSITORY_FILE.test(text) || CODE_PROPERTY.test(text);
    })
    .map((c) => c.id);
}

const OPERATING_SYSTEMS = [/\bwindows\b/i, /\bmac\s?os\b|\bos x\b|\bdarwin\b/i, /\blinux\b/i];
const BROWSERS = [
  /\bchrom(?:e|ium)\b/i,
  /\bfirefox\b/i,
  /\bsafari\b/i,
  /\bedge browser\b|\bmicrosoft edge\b/i,
];
const EVERY_HOST =
  /\bcross[- ](?:platform|browser|os)\b|\b(?:all|every|each) (?:supported )?(?:operating systems?|platforms?|os(?:es)?|browsers?)\b|\b(?:real|physical) (?:device|phone|hardware)s?\b|\bon (?:an? )?(?:iphone|ipad|android (?:phone|device|tablet))s?\b/i;
// A CI matrix file or a simulated platform is evidence one host can read or run.
const HOST_EVIDENCE =
  /\bmatrix\b|\bruns-on\b|\.github\/workflows|\bci workflow\b|\bworkflow file\b|\bpath\.(?:win32|posix)\b|\bsimulat|\bemulat|\bmock/i;

/**
 * Automated criteria that claim behavior on several operating systems, browsers or real devices.
 * A run checks on one host, so no declared check can prove them and convergence can only answer
 * inconclusive (propdrift eea2e0e9 AC-008: "behavior is confirmed on Windows, macOS, and Linux",
 * two convergence calls and a block). A criterion about a CI matrix file or a simulated platform
 * is checkable here and stays.
 */
export function hostBoundCriteria(spec: Spec): string[] {
  return spec.criteria
    .filter((c) => {
      if (c.method !== "automated") return false;
      const text = `${c.given}\n${c.when}\n${c.then}`;
      if (HOST_EVIDENCE.test(text)) return false;
      const count = (patterns: RegExp[]) => patterns.filter((p) => p.test(text)).length;
      return count(OPERATING_SYSTEMS) >= 2 || count(BROWSERS) >= 2 || EVERY_HOST.test(text);
    })
    .map((c) => c.id);
}

/**
 * The spec with every host-bound criterion made checkable instead of sent back to the author: the
 * claim about other platforms stays as a post-release criterion, and a requirement it leaves
 * without a criterion this run can check gets one about what this host proves. A 51 KB spec was
 * written twice over one such criterion (#1015, stmtsplit e29347c1: $1.72 and 128k tokens).
 */
export function repairHostBoundCriteria(spec: Spec): { spec: Spec; repaired: string[] } {
  const repaired = hostBoundCriteria(spec);
  if (!repaired.length) return { spec, repaired };
  const criteria: Spec["criteria"] = spec.criteria.map((c) =>
    repaired.includes(c.id) ? { ...c, method: "post-release" } : c,
  );
  let next = Math.max(0, ...spec.criteria.map((c) => Number(c.id.slice(3)) || 0));
  for (const id of repaired) {
    const original = spec.criteria.find((c) => c.id === id);
    if (!original) continue;
    const uncovered = original.requirementIds.filter(
      (r) => !criteria.some((c) => c.method !== "post-release" && c.requirementIds.includes(r)),
    );
    if (!uncovered.length) continue;
    next += 1;
    criteria.push({
      id: `AC-${String(next).padStart(3, "0")}`,
      requirementIds: uncovered,
      given: original.given,
      when: "the run's checks run on this host",
      // biome-ignore lint/suspicious/noThenProperty: Given/When/Then is the versioned acceptance-criterion contract.
      then: `the code uses platform-neutral path, line-ending and process APIs and the tests pass here (${id} keeps the claim about other platforms for after release)`,
      method: "automated",
    });
  }
  return { spec: { ...spec, criteria }, repaired };
}

// A criterion that the project's build succeeds, or a build command named outright.// A criterion that the project's build succeeds, or a build command named outright.
const BUILD_CLAIM =
  /\b(?:production|release|project|package|app(?:lication)?|the) build (?:succeeds|passes|completes|works|runs)\b|\bbuilds? (?:successfully|cleanly|without (?:errors?|warnings?))\b|\b(?:npm|bun|pnpm|yarn) run build\b|\b(?:cargo|go|dotnet|gradlew?) build\b|\bmvn (?:package|install|verify)\b/i;
/** What a check runs, for the spec checks that compare criteria with the execution contract. */
type CheckCommand = { id: string; executable: string; args: readonly string[] };
// A declared check that builds the project.
const BUILD_CHECK =
  /\b(?:build|bundle|assemble|compile|package)\b|\bmvn\b.*\b(?:verify|install)\b/i;

/**
 * Automated criteria that need a build while no declared check builds the project. Convergence
 * proves a criterion only with the checks of the execution contract, so such a criterion ends
 * inconclusive however the build goes (zoneslot-update fc3e9c49 AC-010: "production build
 * succeeds", the contract had typecheck, lint and tests, and the run noted a false alarm).
 */
export function uncontractedBuildCriteria(spec: Spec, checks: readonly CheckCommand[]): string[] {
  if (checks.some((c) => BUILD_CHECK.test([c.id, c.executable, ...c.args].join(" ")))) return [];
  return spec.criteria
    .filter((c) => c.method === "automated" && BUILD_CLAIM.test(`${c.given}\n${c.when}\n${c.then}`))
    .map((c) => c.id);
}

// A step of how the implementer works: a command run before or after changing the work itself.
const PROCEDURE =
  /\b(?:runs?|ran|executes?|executed|invokes?|invoked)\b[^.;]{0,120}?\b(?:before|prior to|after)\s+(?:any\s+|each\s+|the\s+|existing\s+)*(?:editing|changing|modifying|touching|updating|writing|rewriting|adding)\b[^.;]{0,30}?\b(?:tests?|test files?|the code|source code|implementation)\b|\b(?:intermediate|interim)\s+(?:test\s+)?checkpoint\b/i;

/**
 * Criteria whose subject is how the implementer works ("cargo test is run before editing any
 * test") rather than what the result is. Nothing after the run can observe the order of the
 * implementer's steps, so analysis and review demand it in the plan and tasks without end
 * (#1113: tplfill AC-007, keeplint's checkpoint task). The request still reaches the implementer.
 */
export function procedureCriteria(spec: Spec): string[] {
  return spec.criteria
    .filter((c) => PROCEDURE.test(`${c.given}\n${c.when}\n${c.then}`))
    .map((c) => c.id);
}

const SCOPE_FILLER = new Set(
  "a an the of for to in on and or with any all new its it is be are by as at from this that these those".split(
    " ",
  ),
);
const scopeWords = (line: string): string[] =>
  line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}./-]+/gu, " ")
    .split(" ")
    .map((w) => w.replace(/^[./-]+|[./-]+$/g, "").replace(/(?<=\w{3})s$/, ""))
    .filter((w) => w && !SCOPE_FILLER.has(w));

/**
 * `outOfScope` lines that exclude what an `inScope` line includes: every word of the exclusion is
 * in one inclusion ("CI workflows" against "Add a GitHub Actions CI workflow that runs the checks").
 * cfgtrace b4dc83b2 added a CI workflow to inScope and kept it in outOfScope, and analysis
 * returned the spec for it three times (#1120).
 */
export function contradictoryScope(spec: Pick<Spec, "inScope" | "outOfScope">): string[] {
  const included = spec.inScope.map((line) => new Set(scopeWords(line)));
  return spec.outOfScope.filter((line) => {
    const words = scopeWords(line);
    return words.length > 0 && included.some((set) => words.every((w) => set.has(w)));
  });
}

/** A request that says the limits the spec states must not narrow what it asks for. */
const NON_NARROWING =
  /\bnon[- ]?narrowing\b|\b(?:must|do|does|should|may)\s+not\s+narrow\b|\bwithout\s+narrowing\b/i;
/** A numeric bound on input or output: "more than 50 files", "up to 4,096 characters". */
const NUMERIC_BOUND =
  /\b(?:more than|fewer than|less than|over|above|beyond|exceed(?:s|ing)?|larger than|longer than|greater than|up to|at most|no more than|maximum(?: of)?|limit(?:ed)? (?:of|to)|capped at)\s+~?\d[\d,._]*/i;
/** A criterion sentence that puts inputs beyond a bound outside what the feature handles. */
const EXCLUDES =
  /\b(?:outside|out of scope|not (?:supported|handled|checked|required|guaranteed)|unsupported|rejected|excluded)\b/i;

/**
 * `outOfScope` lines and criteria that state a numeric bound as an exclusion while the request
 * says limits are non-narrowing (keeplint ada519a3: 50 files and 4,096 characters in the first
 * spec, raised by analysis on the fourth return, #1120). Such a domain belongs in the assumptions.
 */
export function narrowingBounds(
  spec: Pick<Spec, "outOfScope" | "criteria">,
  request: string,
): { outOfScope: string[]; criteria: string[] } {
  if (!NON_NARROWING.test(request)) return { outOfScope: [], criteria: [] };
  return {
    outOfScope: spec.outOfScope.filter((line) => NUMERIC_BOUND.test(line)),
    criteria: spec.criteria
      .filter((c) => {
        const text = `${c.given}\n${c.when}\n${c.then}`;
        return NUMERIC_BOUND.test(text) && EXCLUDES.test(text);
      })
      .map((c) => c.id),
  };
}

/** A clause that puts inputs beyond a criterion's domain outside it: "larger inputs are outside this criterion's checked domain". */
const DOMAIN_EXCLUSION =
  /\boutside\b[^.;]*\bdomain\b|\b(?:larger|longer|bigger|greater|deeper|more|higher|wider)\b[^.;]*\b(?:are|is)\s+(?:outside|not covered)\b|\bnot covered\b/i;
const boundNumbers = (text: string): string[] =>
  (text.match(/\d[\d,._]*/g) ?? []).map((n) => n.replace(/[,._]+$/, "").replace(/[,_]/g, ""));

/**
 * Criteria whose Given, When or Then narrow the criterion with a domain exclusion the request does not
 * state. stmtsplit-update cae4291d ended each Given with "...; larger inputs are outside this
 * criterion's checked domain" and no analysis caught it (#1161). A clause is kept when every
 * number it names is in the request, so a bound the request sets may stay.
 */
export function domainExclusions(spec: Pick<Spec, "criteria">, request: string): string[] {
  const requested = new Set(boundNumbers(request));
  return spec.criteria
    .filter((c) =>
      `${c.given}\n${c.when}\n${c.then}`.split(/(?<=[.;\n])\s*/).some((clause) => {
        if (!DOMAIN_EXCLUSION.test(clause)) return false;
        // The bound usually sits in the clause before the exclusion ("up to 20 arguments; larger ...").
        const numbers = boundNumbers(`${c.given}\n${c.when}\n${c.then}`);
        return !numbers.length || numbers.some((n) => !requested.has(n));
      }),
    )
    .map((c) => c.id);
}

/** A size or count unit of input or output: rows, lines, characters, bytes, MiB, digits. */
const SIZE_UNIT =
  "(?:rows?|lines?|files?|characters?|chars?|bytes?|[KMGT]i?B|digits?|entries|entry|items?|records?|columns?|fields?|elements?|arguments?|nodes?|levels?)";
/** A bound phrase with a number and a size unit: "up to 100,000 rows", "1 through 256 characters". */
const SIZE_BOUND = new RegExp(
  `\\b(?:up to|at most|no more than|maximum(?: of)?|max|as many as|limit(?:ed)? (?:of|to)|capped at|through|between \\S+ and)\\s+~?(\\d[\\d,._]*)\\s*${SIZE_UNIT}\\b`,
  "gi",
);

/**
 * Criteria whose Given, When or Then state a size or count bound with a unit that the request
 * never states. expenses-py 617fef26 (bench round 27) wrote "up to 100,000 rows", "source lines
 * up to 1 MiB" and "files up to 100 MiB" into a brief that names no size; reviewers tested those
 * extremes and three correctives (1.63M tokens) chased them until the run blocked (#1227). A bound
 * whose number the request names may stay.
 */
export function inventedBounds(spec: Pick<Spec, "criteria">, request: string): string[] {
  const requested = new Set(boundNumbers(request));
  return spec.criteria
    .filter((c) =>
      [...`${c.given}\n${c.when}\n${c.then}`.matchAll(SIZE_BOUND)].some(
        (match) => !requested.has(boundNumbers(match[1] ?? "")[0] ?? ""),
      ),
    )
    .map((c) => c.id);
}

/**
 * The spec defects as corrections for the spec author, who can add or relink criteria. With the
 * run's checks, a criterion that needs a check the execution contract lacks is one too.
 */
export function specCoverageProblems(
  spec: Spec,
  checks?: readonly CheckCommand[],
  options: { ciForbidden?: boolean; request?: string } = {},
): string[] {
  const bounds = narrowingBounds(spec, options.request ?? "");
  const exclusions = domainExclusions(spec, options.request ?? "").filter(
    (id) => !bounds.criteria.includes(id),
  );
  const invented = inventedBounds(spec, options.request ?? "").filter(
    (id) => !bounds.criteria.includes(id) && !exclusions.includes(id),
  );
  return [
    ...validateSpecCoverage(spec).map((error) =>
      /^(requirement without criterion|engineering requirement deferred) /.test(error)
        ? `${error}: add an acceptance criterion with a non-post-release method that lists this requirement in requirementIds, or mark the requirement post-release.`
        : error,
    ),
    ...manualRepositoryCriteria(spec).map(
      (id) =>
        `criterion ${id} is about a file in the repository or a property of its code but has method manual: use method automated (a test, a command check, or the reviewer reading the file or code), because a person can add nothing a reviewer cannot read there. Keep manual for behavior only a person can observe.`,
    ),
    ...hostBoundCriteria(spec).map(
      (id) =>
        `criterion ${id} is automated but claims behavior on other operating systems, browsers or devices, and the run checks on one host, so nothing can prove it. Rewrite it as what this host can check (platform-neutral path, line-ending and process APIs; the tests pass here).${options.ciForbidden ? " The request wants no CI, so add no CI workflow or platform matrix." : " When the request asks for proof on other platforms, add a criterion that a CI workflow file runs the checks on a matrix of those platforms (for example ubuntu-latest, macos-latest, windows-latest), which the reviewer verifies by reading the file."} Use post-release only for a claim that needs a release or a real device.`,
    ),
    ...procedureCriteria(spec).map(
      (id) =>
        `criterion ${id} describes how the implementer works (a command run before or after changing the work), not what the result is, and nothing after the run can check the order of its steps. Remove it, and the requirement it alone covers; the implementer reads that instruction in the request. Keep a criterion about the result instead, for example that the tests pass.`,
    ),
    ...contradictoryScope(spec).map(
      (line) =>
        `outOfScope line "${line}" excludes what inScope includes: keep each item in one list only. Remove the line from outOfScope when the request asks for the item, or remove the item from inScope (with its requirements, criteria and tasks) when it does not.`,
    ),
    ...bounds.outOfScope.map(
      (line) =>
        `outOfScope line "${line}" states a numeric bound, and the request says limits are non-narrowing. Remove it from outOfScope; record the domain only as an assumption ("<domain> Assumed: <value>, because <reason>."), which does not exclude larger inputs.`,
    ),
    ...bounds.criteria.map(
      (id) =>
        `criterion ${id} puts inputs beyond a numeric bound outside what the feature handles, and the request says limits are non-narrowing. Remove the bound and the exclusion from the criterion; record the domain only as an assumption ("<domain> Assumed: <value>, because <reason>.").`,
    ),
    ...exclusions.map(
      (id) =>
        `criterion ${id} narrows its Given, When or Then with a domain exclusion the request does not state (inputs beyond it "outside this criterion's checked domain" or "not covered"). The request is authoritative: remove the exclusion so the criterion holds for the inputs the request names; a domain you want to keep may be recorded only as a non-narrowing assumption ("<domain> Assumed: <value>, because <reason>."), never as an exclusion.`,
    ),
    ...invented.map(
      (id) =>
        `criterion ${id} states a size or count bound in its Given, When or Then (such as "up to 100,000 rows" or "lines up to 1 MiB") that the request never states, so reviewers test that extreme and the implementation gets repaired for a limit nobody asked for. The request is authoritative: remove the bound so the criterion holds for the inputs the request names. When a test needs a concrete size, record the smallest one the request's own examples need only as an assumption ("<domain> Assumed: <value>, because <reason>."), never in the criterion.`,
    ),
    ...(checks ? uncontractedBuildCriteria(spec, checks) : []).map(
      (id) =>
        `criterion ${id} is automated but needs a build, and no check of executionContract.checks (${checks?.map((c) => c.id).join(", ") || "none"}) builds the project, so convergence cannot prove it. Rewrite it as what those checks prove (the tests or the type check pass) or what the reviewer can read in a file, or use method post-release when the request needs the build itself checked outside this run.`,
    ),
  ];
}

/** Semantic validation supplements schema validation. Runtime must also validate paths against realpath. */
export function validateTaskGraph(spec: Spec, graph: TaskGraph): string[] {
  const errors: string[] = [];
  if (spec.featureId !== graph.featureId) errors.push("feature mismatch");
  const requirements = new Set(spec.requirements.map((r) => r.id));
  const criteria = new Set(spec.criteria.map((c) => c.id));
  errors.push(...validateSpecCoverage(spec));
  const tasks = new Map(graph.tasks.map((t) => [t.id, t]));
  if (tasks.size !== graph.tasks.length) errors.push("duplicate task ID");
  for (const task of graph.tasks) {
    for (const id of task.requirementIds)
      if (!requirements.has(id)) errors.push(`unknown requirement ${id}`);
    for (const id of task.criterionIds)
      if (!criteria.has(id)) errors.push(`unknown criterion ${id}`);
    for (const id of task.criterionIds) {
      const criterion = spec.criteria.find((c) => c.id === id);
      if (criterion && !criterion.requirementIds.some((r) => task.requirementIds.includes(r)))
        errors.push(
          `criterion mapping mismatch ${task.id}/${id}: ${id} verifies ${criterion.requirementIds.join(", ")}, but ${task.id} lists ${task.requirementIds.join(", ") || "no requirements"}`,
        );
    }
    for (const id of task.dependsOn) if (!tasks.has(id)) errors.push(`unknown dependency ${id}`);
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      errors.push(`duplicate dependency ${task.id}`);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) {
      errors.push(`cycle at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of tasks.get(id)?.dependsOn ?? []) visit(dep);
    active.delete(id);
    visited.add(id);
  }
  for (const id of tasks.keys()) visit(id);
  for (const criterion of spec.criteria) {
    if (
      criterion.method !== "post-release" &&
      !graph.tasks.some((t) => t.criterionIds.includes(criterion.id))
    )
      errors.push(`uncovered criterion ${criterion.id}`);
  }
  return errors;
}

export function validateWorkflow(workflow: WorkflowDefinition): string[] {
  const errors: string[] = [];
  const ids = new Set(workflow.stages.map((s) => s.id));
  if (ids.size !== workflow.stages.length) errors.push("duplicate stage ID");
  const kinds = workflow.stages.map((s) => s.kind);
  const required = [
    "research",
    "specify",
    "plan",
    "analyze",
    "approve",
    "task-graph",
    "checks",
    "review",
    "converge",
  ] as const;
  let previous = -1;
  for (const kind of required) {
    const index = kinds.indexOf(kind);
    if (index <= previous || index < 0 || kinds.lastIndexOf(kind) !== index)
      errors.push(`missing, repeated or unordered ${kind}`);
    previous = index;
  }
  if (
    kinds.filter((k) => k === "learn").length > 1 ||
    (kinds.includes("learn") && kinds.at(-1) !== "learn")
  )
    errors.push("learn must be last");
  for (const stage of workflow.stages) {
    if (/^(task|dimension|skeptic)-/.test(stage.id)) errors.push(`reserved stage ID ${stage.id}`);
    const agentStage = ["research", "specify", "plan", "analyze", "review", "converge"].includes(
      stage.kind,
    );
    if (agentStage !== Boolean(stage.profileId)) errors.push(`invalid profile binding ${stage.id}`);
    if (stage.kind === "checks" || stage.kind === "review" || stage.kind === "converge") {
      if (
        !stage.repairTo ||
        workflow.stages.find((s) => s.id === stage.repairTo)?.kind !== "task-graph"
      )
        errors.push(`invalid repair target ${stage.id}`);
    } else if (stage.repairTo !== undefined) errors.push(`unexpected repair target ${stage.id}`);
  }
  return errors;
}

/** Paths the run's commands produce; source snapshots leave them out. */
export const generatedPaths = (policy: RunPolicy): string[] => [
  ...policy.checks.flatMap((c) => c.writes),
  ...(policy.acceptanceWrites ?? []),
];

/** How far past `sizing.maxRunTokens` a run grows past the ceiling on progress, if at all. */
export const DEFAULT_EXTEND_FACTOR = 1.5;

/**
 * `sizing.extendToTokens`, or under `clarification: "assume"` with a ceiling and no explicit
 * value, 1.5 times the ceiling: a run nobody watches finishes a plan priced just above it
 * instead of stopping with a corrective half done (#974). The extension still needs progress.
 */
export function extendToOf(policy: RunPolicy): number | null {
  const explicit = policy.sizing?.extendToTokens;
  if (explicit !== undefined) return explicit;
  const ceiling = policy.sizing?.maxRunTokens;
  if (ceiling === undefined || ceiling === null || policy.clarification !== "assume") return null;
  return Math.round(ceiling * DEFAULT_EXTEND_FACTOR);
}

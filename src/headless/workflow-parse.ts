import { parseRouteOverrides } from "../core/llm/model-routing.js";
import { BUDGET_PRESETS } from "../core/workflows/budget.js";
import { MAX_CANDIDATES } from "../core/workflows/candidates.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import { MAX_CONCURRENT_WRITERS, RunStatus } from "../core/workflows/schemas.js";

const commands = [
  "run",
  "quick",
  "status",
  "list",
  "resume",
  "approve",
  "answer",
  "evidence",
  "reject",
  "pause",
  "cancel",
  "revise",
  "fork",
  "profiles",
  "artifacts",
  "import",
  "export",
  "export-progress",
  "gc",
  "redact",
  "recover",
  "candidate",
  "usage",
  "report",
  "outcomes",
  "compare",
  "memory",
  "extend",
  "reroute",
  "continue",
  "accept",
  "undo",
  "definitions",
  "validate",
  "define",
  "gates",
  "agents",
  "gate",
  "deliver",
  "follow",
  "discard-worktree",
  "worktrees",
  "route",
  "models",
  "doctor",
  "estimate",
  "propose",
] as const;
export type WorkflowCommand = (typeof commands)[number];
/** Decisions that continue the run in the terminal unless `--no-resume` is given. */
export const DECISION_COMMANDS: readonly WorkflowCommand[] = [
  "approve",
  "answer",
  "evidence",
  "accept",
];
export interface WorkflowArgs {
  command: WorkflowCommand;
  positional: string[];
  flags: Record<string, string | true>;
  /**
   * Values supplied in place of the files named by file flags, keyed by flag name (the flag itself
   * is then `true`): the parsed value of a JSON file, the text of a text file. API clients send
   * these in request bodies instead of file paths.
   */
  inline?: Record<string, unknown>;
}
/** Options every workflow command takes. */
const globalFlags = ["json", "cwd", "help"];
const booleanFlags = new Set([
  "approval-review",
  "refresh",
  "clean",
  "auto-preset",
  "all",
  "save",
  "from-criteria",
  "model-strict",
  "json",
  "events",
  "accept",
  "dry-run",
  "help",
  "draft",
  "no-pr",
  "with-specs",
  "no-specs",
  "execute",
  "once",
  "fix",
  "reviews",
  "resolve",
  "worktree",
  "remove",
  "exclude-user-changes",
  "resume",
  "no-resume",
]);
/** `doctor` and `estimate` take the `run` options that change whether and how a run starts. */
const preRunFlags = [
  "workflow",
  "model",
  "model-strict",
  "route",
  "policy",
  "worktree",
  "writers",
  "candidates",
  "sandbox",
  "confirm-auto-approval",
  "json",
];
const decisionResumeFlags = ["resume", "no-resume", "events", "after"];
const commandFlags: Record<WorkflowCommand, string[]> = {
  run: [
    "feature",
    "workflow",
    "prompt",
    "prompt-file",
    "policy",
    "owner",
    "model",
    "events",
    "command-id",
    "after",
    "confirm-auto-approval",
    "worktree",
    "writers",
    "candidates",
    "route",
    "model-strict",
    "clarification",
    "test-integrity",
    "sandbox",
    "duplication",
    "sast",
    "mutation",
    "property-tests",
    "issue",
    "budget",
    "approval-review",
    "auto-preset",
  ],
  quick: [
    "feature",
    "prompt-file",
    "policy",
    "budget",
    "owner",
    "model",
    "events",
    "command-id",
    "after",
    "confirm-auto-approval",
    "worktree",
    "route",
    "model-strict",
    "approval-review",
  ],
  status: [],
  list: ["feature", "limit", "cursor", "status"],
  resume: ["expected-revision", "command-id", "events", "after"],
  approve: [
    "request",
    "digest",
    "expected-revision",
    "command-id",
    "exclude-user-changes",
    ...decisionResumeFlags,
  ],
  answer: ["request", "answers-file", "expected-revision", "command-id", ...decisionResumeFlags],
  evidence: [
    "request",
    "file",
    "accept",
    "expected-revision",
    "command-id",
    ...decisionResumeFlags,
  ],
  reject: ["request", "reason", "expected-revision", "command-id"],
  pause: ["expected-revision", "command-id"],
  cancel: ["expected-revision", "command-id"],
  fork: ["expected-revision", "command-id"],
  revise: ["candidate", "expected-revision", "command-id", "resume", "events", "after"],
  candidate: ["spec", "plan", "tasks", "policy", "workflow", "confirm-auto-approval", "command-id"],
  profiles: ["model"],
  artifacts: ["file"],
  import: ["source", "path", "feature", "command-id"],
  export: ["destination"],
  "export-progress": [],
  gc: ["before", "dry-run"],
  redact: ["file", "reason"],
  recover: ["request", "effect", "resolution", "file", "expected-revision", "command-id"],
  usage: ["model", "stage", "top", "format", "output"],
  report: ["output"],
  outcomes: ["refresh"],
  compare: ["output"],
  memory: ["text"],
  extend: [
    "tokens",
    "calls",
    "time-ms",
    "expected-revision",
    "command-id",
    "resume",
    "events",
    "after",
  ],
  reroute: ["model", "route", "expected-revision", "command-id", "resume", "events", "after"],
  continue: ["request", "expected-revision", "command-id", ...decisionResumeFlags],
  accept: ["request", "expected-revision", "command-id", ...decisionResumeFlags],
  undo: ["path", "expected-revision", "command-id"],
  definitions: [],
  validate: ["file"],
  define: ["from"],
  gates: ["all"],
  agents: ["from", "stages", "remove"],
  gate: ["text", "kind", "id", "model", "from-criteria", "save", "file", "json", "workflow", "at"],
  follow: ["interval", "timeout", "once", "fix", "reviews"],
  deliver: [
    "remote",
    "branch",
    "follow-up",
    "answer-threads",
    "resolve",
    "draft",
    "no-pr",
    "with-specs",
    "no-specs",
    "execute",
    "request",
    "expected-revision",
  ],
  "discard-worktree": ["expected-revision", "command-id"],
  worktrees: ["clean", "dry-run"],
  route: ["workflow", "model", "route", "json"],
  models: ["model", "provider", "json"],
  doctor: preRunFlags,
  estimate: preRunFlags,
  propose: ["prompt", "prompt-file", "json"],
};
/** Every option the parser knows: derived from the command tables, so a flag cannot be missed. */
const flags = new Set([...globalFlags, ...Object.values(commandFlags).flat()]);
/** The flag tables the argv parser checks, exposed so tests can assert they agree. */
export const workflowFlagTables = { flags, booleanFlags, commandFlags, globalFlags };
export function parseWorkflowArgs(argv: string[]): WorkflowArgs {
  const command = argv[0];
  if (!commands.includes(command as WorkflowCommand))
    throw new WorkflowFault("INVALID_DEFINITION", `Unknown workflow command ${command ?? ""}`);
  const result: WorkflowArgs = { command: command as WorkflowCommand, positional: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      result.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!flags.has(name) || name in result.flags)
      throw new WorkflowFault("INVALID_DEFINITION", `Unknown or duplicate option ${token}`);
    if (booleanFlags.has(name)) result.flags[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new WorkflowFault("INVALID_DEFINITION", `${token} needs a value`);
      result.flags[name] = value;
    }
  }
  if (DECISION_COMMANDS.includes(result.command)) {
    if (result.flags.resume && result.flags["no-resume"])
      throw new WorkflowFault("INVALID_DEFINITION", "--resume and --no-resume exclude each other");
    // The terminal continues the run after a decision, as the terminal app and the desktop do.
    if (result.flags["no-resume"]) {
      if ("events" in result.flags || "after" in result.flags)
        throw new WorkflowFault("INVALID_DEFINITION", "--events and --after need --resume");
    } else result.flags.resume = true;
  }
  return validateWorkflowArgs(result);
}
/** Checks option combinations and values of parsed or programmatically built workflow arguments. */
export function validateWorkflowArgs(result: WorkflowArgs): WorkflowArgs {
  for (const name of Object.keys(result.flags)) {
    if (!globalFlags.includes(name) && !commandFlags[result.command].includes(name))
      throw new WorkflowFault("INVALID_DEFINITION", `--${name} is not valid for ${result.command}`);
    if (name === "status" && !RunStatus.safeParse(result.flags[name]).success)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Invalid --status value ${JSON.stringify(result.flags[name])}. Valid statuses: ${RunStatus.options.join(", ")}`,
      );
    if (
      ["expected-revision", "limit", "after", "tokens", "calls", "time-ms", "top"].includes(name)
    ) {
      const value = Number(result.flags[name]);
      const minimum = ["limit", "tokens", "calls", "time-ms", "top"].includes(name) ? 1 : 0;
      if (
        !Number.isSafeInteger(value) ||
        value < minimum ||
        !/^\d+$/.test(String(result.flags[name]))
      )
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `--${name} requires a ${minimum ? "positive" : "non-negative"} integer`,
        );
    }
  }
  if ("format" in result.flags && result.flags.format !== "md")
    throw new WorkflowFault("INVALID_DEFINITION", "--format takes md");
  if (result.command === "usage" && "output" in result.flags && !("format" in result.flags))
    result.flags.format = "md";
  if (typeof result.flags.route === "string") parseRouteOverrides(result.flags.route);
  if (!result.flags.help && result.command === "memory") {
    const [action = "list", ...rest] = result.positional;
    const needs = {
      list: [0, false],
      add: [0, true],
      edit: [1, true],
      accept: [1, false],
      forget: [1, false],
      restore: [1, false],
    } as const;
    const rule = needs[action as keyof typeof needs];
    if (!rule)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "memory accepts list, add, edit, accept, forget or restore",
      );
    if (rest.length !== rule[0])
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        rule[0] ? `memory ${action} expects an entry ID` : `memory ${action} takes no entry ID`,
      );
    if (rule[1] !== (typeof result.flags.text === "string"))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        rule[1] ? `memory ${action} requires --text` : `--text is not valid for memory ${action}`,
      );
  } else if (!result.flags.help && result.command === "agents") {
    const [action = "list", ...rest] = result.positional;
    const arity: Record<string, number> = { list: 0, convert: 1, remove: 1 };
    if (arity[action] === undefined || rest.length !== arity[action])
      throw new WorkflowFault("INVALID_DEFINITION", "agents takes list, convert ID or remove NAME");
  } else if (!result.flags.help && ["route", "doctor", "estimate"].includes(result.command)) {
    if (result.positional.length > 1 || (result.positional.length && result.flags.workflow))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Specify at most one workflow ID, positional or --workflow",
      );
  } else if (
    !result.flags.help &&
    result.command !== "run" &&
    result.command !== "quick" &&
    result.command !== "gates" &&
    result.command !== "gate" &&
    result.command !== "propose"
  ) {
    const count =
      ["list", "profiles", "models", "import", "gc", "definitions", "worktrees"].includes(
        result.command,
      ) ||
      (result.command === "validate" && result.flags.file)
        ? 0
        : result.command === "compare"
          ? 2
          : 1;
    if (result.positional.length !== count)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `${result.command} expects ${count} positional argument(s)`,
      );
  }
  if (
    ["revise", "extend", "reroute"].includes(result.command) &&
    !result.flags.resume &&
    ("events" in result.flags || "after" in result.flags)
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--events and --after need --resume");
  if (!result.flags.help && result.command === "follow") {
    for (const [flag, min, max] of [
      ["interval", 5, 3600],
      ["timeout", 1, 1440],
    ] as const) {
      const value = result.flags[flag];
      if (value === undefined) continue;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min || n > max)
        throw new WorkflowFault("INVALID_DEFINITION", `--${flag} accepts ${min} to ${max}`);
    }
    if (result.flags.once && ("interval" in result.flags || "timeout" in result.flags))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--once reads the checks once; it does not wait",
      );
  }
  if (!result.flags.help && result.command === "deliver") {
    const planning = [
      "remote",
      "branch",
      "follow-up",
      "answer-threads",
      "resolve",
      "draft",
      "no-pr",
      "with-specs",
      "no-specs",
    ].filter((name) => name in result.flags);
    const newBranch = ["branch", "draft", "no-pr"].find((name) => name in result.flags);
    if ("follow-up" in result.flags && newBranch)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `--${newBranch} plans a new branch; --follow-up adds a commit to the followed run's branch and pull request`,
      );
    if (
      ("answer-threads" in result.flags || "resolve" in result.flags) &&
      !("follow-up" in result.flags)
    )
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--answer-threads and --resolve answer review threads of the followed pull request; add --follow-up",
      );
    if (result.flags.resolve && !("answer-threads" in result.flags))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--resolve resolves the --answer-threads threads",
      );
    if (result.flags["with-specs"] && result.flags["no-specs"])
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--with-specs and --no-specs exclude each other",
      );
    if (result.flags.execute) {
      if (planning.length)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `--${planning[0]} belongs to the plan; --execute performs the approved plan as it is`,
        );
      if (!("expected-revision" in result.flags))
        throw new WorkflowFault("INVALID_DEFINITION", "--execute requires --expected-revision");
    } else if ("request" in result.flags || "expected-revision" in result.flags)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--request and --expected-revision apply only with --execute",
      );
  }
  if (
    !result.flags.help &&
    result.command === "propose" &&
    Number(result.positional.length > 0) +
      Number(!!result.flags.prompt) +
      Number(!!result.flags["prompt-file"]) !==
      1
  )
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "Describe the request as text, with --prompt or with --prompt-file",
    );
  if (!result.flags.help && result.command === "run") {
    if (result.positional.length > 1 || (result.positional.length && result.flags.workflow))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Specify at most one workflow ID, positional or --workflow",
      );
    const prompts = Number(!!result.flags.prompt) + Number(!!result.flags["prompt-file"]);
    if (result.flags.issue ? prompts > 1 : prompts !== 1)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        result.flags.issue
          ? "Specify at most one of --prompt or --prompt-file with --issue"
          : "Specify exactly one of --prompt, --prompt-file or --issue",
      );
  }
  if (
    !result.flags.help &&
    "budget" in result.flags &&
    !(BUDGET_PRESETS as readonly string[]).includes(String(result.flags.budget))
  )
    throw new WorkflowFault("INVALID_DEFINITION", `--budget accepts ${BUDGET_PRESETS.join(", ")}`);
  if (
    !result.flags.help &&
    "clarification" in result.flags &&
    !["ask", "assume"].includes(String(result.flags.clarification))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--clarification accepts ask or assume");
  if (
    !result.flags.help &&
    "test-integrity" in result.flags &&
    !["block", "warn"].includes(String(result.flags["test-integrity"]))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--test-integrity accepts block or warn");
  if (
    !result.flags.help &&
    "sandbox" in result.flags &&
    !["off", "auto", "required"].includes(String(result.flags.sandbox))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--sandbox accepts off, auto or required");
  if (
    !result.flags.help &&
    "duplication" in result.flags &&
    !["off", "warn", "ratchet"].includes(String(result.flags.duplication))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--duplication accepts off, warn or ratchet");
  if (
    !result.flags.help &&
    "sast" in result.flags &&
    !["auto", "off"].includes(String(result.flags.sast))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--sast accepts auto or off");
  if (
    !result.flags.help &&
    "mutation" in result.flags &&
    !["off", "advisory", "required"].includes(String(result.flags.mutation))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--mutation accepts off, advisory or required");
  if (
    !result.flags.help &&
    "property-tests" in result.flags &&
    !["auto", "off"].includes(String(result.flags["property-tests"]))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--property-tests accepts auto or off");
  if (!result.flags.help && ["run", "doctor", "estimate"].includes(result.command)) {
    if ("writers" in result.flags) {
      const writers = String(result.flags.writers);
      if (!/^\d+$/.test(writers) || Number(writers) < 1 || Number(writers) > MAX_CONCURRENT_WRITERS)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `--writers requires an integer from 1 to ${MAX_CONCURRENT_WRITERS}`,
        );
      if (Number(writers) > 1 && !result.flags.worktree)
        throw new WorkflowFault("INVALID_DEFINITION", "--writers above 1 requires --worktree");
    }
    if ("candidates" in result.flags) {
      const candidates = String(result.flags.candidates);
      if (
        !/^\d+$/.test(candidates) ||
        Number(candidates) < 1 ||
        Number(candidates) > MAX_CANDIDATES
      )
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `--candidates requires an integer from 1 to ${MAX_CANDIDATES}`,
        );
    }
  }
  if (
    !result.flags.help &&
    result.command === "quick" &&
    Number(result.positional.length > 0) + Number(!!result.flags["prompt-file"]) !== 1
  )
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "Describe the task as text or with --prompt-file, not both",
    );
  return result;
}
export const workflowHelp = `baked workflow <command> [options]

run [WORKFLOW] --feature ID (--prompt TEXT | --prompt-file FILE) [--policy FILE] [--model ID [--model-strict]] [--route STAGE=MODEL,...] [--events] [--confirm-auto-approval HASH] [--worktree [--writers N]] [--candidates N] [--clarification ask|assume] [--sandbox off|auto|required] [--duplication off|warn|ratchet] [--sast auto|off] [--mutation off|advisory|required] [--property-tests auto|off] [--budget PRESET] [--approval-review]
run [WORKFLOW] --issue URL|OWNER/NAME#N|#N [--feature ID] [--prompt TEXT | --prompt-file FILE] [other run options]
  --issue takes the request from a GitHub issue (its title and body; --prompt adds instructions)
  and names the feature issue-N-TITLE unless --feature is given; the delivery pull request says
  Closes #N, so merging it closes the issue. #N reads the origin remote's repository
  --route sends every agent of a stage to a model or a modelRouting class ($name) for this run
  --model applies to the active class only: a configured modelRouting class, role or stage route
  still wins, and the start warns which agents run on another model. --model-strict makes the
  model serve every class, role and stage of this run (only --route still overrides it)
  --worktree runs the tasks in .baked/worktrees/RUN_ID/main on branch baked/wf/RUN_ID; your working copy is not changed
  --writers N (1..4, with --worktree) implements up to N independent tasks at once, each in .baked/worktrees/RUN_ID/TASK_ID
  --candidates N (1..8, at most the policy's maxCandidates, default 4) implements each planned task
  N times in separate worktrees and keeps the best candidate (best-of-N); needs a worktree run
  (--worktree or the best-of-n workflow). Default: the tasks stage's candidates, then the policy's
  --clarification assume lets research, spec and analysis settle blocking questions with recorded
  assumptions, shown at approval; only questions without a safe default wait for you. Default: the
  policy's clarification, otherwise ask
  --test-integrity warn records test gaming in a task's diff (deleted, skipped or weakened tests,
  suppressions, special cases for test inputs) instead of sending it to a repair. Default: the
  policy's testIntegrity, otherwise block
  --sandbox runs the run's checks, fixes, probes and acceptance apps in the OS sandbox (see
  docs/sandbox.md); required refuses to start without a backend. Default: the stricter of the
  policy's sandbox and the sandbox setting
  --approval-review lets the approval reviewer (a model) approve a low-risk plan that leaves the
  auto approval limits only by its task count, file count or paths; it needs autoApproval.limits.
  Always-human paths, deletions and the token limit still wait for you
  --duplication ratchet blocks code the run copies and code it adds that nothing uses; warn (the
  default) reports them in the run report; off skips the measurement. Default: the policy's
  duplication, then the quality.duplication setting, otherwise warn
  --sast off skips Semgrep on the run's diff; auto (the default) runs it when it is installed.
  Default: the policy's sast, then the quality.sast setting, otherwise auto
  --mutation required makes the mutants of the added lines that the test checks do not kill
  blocking findings; advisory lists them in the run report; off skips the gate. Default: the
  policy's mutation, then the quality.mutation setting, then the preset (advisory for sdd/full)
  --property-tests auto has the spec mark criteria that hold over an input domain and blocks
  until each has a property-based test; off skips it. Default: the policy's propertyTests, then
  the quality.propertyTests setting, then the preset (auto for sdd/full and standard)
  --budget quick|standard|extended|checkpoints scales the policy (--policy, the config's
  workflows.policy, or the built-in default): quick halves the limits, extended doubles them,
  checkpoints drops the token cap and pauses for your go-ahead. Default: standard
  --auto-preset proposes the workflow and budget from the request (see propose) and runs it; with a
  WORKFLOW the person's pick wins and both are recorded in the run. --budget still wins
propose TEXT... | --prompt TEXT | --prompt-file FILE [--json]
  The workflow and budget --auto-preset would pick for a request, with the reason: a review of
  existing changes (review-only), research without a change (spike), a failing check (fix-ci),
  a docs-only or small change (quick, quick budget), a large change (default, extended budget)
quick TEXT... | --prompt-file FILE [--feature ID] [--model ID] [--route STAGE=MODEL,...] [--policy FILE] [--budget PRESET] [--events] [--worktree] [--confirm-auto-approval HASH] [--approval-review]
  A small task without specification: one agent finds the files and plans, then approval,
  implementation, the policy checks and one correctness review. The feature ID is derived from
  the text. Runs workflows.quickWorkflow when set, otherwise the quick preset. Also: baked quick
status RUN_ID [--json]
memory [list] [--json] | memory add --text TEXT | memory edit ID --text TEXT | memory accept|forget|restore ID
  What earlier runs taught new runs (answers, approved assumptions, passing checks, code rules
  learned from recurring findings) and your notes. add writes a note; edit rewords a note, answer,
  assumption or rule; accept activates a proposed rule; forget deletes a note or hides an entry
  (retires a rule); restore brings an entry back as runs recorded it. Runs started afterwards read the result
list [--feature ID] [--status STATUS] [--limit 20] [--cursor RUN_ID]
  --status accepts: ${RunStatus.options.join(", ")}
resume RUN_ID --expected-revision N [--events]
approve RUN_ID --request ID --digest SHA256 --expected-revision N [--exclude-user-changes] [--no-resume]
  --exclude-user-changes is required when a worktree run's approved files have uncommitted changes in your working copy
answer RUN_ID --request ID --answers-file FILE --expected-revision N [--no-resume]
evidence RUN_ID --request ID --file FILE --accept --expected-revision N [--no-resume]
  approve, answer and evidence continue the run after the decision (resume and drive, exit codes
  as resume) unless another request still waits for a person; --no-resume only records the decision
reject RUN_ID --request ID --reason TEXT --expected-revision N
  An AI walk-through's verified test waits as an approval request with an acceptance body
  (see status). approve promotes it: the test file and its command gate with provenance are
  written to the project and confirmed; reject discards it. Neither changes the run's state.
pause|cancel|fork RUN_ID --expected-revision N
continue RUN_ID --request ID --expected-revision N [--resume]   (answer a token checkpoint; resume then spends up to the next one. On a stopped convergence it allows one more repair round)
accept RUN_ID --request ID --expected-revision N [--no-resume]   (a stopped convergence: accept the remaining findings as known limitations; reject stops the run)
extend RUN_ID --expected-revision N [--tokens N] [--calls N] [--time-ms N] [--resume [--events]]
  (raise the limits of a run blocked on its budget; resume continues it, or --resume in the same command)
reroute RUN_ID --expected-revision N [--model ID] [--route STAGE=MODEL,...] [--resume [--events]]
  (move a stopped run to other models: completed stages and tasks stay, the next agent calls use
  the new models; routes resolve again through modelRouting with the new run model, the start
  model checks and independentReview apply, and the change is recorded in routing.json)
candidate RUN_ID [--spec FILE] [--plan FILE] [--tasks FILE] [--policy FILE] [--workflow FILE [--confirm-auto-approval HASH]]
  --workflow stages a revised schema 2 definition for a started v2 run; it is refused with the
  reasons when the current or a completed stage is gone or changed, or a contract the run needs
  is no longer produced
revise RUN_ID --candidate SHA256 --expected-revision N [--resume [--events]]   (applies the candidate; the plan is approved again)
  Implemented tasks the revision leaves unchanged, or only gives added criteria, keep their
  implementation; their checks run again.
  --resume resumes and drives the revised run in the same command (exit codes as resume)
undo RUN_ID --expected-revision N [--path PATH]   (restore what unfinished or invalidated task edits changed, unless changed since)
recover RUN_ID --request ID --effect ID --resolution record-applied|record-not-applied|retry|cancel --file EVIDENCE --expected-revision N
  record-not-applied / record-applied settle the one effect and the run goes on; cancel CANCELS THE WHOLE RUN (prints a warning)
definitions               list workflow definitions: sdd, the presets and baked/workflows/*.json
validate (ID | --file FILE)   check a definition against the gate library; exit 1 with problems
define ID --from PRESET   copy a preset or definition to baked/workflows/ID.json as a custom workflow
agents                    list the project's custom agents from other tools (Claude Code, Copilot, OpenCode, Roo)
agents convert ID [--from PRESET] [--stages NAME=STAGE,...] [--remove]
  make workflow ID from them: each agent fills a stage (research, specify, plan, implement, review, skip);
  --remove deletes the converted agent files
agents remove NAME        delete one agent's file
gates                     list the gate library with each gate's source and what it shadows
gates confirm ID... | --all  confirm project gates (baked/gates) before a run may use them
gate new "TEXT" [--kind command|ai-acceptance|human|ai-review] [--id ID] [--from-criteria] [--model ID] [--save] [--json]
  draft a gate from a sentence: a command gate for an exact check, a terminal AI walk-through
  for a judged one (human and ai-review need no model); prints the draft and what it may do,
  and writes it only with --save
gate save --file DRAFT.json   save a draft printed by gate new --json (confirms it)
gate list [--json]   |   gate show ID [--json]   the gate library in words
gate places ID [--workflow W]   where the gate can go in a workflow (default: the default workflow)
gate bind ID --at PLACE [--workflow W]   bind it there; sdd and presets are copied as W-custom first
profiles [--model ID]     artifacts RUN_ID [--file ARTIFACT_ID]
route [WORKFLOW] [--model ID] [--route STAGE=MODEL,...] [--json]
  show the model each stage and profile would use and where each choice comes from
routing [show] | set TARGET MODEL | clear TARGET | review MODE   [--scope project|global]
  change modelRouting with the routing screen's checks (see baked workflow routing --help)
models [--model ID] [--provider ID] [--json]
  list what a route, --route, --model or a fallback can name: the model names ($active, $fast,
  ...) with the model each resolves to, then the models of each provider; providers without a key
  or login are listed with that reason
doctor [WORKFLOW] [--model ID] [--route STAGE=MODEL,...] [--policy FILE] [--worktree [--writers N]] [--candidates N] [--sandbox MODE] [--confirm-auto-approval HASH] [--json]
  check before a run: start refusals, provider keys of every routed model, check commands, Git,
  a busy workspace and the budget; exit 1 when something must be fixed (also: baked doctor)
estimate [WORKFLOW] (same options as doctor)
  tokens and approximate cost per stage and per model, from earlier runs of this project
import --source spec-kit|ecc|markdown-edit --path DIRECTORY --feature ID
export RUN_ID --destination DIRECTORY    export-progress RUN_ID
usage RUN_ID [--model ID] [--stage NAME] [--top N] [--format md] [--output FILE]
  per-stage and per-attempt token and step usage; --format md renders tokens and estimated cost
  by stage and model as Markdown, printed or written to FILE (project-wide: baked usage)
report RUN_ID [--output FILE] [--json]
  One Markdown report of the run: summary, changes, tasks, checks, criteria, findings, decisions,
  tokens by stage and model, artifacts. Printed, or written to FILE; deliver uses it as the PR body.
outcomes [RUN_ID] [--refresh] [--json]
  The critic outcome log: each critic score with whether the task's checks passed, how the run
  ended, the delivered commit's fate and the share of its lines that survive (final after 30 days).
  --refresh updates delivery and survival from Git first.
compare RUN_A RUN_B [--output FILE] [--json]
  an A/B of two runs (one feature run with two --route maps): the routes that differ, then status,
  tokens, cost, active time, agent calls, repairs, checks and review findings side by side
gc --before ISO_DATE [--dry-run]          redact RUN_ID --file ARTIFACT_ID --reason TEXT
deliver RUN_ID [--remote origin] [--branch NAME] [--draft] [--no-pr] [--with-specs|--no-specs]
  Prepare Git delivery of a completed, verified run: one commit of the run's files on a new
  branch, push, and a pull request. Stores the plan and a delivery request; nothing runs yet.
  Approve the exact plan with: approve RUN_ID --request ID --digest SHA256 --expected-revision N
deliver RUN_ID --execute --expected-revision N [--request ID]
  Perform the approved plan. Retries check what already exists; nothing is force-pushed or merged.
  The pull request token is read from workflows.delivery.tokenEnv (default GITHUB_TOKEN).
  A worktree run is delivered from its branch; its worktree is removed afterwards, the branch stays.
deliver RUN_ID --follow-up DELIVERED_RUN_ID [--remote origin] [--with-specs|--no-specs]
  Plan one commit of this run's files on top of the branch DELIVERED_RUN_ID pushed, fast-forward
  only, and no new pull request: a fix for that pull request's checks or review. The local copy of
  that branch must match the remote and not be checked out.
  --answer-threads ID,ID replies "Addressed in COMMIT." to those unresolved review threads of the
  pull request after the push; --resolve also resolves them. Both are part of the approved plan.
follow RUN_ID [--interval 60] [--timeout 60] [--once] [--fix] [--reviews]
  Wait for the checks GitHub reports on the commit the run's latest delivery pushed, reading them
  every --interval seconds (5..3600) for up to --timeout minutes (1..1440); no model runs. Ends at
  the first failed check, when all pass, or at the timeout. --once reads them once. --fix starts a
  fix-ci run for the failed checks; deliver it with deliver FIX_RUN_ID --follow-up RUN_ID.
  --reviews also reads the pull request's unresolved review threads and requested changes once no
  check failed; --fix then starts a quick-fix run for them, delivered with
  deliver FIX_RUN_ID --follow-up RUN_ID --answer-threads THREAD_IDS.
discard-worktree RUN_ID --expected-revision N
  Remove the worktree and delete the branch of a completed, failed or cancelled worktree run.
worktrees [--clean [--dry-run]]
  Run and task worktrees under .baked/worktrees, largest first, with size and run status.
  --clean removes those of completed, failed, cancelled and unknown runs (branches stay).
initiative <command> ...   split a large request into 3..12 features run in dependency order
  start, show, list, events, merge, split, remove, rename, approve, reject, drive, resume, pause,
  replan, extend, reroute; see baked workflow initiative --help

Management mutations accept --command-id UUID for idempotent retries.
All commands accept --help. Workflows are on unless the configuration sets workflows.enabled: false.
Drive exit codes: 0 completed, 1 error, 2 deadline, 3 waiting, 4 blocked,
5 revision/lease/input conflict, 130 paused/cancelled. Management success returns 0.
No daemon continues execution after the command exits.
`;

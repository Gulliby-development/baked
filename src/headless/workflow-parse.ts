import { parseRouteOverrides } from "../core/llm/model-routing.js";
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
  "memory",
  "extend",
  "reroute",
  "continue",
  "undo",
  "definitions",
  "validate",
  "define",
  "gates",
  "deliver",
  "discard-worktree",
  "route",
  "doctor",
  "estimate",
] as const;
export type WorkflowCommand = (typeof commands)[number];
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
const flags = new Set([
  "feature",
  "workflow",
  "prompt",
  "prompt-file",
  "policy",
  "owner",
  "model",
  "json",
  "events",
  "request",
  "digest",
  "expected-revision",
  "command-id",
  "answers-file",
  "file",
  "accept",
  "reason",
  "candidate",
  "source",
  "path",
  "destination",
  "before",
  "dry-run",
  "limit",
  "cursor",
  "status",
  "stage",
  "top",
  "after",
  "effect",
  "resolution",
  "tokens",
  "calls",
  "time-ms",
  "spec",
  "plan",
  "tasks",
  "cwd",
  "from",
  "all",
  "confirm-auto-approval",
  "help",
  "remote",
  "branch",
  "draft",
  "no-pr",
  "execute",
  "worktree",
  "writers",
  "exclude-user-changes",
  "route",
  "resume",
  "clarification",
  "issue",
  "output",
  "text",
]);
const booleanFlags = new Set([
  "all",
  "json",
  "events",
  "accept",
  "dry-run",
  "help",
  "draft",
  "no-pr",
  "execute",
  "worktree",
  "exclude-user-changes",
  "resume",
]);
/** `doctor` and `estimate` take the `run` options that change whether and how a run starts. */
const preRunFlags = [
  "workflow",
  "model",
  "route",
  "policy",
  "worktree",
  "writers",
  "confirm-auto-approval",
  "json",
];
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
    "route",
    "clarification",
    "issue",
  ],
  quick: [
    "feature",
    "prompt-file",
    "policy",
    "owner",
    "model",
    "events",
    "command-id",
    "after",
    "confirm-auto-approval",
    "worktree",
    "route",
  ],
  status: [],
  list: ["feature", "limit", "cursor", "status"],
  resume: ["expected-revision", "command-id", "events", "after"],
  approve: ["request", "digest", "expected-revision", "command-id", "exclude-user-changes"],
  answer: ["request", "answers-file", "expected-revision", "command-id"],
  evidence: ["request", "file", "accept", "expected-revision", "command-id"],
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
  usage: ["model", "stage", "top"],
  report: ["output"],
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
  continue: ["request", "expected-revision", "command-id"],
  undo: ["path", "expected-revision", "command-id"],
  definitions: [],
  validate: ["file"],
  define: ["from"],
  gates: ["all"],
  deliver: ["remote", "branch", "draft", "no-pr", "execute", "request", "expected-revision"],
  "discard-worktree": ["expected-revision", "command-id"],
  route: ["workflow", "model", "route", "json"],
  doctor: preRunFlags,
  estimate: preRunFlags,
};
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
  return validateWorkflowArgs(result);
}
/** Checks option combinations and values of parsed or programmatically built workflow arguments. */
export function validateWorkflowArgs(result: WorkflowArgs): WorkflowArgs {
  for (const name of Object.keys(result.flags)) {
    if (!["json", "cwd", "help", ...commandFlags[result.command]].includes(name))
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
  if (typeof result.flags.route === "string") parseRouteOverrides(result.flags.route);
  if (!result.flags.help && result.command === "memory") {
    const [action = "list", ...rest] = result.positional;
    const needs = {
      list: [0, false],
      add: [0, true],
      edit: [1, true],
      forget: [1, false],
      restore: [1, false],
    } as const;
    const rule = needs[action as keyof typeof needs];
    if (!rule)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "memory accepts list, add, edit, forget or restore",
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
    result.command !== "gates"
  ) {
    const count =
      ["list", "profiles", "import", "gc", "definitions"].includes(result.command) ||
      (result.command === "validate" && result.flags.file)
        ? 0
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
  if (!result.flags.help && result.command === "deliver") {
    const planning = ["remote", "branch", "draft", "no-pr"].filter((name) => name in result.flags);
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
    "clarification" in result.flags &&
    !["ask", "assume"].includes(String(result.flags.clarification))
  )
    throw new WorkflowFault("INVALID_DEFINITION", "--clarification accepts ask or assume");
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

run [WORKFLOW] --feature ID (--prompt TEXT | --prompt-file FILE) [--policy FILE] [--model ID] [--route STAGE=MODEL,...] [--events] [--confirm-auto-approval HASH] [--worktree [--writers N]] [--clarification ask|assume]
run [WORKFLOW] --issue URL|OWNER/NAME#N|#N [--feature ID] [--prompt TEXT | --prompt-file FILE] [other run options]
  --issue takes the request from a GitHub issue (its title and body; --prompt adds instructions)
  and names the feature issue-N-TITLE unless --feature is given; the delivery pull request says
  Closes #N, so merging it closes the issue. #N reads the origin remote's repository
  --route sends every agent of a stage to a model or a modelRouting class ($name) for this run
  --worktree runs the tasks in .baked/worktrees/RUN_ID/main on branch baked/wf/RUN_ID; your working copy is not changed
  --writers N (1..4, with --worktree) implements up to N independent tasks at once, each in .baked/worktrees/RUN_ID/TASK_ID
  --clarification assume lets research, spec and analysis settle blocking questions with recorded
  assumptions, shown at approval; only questions without a safe default wait for you. Default: the
  policy's clarification, otherwise ask
quick TEXT... | --prompt-file FILE [--feature ID] [--model ID] [--route STAGE=MODEL,...] [--policy FILE] [--events] [--worktree] [--confirm-auto-approval HASH]
  A small task without specification: one agent finds the files and plans, then approval,
  implementation, the policy checks and one correctness review. The feature ID is derived from
  the text. Runs workflows.quickWorkflow when set, otherwise the quick preset. Also: baked quick
status RUN_ID [--json]
memory [list] [--json] | memory add --text TEXT | memory edit ID --text TEXT | memory forget|restore ID
  What earlier runs taught new runs (answers, approved assumptions, passing checks) and your notes.
  add writes a note; edit rewords a note, answer or assumption; forget deletes a note or hides an
  entry; restore brings an entry back as runs recorded it. Runs started afterwards read the result
list [--feature ID] [--status STATUS] [--limit 20] [--cursor RUN_ID]
  --status accepts: ${RunStatus.options.join(", ")}
resume RUN_ID --expected-revision N [--events]
approve RUN_ID --request ID --digest SHA256 --expected-revision N [--exclude-user-changes]
  --exclude-user-changes is required when a worktree run's approved files have uncommitted changes in your working copy
answer RUN_ID --request ID --answers-file FILE --expected-revision N
evidence RUN_ID --request ID --file FILE --accept --expected-revision N
reject RUN_ID --request ID --reason TEXT --expected-revision N
  An AI walk-through's verified test waits as an approval request with an acceptance body
  (see status). approve promotes it: the test file and its command gate with provenance are
  written to the project and confirmed; reject discards it. Neither changes the run's state.
pause|cancel|fork RUN_ID --expected-revision N
continue RUN_ID --request ID --expected-revision N   (answer a token checkpoint; resume then spends up to the next one)
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
definitions               list workflow definitions: sdd, the presets and baked/workflows/*.json
validate (ID | --file FILE)   check a definition against the gate library; exit 1 with problems
define ID --from PRESET   copy a preset or definition to baked/workflows/ID.json as a custom workflow
gates                     list the gate library with each gate's source and what it shadows
gates confirm ID... | --all  confirm project gates (baked/gates) before a run may use them
profiles [--model ID]     artifacts RUN_ID [--file ARTIFACT_ID]
route [WORKFLOW] [--model ID] [--route STAGE=MODEL,...] [--json]
  show the model each stage and profile would use and where each choice comes from
doctor [WORKFLOW] [--model ID] [--route STAGE=MODEL,...] [--policy FILE] [--worktree [--writers N]] [--confirm-auto-approval HASH] [--json]
  check before a run: start refusals, provider keys of every routed model, check commands, Git,
  a busy workspace and the budget; exit 1 when something must be fixed (also: baked doctor)
estimate [WORKFLOW] (same options as doctor)
  tokens and approximate cost per stage and per model, from earlier runs of this project
import --source spec-kit|ecc|markdown-edit --path DIRECTORY --feature ID
export RUN_ID --destination DIRECTORY    export-progress RUN_ID
usage RUN_ID [--model ID] [--stage NAME] [--top N]   per-stage and per-attempt token and step usage
report RUN_ID [--output FILE] [--json]
  One Markdown report of the run: summary, changes, tasks, checks, criteria, findings, decisions,
  tokens by stage and model, artifacts. Printed, or written to FILE; deliver uses it as the PR body.
gc --before ISO_DATE [--dry-run]          redact RUN_ID --file ARTIFACT_ID --reason TEXT
deliver RUN_ID [--remote origin] [--branch NAME] [--draft] [--no-pr]
  Prepare Git delivery of a completed, verified run: one commit of the run's files on a new
  branch, push, and a pull request. Stores the plan and a delivery request; nothing runs yet.
  Approve the exact plan with: approve RUN_ID --request ID --digest SHA256 --expected-revision N
deliver RUN_ID --execute --expected-revision N [--request ID]
  Perform the approved plan. Retries check what already exists; nothing is force-pushed or merged.
  The pull request token is read from workflows.delivery.tokenEnv (default GITHUB_TOKEN).
  A worktree run is delivered from its branch; its worktree is removed afterwards, the branch stays.
discard-worktree RUN_ID --expected-revision N
  Remove the worktree and delete the branch of a completed, failed or cancelled worktree run.
initiative <command> ...   split a large request into 3..12 features run in dependency order
  start, show, list, events, merge, split, remove, rename, approve, reject, drive, resume, pause,
  replan, extend, reroute; see baked workflow initiative --help

Management mutations accept --command-id UUID for idempotent retries.
All commands accept --help. Workflows are on unless the configuration sets workflows.enabled: false.
Drive exit codes: 0 completed, 1 error, 2 deadline, 3 waiting, 4 blocked,
5 revision/lease/input conflict, 130 paused/cancelled. Management success returns 0.
No daemon continues execution after the command exits.
`;

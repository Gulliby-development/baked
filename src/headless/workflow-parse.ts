import { WorkflowFault } from "../core/workflows/errors.js";
import { MAX_CONCURRENT_WRITERS, RunStatus } from "../core/workflows/schemas.js";

const commands = [
  "run",
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
  "extend",
  "continue",
  "undo",
  "definitions",
  "validate",
  "define",
  "gates",
  "deliver",
  "discard-worktree",
] as const;
export type WorkflowCommand = (typeof commands)[number];
export interface WorkflowArgs {
  command: WorkflowCommand;
  positional: string[];
  flags: Record<string, string | true>;
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
  "resume",
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
  profiles: [],
  artifacts: ["file"],
  import: ["source", "path", "feature", "command-id"],
  export: ["destination"],
  "export-progress": [],
  gc: ["before", "dry-run"],
  redact: ["file", "reason"],
  recover: ["request", "effect", "resolution", "file", "expected-revision", "command-id"],
  usage: ["stage"],
  extend: ["tokens", "calls", "time-ms", "expected-revision", "command-id"],
  continue: ["request", "expected-revision", "command-id"],
  undo: ["path", "expected-revision", "command-id"],
  definitions: [],
  validate: ["file"],
  define: ["from"],
  gates: ["all"],
  deliver: ["remote", "branch", "draft", "no-pr", "execute", "request", "expected-revision"],
  "discard-worktree": ["expected-revision", "command-id"],
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
  for (const name of Object.keys(result.flags)) {
    if (!["json", "cwd", "help", ...commandFlags[result.command]].includes(name))
      throw new WorkflowFault("INVALID_DEFINITION", `--${name} is not valid for ${result.command}`);
    if (name === "status" && !RunStatus.safeParse(result.flags[name]).success)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Invalid --status value ${JSON.stringify(result.flags[name])}. Valid statuses: ${RunStatus.options.join(", ")}`,
      );
    if (["expected-revision", "limit", "after", "tokens", "calls", "time-ms"].includes(name)) {
      const value = Number(result.flags[name]);
      if (
        !Number.isSafeInteger(value) ||
        value < (name === "limit" || ["tokens", "calls", "time-ms"].includes(name) ? 1 : 0) ||
        !/^\d+$/.test(String(result.flags[name]))
      )
        throw new WorkflowFault("INVALID_DEFINITION", `--${name} requires an integer`);
    }
  }
  if (!result.flags.help && result.command !== "run" && result.command !== "gates") {
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
    result.command === "revise" &&
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
    if (Number(!!result.flags.prompt) + Number(!!result.flags["prompt-file"]) !== 1)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Specify exactly one of --prompt or --prompt-file",
      );
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
  return result;
}
export const workflowHelp = `baked workflow <command> [options]

run [WORKFLOW] --feature ID (--prompt TEXT | --prompt-file FILE) [--policy FILE] [--model ID] [--events] [--confirm-auto-approval HASH] [--worktree [--writers N]]
  --worktree runs the tasks in .baked/worktrees/RUN_ID/main on branch baked/wf/RUN_ID; your working copy is not changed
  --writers N (1..4, with --worktree) implements up to N independent tasks at once, each in .baked/worktrees/RUN_ID/TASK_ID
status RUN_ID [--json]
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
extend RUN_ID --expected-revision N [--tokens N] [--calls N] [--time-ms N]   (raise the limits of a run blocked on its budget; resume continues it)
candidate RUN_ID [--spec FILE] [--plan FILE] [--tasks FILE] [--policy FILE] [--workflow FILE [--confirm-auto-approval HASH]]
  --workflow stages a revised schema 2 definition for a started v2 run; it is refused with the
  reasons when the current or a completed stage is gone or changed, or a contract the run needs
  is no longer produced
revise RUN_ID --candidate SHA256 --expected-revision N [--resume [--events]]   (applies the candidate; the plan is approved again)
  Implemented tasks the revision leaves unchanged keep their implementation; their checks run again.
  --resume resumes and drives the revised run in the same command (exit codes as resume)
undo RUN_ID --expected-revision N [--path PATH]   (restore what unfinished or invalidated task edits changed, unless changed since)
recover RUN_ID --request ID --effect ID --resolution record-applied|record-not-applied|retry|cancel --file EVIDENCE --expected-revision N
definitions               list workflow definitions: sdd, the presets and baked/workflows/*.json
validate (ID | --file FILE)   check a definition against the gate library; exit 1 with problems
define ID --from PRESET   copy a preset or definition to baked/workflows/ID.json as a custom workflow
gates                     list the gate library with each gate's source and what it shadows
gates confirm ID... | --all  confirm project gates (baked/gates) before a run may use them
profiles                  artifacts RUN_ID [--file ARTIFACT_ID]
import --source spec-kit|ecc|markdown-edit --path DIRECTORY --feature ID
export RUN_ID --destination DIRECTORY    export-progress RUN_ID
usage RUN_ID [--stage NAME]   per-stage and per-attempt token and step usage
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
  replan, extend; see baked workflow initiative --help

Management mutations accept --command-id UUID for idempotent retries.
All commands accept --help. Workflows require an explicit workflows.enabled opt-in.
Drive exit codes: 0 completed, 1 error, 2 deadline, 3 waiting, 4 blocked,
5 revision/lease/input conflict, 130 paused/cancelled. Management success returns 0.
No daemon continues execution after the command exits.
`;

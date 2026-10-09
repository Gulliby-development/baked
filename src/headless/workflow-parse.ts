import { WorkflowFault } from "../core/workflows/errors.js";
import { RunStatus } from "../core/workflows/schemas.js";

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
  "after",
  "effect",
  "resolution",
  "spec",
  "plan",
  "tasks",
  "cwd",
  "help",
]);
const booleanFlags = new Set(["json", "events", "accept", "dry-run", "help"]);
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
  ],
  status: [],
  list: ["feature", "limit", "cursor", "status"],
  resume: ["expected-revision", "command-id", "events", "after"],
  approve: ["request", "digest", "expected-revision", "command-id"],
  answer: ["request", "answers-file", "expected-revision", "command-id"],
  evidence: ["request", "file", "accept", "expected-revision", "command-id"],
  reject: ["request", "reason", "expected-revision", "command-id"],
  pause: ["expected-revision", "command-id"],
  cancel: ["expected-revision", "command-id"],
  fork: ["expected-revision", "command-id"],
  revise: ["candidate", "expected-revision", "command-id"],
  candidate: ["spec", "plan", "tasks", "policy", "command-id"],
  profiles: [],
  artifacts: ["file"],
  import: ["source", "path", "feature", "command-id"],
  export: ["destination"],
  "export-progress": [],
  gc: ["before", "dry-run"],
  redact: ["file", "reason"],
  recover: ["request", "effect", "resolution", "file", "expected-revision", "command-id"],
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
    if (["expected-revision", "limit", "after"].includes(name)) {
      const value = Number(result.flags[name]);
      if (
        !Number.isSafeInteger(value) ||
        value < (name === "limit" ? 1 : 0) ||
        !/^\d+$/.test(String(result.flags[name]))
      )
        throw new WorkflowFault("INVALID_DEFINITION", `--${name} requires an integer`);
    }
  }
  if (!result.flags.help && result.command !== "run") {
    const count = ["list", "profiles", "import", "gc"].includes(result.command) ? 0 : 1;
    if (result.positional.length !== count)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `${result.command} expects ${count} positional argument(s)`,
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
  }
  return result;
}
export const workflowHelp = `baked workflow <command> [options]

run [sdd] --feature ID (--prompt TEXT | --prompt-file FILE) [--policy FILE] [--model ID] [--events]
status RUN_ID [--json]
list [--feature ID] [--status STATUS] [--limit 20] [--cursor RUN_ID]
  --status accepts: ${RunStatus.options.join(", ")}
resume RUN_ID --expected-revision N [--events]
approve RUN_ID --request ID --digest SHA256 --expected-revision N
answer RUN_ID --request ID --answers-file FILE --expected-revision N
evidence RUN_ID --request ID --file FILE --accept --expected-revision N
reject RUN_ID --request ID --reason TEXT --expected-revision N
pause|cancel|fork RUN_ID --expected-revision N
candidate RUN_ID [--spec FILE] [--plan FILE] [--tasks FILE] [--policy FILE]
revise RUN_ID --candidate SHA256 --expected-revision N
recover RUN_ID --request ID --effect ID --resolution record-applied|record-not-applied|retry|cancel --file EVIDENCE --expected-revision N
profiles                  artifacts RUN_ID [--file ARTIFACT_ID]
import --source spec-kit|ecc|markdown-edit --path DIRECTORY --feature ID
export RUN_ID --destination DIRECTORY    export-progress RUN_ID
gc --before ISO_DATE [--dry-run]          redact RUN_ID --file ARTIFACT_ID --reason TEXT

Management mutations accept --command-id UUID for idempotent retries.
All commands accept --help. Workflows require an explicit workflows.enabled opt-in.
Drive exit codes: 0 completed, 1 error, 2 deadline, 3 waiting, 4 blocked,
5 revision/lease/input conflict, 130 paused/cancelled. Management success returns 0.
No daemon continues execution after the command exits.
`;

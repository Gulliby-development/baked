import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultWorkflowPolicy } from "../core/workflows/defaults.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import { InitiativePlanSchema, SplitEditSchema } from "../core/workflows/initiatives/plan.js";
import { InitiativeService, type InitiativeView } from "../core/workflows/initiatives/service.js";
import {
  type BudgetLimitsValue,
  CostToleranceSchema,
  type CostToleranceValue,
} from "../core/workflows/initiatives/store.js";
import { PolicySchema } from "../core/workflows/schemas.js";
import type { NativeWorkflowService } from "../core/workflows/service.js";
import { newId } from "../core/workflows/store.js";

const subcommands = [
  "start",
  "show",
  "list",
  "events",
  "estimate",
  "merge",
  "split",
  "remove",
  "rename",
  "set-workflow",
  "set-size",
  "approve",
  "reject",
  "drive",
  "resume",
  "pause",
  "replan",
  "extend",
  "reroute",
] as const;
export type InitiativeCommand = (typeof subcommands)[number];
export interface InitiativeArgs {
  command: InitiativeCommand;
  positional: string[];
  flags: Record<string, string | true>;
}

const mutation = ["expected-revision", "command-id"];
const commandFlags: Record<InitiativeCommand, string[]> = {
  start: [
    "prompt",
    "prompt-file",
    "plan",
    "workflow",
    "policy",
    "owner",
    "model",
    "budget-tokens",
    "budget-calls",
    "budget-time-ms",
    "budget-usd",
    "cost-tolerance",
    "tiered-approval",
    "max-tasks",
    "max-files",
    "confirm-auto-approval",
    "worktree",
    "command-id",
  ],
  show: [],
  list: [],
  events: ["after", "limit"],
  estimate: [],
  merge: ["features", "id", "title", ...mutation],
  split: ["feature", "parts", ...mutation],
  remove: ["feature", ...mutation],
  rename: ["feature", "title", ...mutation],
  "set-workflow": ["feature", "workflow", ...mutation],
  "set-size": ["feature", "size", ...mutation],
  approve: ["request", "digest", ...mutation],
  reject: ["request", "reason", ...mutation],
  drive: [],
  resume: mutation,
  pause: mutation,
  replan: ["feature", ...mutation],
  extend: ["tokens", "calls", "time-ms", "budget-usd", ...mutation],
  reroute: ["model", "resume", ...mutation],
};
const booleanFlags = new Set(["json", "help", "tiered-approval", "resume", "worktree"]);
const integerFlags = new Set([
  "expected-revision",
  "after",
  "limit",
  "tokens",
  "calls",
  "time-ms",
  "budget-tokens",
  "budget-calls",
  "budget-time-ms",
  "max-tasks",
  "max-files",
]);

export function parseInitiativeArgs(argv: string[]): InitiativeArgs {
  const command = argv[0];
  if (!subcommands.includes(command as InitiativeCommand))
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `Unknown initiative command ${command ?? ""}. Commands: ${subcommands.join(", ")}`,
    );
  const result: InitiativeArgs = {
    command: command as InitiativeCommand,
    positional: [],
    flags: {},
  };
  const allowed = new Set(["json", "cwd", "help", ...commandFlags[result.command]]);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      result.positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!allowed.has(name) || name in result.flags)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        `Unknown, duplicate or invalid option ${token} for initiative ${result.command}`,
      );
    if (booleanFlags.has(name)) {
      result.flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (!value || value.startsWith("--"))
      throw new WorkflowFault("INVALID_DEFINITION", `${token} needs a value`);
    if (integerFlags.has(name) && !/^\d+$/.test(value))
      throw new WorkflowFault("INVALID_DEFINITION", `${token} requires an integer`);
    if (name === "budget-usd" && !(/^\d+(\.\d+)?$/.test(value) && Number(value) > 0))
      throw new WorkflowFault("INVALID_DEFINITION", `${token} requires a positive dollar amount`);
    if (name === "cost-tolerance" && !CostToleranceSchema.safeParse(costTolerance(value)).success)
      throw new WorkflowFault("INVALID_DEFINITION", `${token} takes auto, off or 0 to 0.5`);
    result.flags[name] = value;
  }
  if (result.flags.help) return result;
  const count = result.command === "list" ? 0 : 1;
  if (result.positional.length !== count)
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      `initiative ${result.command} expects ${count} positional argument(s)`,
    );
  if (result.command === "start") {
    if (Number(!!result.flags.prompt) + Number(!!result.flags["prompt-file"]) !== 1)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Specify exactly one of --prompt or --prompt-file",
      );
    const budget = ["budget-tokens", "budget-calls", "budget-time-ms"].filter(
      (f) => f in result.flags,
    );
    if (budget.length !== 0 && budget.length !== 3)
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "A shared budget needs all of --budget-tokens, --budget-calls and --budget-time-ms",
      );
    if ("cost-tolerance" in result.flags && !("budget-usd" in result.flags))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--cost-tolerance applies only with --budget-usd",
      );
    if (
      !result.flags["tiered-approval"] &&
      ("max-tasks" in result.flags || "max-files" in result.flags)
    )
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "--max-tasks and --max-files apply only with --tiered-approval",
      );
  }
  return result;
}

const stringFlag = (args: InitiativeArgs, name: string, fallback?: string): string => {
  const value = args.flags[name] ?? fallback;
  if (typeof value !== "string")
    throw new WorkflowFault("INVALID_DEFINITION", `--${name} is required`);
  return value;
};
const numberFlag = (args: InitiativeArgs, name: string): number | undefined =>
  typeof args.flags[name] === "string" ? Number(args.flags[name]) : undefined;
/** `auto`, `off`, or a share of the cap such as 0.2. */
const costTolerance = (value: string): CostToleranceValue =>
  value === "auto" || value === "off" ? value : Number(value);

export async function executeInitiativeCommand(
  initiatives: InitiativeService,
  args: InitiativeArgs,
  signal: AbortSignal,
): Promise<unknown> {
  const workflows = initiatives.workflows;
  const id = args.positional[0] ?? "";
  const identity = () => ({
    commandId: stringFlag(args, "command-id", newId()),
    expectedRevision: Number(stringFlag(args, "expected-revision")),
  });
  const readFlagFile = (flag: string): string =>
    readFileSync(resolve(workflows.workspace, stringFlag(args, flag)), "utf8");
  const feature = () => stringFlag(args, "feature");
  switch (args.command) {
    case "start": {
      const tokens = numberFlag(args, "budget-tokens");
      const calls = numberFlag(args, "budget-calls");
      const ms = numberFlag(args, "budget-time-ms");
      const budget: BudgetLimitsValue | null =
        tokens !== undefined && calls !== undefined && ms !== undefined
          ? { maxTotalTokens: tokens, maxAgentCalls: calls, maxActiveMs: ms }
          : null;
      await initiatives.start({
        commandId: stringFlag(args, "command-id", newId()),
        initiativeId: id,
        prompt: args.flags["prompt-file"]
          ? readFlagFile("prompt-file")
          : stringFlag(args, "prompt"),
        ...(args.flags.plan
          ? { plan: InitiativePlanSchema.parse(JSON.parse(readFlagFile("plan"))) }
          : {}),
        policy: PolicySchema.parse({
          ...PolicySchema.parse(
            args.flags.policy
              ? JSON.parse(readFlagFile("policy"))
              : (workflows.config.workflows?.policy ?? defaultWorkflowPolicy),
          ),
          ...(args.flags.worktree ? { executionMode: "worktree" } : {}),
        }),
        workflowId: stringFlag(
          args,
          "workflow",
          workflows.config.workflows?.defaultWorkflow ?? "sdd",
        ),
        budget,
        costBudget:
          typeof args.flags["budget-usd"] === "string"
            ? {
                maxCostUsd: Number(args.flags["budget-usd"]),
                costTolerance: costTolerance(stringFlag(args, "cost-tolerance", "off")),
              }
            : null,
        featureAutoApproval: args.flags["tiered-approval"]
          ? {
              maxTasks: numberFlag(args, "max-tasks") ?? 5,
              maxFiles: numberFlag(args, "max-files") ?? 10,
            }
          : null,
        ...(typeof args.flags["confirm-auto-approval"] === "string"
          ? { autoApprovalConfirmation: args.flags["confirm-auto-approval"] }
          : {}),
        ...(typeof args.flags.model === "string" ? { model: args.flags.model } : {}),
        ownerLabel: stringFlag(args, "owner", "CLI"),
      });
      return initiatives.drive(id, signal);
    }
    case "show":
      return initiatives.view(id);
    case "list":
      return initiatives.list().map((view) => ({
        initiativeId: view.initiativeId,
        title: view.title,
        status: view.status,
        features: view.features.length,
        next: view.next,
      }));
    case "estimate": {
      const estimate = initiatives.estimate(id);
      if (!estimate)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          `Initiative ${id} has no split to estimate yet`,
        );
      return estimate;
    }
    case "events":
      return initiatives.events(
        id,
        numberFlag(args, "after") ?? 0,
        Math.min(1000, numberFlag(args, "limit") ?? 200),
      );
    case "merge":
      return initiatives.edit(
        id,
        identity(),
        SplitEditSchema.parse({
          op: "merge",
          featureIds: stringFlag(args, "features")
            .split(",")
            .map((f) => f.trim()),
          ...(typeof args.flags.id === "string" ? { id: args.flags.id } : {}),
          ...(typeof args.flags.title === "string" ? { title: args.flags.title } : {}),
        }),
      );
    case "split":
      return initiatives.edit(
        id,
        identity(),
        SplitEditSchema.parse({
          op: "split",
          featureId: feature(),
          into: JSON.parse(readFlagFile("parts")),
        }),
      );
    case "remove":
      return initiatives.edit(id, identity(), { op: "remove", featureId: feature() });
    case "rename":
      return initiatives.edit(id, identity(), {
        op: "rename",
        featureId: feature(),
        title: stringFlag(args, "title"),
      });
    case "set-workflow":
      return initiatives.edit(id, identity(), {
        op: "workflow",
        featureId: feature(),
        workflow: stringFlag(args, "workflow"),
      });
    case "set-size":
      return initiatives.edit(
        id,
        identity(),
        SplitEditSchema.parse({ op: "size", featureId: feature(), size: stringFlag(args, "size") }),
      );
    case "approve":
      await initiatives.approve(id, identity(), {
        requestId: stringFlag(args, "request"),
        digest: stringFlag(args, "digest"),
      });
      return initiatives.drive(id, signal);
    case "reject":
      return initiatives.reject(id, identity(), {
        requestId: stringFlag(args, "request"),
        reason: stringFlag(args, "reason"),
      });
    case "drive":
      return initiatives.drive(id, signal);
    case "resume":
      await initiatives.resume(id, identity());
      return initiatives.drive(id, signal);
    case "pause":
      return initiatives.pause(id, identity());
    case "replan":
      return initiatives.replan(id, identity(), feature());
    case "extend": {
      const tokens = numberFlag(args, "tokens");
      const calls = numberFlag(args, "calls");
      const ms = numberFlag(args, "time-ms");
      const usd = numberFlag(args, "budget-usd");
      return initiatives.extendBudget(id, identity(), {
        ...(tokens !== undefined ? { maxTotalTokens: tokens } : {}),
        ...(calls !== undefined ? { maxAgentCalls: calls } : {}),
        ...(ms !== undefined ? { maxActiveMs: ms } : {}),
        ...(usd !== undefined ? { maxCostUsd: usd } : {}),
      });
    }
    case "reroute": {
      const resume = args.flags.resume === true;
      const view = await initiatives.reroute(id, identity(), {
        model: stringFlag(args, "model"),
        resume,
      });
      return resume ? initiatives.drive(id, signal) : view;
    }
  }
}

/** Exit code of a driving command, after the same scheme as `baked workflow run`. */
export function initiativeExit(view: InitiativeView): number {
  if (view.status === "completed") return 0;
  if (view.status === "refused") return 1;
  if (view.status === "paused") return 130;
  return ["await_split_approval", "decide"].includes(view.next.kind)
    ? 3
    : view.next.kind === "blocked"
      ? 4
      : 0;
}

const DRIVING: readonly InitiativeCommand[] = ["start", "approve", "drive", "resume"];
const READING: readonly InitiativeCommand[] = ["show", "list", "events", "estimate"];

export async function runInitiativeCli(
  argv: string[],
  open: (readonly: boolean) => NativeWorkflowService,
  signal: AbortSignal,
): Promise<number> {
  if (!argv[0] || argv[0] === "--help" || argv.includes("-h")) {
    process.stdout.write(initiativeHelp);
    return 0;
  }
  const args = parseInitiativeArgs(argv);
  if (args.flags.help) {
    process.stdout.write(initiativeHelp);
    return 0;
  }
  const workflows = open(READING.includes(args.command));
  try {
    const initiatives = new InitiativeService(workflows);
    const result = await executeInitiativeCommand(initiatives, args, signal);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const driving =
      DRIVING.includes(args.command) || (args.command === "reroute" && args.flags.resume === true);
    return driving ? initiativeExit(result as InitiativeView) : 0;
  } finally {
    workflows.close();
  }
}

export const initiativeHelp = `baked workflow initiative <command> [options]

start ID (--prompt TEXT | --prompt-file FILE) [--plan FILE] [--workflow sdd] [--policy FILE]
    [--budget-tokens N --budget-calls N --budget-time-ms N] [--budget-usd N [--cost-tolerance auto|off|0.2]]
    [--tiered-approval [--max-tasks 5] [--max-files 10]]
    [--confirm-auto-approval HASH] [--model ID] [--worktree]
  Split a large request into 3..12 features. Without --plan the decomposer proposes the split;
  a split above 12 features is refused with a request to split the work into stages. Each
  feature runs its own workflow (--workflow is the default for a feature that names none) and
  takes a budget share weighted by its estimated need (by size without history). --budget-usd
  gives the initiative a dollar cap its feature runs share; once a feature is accepted, no feature
  starts while the projected total passes the cap and its tolerance. --worktree runs feature runs in worktrees, so
  independent features run side by side.
show ID | list | events ID [--after SEQ] [--limit 200]
estimate ID
  Estimate the split: a level from 1 to 5 by planned tasks and a token range per feature and in
  total, from this project's run history, with a 25% margin compared with the shared budget.
merge ID --features A,B[,C] [--id NEW] [--title TEXT] --expected-revision N
split ID --feature F --parts FILE --expected-revision N   (FILE: [{"id","title","scope?","paths?","contract?"}, ...])
remove ID --feature F --expected-revision N    rename ID --feature F --title TEXT --expected-revision N
set-workflow ID --feature F --workflow W --expected-revision N   (a feature others depend on needs a spec)
set-size ID --feature F --size small|medium|large --expected-revision N
  Each edit makes a new plan revision with a new approval digest; edit while awaiting approval or paused.
approve ID --request ID --digest SHA256 --expected-revision N   (approve the split, then drive)
reject ID --request ID --reason TEXT --expected-revision N
drive ID                  run feature runs in dependency order until a person is needed
pause|resume ID --expected-revision N
replan ID --feature F --expected-revision N   (run one feature again; other results stay)
extend ID --expected-revision N [--tokens N] [--calls N] [--time-ms N] [--budget-usd N]   (raise the shared budget)
reroute ID --model ID --expected-revision N [--resume]
  Feature runs started from now on use the model, and the stopped open runs move to it as with
  baked workflow reroute (same checks, run.rerouted events); every run is checked before any is
  changed. Pause the initiative first if a run is executing. --resume continues blocked rerouted
  runs and a paused initiative, then drives it.
  Feature run decisions use the run commands: baked workflow approve RUN_ID ...
  Exit codes of start, approve, drive and resume: 0 completed or progressing, 1 refused or error,
  3 waiting for a decision, 4 blocked, 5 revision conflict, 130 paused.
`;

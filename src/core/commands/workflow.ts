import { reasonText } from "../../components/workflow/format.js";
import { tuiErrorText, tuiRecoveryText } from "../../components/workflow/remedies.js";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../../config/index.js";
import { parseWorkflowArgs, workflowHelp } from "../../headless/workflow-parse.js";
import { formatDoctor } from "../../headless/workflow-pre-run.js";
import { workflowSession } from "../../hooks/useWorkflow.js";
import { useUIStore } from "../../stores/ui.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import { type CriticOutcomes, formatCriticOutcomes } from "../workflows/critic-outcomes.js";
import type { DoctorReport } from "../workflows/doctor.js";
import type { RunSnapshot } from "../workflows/schemas.js";
import { describeSddExport, isSddExport } from "../workflows/sdd-export/describe.js";
import { QUICK_WORKFLOW_ID } from "../workflows/v2/definitions.js";
import type { CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

export function splitWorkflowCommand(input: string): string[] {
  const words = input.match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  return words.map((word) =>
    word.startsWith('"')
      ? (JSON.parse(word) as string)
      : word.startsWith("'")
        ? word.slice(1, -1)
        : word,
  );
}
const isSnapshot = (value: unknown): value is RunSnapshot =>
  !!value &&
  typeof value === "object" &&
  "runId" in value &&
  "status" in value &&
  "featureId" in value;

const isReport = (value: unknown): value is { runId: string; markdown: string } =>
  !!value && typeof value === "object" && "markdown" in value && typeof value.markdown === "string";
const isWrittenReport = (
  value: unknown,
): value is { runId: string; path: string; bytes: number; usage?: true } =>
  !!value && typeof value === "object" && "path" in value && "bytes" in value && "runId" in value;

const isDoctorReport = (value: unknown): value is DoctorReport =>
  !!value &&
  typeof value === "object" &&
  "checks" in value &&
  Array.isArray(value.checks) &&
  "ready" in value &&
  "workflowId" in value &&
  "runModel" in value;

/** Short chat summary; the panel carries the details. Unknown result shapes stay as JSON. */
export function formatWorkflowResult(result: unknown): string {
  if (isDoctorReport(result))
    return formatDoctor({
      ...result,
      checks: result.checks.map((check) => ({
        ...check,
        fix: tuiRecoveryText(check.fix ?? "", check.recovery),
      })),
    });
  if (isSnapshot(result)) {
    const reason = result.reason !== "none" ? ` — ${reasonText(result.reason)}` : "";
    const waiting = result.pendingRequestIds.length
      ? "\nA decision is waiting: open /workflow and press Enter."
      : "";
    return `Workflow ${result.featureId}: ${result.status}${reason}.${waiting}\nRun ${result.runId} · /workflow opens the panel.`;
  }
  if (isReport(result)) return result.markdown;
  if (isSddExport(result)) return describeSddExport(result);
  if (result && typeof result === "object" && "criticOutcomes" in result)
    return formatCriticOutcomes(result as CriticOutcomes);
  if (isWrittenReport(result))
    return `${result.usage ? "Run usage" : "Run report"} written to ${result.path}.`;
  return JSON.stringify(result, null, 2);
}
const SHORT_HELP = `
/workflow            Open the workflow panel (runs, approvals, progress)
/workflow new [text] Open the new-run form, optionally prefilled
/workflow quick [text] The same form on the quick workflow for a small task
/workflow gates      Add, edit, remove and try the checks every run uses
/workflow definitions  Each workflow's family and line, and a step-through of a run along it
/workflow edit ID    Edit a workflow definition: stages, transitions and their gates
/workflow routing    Which model runs each class, role, stage and profile (modelRouting)
/workflow usage      Tokens and cost of every run over 7, 30 or 90 days, by model, stage or day
/workflow report ID  The run's report in Markdown (--output FILE writes it)
/workflow usage ID --format md  The run's tokens and cost in Markdown (--output FILE)
/workflow outcomes   Critic scores with how each attempt turned out (--refresh reads Git)
/workflow compare A B  Two runs side by side: routes, tokens, cost, time, review (A/B)
/workflow help       All commands (run, status, approve, recover, export…)`.trim();

/** The definition a quick task starts with in this project. */
function quickWorkflowId(cwd: string): string {
  return (
    mergeConfigs(loadConfig(), loadProjectConfig(cwd)).workflows?.quickWorkflow ?? QUICK_WORKFLOW_ID
  );
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/workflow", async (input, ctx) => {
    const tokens = splitWorkflowCommand(input).slice(1);
    const ui = useWorkflowStore.getState();
    if (!tokens.length || tokens[0] === "list") {
      ui.showHome();
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "gates") {
      ui.showGates();
      useUIStore.getState().openModal("workflow");
      return;
    }
    // The workflows screen; `baked workflow definitions` keeps the JSON listing.
    if ((tokens[0] === "definitions" || tokens[0] === "workflows") && tokens.length === 1) {
      ui.showWorkflows();
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "routing") {
      ui.showRouting();
      useUIStore.getState().openModal("workflow");
      return;
    }
    // With a run ID, `usage` stays the per-run report of the workflow commands.
    if (tokens[0] === "usage" && tokens.length === 1) {
      ui.showUsage();
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "edit") {
      const id = tokens[1];
      if (!id) {
        sysMsg(ctx, "Usage: /workflow edit ID (for example /workflow edit standard)");
        return;
      }
      ui.showEditor(id);
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "new") {
      ui.showNew(tokens.slice(1).join(" "));
      useUIStore.getState().openModal("workflow");
      return;
    }
    // A quick task opens the form on the quick workflow, so the plan is still started by a person.
    if (tokens[0] === "quick" && !tokens.includes("--help")) {
      ui.showNew(tokens.slice(1).join(" "), quickWorkflowId(ctx.cwd));
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "help" || tokens.includes("--help")) {
      sysMsg(ctx, `${SHORT_HELP}\n\n${workflowHelp.replaceAll("baked workflow", "/workflow")}`);
      return;
    }
    const args = parseWorkflowArgs(tokens);
    if (args.command === "run" && args.flags.model === undefined)
      tokens.push("--model", ctx.chat.activeModel);
    const service = workflowSession(ctx.cwd);
    const result = await service
      .command(tokens, new AbortController().signal, (runId) => {
        useWorkflowStore.getState().select(runId, ctx.tabMgr.activeTabId);
        useUIStore.getState().openModal("workflow");
      })
      .catch((error: unknown) => {
        throw new Error(tuiErrorText(error));
      });
    if (
      args.command !== "report" &&
      args.flags.format !== "md" &&
      result &&
      typeof result === "object" &&
      "runId" in result
    ) {
      useWorkflowStore.getState().select(String(result.runId), ctx.tabMgr.activeTabId);
      useUIStore.getState().openModal("workflow");
    }
    sysMsg(ctx, formatWorkflowResult(result));
  });
}

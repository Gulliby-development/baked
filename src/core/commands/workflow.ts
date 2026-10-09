import { reasonText } from "../../components/workflow/format.js";
import { parseWorkflowArgs, workflowHelp } from "../../headless/workflow-parse.js";
import { workflowSession } from "../../hooks/useWorkflow.js";
import { useUIStore } from "../../stores/ui.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import type { RunSnapshot } from "../workflows/schemas.js";
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

/** Short chat summary; the panel carries the details. Unknown result shapes stay as JSON. */
export function formatWorkflowResult(result: unknown): string {
  if (isSnapshot(result)) {
    const reason = result.reason !== "none" ? ` — ${reasonText(result.reason)}` : "";
    const waiting = result.pendingRequestIds.length
      ? "\nA decision is waiting: open /workflow and press Enter."
      : "";
    return `Workflow ${result.featureId}: ${result.status}${reason}.${waiting}\nRun ${result.runId} · /workflow opens the panel.`;
  }
  return JSON.stringify(result, null, 2);
}
const SHORT_HELP = `
/workflow            Open the workflow panel (runs, approvals, progress)
/workflow new [text] Open the new-run form, optionally prefilled
/workflow help       All commands (run, status, approve, recover, export…)`.trim();

export function register(map: Map<string, CommandHandler>): void {
  map.set("/workflow", async (input, ctx) => {
    const tokens = splitWorkflowCommand(input).slice(1);
    const ui = useWorkflowStore.getState();
    if (!tokens.length || tokens[0] === "list") {
      ui.showHome();
      useUIStore.getState().openModal("workflow");
      return;
    }
    if (tokens[0] === "new") {
      ui.showNew(tokens.slice(1).join(" "));
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
    const result = await service.command(tokens, new AbortController().signal, (runId) => {
      useWorkflowStore.getState().select(runId, ctx.tabMgr.activeTabId);
      useUIStore.getState().openModal("workflow");
    });
    if (result && typeof result === "object" && "runId" in result) {
      useWorkflowStore.getState().select(String(result.runId), ctx.tabMgr.activeTabId);
      useUIStore.getState().openModal("workflow");
    }
    sysMsg(ctx, formatWorkflowResult(result));
  });
}

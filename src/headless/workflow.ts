import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadEffectiveProjectConfig, mergeConfigs } from "../config/index.js";
import { getCwd } from "../core/cwd.js";
import { loadModelCatalog } from "../core/llm/model-catalog.js";
import { parseRouteOverrides } from "../core/llm/model-routing.js";
import { WorkflowArtifacts } from "../core/workflows/artifacts.js";
import { type BudgetLimits, type BudgetPresetId, presetPolicy } from "../core/workflows/budget.js";
import { defaultWorkflowPolicy } from "../core/workflows/defaults.js";
import { executeDelivery, prepareDelivery } from "../core/workflows/delivery.js";
import type { PullRequestProvider } from "../core/workflows/delivery-provider.js";
import { preRunEstimate, runDoctor } from "../core/workflows/doctor.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import { uniqueFeatureId } from "../core/workflows/feature-id.js";
import { issueStart } from "../core/workflows/issue-source.js";
import {
  editProjectMemory,
  type MemoryEdit,
  type ProjectMemoryView,
  projectMemoryView,
} from "../core/workflows/project-memory.js";
import { ROLLBACK_ARTIFACT_KIND } from "../core/workflows/rollback.js";
import { explainRoute, type RouteExplanation, routedProfiles } from "../core/workflows/routing.js";
import { runReport } from "../core/workflows/run-report.js";
import {
  type Decision,
  PolicySchema,
  type RunSnapshot,
  type RunState,
} from "../core/workflows/schemas.js";
import { NativeWorkflowService } from "../core/workflows/service.js";
import { newId } from "../core/workflows/store.js";
import { runUsage } from "../core/workflows/usage.js";
import { runUsageMarkdown } from "../core/workflows/usage-markdown.js";
import { recordedSteps } from "../core/workflows/v2/acceptance-gate.js";
import { QUICK_WORKFLOW_ID } from "../core/workflows/v2/definitions.js";
import { readRoutingSummary } from "../core/workflows/view.js";
import { worktreeView } from "../core/workflows/worktree.js";
import type { AppConfig } from "../types/index.js";
import { followProgress } from "./progress.js";
import { DEFINITION_COMMANDS, executeDefinitionCommand } from "./workflow-definitions.js";
import { executeGateCommand } from "./workflow-gate.js";
import { runInitiativeCli } from "./workflow-initiative.js";
import { formatWorkflowModels, workflowModels } from "./workflow-models.js";
import {
  DECISION_COMMANDS,
  parseWorkflowArgs,
  type WorkflowArgs,
  workflowHelp,
} from "./workflow-parse.js";
import { formatDoctor, formatEstimate, preRunRequest } from "./workflow-pre-run.js";
import { runRoutingCli } from "./workflow-routing.js";

export function workflowExit(
  snapshot: RunSnapshot,
  maxActiveMs = Number.POSITIVE_INFINITY,
): number {
  if (snapshot.status === "completed") return 0;
  if (snapshot.reason === "budget_exhausted" && snapshot.activeMs >= maxActiveMs) return 2;
  if (["input_changed", "workspace_busy"].includes(snapshot.reason)) return 5;
  return { created: 0, running: 0, waiting: 3, paused: 130, blocked: 4, failed: 1, cancelled: 130 }[
    snapshot.status
  ];
}
const stringFlag = (args: WorkflowArgs, name: string, fallback?: string): string => {
  const value = args.flags[name] ?? fallback;
  if (typeof value !== "string")
    throw new WorkflowFault("INVALID_DEFINITION", `--${name} is required`);
  return value;
};
/**
 * The `run` a quick task stands for: the quick workflow (or `workflows.quickWorkflow`), the task
 * text as the prompt and a feature ID derived from it unless `--feature` names one.
 */
export function quickRunArgs(service: NativeWorkflowService, args: WorkflowArgs): WorkflowArgs {
  const { "prompt-file": promptFile, ...flags } = args.flags;
  const prompt =
    typeof promptFile === "string"
      ? readFileSync(resolve(service.store.workspace, promptFile), "utf8")
      : args.positional.join(" ");
  if (!prompt.trim()) throw new WorkflowFault("INVALID_DEFINITION", "Describe the task to run");
  const feature =
    typeof flags.feature === "string"
      ? flags.feature
      : uniqueFeatureId(prompt, (id) => service.store.list(1, id).items.length > 0);
  return {
    command: "run",
    positional: [],
    flags: {
      ...flags,
      workflow: service.config.workflows?.quickWorkflow ?? QUICK_WORKFLOW_ID,
      feature,
      prompt,
    },
  };
}
const modelFlag = (args: WorkflowArgs, config: AppConfig): string =>
  typeof args.flags.model === "string" ? args.flags.model : config.defaultModel;
const routeRequest = (args: WorkflowArgs, config: AppConfig) => ({
  workflowId:
    (typeof args.flags.workflow === "string" ? args.flags.workflow : undefined) ??
    args.positional[0] ??
    config.workflows?.defaultWorkflow ??
    "sdd",
  model: typeof args.flags.model === "string" ? args.flags.model : undefined,
  ...(typeof args.flags.route === "string"
    ? { routes: parseRouteOverrides(args.flags.route) }
    : {}),
});
/** A table of stages and profiles with their models and the source of each choice. */
export function formatRoute(route: RouteExplanation): string {
  const extras = (entry: { effort?: string | null; fallback?: string[] } | undefined): string[] => [
    entry?.effort ?? "",
    entry?.fallback?.length ? entry.fallback.join(", ") : "",
  ];
  const rows: string[][] = [["STAGE", "KIND", "MODEL", "SOURCE", "EFFORT", "FALLBACK"]];
  for (const stage of route.stages) {
    const own = stage.profileId ? route.profiles[stage.profileId] : undefined;
    rows.push([
      stage.stageId,
      stage.kind,
      stage.model ?? own?.model ?? "(per profile)",
      stage.source ?? (own ? `${own.source} via ${stage.profileId}` : "-"),
      ...extras(stage.model ? stage : own),
    ]);
  }
  rows.push([], ["PROFILE", "", "MODEL", "SOURCE", "EFFORT", "FALLBACK"]);
  for (const [id, entry] of Object.entries(route.profiles).sort(([a], [b]) => a.localeCompare(b)))
    rows.push([id, "", entry.model, entry.source, ...extras(entry)]);
  const columns = rows[0]?.length ?? 0;
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((r) => r[i]?.length ?? 0)),
  );
  const lines = rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  "));
  const warnings = route.warnings.length
    ? `\n${route.warnings.map((w) => `warning: ${w}`).join("\n")}\n`
    : "";
  return `Workflow ${route.workflowId}, run model ${route.runModel}\n\n${lines.join("\n").replace(/ +$/gm, "")}\n${warnings}`;
}
/** Project memory as `baked workflow memory` prints it: one entry per line with its ID. */
export function formatProjectMemory(view: ProjectMemoryView & { id?: string }): string {
  const KIND = { note: "note", answer: "answer", assumption: "assume", check: "check" } as const;
  const line = (e: ProjectMemoryView["hidden"][number], extra = ""): string => {
    const source = e.runId ? ` (run ${e.runId.slice(0, 8)})` : "";
    const head = `${e.id}  ${KIND[e.kind].padEnd(6)}  `;
    const body =
      e.kind === "answer"
        ? `Q: ${e.question ?? ""}\n${" ".repeat(head.length)}A: ${e.text}`
        : e.text;
    return `${head}${body}${source}${e.recorded ? " [edited]" : ""}${extra}`;
  };
  const out: string[] = [];
  if (view.id) out.push(`Changed ${view.id}.`, "");
  if (!view.enabled)
    out.push("Project memory is off for new runs (workflow policy projectMemory: false).", "");
  out.push(
    view.entries.length
      ? `Project memory new runs read (${String(view.entries.length)}):`
      : "Project memory is empty: earlier runs recorded nothing and there are no notes.",
    ...view.entries.map((e) => line(e, e.sent ? "" : " [not sent: the policy's own check]")),
  );
  if (view.hidden.length)
    out.push("", `Forgotten (${String(view.hidden.length)}):`, ...view.hidden.map((e) => line(e)));
  return `${out.join("\n")}\n`;
}
/** AI walk-throughs of a run: their phase, verdict, recorded steps and generated test. */
function walkThroughs(store: NativeWorkflowService["store"], runId: string) {
  return Object.fromEntries(
    Object.entries(store.state(runId).acceptance ?? {}).map(([gateId, entry]) => [
      gateId,
      {
        ...entry,
        steps: entry?.attemptId
          ? recordedSteps(store, runId, gateId, entry.attemptId).map((s) => ({
              stepId: s.stepId,
              action: s.action,
              observation: s.observation,
              expectationIds: s.expectationIds,
            }))
          : [],
      },
    ]),
  );
}
export async function executeWorkflowCommand(
  service: NativeWorkflowService,
  args: WorkflowArgs,
  signal: AbortSignal,
  onDrive?: (runId: string) => void,
  options: { pullRequests?: PullRequestProvider | null } = {},
): Promise<unknown> {
  const runId = args.positional[0] ?? "";
  const artifacts = new WorkflowArtifacts(service);
  /** Records a decision; with `--resume` the run continues from it when nothing else is pending. */
  const decideThenResume = async (decision: Decision): Promise<unknown> => {
    const decided = await service.decide(runId, identity(), decision);
    if (args.flags.resume !== true || !service.canResumeAfterDecision(runId)) return decided;
    await service.resume(runId, { commandId: newId(), expectedRevision: decided.revision });
    onDrive?.(runId);
    return service.drive(runId, signal);
  };
  const identity = () => {
    const revision = Number(stringFlag(args, "expected-revision"));
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new WorkflowFault("INVALID_DEFINITION", "Expected a nonnegative integer revision");
    return { commandId: stringFlag(args, "command-id", newId()), expectedRevision: revision };
  };
  const readFlagFile = (flag: string): string => {
    const inline = args.inline?.[flag];
    return typeof inline === "string"
      ? inline
      : readFileSync(resolve(service.store.workspace, stringFlag(args, flag)), "utf8");
  };
  const jsonFile = (flag: string): unknown =>
    args.inline && flag in args.inline ? args.inline[flag] : JSON.parse(readFlagFile(flag));
  // `--policy FILE` or the configured policy, scaled by `--budget`.
  const startPolicy = (run: WorkflowArgs) =>
    presetPolicy(
      run.flags.policy ? jsonFile("policy") : service.config.workflows?.policy,
      typeof run.flags.budget === "string" ? (run.flags.budget as BudgetPresetId) : "standard",
    );
  switch (args.command) {
    case "quick": {
      const run = quickRunArgs(service, args);
      const policy = startPolicy(run);
      if (!policy.checks.some((c) => c.scope === "feature"))
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "A quick task needs at least one feature check in the workflow policy (workflows.policy.checks); /workflow gates adds them",
        );
      return executeWorkflowCommand(service, run, signal, onDrive, options);
    }
    case "run": {
      const policy = startPolicy(args);
      const typed = args.flags["prompt-file"]
        ? readFlagFile("prompt-file")
        : typeof args.flags.prompt === "string"
          ? args.flags.prompt
          : undefined;
      const fromIssue =
        typeof args.flags.issue === "string"
          ? await issueStart(service.store.workspace, service.config, {
              reference: args.flags.issue,
              ...(typed !== undefined ? { prompt: typed } : {}),
              ...(typeof args.flags.feature === "string" ? { featureId: args.flags.feature } : {}),
            })
          : null;
      const run = await service.start({
        commandId: stringFlag(args, "command-id", newId()),
        workflowId: stringFlag(
          args,
          "workflow",
          args.positional[0] ?? service.config.workflows?.defaultWorkflow ?? "sdd",
        ),
        featureId: fromIssue?.featureId ?? stringFlag(args, "feature"),
        prompt: fromIssue?.prompt ?? typed ?? stringFlag(args, "prompt"),
        ...(fromIssue ? { issue: fromIssue.issue } : {}),
        policy,
        ownerLabel: stringFlag(args, "owner", "CLI"),
        ...(typeof args.flags.model === "string" ? { model: args.flags.model } : {}),
        ...(typeof args.flags["confirm-auto-approval"] === "string"
          ? { autoApprovalConfirmation: args.flags["confirm-auto-approval"] }
          : {}),
        ...(args.flags.worktree === true ? { executionMode: "worktree" as const } : {}),
        ...(args.flags["model-strict"] === true ? { modelStrict: true } : {}),
        ...(typeof args.flags.route === "string"
          ? { routes: parseRouteOverrides(args.flags.route) }
          : {}),
        ...(typeof args.flags.writers === "string"
          ? { maxConcurrentWriters: Number(args.flags.writers) }
          : {}),
        ...(args.flags.clarification === "ask" || args.flags.clarification === "assume"
          ? { clarification: args.flags.clarification }
          : {}),
      });
      // The run's record keeps these warnings; the operator sees them before the run goes on.
      for (const warning of readRoutingSummary(service.store, run.runId)?.warnings ?? [])
        process.stderr.write(`warning: ${warning}
`);
      onDrive?.(run.runId);
      return service.drive(run.runId, signal);
    }
    case "status":
      return {
        ...(await service.get(runId)),
        requests: service.store.requests(runId),
        worktree: worktreeView(service.workspace, service.store.state(runId)),
        routing: readRoutingSummary(service.store, runId),
        acceptance: walkThroughs(service.store, runId),
      };
    case "list":
      return service.list({
        featureId: typeof args.flags.feature === "string" ? args.flags.feature : undefined,
        status: typeof args.flags.status === "string" ? (args.flags.status as RunState) : undefined,
        limit: Number(stringFlag(args, "limit", "20")),
        cursor: typeof args.flags.cursor === "string" ? args.flags.cursor : undefined,
      });
    case "resume":
      await service.resume(runId, identity());
      onDrive?.(runId);
      return service.drive(runId, signal);
    case "pause":
      return service.pause(runId, identity());
    case "cancel":
      return service.cancel(runId, identity());
    case "fork":
      return service.fork(runId, identity());
    case "continue": {
      // One more convergence round is a decision like accept: the run goes on unless `--no-resume`.
      // A token checkpoint keeps the old behavior and resumes only with `--resume`.
      const requestId = stringFlag(args, "request");
      const named = service.store.requests(runId).find((r) => r.id === requestId);
      if (named?.kind === "convergence" && args.flags["no-resume"] !== true)
        args.flags.resume = true;
      return decideThenResume({ kind: "continue", requestId });
    }
    case "accept":
      return decideThenResume({ kind: "accept", requestId: stringFlag(args, "request") });
    case "extend": {
      const number = (flag: string): number | undefined =>
        typeof args.flags[flag] === "string" ? Number(args.flags[flag]) : undefined;
      const extended = await service.extendBudget(runId, identity(), {
        ...(number("tokens") !== undefined ? { maxTotalTokens: number("tokens") } : {}),
        ...(number("calls") !== undefined ? { maxAgentCalls: number("calls") } : {}),
        ...(number("time-ms") !== undefined ? { maxActiveMs: number("time-ms") } : {}),
      } as Partial<BudgetLimits>);
      if (args.flags.resume !== true) return extended;
      await service.resume(runId, { commandId: newId(), expectedRevision: extended.revision });
      onDrive?.(runId);
      return service.drive(runId, signal);
    }
    case "reroute": {
      const rerouted = await service.reroute(runId, identity(), {
        ...(typeof args.flags.model === "string" ? { model: args.flags.model } : {}),
        ...(typeof args.flags.route === "string"
          ? { routes: parseRouteOverrides(args.flags.route) }
          : {}),
      });
      if (args.flags.resume !== true) return rerouted;
      await service.resume(runId, { commandId: newId(), expectedRevision: rerouted.revision });
      onDrive?.(runId);
      return service.drive(runId, signal);
    }
    case "revise": {
      const revised = await service.revise(runId, identity(), stringFlag(args, "candidate"));
      if (args.flags.resume !== true) return revised;
      await service.resume(runId, { commandId: newId(), expectedRevision: revised.revision });
      onDrive?.(runId);
      return service.drive(runId, signal);
    }
    case "undo": {
      const snapshot = await service.undo(
        runId,
        identity(),
        typeof args.flags.path === "string" ? [args.flags.path] : [],
      );
      const report = service.store
        .artifacts(runId)
        .filter((a) => a.kind === ROLLBACK_ARTIFACT_KIND)
        .at(-1);
      return {
        ...snapshot,
        undo: report ? JSON.parse(service.store.readArtifact(runId, report.id)) : null,
      };
    }
    case "candidate":
      return artifacts.stageRevision(runId, {
        commandId: stringFlag(args, "command-id", newId()),
        expectedInputHash: (await service.get(runId)).inputHash,
        ...(args.flags.spec
          ? { spec: jsonFile("spec") as Parameters<WorkflowArtifacts["stageRevision"]>[1]["spec"] }
          : {}),
        ...(args.flags.tasks
          ? {
              graph: jsonFile("tasks") as Parameters<
                WorkflowArtifacts["stageRevision"]
              >[1]["graph"],
            }
          : {}),
        ...(args.flags.plan ? { plan: readFlagFile("plan") } : {}),
        ...(args.flags.policy ? { policy: PolicySchema.parse(jsonFile("policy")) } : {}),
        ...(typeof args.flags.workflow === "string"
          ? {
              definition: jsonFile("workflow"),
              definitionPath: resolve(service.store.workspace, args.flags.workflow),
            }
          : {}),
        ...(typeof args.flags["confirm-auto-approval"] === "string"
          ? { autoApprovalConfirmation: args.flags["confirm-auto-approval"] }
          : {}),
      });
    case "approve":
      return decideThenResume({
        kind: "approve",
        requestId: stringFlag(args, "request"),
        digest: stringFlag(args, "digest"),
        ...(args.flags["exclude-user-changes"] === true ? { userChanges: "exclude" as const } : {}),
      });
    case "answer": {
      const answers = jsonFile("answers-file");
      if (
        !answers ||
        typeof answers !== "object" ||
        Array.isArray(answers) ||
        Object.values(answers).some((v) => typeof v !== "string")
      )
        throw new WorkflowFault("INVALID_DEFINITION", "Answers must be a JSON object of strings");
      return decideThenResume({
        kind: "answer",
        requestId: stringFlag(args, "request"),
        answers: answers as Record<string, string>,
      });
    }
    case "reject":
      return service.decide(runId, identity(), {
        kind: "reject",
        requestId: stringFlag(args, "request"),
        explanation: stringFlag(args, "reason"),
      });
    case "evidence": {
      const requestId = stringFlag(args, "request");
      const request = service.store.requests(runId).find((r) => r.id === requestId);
      if (!request) throw new WorkflowFault("NOT_FOUND", "Manual request not found");
      const body = JSON.parse(request.body_json) as { criterionId: string };
      return decideThenResume({
        kind: "manual-evidence",
        requestId,
        criterionId: body.criterionId,
        evidence: readFlagFile("file"),
        accepted: args.flags.accept === true,
      });
    }
    case "recover": {
      const resolution = stringFlag(args, "resolution");
      if (!["record-applied", "record-not-applied", "retry", "cancel"].includes(resolution))
        throw new WorkflowFault("INVALID_DEFINITION", "Invalid recovery resolution");
      if (resolution === "cancel")
        process.stderr.write(
          "warning: --resolution cancel cancels the whole run, not only this effect. To settle one effect and keep the run, use record-not-applied (the change is not in the file) or record-applied.\n",
        );
      return service.decide(runId, identity(), {
        kind: "recovery",
        requestId: stringFlag(args, "request"),
        effectId: stringFlag(args, "effect"),
        resolution,
        evidence: readFlagFile("file"),
      } as Decision);
    }
    case "profiles":
      return routedProfiles(
        service.workspace,
        service.config,
        modelFlag(args, service.config),
      ).list();
    case "artifacts":
      return args.flags.file
        ? {
            content: new TextDecoder().decode(
              (await artifacts.read(runId, stringFlag(args, "file"))).content,
            ),
          }
        : service.store
            .artifacts(runId)
            .map(({ id, kind, logical_path, revision, content_hash, byte_length }) => ({
              id,
              kind,
              path: logical_path,
              revision,
              hash: content_hash,
              bytes: byte_length,
            }));
    case "import": {
      const source = stringFlag(args, "source");
      if (!["spec-kit", "ecc", "markdown-edit"].includes(source))
        throw new WorkflowFault("INVALID_DEFINITION", "Unknown importer");
      return artifacts.importCandidate({
        commandId: stringFlag(args, "command-id", newId()),
        source: source as "spec-kit" | "ecc" | "markdown-edit",
        sourcePath: resolve(service.store.workspace, stringFlag(args, "path")),
        featureId: stringFlag(args, "feature"),
      });
    }
    case "export":
      return artifacts.exportRun(
        runId,
        resolve(service.store.workspace, stringFlag(args, "destination")),
      );
    case "export-progress":
      return artifacts.exportProgress(runId);
    case "usage": {
      service.store.run(runId);
      const markdown = args.flags.format === "md";
      const usage = runUsage(
        service.store,
        runId,
        typeof args.flags.stage === "string" ? args.flags.stage : undefined,
        // The Markdown sums every attempt; --top only shortens the attempt list.
        typeof args.flags.top === "string" && !markdown ? Number(args.flags.top) : undefined,
        typeof args.flags.model === "string" ? args.flags.model : undefined,
      );
      if (!markdown) return usage;
      const text = runUsageMarkdown(usage);
      if (typeof args.flags.output !== "string") return { runId, markdown: text };
      const path = resolve(service.store.workspace, args.flags.output);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return { runId, path, bytes: Buffer.byteLength(text), usage: true };
    }
    case "report": {
      const markdown = runReport(service.store, runId);
      if (typeof args.flags.output !== "string") return { runId, markdown };
      const path = resolve(service.store.workspace, args.flags.output);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, markdown);
      return { runId, path, bytes: Buffer.byteLength(markdown) };
    }
    case "memory": {
      const [action = "list", id = ""] = args.positional;
      const policy = PolicySchema.parse(service.config.workflows?.policy ?? defaultWorkflowPolicy);
      if (action === "list") return projectMemoryView(service.store, policy);
      const text = typeof args.flags.text === "string" ? args.flags.text : "";
      const edit = (
        action === "add"
          ? { action, text }
          : action === "edit"
            ? { action, id, text }
            : { action, id }
      ) as MemoryEdit;
      const changed = editProjectMemory(service.store, edit);
      return { id: changed, ...projectMemoryView(service.store, policy) };
    }
    case "gc":
      return artifacts.gc({
        before: stringFlag(args, "before"),
        dryRun: args.flags["dry-run"] === true,
      });
    case "deliver": {
      const provider = options.pullRequests === undefined ? {} : { provider: options.pullRequests };
      if (args.flags.execute)
        return executeDelivery(service.store, service.config, runId, {
          expectedRevision: identity().expectedRevision,
          ...(typeof args.flags.request === "string" ? { requestId: args.flags.request } : {}),
          ...provider,
        });
      const prepared = await prepareDelivery(service.store, service.config, runId, {
        ...(typeof args.flags.remote === "string" ? { remote: args.flags.remote } : {}),
        ...(typeof args.flags.branch === "string" ? { branch: args.flags.branch } : {}),
        draft: args.flags.draft === true,
        pullRequest: args.flags["no-pr"] !== true,
        ...(args.flags["with-specs"] ? { specs: true } : {}),
        ...(args.flags["no-specs"] ? { specs: false } : {}),
        ...provider,
      });
      return {
        ...prepared,
        next: `baked workflow approve ${runId} --request ${prepared.requestId} --digest ${prepared.digest} --expected-revision ${prepared.revision}`,
      };
    }
    case "discard-worktree":
      return service.discardWorktree(runId, identity());
    case "redact":
      await artifacts.redact(runId, stringFlag(args, "file"), stringFlag(args, "reason"));
      return { redacted: true };
    case "definitions":
    case "validate":
    case "define":
    case "gates":
      return executeDefinitionCommand(
        args,
        service.store.workspace,
        PolicySchema.parse(service.config.workflows?.policy ?? defaultWorkflowPolicy),
      ).result;
    case "gate":
      return (
        await executeGateCommand(
          args,
          service.store.workspace,
          service.config,
          PolicySchema.parse(service.config.workflows?.policy ?? defaultWorkflowPolicy),
        )
      ).result;
    case "route":
      return explainRoute(service.workspace, service.config, routeRequest(args, service.config));
    case "models": {
      const model = stringFlag(args, "model", service.config.defaultModel ?? "");
      const provider = typeof args.flags.provider === "string" ? args.flags.provider : undefined;
      return workflowModels(
        service.config,
        await loadModelCatalog(provider),
        model && model !== "none" ? model : null,
      );
    }
    case "doctor":
      return runDoctor(service.workspace, service.config, preRunRequest(args, service.workspace));
    case "estimate":
      return preRunEstimate(
        service.workspace,
        service.config,
        preRunRequest(args, service.workspace),
      );
  }
}
export async function runWorkflowCli(argv: string[]): Promise<number> {
  if (
    argv.length === 0 ||
    (argv[0] !== "initiative" &&
      argv[0] !== "routing" &&
      (argv.includes("--help") || argv.includes("-h")))
  ) {
    process.stdout.write(workflowHelp);
    return 0;
  }
  let service: NativeWorkflowService | undefined;
  const controller = new AbortController();
  const eventController = new AbortController();
  const streams: Promise<void>[] = [];
  let stopProgress = (): void => {};
  let interrupts = 0;
  const abort = (): void => {
    if (++interrupts > 1) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    if (argv[0] === "initiative") {
      const cwd = getCwd();
      const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd));
      return await runInitiativeCli(
        argv.slice(1),
        (readonly) => new NativeWorkflowService(cwd, config, undefined, readonly),
        controller.signal,
      );
    }
    if (argv[0] === "routing") return runRoutingCli(argv.slice(1));
    const args = parseWorkflowArgs(argv);
    const cwd = getCwd();
    const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(cwd));
    const readonly = [
      "status",
      "list",
      "artifacts",
      "export",
      "export-progress",
      "usage",
      "report",
    ].includes(args.command);
    if (args.command === "profiles") {
      process.stdout.write(
        `${JSON.stringify(routedProfiles(cwd, config, modelFlag(args, config)).list(), null, 2)}\n`,
      );
      return 0;
    }
    if (args.command === "models") {
      const provider = typeof args.flags.provider === "string" ? args.flags.provider : undefined;
      const catalog = await loadModelCatalog(provider);
      if (provider && !catalog.providers.length)
        throw new WorkflowFault("INVALID_DEFINITION", `Unknown provider ${provider}`);
      const model = stringFlag(args, "model", config.defaultModel ?? "");
      const view = workflowModels(config, catalog, model && model !== "none" ? model : null);
      process.stdout.write(
        args.flags.json ? `${JSON.stringify(view, null, 2)}\n` : formatWorkflowModels(view),
      );
      return 0;
    }
    if (args.command === "route") {
      const explained = explainRoute(cwd, config, routeRequest(args, config));
      process.stdout.write(
        args.flags.json ? `${JSON.stringify(explained, null, 2)}\n` : formatRoute(explained),
      );
      return 0;
    }
    // Pre-run checks read the workspace without opening the run database for writing.
    if (args.command === "doctor") {
      const report = await runDoctor(cwd, config, preRunRequest(args, cwd));
      process.stdout.write(
        args.flags.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report),
      );
      return report.ready ? 0 : 1;
    }
    if (args.command === "estimate") {
      const estimate = await preRunEstimate(cwd, config, preRunRequest(args, cwd));
      process.stdout.write(
        args.flags.json ? `${JSON.stringify(estimate, null, 2)}\n` : formatEstimate(estimate),
      );
      return 0;
    }
    if (args.command === "gate") {
      const { result, text, exitCode } = await executeGateCommand(
        args,
        cwd,
        config,
        PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy),
      );
      process.stdout.write(args.flags.json ? `${JSON.stringify(result, null, 2)}\n` : text);
      return exitCode;
    }
    if ((DEFINITION_COMMANDS as readonly string[]).includes(args.command)) {
      const { result, exitCode } = executeDefinitionCommand(
        args,
        cwd,
        PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy),
      );
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return exitCode;
    }
    service = new NativeWorkflowService(cwd, config, undefined, readonly);
    // A run started from an interactive terminal notifies the person when it waits; scripts that
    // read the output do not.
    if (service.attention) service.attention.systemNotifications = process.stdout.isTTY === true;
    let lastSeq = 0;
    const existingRun = ["run", "quick"].includes(args.command) ? undefined : args.positional[0];
    if (existingRun && args.flags.events) lastSeq = service.store.snapshot(existingRun).eventSeq;
    if (typeof args.flags.after === "string") lastSeq = Number(args.flags.after);
    const eventService = service;
    // Opening the project and indexing print to stderr on a terminal; scripts read stdout and
    // the error JSON on stderr, so they get nothing extra.
    if (
      process.stderr.isTTY === true &&
      !args.flags.json &&
      !args.flags.events &&
      ["run", "quick", "resume"].includes(args.command)
    )
      stopProgress = followProgress((line) => process.stderr.write(`${line}\n`));
    const result = await executeWorkflowCommand(service, args, controller.signal, (runId) => {
      if (!args.flags.events) return;
      streams.push(
        (async () => {
          for await (const event of eventService.events(runId, lastSeq, eventController.signal)) {
            process.stdout.write(`${JSON.stringify(event)}\n`);
            lastSeq = event.seq;
          }
        })(),
      );
    });
    await Promise.all(streams);
    // The report prints as Markdown so it can be piped into a file or a pull request.
    if (
      (args.command === "report" || (args.command === "usage" && args.flags.format === "md")) &&
      !args.flags.json &&
      !args.flags.output
    ) {
      process.stdout.write((result as { markdown: string }).markdown);
      return 0;
    }
    if (args.command === "memory" && !args.flags.json) {
      process.stdout.write(formatProjectMemory(result as ProjectMemoryView & { id?: string }));
      return 0;
    }
    process.stdout.write(`${JSON.stringify(result, null, args.flags.events ? undefined : 2)}\n`);
    return ["run", "quick", "resume"].includes(args.command) ||
      (["revise", "extend", "reroute", "continue", ...DECISION_COMMANDS].includes(args.command) &&
        args.flags.resume === true)
      ? workflowExit(
          result as RunSnapshot,
          PolicySchema.parse(
            JSON.parse(service.store.run((result as RunSnapshot).runId).policy_json),
          ).maxActiveMs,
        )
      : 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ code: error instanceof WorkflowFault ? error.code : "ERROR", message: error instanceof Error ? error.message : String(error) })}\n`,
    );
    return error instanceof WorkflowFault &&
      [
        "REVISION_CONFLICT",
        "COMMAND_CONFLICT",
        "STALE_DECISION",
        "WORKSPACE_BUSY",
        "INPUT_CHANGED",
      ].includes(error.code)
      ? 5
      : 1;
  } finally {
    stopProgress();
    eventController.abort();
    await Promise.allSettled(streams);
    await service?.attention?.flush();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    service?.close();
  }
}

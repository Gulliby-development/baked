import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, loadProjectConfig, mergeConfigs } from "../config/index.js";
import { ProfileRegistry } from "../core/agents/profiles/registry.js";
import { getCwd } from "../core/cwd.js";
import { WorkflowArtifacts } from "../core/workflows/artifacts.js";
import type { BudgetLimits } from "../core/workflows/budget.js";
import { defaultWorkflowPolicy } from "../core/workflows/defaults.js";
import { executeDelivery, prepareDelivery } from "../core/workflows/delivery.js";
import type { PullRequestProvider } from "../core/workflows/delivery-provider.js";
import { WorkflowFault } from "../core/workflows/errors.js";
import { uniqueFeatureId } from "../core/workflows/feature-id.js";
import { ROLLBACK_ARTIFACT_KIND } from "../core/workflows/rollback.js";
import {
  type Decision,
  PolicySchema,
  type RunSnapshot,
  type RunState,
} from "../core/workflows/schemas.js";
import { NativeWorkflowService } from "../core/workflows/service.js";
import { newId } from "../core/workflows/store.js";
import { runUsage } from "../core/workflows/usage.js";
import { QUICK_WORKFLOW_ID } from "../core/workflows/v2/definitions.js";
import { DEFINITION_COMMANDS, executeDefinitionCommand } from "./workflow-definitions.js";
import { runInitiativeCli } from "./workflow-initiative.js";
import { parseWorkflowArgs, type WorkflowArgs, workflowHelp } from "./workflow-parse.js";

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
export async function executeWorkflowCommand(
  service: NativeWorkflowService,
  args: WorkflowArgs,
  signal: AbortSignal,
  onDrive?: (runId: string) => void,
  options: { pullRequests?: PullRequestProvider | null } = {},
): Promise<unknown> {
  const runId = args.positional[0] ?? "";
  const artifacts = new WorkflowArtifacts(service);
  const identity = () => {
    const revision = Number(stringFlag(args, "expected-revision"));
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new WorkflowFault("INVALID_DEFINITION", "Expected a nonnegative integer revision");
    return { commandId: stringFlag(args, "command-id", newId()), expectedRevision: revision };
  };
  const readFlagFile = (flag: string): string =>
    readFileSync(resolve(service.store.workspace, stringFlag(args, flag)), "utf8");
  const jsonFile = (flag: string): unknown => JSON.parse(readFlagFile(flag));
  switch (args.command) {
    case "quick": {
      const run = quickRunArgs(service, args);
      const policy = PolicySchema.parse(
        run.flags.policy
          ? jsonFile("policy")
          : (service.config.workflows?.policy ?? defaultWorkflowPolicy),
      );
      if (!policy.checks.some((c) => c.scope === "feature"))
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "A quick task needs at least one feature check in the workflow policy (workflows.policy.checks); /workflow gates adds them",
        );
      return executeWorkflowCommand(service, run, signal, onDrive, options);
    }
    case "run": {
      const policy = PolicySchema.parse(
        args.flags.policy
          ? jsonFile("policy")
          : (service.config.workflows?.policy ?? defaultWorkflowPolicy),
      );
      const run = await service.start({
        commandId: stringFlag(args, "command-id", newId()),
        workflowId: stringFlag(
          args,
          "workflow",
          args.positional[0] ?? service.config.workflows?.defaultWorkflow ?? "sdd",
        ),
        featureId: stringFlag(args, "feature"),
        prompt: args.flags["prompt-file"]
          ? readFlagFile("prompt-file")
          : stringFlag(args, "prompt"),
        policy,
        ownerLabel: stringFlag(args, "owner", "CLI"),
        ...(typeof args.flags.model === "string" ? { model: args.flags.model } : {}),
        ...(typeof args.flags["confirm-auto-approval"] === "string"
          ? { autoApprovalConfirmation: args.flags["confirm-auto-approval"] }
          : {}),
        ...(args.flags.worktree === true ? { executionMode: "worktree" as const } : {}),
        ...(typeof args.flags.writers === "string"
          ? { maxConcurrentWriters: Number(args.flags.writers) }
          : {}),
      });
      onDrive?.(run.runId);
      return service.drive(run.runId, signal);
    }
    case "status":
      return { ...(await service.get(runId)), requests: service.store.requests(runId) };
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
    case "continue":
      return service.decide(runId, identity(), {
        kind: "continue",
        requestId: stringFlag(args, "request"),
      });
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
      return service.decide(runId, identity(), {
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
      return service.decide(runId, identity(), {
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
      return service.decide(runId, identity(), {
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
      return service.decide(runId, identity(), {
        kind: "recovery",
        requestId: stringFlag(args, "request"),
        effectId: stringFlag(args, "effect"),
        resolution,
        evidence: readFlagFile("file"),
      } as Decision);
    }
    case "profiles":
      return new ProfileRegistry(service.workspace, { active: service.config.defaultModel }).list();
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
    case "usage":
      service.store.run(runId);
      return runUsage(
        service.store,
        runId,
        typeof args.flags.stage === "string" ? args.flags.stage : undefined,
      );
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
  }
}
export async function runWorkflowCli(argv: string[]): Promise<number> {
  if (
    argv.length === 0 ||
    (argv[0] !== "initiative" && (argv.includes("--help") || argv.includes("-h")))
  ) {
    process.stdout.write(workflowHelp);
    return 0;
  }
  let service: NativeWorkflowService | undefined;
  const controller = new AbortController();
  const eventController = new AbortController();
  const streams: Promise<void>[] = [];
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
      const config = mergeConfigs(loadConfig(), loadProjectConfig(cwd));
      return await runInitiativeCli(
        argv.slice(1),
        (readonly) => new NativeWorkflowService(cwd, config, undefined, readonly),
        controller.signal,
      );
    }
    const args = parseWorkflowArgs(argv);
    const cwd = getCwd();
    const config = mergeConfigs(loadConfig(), loadProjectConfig(cwd));
    const readonly = ["status", "list", "artifacts", "export", "export-progress", "usage"].includes(
      args.command,
    );
    if (args.command === "profiles") {
      process.stdout.write(
        `${JSON.stringify(new ProfileRegistry(cwd, { active: config.defaultModel }).list(), null, 2)}\n`,
      );
      return 0;
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
    let lastSeq = 0;
    const existingRun = ["run", "quick"].includes(args.command) ? undefined : args.positional[0];
    if (existingRun && args.flags.events) lastSeq = service.store.snapshot(existingRun).eventSeq;
    if (typeof args.flags.after === "string") lastSeq = Number(args.flags.after);
    const eventService = service;
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
    process.stdout.write(`${JSON.stringify(result, null, args.flags.events ? undefined : 2)}\n`);
    return ["run", "quick", "resume"].includes(args.command) ||
      (["revise", "extend"].includes(args.command) && args.flags.resume === true)
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
    eventController.abort();
    await Promise.allSettled(streams);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    service?.close();
  }
}

import { useCallback, useEffect, useState } from "react";
import type { GatesApi } from "../components/workflow/GatesView.js";
import type { InitiativesApi } from "../components/workflow/InitiativesView.js";
import type { RoutingApi } from "../components/workflow/RoutingView.js";
import type { WorkflowEditorApi } from "../components/workflow/WorkflowEditor.js";
import {
  loadConfig,
  loadEffectiveProjectConfig,
  loadProjectConfig,
  mergeConfigs,
  removeGlobalConfigKeys,
  removeProjectConfigKeys,
  saveGlobalConfig,
  saveProjectConfig,
} from "../config/index.js";
import { getIntelligenceClient } from "../core/intelligence/instance.js";
import { type WorkflowAction, WorkflowClient } from "../core/workers/workflow-client.js";
import { defaultWorkflowPolicy } from "../core/workflows/defaults.js";
import { detectGates, readGates, writeGates } from "../core/workflows/gates.js";
import { explainRoute } from "../core/workflows/routing.js";
import { PolicySchema, workflowsEnabled } from "../core/workflows/schemas.js";
import { listDefinitions } from "../core/workflows/v2/definitions.js";
import { readEditorSource, writeDefinitionFile } from "../core/workflows/v2/editor.js";
import type { RunSummary, WorkflowInfo } from "../core/workflows/view.js";
import { useWorkflowStore } from "../stores/workflow.js";

const sessions = new Map<string, WorkflowClient>();
const exitedOwners = new Map<string, Set<string>>();
export function workflowIsRunning(runId: string): boolean {
  return [...sessions.values()].some((service) => service.isRunning(runId));
}
/** Runs this process executes in any workspace; they pause when the process exits. */
export function drivingWorkflowRuns(): string[] {
  return [...sessions.values()].flatMap((service) => service.drivingRuns());
}
export async function stopWorkflowSessions(): Promise<void> {
  const clients = [...sessions.values()];
  const results = await Promise.allSettled(
    clients.map(async (client) => {
      try {
        await client.shutdown();
      } finally {
        client.close();
      }
    }),
  );
  sessions.clear();
  const errors = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      "Workflow shutdown failed",
    );
}
export function workflowSession(workspace: string): WorkflowClient {
  let service = sessions.get(workspace);
  if (service?.closed) {
    const owner = service.exitedOwner;
    if (owner) {
      const owners = exitedOwners.get(workspace) ?? new Set<string>();
      owners.add(owner);
      exitedOwners.set(workspace, owners);
    }
    service.close();
    service = undefined;
  }
  if (!service) {
    service = new WorkflowClient(
      workspace,
      mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace)),
      [...(exitedOwners.get(workspace) ?? [])],
      getIntelligenceClient,
    );
    sessions.set(workspace, service);
  }
  return service;
}
/** Returns the live session without starting a worker; used by passive indicators. */
export function existingWorkflowSession(workspace: string): WorkflowClient | null {
  const service = sessions.get(workspace);
  return service && !service.closed ? service : null;
}
/**
 * Replaces an idle session so the worker picks up changed configuration.
 * Returns false and keeps the session while this process executes any run.
 */
export async function reloadWorkflowSession(workspace: string, runIds: string[]): Promise<boolean> {
  const service = sessions.get(workspace);
  if (!service) return true;
  if (runIds.some((id) => service.isDriving(id))) return false;
  try {
    await service.shutdown();
  } finally {
    service.close();
    sessions.delete(workspace);
  }
  return true;
}

export function useWorkflow(workspace: string, runId: string | null, visible: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const snapshot = useWorkflowStore((s) => s.projection.snapshot);
  useEffect(() => {
    if (!visible || !runId) return;
    let disposed = false;
    let inFlight = false;
    let lastStamp = "";
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const view = await workflowSession(workspace).refresh(runId);
        if (!disposed && view.stamp !== lastStamp) {
          lastStamp = view.stamp;
          useWorkflowStore.getState().load(view.snapshot);
          setGeneration((g) => g + 1);
          setError(null);
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    // Worker pushes changes from runs it executes; polling covers other processes and active time.
    const unsubscribe = workflowSession(workspace).onChange((changed) => {
      if (changed === runId) void refresh();
    });
    const timer = setInterval(() => {
      void refresh();
    }, 150);
    return () => {
      disposed = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, [workspace, runId, visible]);
  const service = visible && runId ? workflowSession(workspace) : null;
  const act = async (action: WorkflowAction): Promise<void> => {
    if (!service || !runId) return;
    try {
      setError(null);
      const result = await service.action(runId, action);
      if (action === "fork" && result.runId !== runId)
        useWorkflowStore.getState().select(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return { service, snapshot: snapshot?.runId === runId ? snapshot : null, error, generation, act };
}

export function useWorkflowRuns(workspace: string, visible: boolean) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [info, setInfo] = useState<WorkflowInfo | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch((e) => e + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch forces an immediate reload after configuration changes
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Read configuration locally so a disabled project never starts a worker or creates a DB.
        const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
        const on = workflowsEnabled(config);
        setEnabled(on);
        if (!on && !existingWorkflowSession(workspace)) return;
        const service = workflowSession(workspace);
        const [nextInfo, nextRuns] = await Promise.all([service.info(), service.list(50)]);
        if (disposed) return;
        setInfo(nextInfo);
        setRuns(nextRuns);
        setError(null);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [workspace, visible, epoch]);
  return { runs, info, enabled, error, reload };
}

/**
 * Reads and edits the project's gates. Reading, saving and detection touch only files; a run on
 * demand goes through the workflow worker so the interface never waits for the command.
 */
export function workflowGatesApi(workspace: string): GatesApi {
  const inherited = () =>
    mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace)).workflows;
  return {
    load: () => readGates(workspace, inherited()),
    save: async (checks) => {
      writeGates(workspace, checks, inherited());
      // Only a live worker holds a copy of the policy; a new one reads the file.
      await existingWorkflowSession(workspace)?.updateGates(checks);
    },
    suggest: (configured) => detectGates(workspace, configured),
    run: (check, signal) => workflowSession(workspace).runGate(check, signal),
  };
}

/**
 * Opens and saves workflow definitions for the editor window. Opening and saving touch only files;
 * the past runs for the estimate come from the worker, and only when workflows are on, so a
 * disabled project starts no worker.
 */
export function workflowEditorApi(workspace: string): WorkflowEditorApi {
  const config = () => mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  return {
    open: (id) =>
      readEditorSource(
        workspace,
        id,
        PolicySchema.parse(config().workflows?.policy ?? defaultWorkflowPolicy),
      ),
    save: (definition) => writeDefinitionFile(workspace, definition),
    history: async () => {
      if (!workflowsEnabled(config()) && !existingWorkflowSession(workspace)) return null;
      try {
        return await workflowSession(workspace).history();
      } catch {
        return null;
      }
    },
  };
}

/**
 * Reads and writes `modelRouting` for the routing screen. Each layer is read from its own file, so
 * saving the project layer never copies global or manifest settings into `.baked/config.json`.
 */
export function workflowRoutingApi(workspace: string): RoutingApi {
  const config = () => mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
  return {
    load: () => {
      const effective = config();
      const policy = PolicySchema.parse(effective.workflows?.policy ?? defaultWorkflowPolicy);
      return {
        global: loadConfig().modelRouting,
        project: loadProjectConfig(workspace)?.modelRouting,
        workflows: listDefinitions(workspace, policy).map((d) => d.id),
        legacy: {
          coding: effective.taskRouter?.ember ?? effective.taskRouter?.coding ?? undefined,
          review: effective.taskRouter?.verify ?? undefined,
        },
      };
    },
    explain: (workflowId, model) =>
      explainRoute(workspace, config(), { workflowId, model: model ?? undefined }),
    save: (scope, routing) => {
      if (scope === "global") {
        if (routing) saveGlobalConfig({ modelRouting: routing });
        else removeGlobalConfigKeys(["modelRouting"]);
      } else if (routing) saveProjectConfig(workspace, { modelRouting: routing });
      else removeProjectConfigKeys(workspace, ["modelRouting"]);
    },
  };
}

/**
 * Reads and commands initiatives through the workflow worker, which owns the SQLite store and
 * drives an approved or resumed initiative in the background. A disabled project starts no worker.
 */
export function workflowInitiativesApi(workspace: string): InitiativesApi {
  return {
    load: async () => {
      const config = mergeConfigs(loadConfig(), loadEffectiveProjectConfig(workspace));
      if (!workflowsEnabled(config) && !existingWorkflowSession(workspace)) return null;
      return workflowSession(workspace).initiatives();
    },
    act: (id, action) => workflowSession(workspace).initiativeAction(id, action),
  };
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** Keeps the status-bar badge current without starting a worker or polling when idle. */
export function useWorkflowBadge(workspace: string, panelOpen: boolean): void {
  const runId = useWorkflowStore((s) => s.selectedRunId);
  useEffect(() => {
    if (!runId) {
      useWorkflowStore.getState().setBadge(null);
      return;
    }
    let disposed = false;
    const refresh = async (): Promise<void> => {
      const service = existingWorkflowSession(workspace);
      if (!service) return;
      try {
        const view = await service.refresh(runId);
        if (disposed) return;
        const { snapshot } = view;
        const store = useWorkflowStore.getState();
        if (panelOpen) store.acknowledge(runId, snapshot.status);
        const hidden =
          TERMINAL.has(snapshot.status) &&
          useWorkflowStore.getState().acknowledged[runId] === snapshot.status;
        store.setBadge(
          hidden
            ? null
            : {
                runId,
                featureId: snapshot.featureId,
                status: snapshot.status,
                stageId: snapshot.stageId,
                needsUser: snapshot.pendingRequestIds.length > 0,
                tokens: snapshot.tokenUsage,
              },
        );
      } catch {
        // The panel reports errors; the badge only reflects known state.
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [workspace, runId, panelOpen]);
}

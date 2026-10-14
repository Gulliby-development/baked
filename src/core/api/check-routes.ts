/**
 * The project's checks over the local API (`/v1/workflow/checks`): the commands every run uses as
 * evidence (`workflows.policy.checks`), the ones BAKED detects in the project, and running one on
 * demand. The terminal UI's gate editor does the same through `src/core/workflows/gates.ts`.
 */
import { z } from "zod";
import { loadProjectConfig } from "../../config/index.js";
import type { AppConfig } from "../../types/index.js";
import {
  assertWorkspaceFreeForGate,
  detectGates,
  executeGate,
  type GateRunResult,
  readGates,
  writeGates,
} from "../workflows/gates.js";
import { leaseOwnerAlive } from "../workflows/leases.js";
import { CheckSchema, SafeId, workflowsEnabled } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";
import type { RouteContext } from "./route-context.js";

export interface CheckRunRecord extends GateRunResult {
  checkId: string;
  /** When the run finished, in epoch milliseconds. */
  at: number;
}

export interface CheckRouteContext extends RouteContext {
  workspace: string;
  config: AppConfig;
  store: WorkflowStore;
  /** The latest on-demand result of each check, kept for the server's lifetime. */
  results: Map<string, CheckRunRecord>;
  /** Aborted when the server stops. */
  signal: AbortSignal;
}

const ChecksBody = z.strictObject({ checks: z.array(z.unknown()).max(100) });
const RUN_PATH = /^\/v1\/workflow\/checks\/([^/]+)\/run$/;

/** Answers a checks request, or returns null when the path is not a checks endpoint. */
export async function checkRoute(ctx: CheckRouteContext): Promise<Response | null> {
  const { path, method, workspace, config } = ctx;
  const configured = () => readGates(workspace, config.workflows);
  const listing = () => ({
    checks: configured().map((check) => {
      const last = ctx.results.get(check.id);
      return { ...check, ...(last ? { lastResult: last } : {}) };
    }),
    workflowsEnabled: workflowsEnabled(config),
  });

  if (path === "/v1/workflow/checks") {
    ctx.only("GET", "PUT");
    if (method === "GET") return ctx.json(200, listing());
    const body = ChecksBody.parse(await ctx.readJson());
    const checks = body.checks.map((check) => CheckSchema.parse(check));
    if (new Set(checks.map((check) => check.id)).size !== checks.length)
      ctx.fail(400, "INVALID_REQUEST", "Check IDs must be unique");
    writeGates(workspace, checks, config.workflows);
    // New runs and the gate list read the in-memory policy; started runs keep the copy they
    // froze. A project without a workflows block got the one writeGates wrote.
    const workflows = config.workflows ?? loadProjectConfig(workspace)?.workflows;
    if (workflows) config.workflows = { ...workflows, policy: { ...workflows.policy, checks } };
    return ctx.json(200, listing());
  }

  if (path === "/v1/workflow/checks/suggestions") {
    ctx.only("GET");
    return ctx.json(200, { suggestions: detectGates(workspace, configured()) });
  }

  const match = RUN_PATH.exec(path);
  if (match?.[1]) {
    ctx.only("POST");
    const id = SafeId.parse(decodeURIComponent(match[1]));
    z.strictObject({}).parse(await ctx.readJson());
    const check = configured().find((candidate) => candidate.id === id);
    if (!check) ctx.fail(404, "NOT_FOUND", `No check ${id}`);
    assertWorkspaceFreeForGate(
      (["execution", "mutation"] as const).some((resource) => {
        const lease = ctx.store.lease(resource);
        return lease !== null && leaseOwnerAlive(lease) !== false;
      }),
    );
    const result = await executeGate(workspace, check, ctx.signal);
    const record: CheckRunRecord = { checkId: id, at: Date.now(), ...result };
    ctx.results.set(id, record);
    return ctx.json(200, record);
  }
  return null;
}

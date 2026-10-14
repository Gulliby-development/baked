import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type ModelRouting,
  type RoutingEntry,
  recordEntry,
  resolveProfileModel,
} from "../../llm/model-routing.js";
import { hashJson } from "../../specs/hash.js";
import { WorkflowFault } from "../../workflows/errors.js";
import { isMcpGrant } from "../../workflows/mcp-grants.js";
import { builtinProfiles } from "./builtin.js";
import { type AgentProfile, ProfileSchema } from "./schema.js";
import { withTestIntegrityRules } from "./test-integrity-rules.js";

export interface RegisteredProfile {
  profile: AgentProfile;
  source: string;
  hash: string;
  /** Where the resolved model came from, for example `modelRouting.roles.planner`. */
  modelSource: string;
  /** The resolved route: model, source, and the route's effort and fallback models if any. */
  route: RoutingEntry;
}
export interface ProfileModels {
  /** The run model. */
  active: string;
  /** Legacy router slots behind the `$coding` and `$review` classes. */
  coding?: string | undefined;
  review?: string | undefined;
  routing?: ModelRouting | undefined;
}
export class ProfileRegistry {
  private entries = new Map<string, RegisteredProfile>();
  constructor(
    workspace: string,
    models: ProfileModels,
    globalDirectory = join(homedir(), ".baked", "agents"),
  ) {
    for (const profile of withTestIntegrityRules(builtinProfiles))
      this.add(profile, "builtin", models);
    for (const directory of [globalDirectory, join(workspace, "baked", "agents")]) {
      if (!existsSync(directory)) continue;
      for (const file of readdirSync(directory)
        .filter((f) => f.endsWith(".json"))
        .sort()) {
        const path = join(directory, file);
        const text = readFileSync(path, "utf8");
        if (Buffer.byteLength(text) > 256 * 1024)
          throw new WorkflowFault("INVALID_DEFINITION", `Profile too large: ${path}`);
        this.add(ProfileSchema.parse(JSON.parse(text)), path, models);
      }
    }
  }
  private add(profile: AgentProfile, source: string, models: ProfileModels): void {
    const routed = resolveProfileModel(profile, {
      runModel: models.active,
      routing: models.routing,
      legacy: { coding: models.coding, review: models.review },
    });
    const resolved = { ...profile, model: routed.model };
    assertProfileCapabilities(resolved);
    const route = recordEntry(routed);
    this.entries.set(profile.id, {
      profile: resolved,
      source,
      hash: hashJson(resolved),
      modelSource: routed.source,
      // A routed effort wins; otherwise the profile's own effort (#334) is the route's.
      route: route.effort || !profile.effort ? route : { ...route, effort: profile.effort },
    });
  }
  list(): RegisteredProfile[] {
    return [...this.entries.values()];
  }
  get(id: string): AgentProfile {
    const entry = this.entries.get(id);
    if (!entry) throw new WorkflowFault("NOT_FOUND", `Unknown profile ${id}`);
    return entry.profile;
  }
}

/**
 * Throws when a profile asks for tools its role may not use or pairs a role with the wrong output.
 * The registry runs it on every profile it loads; package inspection runs it before an install.
 */
export function assertProfileCapabilities(profile: AgentProfile): void {
  const available = new Set([
    "read",
    // The run's own spec criteria in full (spec-digest.ts); read-only, any role.
    "read_criterion",
    "bake_find",
    "bake_impact",
    "navigate",
    "edit_file",
    "multi_edit",
    "delete_file",
    "request_check",
    "submit_result",
    "submit_review",
    "submit_artifact",
  ]);
  // Host tools of the AI acceptance gate exist only for its own two roles.
  const walkTools = [
    "app_start",
    "app_stop",
    "terminal_send",
    "terminal_read",
    "command_run",
    "browser_open",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_key",
    "record_step",
  ];
  if (profile.role === "acceptance-walker") for (const name of walkTools) available.add(name);
  if (profile.role === "acceptance-writer") available.add("write_test");
  // Reviewers and the convergence walker try a finding's repro with the runtime's own runner
  // (#155, #930).
  if (profile.role === "reviewer" || profile.role === "spec-auditor") available.add("run_repro");
  // Repair tasks isolate a failing check with a probe; documentation tasks capture real output.
  if (profile.role === "implementer") available.add("run_probe");
  // MCP grants (#133) are open to agent roles; the acceptance roles run on host tools only.
  const mcpAllowed = profile.role !== "acceptance-walker" && profile.role !== "acceptance-writer";
  if (profile.allowedTools.some((t) => !available.has(t) && !(mcpAllowed && isMcpGrant(t))))
    throw new WorkflowFault("CAPABILITY_DENIED", `Unsupported tool in profile ${profile.id}`);
  if (
    profile.role !== "implementer" &&
    profile.allowedTools.some(
      (t) =>
        t === "edit_file" || t === "multi_edit" || t === "delete_file" || t === "request_check",
    )
  )
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      `Read-only profile ${profile.id} declares writing tools`,
    );
  if ((profile.role === "implementer") !== (profile.output === "implementation"))
    throw new WorkflowFault("INVALID_DEFINITION", `Incompatible role/output for ${profile.id}`);
  if (
    (profile.role === "acceptance-walker") !== (profile.output === "acceptance") ||
    (profile.role === "acceptance-writer") !== (profile.output === "acceptance-draft")
  )
    throw new WorkflowFault("INVALID_DEFINITION", `Incompatible role/output for ${profile.id}`);
}

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hashJson } from "../../specs/hash.js";
import { WorkflowFault } from "../../workflows/errors.js";
import { builtinProfiles } from "./builtin.js";
import { type AgentProfile, ProfileSchema } from "./schema.js";

export interface RegisteredProfile {
  profile: AgentProfile;
  source: string;
  hash: string;
}
export class ProfileRegistry {
  private entries = new Map<string, RegisteredProfile>();
  constructor(
    workspace: string,
    models: { active: string; coding?: string; review?: string },
    globalDirectory = join(homedir(), ".baked", "agents"),
  ) {
    for (const profile of builtinProfiles) this.add(profile, "builtin", models);
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
  private add(
    profile: AgentProfile,
    source: string,
    models: { active: string; coding?: string; review?: string },
  ): void {
    const slots: Record<string, string> = {
      $active: models.active,
      $coding: models.coding ?? models.active,
      $review: models.review ?? models.active,
    };
    const resolved = { ...profile, model: slots[profile.model] ?? profile.model };
    const available = new Set([
      "read",
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
    if (resolved.allowedTools.some((t) => !available.has(t)))
      throw new WorkflowFault("CAPABILITY_DENIED", `Unsupported tool in profile ${profile.id}`);
    if (
      resolved.role !== "implementer" &&
      resolved.allowedTools.some(
        (t) =>
          t === "edit_file" || t === "multi_edit" || t === "delete_file" || t === "request_check",
      )
    )
      throw new WorkflowFault(
        "CAPABILITY_DENIED",
        `Read-only profile ${profile.id} declares writing tools`,
      );
    if ((resolved.role === "implementer") !== (resolved.output === "implementation"))
      throw new WorkflowFault("INVALID_DEFINITION", `Incompatible role/output for ${profile.id}`);
    this.entries.set(profile.id, { profile: resolved, source, hash: hashJson(resolved) });
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

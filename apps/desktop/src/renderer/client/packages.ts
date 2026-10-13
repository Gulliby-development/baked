/**
 * BAKED packages over `/v1/packages*` (docs/desktop/api.md#packages): local package folders whose
 * agent profiles, skills, workflow definitions and gates are copied into the project's `baked/`
 * folders. An install sends the `planHash` of the plan the person approved; the backend refuses a
 * plan that changed since.
 */
import { call } from "./api.js";
import { PACKAGES_CAPABILITY } from "./capabilities.js";
import { withCapability } from "./setup.js";

export type PackageKind = "agents" | "skills" | "workflows" | "gates";
export type FileStatus = "new" | "identical" | "overwrite";

export interface PlannedFile {
  path: string;
  target: string;
  kind: PackageKind;
  sha256: string;
  size: number;
  status: FileStatus;
}
export interface StaleFile {
  target: string;
  action: "remove" | "keep" | "missing";
}
/** What an install would do (`PackagePlan` in src/core/packages/packages.ts). */
export interface PackagePlan {
  source: string;
  workspace: string;
  name: string;
  version: string;
  description: string | null;
  installed: string | null;
  files: PlannedFile[];
  stale: StaleFile[];
  contents: Record<PackageKind, string[]>;
  gatesToConfirm: string[];
  problems: string[];
  overwrites: number;
  planHash: string;
}
export interface InstallResult {
  name: string;
  version: string;
  written: string[];
  unchanged: string[];
  removed: string[];
  kept: string[];
  gatesToConfirm: string[];
}
export interface InstalledPackage {
  name: string;
  version: string;
  description?: string;
  installedAt: string;
  files: { path: string; sha256: string }[];
  changed: string[];
}
export interface RemoveResult {
  name: string;
  version: string;
  removed: string[];
  kept: string[];
  missing: string[];
}

export const packages = {
  list: (key: string) =>
    withCapability(key, PACKAGES_CAPABILITY, () =>
      call<{ packages: InstalledPackage[] }>(key, "GET", "/v1/packages"),
    ),
  inspect: (key: string, path: string) =>
    call<PackagePlan>(key, "POST", "/v1/packages/inspect", { path }),
  /** Sent only after the person approved the plan. */
  install: (key: string, plan: PackagePlan, overwrite: boolean) =>
    call<InstallResult>(key, "POST", "/v1/packages/install", {
      path: plan.source,
      planHash: plan.planHash,
      overwrite,
      commandId: crypto.randomUUID(),
    }),
  remove: (key: string, name: string) =>
    call<RemoveResult>(key, "DELETE", `/v1/packages/${encodeURIComponent(name)}`),
};

/** Whether the person may install the plan, and what the button says. */
export function installAction(plan: PackagePlan): { allowed: boolean; label: string } {
  if (plan.problems.length) return { allowed: false, label: "Cannot be installed" };
  if (plan.overwrites > 0)
    return {
      allowed: true,
      label: `Install and replace ${plan.overwrites} ${plan.overwrites === 1 ? "file" : "files"}`,
    };
  return { allowed: true, label: plan.installed ? `Update to ${plan.version}` : "Install" };
}

/** The status of a planned file in words. */
export const FILE_STATUS: Record<FileStatus, string> = {
  new: "new",
  identical: "same as the project's",
  overwrite: "replaces a different file",
};

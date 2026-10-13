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

/** What writing a package's manifest did or would do (`PackResult` in src/core/packages/pack.ts). */
export interface PackResult {
  root: string;
  manifestPath: string;
  name: string | null;
  version: string | null;
  description: string | null;
  files: { path: string; kind: PackageKind; sha256: string; size: number }[];
  contents: Record<PackageKind, string[]>;
  problems: string[];
  manifest: {
    schemaVersion: 1;
    name: string;
    version: string;
    description?: string;
    files: { path: string; sha256: string }[];
  } | null;
  existing: boolean;
  upToDate: boolean;
  written: boolean;
}
/** The manifest fields of `POST /v1/packages/pack`; empty ones keep the existing manifest's. */
export interface PackRequest {
  path: string;
  name?: string;
  version?: string;
  description?: string;
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
  /** Writes the package folder's `baked-package.json`, or with `check` only reports on it. */
  pack: (key: string, request: PackRequest, check: boolean) =>
    call<PackResult>(key, "POST", "/v1/packages/pack", {
      path: request.path,
      ...(request.name ? { name: request.name } : {}),
      ...(request.version ? { version: request.version } : {}),
      ...(request.description ? { description: request.description } : {}),
      check,
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

/** The outcome of writing or checking a manifest, in one sentence. */
export function packSummary(result: PackResult, check: boolean): string {
  const label = [result.name, result.version].filter(Boolean).join(" ");
  const count = `${result.files.length} ${result.files.length === 1 ? "file" : "files"}`;
  if (result.problems.length)
    return `baked-package.json not written for ${label}: ${result.problems.length} ${result.problems.length === 1 ? "problem" : "problems"}.`;
  if (check)
    return result.upToDate
      ? `${label}: baked-package.json is up to date (${count}).`
      : result.existing
        ? `${label}: baked-package.json is out of date; Write updates it (${count}).`
        : `${label}: no baked-package.json yet; Write creates it (${count}).`;
  return result.written
    ? `Wrote baked-package.json for ${label} (${count}).`
    : `${label}: baked-package.json was already up to date (${count}).`;
}

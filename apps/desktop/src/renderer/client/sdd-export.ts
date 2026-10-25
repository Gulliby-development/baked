import { call } from "./api.js";

/** `GET|POST .../package` of runs and initiatives (Export package… on both screens). */
export const SDD_EXPORT_CAPABILITY = "sdd-export";

export type PackageKind = "run" | "initiative";

/** One feature of a written package, as `manifest.json` lists it. */
export interface PackageFeature {
  id: string;
  title: string;
  status: string;
  runId: string | null;
  accepted: boolean;
  dependsOn: string[];
  dir: string | null;
}
/** `POST .../package`: where the package went and what it holds. */
export interface WrittenPackage {
  path: string;
  zip: boolean;
  files: string[];
  manifest: { kind: PackageKind; id: string; title: string; features: PackageFeature[] };
}

const packagePath = (kind: PackageKind, id: string): string =>
  `${kind === "run" ? "/v1/workflow/runs" : "/v1/initiatives"}/${encodeURIComponent(id)}/package`;

export const sddExport = {
  /**
   * Writes the SDD export package inside the project: a folder, or one archive with `zip`. `out`
   * is relative to the project; omitted, `.baked/exports/ID-export`.
   */
  write: (key: string, kind: PackageKind, id: string, body: { zip: boolean; out?: string }) =>
    call<WrittenPackage>(key, "POST", packagePath(kind, id), body),
};

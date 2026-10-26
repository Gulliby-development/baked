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

/** `source: "baked-export"` on `POST /v1/workflow/import` (Import… on the run list). */
export const SDD_IMPORT_CAPABILITY = "sdd-import";

/** What an imported package made: an initiative awaiting its split approval, or a run. */
export interface ImportedPackage {
  kind: PackageKind;
  /** The new initiative's ID, or the run's feature ID. */
  id: string;
  /** Features that start at analysis with their imported spec, plan and tasks. */
  seeded: string[];
  /** Features without accepted documents; they specify and plan as usual. */
  unseeded: string[];
  run?: { runId: string };
}

export const sddImport = {
  /** Reads a package folder or zip archive in the project and recreates its work. */
  importPackage: (key: string, body: { path: string; id?: string }) =>
    call<ImportedPackage>(key, "POST", "/v1/workflow/import", {
      source: "baked-export",
      ...body,
    }),
};

/** The result line of an import: what was made and where the person continues. */
export function importedSummary(imported: ImportedPackage): string {
  if (imported.kind === "run")
    return `Created run ${imported.run?.runId ?? ""} for ${imported.id}. It starts at analysis with the imported spec, plan and tasks; open it on the run list to continue.`;
  const total = imported.seeded.length + imported.unseeded.length;
  return `Created initiative ${imported.id}. ${imported.seeded.length} of ${total} feature${total === 1 ? "" : "s"} start at analysis with their imported spec, plan and tasks; approve the split on the Initiatives screen to continue.`;
}

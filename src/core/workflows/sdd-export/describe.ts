import type { ImportedPackage } from "./import.js";
import type { WrittenSddPackage } from "./package.js";

/** One line saying what was written where, for the CLI and the terminal app. */
export function describeSddExport(written: WrittenSddPackage): string {
  const { manifest } = written;
  const accepted = manifest.features.filter((f) => f.accepted).length;
  const features = manifest.features.length;
  return `Exported ${manifest.kind} ${manifest.id} as an SDD package (${accepted} of ${features} feature${features === 1 ? "" : "s"} accepted, ${written.files.length} files) to ${written.path}`;
}

/** Whether a workflow command's result is a written package. */
export const isSddExport = (value: unknown): value is WrittenSddPackage =>
  !!value &&
  typeof value === "object" &&
  "manifest" in value &&
  "files" in value &&
  "path" in value &&
  "zip" in value;

/** One line on what an import made and what the person does next. */
export function describeSddImport(imported: ImportedPackage): string {
  if (imported.kind === "run") {
    const run = imported.run;
    return `Imported run ${run?.runId ?? ""} for feature ${imported.id}: it starts at analysis with the imported spec, plan and tasks. Continue it with: baked workflow resume ${run?.runId ?? ""} --expected-revision ${run?.revision ?? ""}`;
  }
  const total = imported.seeded.length + imported.unseeded.length;
  return `Imported initiative ${imported.id}: ${imported.seeded.length} of ${total} feature${total === 1 ? "" : "s"} start at analysis with their imported spec, plan and tasks. Approve the split to continue: baked workflow initiative show ${imported.id}`;
}

/** Whether a workflow command's result is an imported package. */
export const isSddImport = (value: unknown): value is ImportedPackage =>
  !!value &&
  typeof value === "object" &&
  "kind" in value &&
  "seeded" in value &&
  "unseeded" in value;

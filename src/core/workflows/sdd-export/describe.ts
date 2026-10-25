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

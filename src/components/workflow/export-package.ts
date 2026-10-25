import { describeSddExport } from "../../core/workflows/sdd-export/describe.js";
import type { WrittenSddPackage } from "../../core/workflows/sdd-export/package.js";

/** What the export prompt of the run and initiative screens writes (#2207). */
export type ExportChoice = "folder" | "zip";

/** The prompt shown after E on a run or an initiative. */
export const exportPromptText = (id: string): string =>
  `Export the accepted spec, plan, tasks and graph of ${id} as an SDD package to .baked/exports/${id}-export? F writes a folder, Z one zip archive, N keeps it. /workflow export-package ${id} --out PATH writes elsewhere.`;

/** The choice a key makes in the export prompt; null for a key the prompt ignores. */
export function exportChoice(key: string): ExportChoice | "cancel" | null {
  if (key === "f") return "folder";
  if (key === "z") return "zip";
  if (key === "n" || key === "escape") return "cancel";
  return null;
}

/** Writes the package through the workflow worker; the line to show, as the CLI prints it. */
export async function exportPackage(
  session: { command(argv: string[], signal: AbortSignal): Promise<unknown> },
  id: string,
  choice: ExportChoice,
): Promise<string> {
  const written = (await session.command(
    ["export-package", id, ...(choice === "zip" ? ["--zip"] : [])],
    new AbortController().signal,
  )) as WrittenSddPackage;
  return describeSddExport(written);
}

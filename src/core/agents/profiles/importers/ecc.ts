import { readImportDirectory } from "../../../specs/importers/spec-kit.js";
export function importEcc(source: string) {
  const report = readImportDirectory(source);
  const candidates = Object.entries(report.files)
    .filter(([name]) => name.endsWith(".md") && !/LICENSE|README/i.test(name))
    .map(([path, text]) => ({
      path,
      instructions: text,
      complete: false,
      requiredMapping: ["model", "role", "allowedTools", "output"],
      enabled: false,
    }));
  report.unsupported.push("ECC hooks and JavaScript workflows are never executed by the importer.");
  report.warnings.push(
    "Review tool, model and output mappings before registering a profile. Imported prompts grant no capabilities.",
  );
  return { ...report, candidates };
}

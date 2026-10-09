import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { WorkflowFault } from "../../workflows/errors.js";
import { hashBytes } from "../hash.js";
import { SpecSchema, TaskGraphSchema } from "../schema.js";

export interface ImportReport {
  source: string;
  revision: string | null;
  adapterVersion: string;
  hashes: Record<string, string>;
  license: string | null;
  warnings: string[];
  unsupported: string[];
  files: Record<string, string>;
}
export function readImportDirectory(source: string): ImportReport {
  const root = resolve(source);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
    throw new WorkflowFault(
      "INVALID_DEFINITION",
      "Import source must be a local directory without symlinks",
    );
  const files: Record<string, string> = {};
  let count = 0;
  let entriesVisited = 0;
  function visit(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (++entriesVisited > 2000)
        throw new WorkflowFault("INVALID_DEFINITION", "Import exceeds directory entry limit");
      if ([".git", "node_modules"].includes(entry.name)) continue;
      if (entry.isSymbolicLink())
        throw new WorkflowFault("CAPABILITY_DENIED", "Import contains a symlink");
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!/\.(md|json|ya?ml)$/i.test(entry.name) && !/^LICENSE/i.test(entry.name)) continue;
      if (++count > 100)
        throw new WorkflowFault(
          "INVALID_DEFINITION",
          "Import exceeds 100 files; select a smaller reviewed directory",
        );
      const bytes = readFileSync(path);
      if (bytes.length > 2 * 1024 * 1024)
        throw new WorkflowFault("INVALID_DEFINITION", `Import file exceeds 2 MiB: ${entry.name}`);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new WorkflowFault("INVALID_DEFINITION", `Import is not UTF-8: ${entry.name}`);
      }
      files[relative(root, path).replaceAll("\\", "/")] = text;
    }
  }
  visit(root);
  let revision: string | null = null;
  if (Bun.which("git")) {
    const rev = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    if (rev.exitCode === 0) revision = rev.stdout.toString().trim();
  }
  return {
    source: root,
    revision,
    adapterVersion: "1.0.0",
    hashes: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, hashBytes(content)]),
    ),
    license: Object.entries(files).find(([path]) => /(^|\/)LICENSE/i.test(path))?.[1] ?? null,
    warnings: [],
    unsupported: [],
    files,
  };
}
export function importSpecKit(
  source: string,
): ImportReport & { spec?: unknown; graph?: unknown; plan?: string } {
  const report = readImportDirectory(source);
  const specFile = Object.entries(report.files).find(([path]) => path === "spec.json");
  const graphFile = Object.entries(report.files).find(([path]) => path === "tasks.json");
  if (!specFile)
    report.warnings.push(
      "Markdown imported as a draft. A spec-author must map requirements and Given/When/Then criteria to SpecSchema before acceptance.",
    );
  report.unsupported.push(
    ...Object.keys(report.files)
      .filter((path) => /\.(ya?ml)$/i.test(path))
      .map((path) => `Executable workflow mapping required: ${path}`),
  );
  return {
    ...report,
    ...(specFile ? { spec: SpecSchema.parse(JSON.parse(specFile[1])) } : {}),
    ...(graphFile ? { graph: TaskGraphSchema.parse(JSON.parse(graphFile[1])) } : {}),
    ...(report.files["plan.md"] ? { plan: report.files["plan.md"] } : {}),
  };
}

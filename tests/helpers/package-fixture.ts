import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { builtinProfiles } from "../../src/core/agents/profiles/builtin.js";
import { hashBytes } from "../../src/core/specs/hash.js";
import { checkToGate } from "../../src/core/workflows/v2/library.js";
import quick from "../../src/core/workflows/v2/presets/quick.json" with { type: "json" };

export const SKILL_TEXT = "---\ndescription: Review checklists\n---\n# Review\nCheck the edges.\n";

const commandGate = (id: string, scope: "feature" | "task" = "feature") =>
  checkToGate({ id, executable: "bun", args: ["run", id], cwd: ".", timeoutMs: 60000, required: true, scope, envNames: [], writes: [] });

/** The files of a valid package: a profile that uses a shipped skill, a workflow and the gates it binds. */
export function packageFiles(): Record<string, string> {
  const reviewer = builtinProfiles.find((p) => p.role === "reviewer");
  if (!reviewer) throw new Error("no reviewer profile");
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  return {
    "agents/pkg-reviewer.json": json({ ...reviewer, id: "pkg-reviewer", skills: [{ id: "review-notes", hash: hashBytes(SKILL_TEXT) }] }),
    "skills/review-notes/SKILL.md": SKILL_TEXT,
    "skills/review-notes/checklist.txt": "edges\n",
    "workflows/pkg-quick.json": json({ ...quick, id: "pkg-quick", preset: "custom" }),
    "gates/typecheck.json": json(commandGate("typecheck")),
    "gates/lint.json": json(commandGate("lint")),
    "gates/tests.json": json(commandGate("tests")),
    "gates/task-tests.json": json(commandGate("task-tests", "task")),
    "gates/scripts/check.sh": "#!/bin/sh\nexit 0\n",
  };
}

/**
 * Writes a package folder: every file, and a manifest listing them with their hashes. `manifest`
 * changes the manifest after the hashes are filled in; `extra` files are written without a listing.
 */
export function writePackage(
  files: Record<string, string> = packageFiles(),
  options: { name?: string; version?: string; manifest?: (m: Record<string, unknown>) => void; extra?: Record<string, string> } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "baked-package-"));
  const write = (path: string, text: string) => {
    const full = join(root, ...path.split("/"));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  for (const [path, text] of Object.entries({ ...files, ...options.extra })) write(path, text);
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    name: options.name ?? "acme-review",
    version: options.version ?? "1.0.0",
    description: "Review profile, skill, workflow and gates",
    files: Object.entries(files).map(([path, text]) => ({ path, sha256: hashBytes(text) })),
  };
  options.manifest?.(manifest);
  write("baked-package.json", JSON.stringify(manifest, null, 2));
  return root;
}

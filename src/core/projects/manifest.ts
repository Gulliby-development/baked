import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { writeViaTemp } from "../workflows/atomic-write.js";

/** Shared repository content like `baked/gates`; `.baked/` is gitignored by ensurebakedDir. */
export const MANIFEST_PATH = join("baked", "project.json");

export const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
  message: "use 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
});

/**
 * Config keys a manifest may set for the whole project. The manifest is repository content, so
 * `workflows` stays out: its checks are commands that would run as trusted policy gates.
 */
export const PROJECT_CONFIG_KEYS = [
  "defaultModel",
  "taskRouter",
  "modelRouting",
  "modelFallback",
] as const;

const Entry = z.string().min(1).max(1024);

export const ProjectManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: ProjectId,
    name: z.string().min(1).max(120),
    roots: z.array(Entry).max(16).default([]),
    workingSet: z.array(Entry).max(200).default([]),
    defaults: z
      .object({
        instructions: z.array(Entry).max(32).optional(),
        config: z
          .record(z.string(), z.unknown())
          .refine((config) => Object.keys(config).every((key) => isProjectConfigKey(key)), {
            message: `defaults.config may only set ${PROJECT_CONFIG_KEYS.join(", ")}`,
          })
          .optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

function isProjectConfigKey(key: string): boolean {
  return (PROJECT_CONFIG_KEYS as readonly string[]).includes(key);
}

export class ProjectManifestError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Invalid project manifest ${path}: ${message}`);
  }
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_PATH);
}

/** The manifest of a checkout, null when it has none; throws ProjectManifestError when invalid. */
export function readManifest(root: string): ProjectManifest | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  return parseManifest(path, readFileSync(path, "utf8"));
}

export function parseManifest(path: string, text: string): ProjectManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectManifestError(path, error instanceof Error ? error.message : String(error));
  }
  if (raw && typeof raw === "object" && "schemaVersion" in raw && raw.schemaVersion !== 1)
    throw new ProjectManifestError(
      path,
      `schemaVersion ${String(raw.schemaVersion)} is not supported by this version of BAKED`,
    );
  const parsed = ProjectManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new ProjectManifestError(
      path,
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  return parsed.data;
}

export function writeManifest(root: string, manifest: ProjectManifest): void {
  const valid = ProjectManifestSchema.parse(manifest);
  const path = manifestPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeViaTemp(path, `${JSON.stringify(valid, null, 2)}\n`, { flag: "w", flush: true });
}

/** A project ID derived from a directory name: lowercased, unsupported characters dashed. */
export function defaultProjectId(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return slug || "project";
}

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../platform/index.js";
import { writeViaTemp } from "../workflows/atomic-write.js";

const WRITE = { flag: "w", flush: true, mode: 0o600 } as const;

/**
 * Artifacts: self-contained HTML pages kept per user, not per project, so every project and every
 * chat sees the same list. Each save is a new version; deploys are recorded with the version they
 * published. Layout: `<root>/<id>/meta.json` and `<root>/<id>/v<N>.html`.
 */

export const ARTIFACT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The largest page an artifact holds, in bytes. */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const Deploy = z.object({
  id: z.string(),
  url: z.string(),
  target: z.enum(["preview", "production"]),
  version: z.number().int().positive(),
  at: z.string(),
});
export type ArtifactDeploy = z.infer<typeof Deploy>;

const Meta = z.object({
  id: z.string().regex(ARTIFACT_ID),
  title: z.string(),
  description: z.string().default(""),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The project folder the last version was saved from, or null. */
  project: z.string().nullable().default(null),
  bytes: z.number().int().nonnegative(),
  deploys: z.array(Deploy).default([]),
});
export type ArtifactMeta = z.infer<typeof Meta>;

export class ArtifactError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

export interface SaveArtifact {
  /** Saves a new version of this artifact; without it a new artifact gets an ID from the title. */
  id?: string;
  title?: string;
  description?: string;
  html: string;
  project?: string | null;
}

/** The artifact store in the user's BAKED data folder, shared by every project. */
export const defaultArtifactRoot = (): string => join(dataDir(), "artifacts");

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "") || "artifact";

export class ArtifactStore {
  constructor(readonly root: string = defaultArtifactRoot()) {}

  private dir(id: string): string {
    if (!ARTIFACT_ID.test(id)) throw new ArtifactError("INVALID", `Invalid artifact ID ${id}`);
    return join(this.root, id);
  }

  /** Every artifact, the most recently updated first. */
  list(): ArtifactMeta[] {
    if (!existsSync(this.root)) return [];
    const items: ArtifactMeta[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ARTIFACT_ID.test(entry.name)) continue;
      const meta = this.find(entry.name);
      if (meta) items.push(meta);
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  find(id: string): ArtifactMeta | null {
    const file = join(this.dir(id), "meta.json");
    if (!existsSync(file)) return null;
    const parsed = Meta.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  }

  get(id: string): ArtifactMeta {
    const meta = this.find(id);
    if (!meta) throw new ArtifactError("NOT_FOUND", `No artifact ${id}`);
    return meta;
  }

  /** The file of a version, the latest by default, for opening it in a browser. */
  pagePath(id: string, version?: number): string {
    const meta = this.get(id);
    const wanted = version ?? meta.version;
    const file = join(this.dir(id), `v${wanted}.html`);
    if (!existsSync(file))
      throw new ArtifactError("NOT_FOUND", `Artifact ${id} has no version ${wanted}`);
    return file;
  }

  /** The page of a version, the latest by default. */
  read(id: string, version?: number): string {
    return readFileSync(this.pagePath(id, version), "utf8");
  }

  save(input: SaveArtifact): ArtifactMeta {
    const bytes = Buffer.byteLength(input.html);
    if (!input.html.trim()) throw new ArtifactError("INVALID", "The page is empty");
    if (bytes > MAX_ARTIFACT_BYTES)
      throw new ArtifactError(
        "INVALID",
        `The page has ${bytes} bytes; an artifact holds at most ${MAX_ARTIFACT_BYTES}`,
      );
    const now = new Date().toISOString();
    const previous = input.id ? this.find(input.id) : null;
    if (input.id && !previous && !ARTIFACT_ID.test(input.id))
      throw new ArtifactError("INVALID", `Invalid artifact ID ${input.id}`);
    const title = input.title?.trim() || previous?.title || titleOf(input.html) || "Untitled";
    const id = input.id ?? this.freeId(slug(title));
    const meta: ArtifactMeta = {
      id,
      title,
      description: input.description ?? previous?.description ?? "",
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      project: input.project ?? null,
      bytes,
      deploys: previous?.deploys ?? [],
    };
    const dir = this.dir(id);
    mkdirSync(dir, { recursive: true });
    writeViaTemp(join(dir, `v${meta.version}.html`), input.html, WRITE);
    this.write(meta);
    return meta;
  }

  recordDeploy(id: string, deploy: ArtifactDeploy): ArtifactMeta {
    const meta = this.get(id);
    const next = { ...meta, deploys: [...meta.deploys, deploy] };
    this.write(next);
    return next;
  }

  remove(id: string): void {
    const dir = this.dir(id);
    if (!existsSync(dir)) throw new ArtifactError("NOT_FOUND", `No artifact ${id}`);
    // Renamed first, so a half-deleted folder never lists as an artifact.
    const trash = join(this.root, `.removed-${id}-${Date.now()}`);
    renameSync(dir, trash);
    rmSync(trash, { recursive: true, force: true });
  }

  private write(meta: ArtifactMeta): void {
    writeViaTemp(join(this.dir(meta.id), "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, WRITE);
  }

  private freeId(base: string): string {
    if (!this.find(base) && !existsSync(join(this.root, base))) return base;
    for (let n = 2; ; n++) {
      const id = `${base.slice(0, 60)}-${n}`;
      if (!existsSync(join(this.root, id))) return id;
    }
  }
}

/** The page's `<title>`, if it has one. */
export function titleOf(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const text = match?.[1]?.replace(/\s+/g, " ").trim();
  return text || null;
}

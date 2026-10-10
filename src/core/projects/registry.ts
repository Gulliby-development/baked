import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configDir } from "../platform/index.js";
import { writeViaTemp } from "../workflows/atomic-write.js";
import { ProjectId } from "./manifest.js";

/**
 * The user's own list of projects. Registering is how the user trusts a manifest's secondary
 * roots: a manifest is repository content, so roots outside its checkout are used only when they
 * were registered here.
 */
const RegistryEntrySchema = z
  .object({
    id: ProjectId,
    /** Absolute path of the manifest's checkout (its primary root). */
    root: z.string().min(1),
    /** Absolute real paths of the secondary roots the user accepted. */
    roots: z.array(z.string().min(1)),
    registeredAt: z.number().int().nonnegative(),
  })
  .strict();
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

const RegistrySchema = z
  .object({ schemaVersion: z.literal(1), projects: z.array(RegistryEntrySchema) })
  .strict();

export function registryPath(dir = configDir()): string {
  return join(dir, "projects.json");
}

/** Registered projects; an unreadable registry counts as empty so a bad file never blocks BAKED. */
export function readRegistry(dir = configDir()): RegistryEntry[] {
  const path = registryPath(dir);
  if (!existsSync(path)) return [];
  try {
    return RegistrySchema.parse(JSON.parse(readFileSync(path, "utf8"))).projects;
  } catch {
    return [];
  }
}

function writeRegistry(entries: RegistryEntry[], dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = registryPath(dir);
  writeViaTemp(path, `${JSON.stringify({ schemaVersion: 1, projects: entries }, null, 2)}\n`, {
    flag: "w",
    flush: true,
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes.
  }
}

/** Records a checkout's project and the secondary roots the user trusts, replacing its entry. */
export function registerProject(
  entry: Omit<RegistryEntry, "registeredAt">,
  dir = configDir(),
): RegistryEntry {
  const saved: RegistryEntry = { ...entry, registeredAt: Date.now() };
  const others = readRegistry(dir).filter((e) => e.root !== entry.root);
  writeRegistry([...others, saved], dir);
  return saved;
}

export function unregisterProject(root: string, dir = configDir()): boolean {
  const entries = readRegistry(dir);
  const kept = entries.filter((e) => e.root !== root);
  if (kept.length === entries.length) return false;
  writeRegistry(kept, dir);
  return true;
}

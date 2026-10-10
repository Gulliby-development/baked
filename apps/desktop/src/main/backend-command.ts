import { existsSync } from "node:fs";
import { join } from "node:path";

export interface BackendCommand {
  command: string;
  /** Arguments that come before the BAKED subcommand. */
  prefix: string[];
}

export interface BackendLocation {
  /** `bakedPath` from the app settings. */
  override: string | null;
  /** True in a packaged build. */
  packaged: boolean;
  /** `process.resourcesPath` of the packaged app. */
  resourcesPath: string;
  /** The repository checkout when running from source. */
  repoRoot: string;
  platform: NodeJS.Platform;
}

/**
 * How to run `baked`: the executable chosen in settings, else the binary bundled under
 * `resources/bin`, else the repository's source through Bun in development.
 */
export function resolveBackendCommand(location: BackendLocation): BackendCommand {
  if (location.override) return { command: location.override, prefix: [] };
  if (location.packaged) {
    const exe = location.platform === "win32" ? "baked.exe" : "baked";
    return { command: join(location.resourcesPath, "bin", exe), prefix: [] };
  }
  const boot = join(location.repoRoot, "src", "boot.tsx");
  if (!existsSync(boot)) throw new Error(`No BAKED source at ${boot}; set the baked path`);
  return { command: "bun", prefix: ["run", boot] };
}

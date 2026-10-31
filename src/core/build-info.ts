import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CURRENT_VERSION } from "./version.js";

/** The commit a compiled binary was built from, injected by `scripts/build.ts`. */
declare const __BAKED_COMMIT__: string | undefined;

/** Which BAKED build is running: the package version and, when known, the source commit. */
export interface RunningBuild {
  version: string;
  /** The full commit hash; null when neither the build nor a checkout names one. */
  commit: string | null;
}

let cached: RunningBuild | null = null;
let override: RunningBuild | null = null;

/** The commit of the checkout this module runs from (`bun run src/...`), or null outside one. */
function checkoutCommit(): string | null {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const result = spawnSync("git", ["-C", dir, "rev-parse", "--verify", "--quiet", "HEAD"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const head = result.status === 0 ? result.stdout.trim() : "";
    return /^[0-9a-f]{7,64}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * The running build (#2587): the version of `package.json` and the commit a compiled binary was
 * built from (`__BAKED_COMMIT__`), or else the `HEAD` of the checkout the process runs from, as
 * a bench runner pinned to a commit does. Read once per process (at the first call), so a
 * checkout moved under a running daemon later still reports the code the daemon loaded.
 */
export function runningBuild(): RunningBuild {
  if (override) return override;
  if (!cached) {
    const injected =
      typeof __BAKED_COMMIT__ !== "undefined" && __BAKED_COMMIT__ ? __BAKED_COMMIT__ : null;
    cached = { version: CURRENT_VERSION, commit: injected ?? checkoutCommit() };
  }
  return cached;
}

/** The running build as one string for repeat keys: `VERSION+COMMIT`, or `VERSION` alone. */
export function buildId(build: RunningBuild = runningBuild()): string {
  return build.commit ? `${build.version}+${build.commit.slice(0, 12)}` : build.version;
}

/** Stands in another build for tests (a scenario where the build changes); null restores it. */
export function setRunningBuild(build: RunningBuild | null): void {
  override = build;
}

/**
 * The formatter built into Bun 1.4.4 (`bun fmt`), shared by the post-edit formatter
 * (`project.ts`) and the format gates (`workflows/gates.ts`), so both detect the same opt-in (#1920).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `bun fmt` as a command. `--no-script` because a bare `bun fmt` runs the project's `fmt` package
 * script, when it has one, instead of the formatter.
 */
export const BUN_FMT = "bun fmt --no-script";

/**
 * Whether a project opted into `bun fmt`: a `[fmt]` section in its `bunfig.toml`, as
 * `bun fmt --init` writes. `bun fmt` reads a Prettier config and formats like Prettier, so a
 * project with both uses `bun fmt`; Biome and dprint stay ahead of it.
 */
export function bunFmtConfigured(cwd: string): boolean {
  try {
    const path = join(cwd, "bunfig.toml");
    if (!existsSync(path)) return false;
    const config = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof config.fmt === "object" && config.fmt !== null;
  } catch {
    return false;
  }
}

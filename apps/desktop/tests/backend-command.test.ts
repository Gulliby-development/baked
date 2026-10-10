import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveBackendCommand } from "../src/main/backend-command.ts";

const base = { override: null, packaged: false, resourcesPath: "/res", platform: "linux" as const };

describe("resolveBackendCommand", () => {
  test("prefers the executable from settings", () => {
    expect(resolveBackendCommand({ ...base, override: "/usr/bin/baked", repoRoot: "/nowhere" })).toEqual({
      command: "/usr/bin/baked",
      prefix: [],
    });
  });

  test("uses the bundled binary in a packaged app", () => {
    expect(
      resolveBackendCommand({ ...base, packaged: true, platform: "win32", repoRoot: "/nowhere" }).command,
    ).toBe(join("/res", "bin", "baked.exe"));
  });

  test("runs the repository source through Bun in development", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..");
    expect(resolveBackendCommand({ ...base, repoRoot })).toEqual({
      command: "bun",
      prefix: ["run", join(repoRoot, "src", "boot.tsx")],
    });
    expect(() => resolveBackendCommand({ ...base, repoRoot: "/nowhere" })).toThrow("No BAKED source");
  });
});

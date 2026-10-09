import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// Every test file runs against an empty user profile, so the developer's global
// hooks, BAKED config, skills and instructions never change test outcomes.
// Code that reads home at runtime (platform userHome(), configDir()) sees it;
// os.homedir() is fixed when Bun starts and is not covered.
const profile = mkdtempSync(join(tmpdir(), "baked-test-home-"));
for (const key of ["HOME", "USERPROFILE"]) process.env[key] = profile;
for (const key of ["LOCALAPPDATA", "APPDATA"]) if (process.env[key] !== undefined) process.env[key] = join(profile, key);
process.env.XDG_CONFIG_HOME = join(profile, ".config");

afterAll(() => {
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});

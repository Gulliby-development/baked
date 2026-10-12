import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, setDefaultTimeout } from "bun:test";

// Every test file runs against an empty user profile, so the developer's global
// hooks, BAKED config, skills and instructions never change test outcomes.
// Code that reads home at runtime (platform userHome(), configDir()) sees it;
// os.homedir() is fixed when Bun starts and is not covered.
const profile = mkdtempSync(join(tmpdir(), "baked-test-home-"));
for (const key of ["HOME", "USERPROFILE"]) process.env[key] = profile;
for (const key of ["LOCALAPPDATA", "APPDATA"]) if (process.env[key] !== undefined) process.env[key] = join(profile, key);
process.env.XDG_CONFIG_HOME = join(profile, ".config");
// GitHub Models falls back to these tokens and to the GitHub CLI's login, which reads GH_CONFIG_DIR.
for (const key of ["GITHUB_TOKEN", "GH_TOKEN"]) delete process.env[key];
process.env.GH_CONFIG_DIR = join(profile, "gh");

// Workflow tests drive whole runs with real check processes; on a loaded CI runner they take
// several seconds, so Bun's 5 s default fails them at random. A preload's setDefaultTimeout
// reaches only the first test file of a run, so `bun run test` passes `--timeout 30000` for the
// whole suite; this call still covers a single file run with `bun test tests/<file>`.
setDefaultTimeout(30_000);

afterAll(() => {
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
});

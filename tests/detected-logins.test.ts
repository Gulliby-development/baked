import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  copilotConfigDir,
  copilotIdeLogin,
  githubCliLogin,
  resetDetectedLoginCache,
} from "../src/core/llm/detected-logins.js";
import { checkProviders } from "../src/core/llm/provider.js";
import { copilot } from "../src/core/llm/providers/copilot.js";
import { githubModels } from "../src/core/llm/providers/github-models.js";
import { IS_WIN } from "../src/core/platform/index.js";

const saved = { ...process.env };
const dirs: string[] = [];

beforeEach(() => {
  resetDetectedLoginCache();
  for (const key of ["COPILOT_API_KEY", "GITHUB_MODELS_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"])
    delete process.env[key];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(copilotConfigDir(), { recursive: true, force: true });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetDetectedLoginCache();
});

function writeCopilotLogin(file: string, body: unknown): void {
  mkdirSync(copilotConfigDir(), { recursive: true });
  writeFileSync(join(copilotConfigDir(), file), JSON.stringify(body));
}

test("a Copilot IDE login in apps.json makes copilot available", async () => {
  expect(copilotIdeLogin()).toBeNull();
  expect(await copilot.checkAvailability?.()).toBe(false);

  writeCopilotLogin("apps.json", {
    "github.com:Iv1.b507a08c87ecfe98": { user: "octo", oauth_token: "gho_ide", githubAppId: "x" },
  });
  expect(copilotIdeLogin()).toEqual({ token: "gho_ide", source: "Copilot IDE login" });
  expect(await copilot.checkAvailability?.()).toBe(true);
  const status = (await checkProviders()).find((s) => s.id === "copilot");
  expect(status).toMatchObject({ available: true, detected: "Copilot IDE login" });

  // Signing out of the IDE makes the provider unavailable again at the next check.
  rmSync(copilotConfigDir(), { recursive: true, force: true });
  expect(await copilot.checkAvailability?.()).toBe(false);
});

test("the older hosts.json Copilot login is read too", () => {
  writeCopilotLogin("hosts.json", { "github.com": { user: "octo", oauth_token: "gho_hosts" } });
  expect(copilotIdeLogin()?.token).toBe("gho_hosts");
});

test("a Copilot key in the environment wins over the IDE login", async () => {
  writeCopilotLogin("apps.json", { "github.com:app": { oauth_token: "gho_ide" } });
  process.env.COPILOT_API_KEY = "gho_env";
  const status = (await checkProviders()).find((s) => s.id === "copilot");
  expect(status?.available).toBe(true);
  expect(status?.detected).toBeUndefined();
});

test("GitHub Models uses GITHUB_TOKEN, then GH_TOKEN, after its own key", async () => {
  expect(await githubModels.checkAvailability?.()).toBe(false);
  process.env.GH_TOKEN = "gh_token";
  expect(githubCliLogin()).toEqual({ token: "gh_token", source: "GH_TOKEN" });
  process.env.GITHUB_TOKEN = "github_token";
  expect(githubCliLogin()?.source).toBe("GITHUB_TOKEN");
  expect(await githubModels.checkAvailability?.()).toBe(true);

  process.env.GITHUB_MODELS_API_KEY = "own_key";
  const status = (await checkProviders()).find((s) => s.id === "github-models");
  expect(status?.available).toBe(true);
  expect(status?.detected).toBeUndefined();
});

// A fake `gh` is a shell script, which Windows cannot start without a shell.
test.skipIf(IS_WIN)("GitHub Models falls back to the GitHub CLI's login", async () => {
  const bin = mkdtempSync(join(tmpdir(), "baked-fake-gh-"));
  dirs.push(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\n[ "$1 $2" = "auth token" ] && echo gho_cli && exit 0\nexit 1\n');
  chmodSync(gh, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

  expect(githubCliLogin()).toEqual({ token: "gho_cli", source: "gh CLI" });
  const status = (await checkProviders()).find((s) => s.id === "github-models");
  expect(status).toMatchObject({ available: true, detected: "gh CLI" });

  // A signed-out CLI exits non-zero; after the cache is reset the provider is unavailable.
  writeFileSync(gh, "#!/bin/sh\nexit 1\n");
  resetDetectedLoginCache();
  expect(await githubModels.checkAvailability?.()).toBe(false);
});

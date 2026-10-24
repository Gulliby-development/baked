import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  _electron,
  test as base,
  type ElectronApplication,
  expect,
  type Page,
} from "@playwright/test";
import { wellKnownBinDirs } from "../../../../src/core/platform/cli-path.ts";

/**
 * Live scenarios: the built app against the repository's own `baked serve` and a real model
 * (`BAKED_LIVE_MODEL`, such as `claude-code/sonnet`). BAKED's own home is a
 * throwaway one, so a run never touches the developer's projects or settings; the providers keep
 * their sign-in, because Claude Code and Codex are pointed at the real `~/.claude` and `~/.codex`
 * and provider keys pass through the environment. Not part of CI: a model is slow, costs money and
 * answers differently from run to run, so the scenarios check outcomes (files, screens), not text.
 */

const root = join(import.meta.dirname, "..", "..");
const repoRoot = join(root, "..", "..");
const boot = join(repoRoot, "src", "boot.tsx");

/** The model every live scenario runs on; the scenarios are skipped without it. */
export const liveModel = process.env.BAKED_LIVE_MODEL?.trim() ?? "";

export interface LiveWorkspace {
  dir: string;
  /** Creates a project folder, registered with `baked projects` when the app launches. */
  project(name: string): string;
}

interface Fixtures {
  workspace: LiveWorkspace;
  /** Launches the built app (`out/`) on the live model; closed after the test. */
  launch: (options?: { config?: Record<string, unknown> }) => Promise<{
    app: ElectronApplication;
    page: Page;
  }>;
}

/** The throwaway home's folders, per platform, as Electron and BAKED look for them. */
function homeEnv(home: string): Record<string, string> {
  const real = homedir();
  const env: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    BAKED_DESKTOP_RESTART_DELAYS_MS: "100,100",
    // The providers' own sign-in stays where the developer made it.
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(real, ".claude"),
    CODEX_HOME: process.env.CODEX_HOME ?? join(real, ".codex"),
  };
  if (process.platform === "win32") {
    env.APPDATA = join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = join(home, "AppData", "Local");
  }
  return env;
}

/**
 * The PATH of `env` with the folders BAKED searches for provider CLIs under the real home appended.
 * The throwaway home hides them: on Windows the Codex desktop app's CLI is found only in
 * `%LOCALAPPDATA%\OpenAI\Codex\bin`, so every Codex scenario failed with "Codex CLI not found".
 */
function withProviderCliDirs(env: Record<string, string>): void {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const dirs = wellKnownBinDirs({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isFile: (path) => existsSync(path) && statSync(path).isFile(),
    listDir: (path) => (existsSync(path) ? readdirSync(path) : []),
    loginShellPath: () => null,
    modifiedMs: (path) => (existsSync(path) ? statSync(path).mtimeMs : 0),
  }).filter((dir) => existsSync(dir));
  env[key] = [env[key], ...dirs].filter(Boolean).join(delimiter);
}

/** Where `baked` reads its global config under `homeEnv(home)` (src/core/platform). */
function bakedConfigDir(home: string): string {
  return process.platform === "win32"
    ? join(home, "AppData", "Local", "baked")
    : join(home, ".baked");
}

/** Electron's userData for this package ("@baked/desktop") under `homeEnv(home)`. */
function userDataDir(home: string): string {
  if (process.platform === "win32") return join(home, "AppData", "Roaming", "@baked", "desktop");
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "@baked", "desktop");
  return join(home, ".config", "@baked", "desktop");
}

export const test = base.extend<Fixtures>({
  workspace: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "baked-desktop-live-"));
    const projects: string[] = [];
    await use({
      dir,
      project(name) {
        const path = join(dir, "projects", name);
        mkdirSync(path, { recursive: true });
        projects.push(path);
        return path;
      },
    });
    // The workspace is kept when BAKED_LIVE_KEEP is set, so a failure can be looked at.
    if (!process.env.BAKED_LIVE_KEEP)
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
      } catch {}
  },
  launch: async ({ workspace }, use, testInfo) => {
    const apps: ElectronApplication[] = [];
    let output = "";
    await use(async (options = {}) => {
      const home = join(workspace.dir, "home");
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (value) env[key] = value;
      Object.assign(env, homeEnv(home));
      withProviderCliDirs(env);
      const configDir = bakedConfigDir(home);
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, "config.json"),
        JSON.stringify({ defaultModel: liveModel, ...options.config }),
      );
      const projectsDir = join(workspace.dir, "projects");
      mkdirSync(projectsDir, { recursive: true });
      for (const name of readdirSync(projectsDir))
        execFileSync("bun", ["run", boot, "projects", "add", join(projectsDir, name)], {
          env,
          timeout: 120_000,
        });
      // No baked path: an unpackaged app runs the repository's source through Bun on every OS.
      const userData = userDataDir(home);
      mkdirSync(userData, { recursive: true });
      writeFileSync(
        join(userData, "settings.json"),
        JSON.stringify({ openLastProjects: false, keepRunningInTray: false }),
      );
      const app = await _electron.launch({
        args: [root, ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
        env,
      });
      apps.push(app);
      for (const stream of [app.process().stdout, app.process().stderr])
        stream?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-20_000);
        });
      const page = await app.firstWindow();
      page.on("console", (entry) => {
        output = (output + `[renderer ${entry.type()}] ${entry.text()}\n`).slice(-20_000);
      });
      page.on("pageerror", (error) => {
        output = (output + `[renderer error] ${error.message}\n`).slice(-20_000);
      });
      await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
      return { app, page };
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      // What the scenario loop files with an issue: the window and the backend's output.
      for (const app of apps) {
        const snapshot = await app
          .windows()[0]
          ?.locator("main")
          .ariaSnapshot({ timeout: 2000 })
          .catch((error: unknown) => String(error));
        await testInfo.attach("window.txt", { body: snapshot ?? "", contentType: "text/plain" });
      }
      await testInfo.attach("app-output.txt", { body: output, contentType: "text/plain" });
    }
    for (const app of apps) await app.close();
  },
});

export { expect };

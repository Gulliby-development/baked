import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _electron,
  test as base,
  type ElectronApplication,
  expect,
  type Page,
} from "@playwright/test";

const root = join(import.meta.dirname, "..", "..");
const repoRoot = join(root, "..", "..");
const fakeServe = join(root, "tests", "fixtures", "fake-serve.ts");

/** A throwaway home with project folders and a `baked` the app is pointed at. */
export interface Workspace {
  dir: string;
  /** Creates a project folder and registers it with `baked projects` when the app launches. */
  project(name: string): string;
}

export interface LaunchOptions {
  /**
   * A chat script for `baked serve` (src/core/chat/scripted-host.ts): the app then runs the
   * repository's own `baked` from source, with BAKED_TEST_SCRIPT, instead of the fake.
   */
  script?: unknown;
  /** Settings merged into the scripted backend's `~/.baked/config.json`. */
  config?: Record<string, unknown>;
  /** Extra environment for the app, e.g. BAKED_VOICE_DIR. */
  env?: Record<string, string>;
  /** Extra Chromium switches, e.g. a fake microphone. */
  args?: string[];
}

interface Fixtures {
  workspace: Workspace & { projects: { path: string; name: string }[] };
  /** Launches the built app (`out/`) against the workspace; closed after the test. */
  launch: (options?: LaunchOptions) => Promise<{ app: ElectronApplication; page: Page }>;
}

export const test = base.extend<Fixtures>({
  workspace: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "baked-desktop-e2e-"));
    const projects: { path: string; name: string }[] = [];
    await use({
      dir,
      projects,
      project(name) {
        const path = join(dir, "projects", name);
        mkdirSync(path, { recursive: true });
        projects.push({ path, name });
        return path;
      },
    });
    // A backend that is still shutting down can write into the temp home while it is removed;
    // a temp folder left behind is not a failure of the test.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {}
  },
  launch: async ({ workspace }, use, testInfo) => {
    const apps: ElectronApplication[] = [];
    let output = "";
    await use(async (options = {}) => {
      const home = join(workspace.dir, "home");
      const config = join(home, ".config");
      // Electron's userData for this package ("@baked/desktop") under XDG_CONFIG_HOME.
      const userData = join(config, "@baked", "desktop");
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        BAKED_DESKTOP_RESTART_DELAYS_MS: "100,100",
        ...options.env,
      };
      // The display, and the X authority file xvfb-run creates outside the throwaway home.
      for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
        const value = process.env[name];
        if (value) env[name] = value;
      }
      const baked = join(workspace.dir, "baked");
      if (options.script === undefined) {
        env.FAKE_BAKED_PROJECTS = join(workspace.dir, "projects.json");
        writeFileSync(env.FAKE_BAKED_PROJECTS, JSON.stringify(workspace.projects));
        writeFileSync(baked, `#!/bin/sh\nexec bun "${fakeServe}" "$@"\n`);
      } else {
        env.BAKED_TEST_SCRIPT = join(workspace.dir, "chat-script.json");
        writeFileSync(env.BAKED_TEST_SCRIPT, JSON.stringify(options.script));
        writeFileSync(
          baked,
          `#!/bin/sh\nexec bun run "${join(repoRoot, "src", "boot.tsx")}" "$@"\n`,
        );
      }
      chmodSync(baked, 0o755);
      mkdirSync(home, { recursive: true });
      if (options.script !== undefined) {
        // Chat needs a model id to start a turn; the scripted host never calls it.
        mkdirSync(join(home, ".baked"), { recursive: true });
        writeFileSync(
          join(home, ".baked", "config.json"),
          JSON.stringify({ defaultModel: "openai/gpt-scripted", ...options.config }),
        );
      }
      if (options.script !== undefined)
        for (const project of workspace.projects)
          execFileSync(baked, ["projects", "add", project.path], { env, timeout: 60_000 });
      mkdirSync(userData, { recursive: true });
      writeFileSync(
        join(userData, "settings.json"),
        JSON.stringify({ bakedPath: baked, openLastProjects: false, keepRunningInTray: false }),
      );
      // CI runners may run as root, where Chromium refuses its sandbox.
      const app = await _electron.launch({
        args: [root, "--no-sandbox", ...(options.args ?? [])],
        env,
      });
      apps.push(app);
      // The backend's and the main process's output, printed when the test fails.
      for (const stream of [app.process().stdout, app.process().stderr])
        stream?.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-6000);
        });
      expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
      const page = await app.firstWindow();
      page.on("console", (entry) => {
        output = (output + `[renderer ${entry.type()}] ${entry.text()}\n`).slice(-6000);
      });
      page.on("pageerror", (error) => {
        output = (output + `[renderer error] ${error.message}\n`).slice(-6000);
      });
      await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
      return { app, page };
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      // CI artifacts are not always at hand: the window and the process output go to the log.
      for (const app of apps) {
        const snapshot = await app
          .windows()[0]
          ?.locator("main")
          .ariaSnapshot({ timeout: 2000 })
          .catch((error: unknown) => String(error));
        console.log(
          `--- window at failure (${app.windows()[0]?.url()}) ---\n${snapshot?.slice(0, 6000)}`,
        );
      }
      console.log(`--- app output ---\n${output}`);
    }
    for (const app of apps) await app.close();
  },
});

export { expect };

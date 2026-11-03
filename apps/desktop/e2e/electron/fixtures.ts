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
      // The main process's quit steps, for the log of an app that does not quit.
      await app.evaluate(
        ({ app, BrowserWindow }, { tick, stall }) => {
          const log = (line: string) => console.log(`[main ${new Date().toISOString()}] ${line}`);
          for (const event of ["before-quit", "window-all-closed", "will-quit", "quit"] as const)
            app.on(event as "quit", () => log(event));
          process.on("uncaughtExceptionMonitor", (error) =>
            log(`uncaught ${error.stack ?? error}`),
          );
          // Why a window stops answering every locator (#2712): a renderer that crashed or hung,
          // or a busy main process, whose UI thread also carries the test's CDP traffic.
          app.on("render-process-gone", (_e, _contents, details) =>
            log(`renderer gone: ${details.reason} (exit ${details.exitCode})`),
          );
          app.on("child-process-gone", (_e, details) =>
            log(`${details.type} process gone: ${details.reason} (exit ${details.exitCode})`),
          );
          const watch = (window: InstanceType<typeof BrowserWindow>) => {
            window.on("unresponsive", () => log("window unresponsive"));
            window.on("responsive", () => log("window responsive again"));
          };
          for (const window of BrowserWindow.getAllWindows()) watch(window);
          app.on("browser-window-created", (_e, window) => watch(window));
          let last = Date.now();
          setInterval(() => {
            const late = Date.now() - last - tick;
            if (late > stall) log(`event loop stalled ${late}ms`);
            last = Date.now();
          }, tick).unref();
        },
        { tick: STALL_TICK_MS, stall: STALL_MS },
      );
      const page = await app.firstWindow();
      page.on("console", (entry) => {
        output = (output + `[renderer ${entry.type()}] ${entry.text()}\n`).slice(-6000);
      });
      page.on("pageerror", (error) => {
        output = (output + `[renderer error] ${error.message}\n`).slice(-6000);
      });
      await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
      // Backend state changes and navigations, for the log of a failed test.
      await page.evaluate(
        ({ tick, stall }) => {
          const log = (line: string) =>
            console.debug(`[${Math.round(performance.now())}ms] ${line}`);
          // A renderer that was busy says so once it runs again (#2712).
          let last = performance.now();
          setInterval(() => {
            const late = Math.round(performance.now() - last - tick);
            if (late > stall) log(`event loop stalled ${late}ms`);
            last = performance.now();
          }, tick);
          const bridge = (
            window as unknown as {
              baked: { onProjects(listener: (list: DesktopProjectLike[]) => void): void };
            }
          ).baked;
          type DesktopProjectLike = { name: string; backend: { kind: string } };
          bridge.onProjects((list) =>
            log(`projects ${list.map((p) => `${p.name}:${p.backend.kind}`).join(" ")}`),
          );
          window.addEventListener("hashchange", () => log(`hash ${window.location.hash}`));
          let prompt: Element | null = null;
          new MutationObserver(() => {
            const now = document.getElementById("chat-prompt");
            if (now !== prompt) log(now ? "composer mounted" : "composer removed");
            prompt = now;
          }).observe(document.body, { childList: true, subtree: true });
        },
        { tick: STALL_TICK_MS, stall: STALL_MS },
      );
      return { app, page };
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      // CI artifacts are not always at hand: the window and the process output go to the log.
      for (const app of apps) {
        // A main process that does not answer is itself the finding: CDP waits on it too.
        console.log(`--- main process at failure ---\n${await mainState(app)}`);
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
    for (const app of apps) {
      if (await closeWithin(app, CLOSE_TIMEOUT_MS)) continue;
      // The app did not quit: its output says what the main process was doing. The process is
      // killed so the worker can go on; the backend it started was already stopped or orphaned.
      console.log(
        `--- app did not quit within ${CLOSE_TIMEOUT_MS}ms, killed (${testInfo.title}) ---\n${output}`,
      );
      testInfo.annotations.push({
        type: "app-close-timeout",
        description: `${CLOSE_TIMEOUT_MS}ms`,
      });
      app.process().kill("SIGKILL");
      await closeWithin(app, 5000);
    }
  },
});

/** How often the event-loop probes tick, and how late a tick must be to be logged (#2712). */
const STALL_TICK_MS = 250;
const STALL_MS = 1000;

/** The window's state and each process's CPU, or that the main process did not answer in 2 s. */
async function mainState(app: ElectronApplication): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("the main process did not answer within 2000ms"), 2000);
  });
  const state = app
    .evaluate(({ app, BrowserWindow }) =>
      JSON.stringify({
        windows: BrowserWindow.getAllWindows().map((window) => ({
          url: window.webContents.getURL(),
          crashed: window.webContents.isCrashed(),
          loading: window.webContents.isLoading(),
        })),
        cpu: app
          .getAppMetrics()
          .map(
            (metric) => `${metric.type} ${metric.pid}: ${metric.cpu.percentCPUUsage.toFixed(0)}%`,
          ),
      }),
    )
    .catch((error: unknown) => String(error));
  try {
    return await Promise.race([state, silent]);
  } finally {
    clearTimeout(timer);
  }
}

/** Long enough for the app to stop its backends (5 s grace each) and quit. */
const CLOSE_TIMEOUT_MS = 20_000;

/** Closes the app and reports whether its process exited in time. */
async function closeWithin(app: ElectronApplication, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const closed = app.close().then(
    () => true,
    () => true,
  );
  try {
    return await Promise.race([closed, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export { expect };

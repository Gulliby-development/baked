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
const fakeServe = join(root, "tests", "fixtures", "fake-serve.ts");

/** A throwaway home with project folders and a fake `baked` the app is pointed at. */
export interface Workspace {
  dir: string;
  /** Creates a project folder and registers it with the fake `baked projects` list. */
  project(name: string): string;
}

interface Fixtures {
  workspace: Workspace;
  /** Launches the built app (`out/`) against the workspace; closed after the test. */
  launch: () => Promise<{ app: ElectronApplication; page: Page }>;
}

export const test = base.extend<Fixtures>({
  workspace: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "baked-desktop-e2e-"));
    const projectsFile = join(dir, "projects.json");
    const projects: { path: string; name: string }[] = [];
    writeFileSync(projectsFile, "[]");
    await use({
      dir,
      project(name) {
        const path = join(dir, "projects", name);
        mkdirSync(path, { recursive: true });
        projects.push({ path, name });
        writeFileSync(projectsFile, JSON.stringify(projects));
        return path;
      },
    });
    rmSync(dir, { recursive: true, force: true });
  },
  launch: async ({ workspace }, use) => {
    const apps: ElectronApplication[] = [];
    await use(async () => {
      const home = join(workspace.dir, "home");
      const config = join(home, ".config");
      // Electron's userData for this package ("@baked/desktop") under XDG_CONFIG_HOME.
      const userData = join(config, "@baked", "desktop");
      const baked = join(workspace.dir, "baked");
      writeFileSync(baked, `#!/bin/sh\nexec bun "${fakeServe}" "$@"\n`);
      chmodSync(baked, 0o755);
      mkdirSync(userData, { recursive: true });
      writeFileSync(
        join(userData, "settings.json"),
        JSON.stringify({ bakedPath: baked, openLastProjects: false, keepRunningInTray: false }),
      );
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        FAKE_BAKED_PROJECTS: join(workspace.dir, "projects.json"),
        BAKED_DESKTOP_RESTART_DELAYS_MS: "100,100",
      };
      // The display, and the X authority file xvfb-run creates outside the throwaway home.
      for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
        const value = process.env[name];
        if (value) env[name] = value;
      }
      // CI runners may run as root, where Chromium refuses its sandbox.
      const app = await _electron.launch({ args: [root, "--no-sandbox"], env });
      apps.push(app);
      expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
      const page = await app.firstWindow();
      await expect(page.getByRole("heading", { name: "All projects", level: 1 })).toBeVisible();
      return { app, page };
    });
    for (const app of apps) await app.close();
  },
});

export { expect };

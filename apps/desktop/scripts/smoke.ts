/**
 * Smoke test of the packaged Linux app: registers a project with the bundled `baked`, launches
 * the app under a throwaway home, and checks that All projects lists that project next to the
 * sidebar. Run it under a display, for example `xvfb-run -a bun run smoke`.
 *
 *   bun run smoke [-- --app dist/linux-unpacked/baked-desktop]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { _electron as electron } from "playwright-core";

const root = join(import.meta.dir, "..");
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { app: { type: "string" } },
});
const executable = resolve(values.app ?? join(root, "dist", "linux-unpacked", "baked-desktop"));
const baked = join(dirname(executable), "resources", "bin", "baked");

const work = mkdtempSync(join(tmpdir(), "baked-desktop-smoke-"));
const home = join(work, "home");
const project = join(work, "smoke-project");
mkdirSync(home);
mkdirSync(project);
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
};
// The display, and the X authority file xvfb-run creates outside the throwaway home.
for (const name of ["DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
  const value = process.env[name];
  if (value) env[name] = value;
}

let failed = false;
try {
  execFileSync(baked, ["projects", "add", project], { env, stdio: "inherit", timeout: 60_000 });

  // The unpacked app's chrome-sandbox is not setuid, and CI runners may run as root.
  const app = await electron.launch({ executablePath: executable, args: ["--no-sandbox"], env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.getByRole("heading", { name: "All projects", level: 1 }).waitFor({ timeout: 30_000 });
    await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 10_000 });
    // The card appears only after the bundled baked answered `projects list`.
    await page
      .getByRole("article", { name: basename(project) })
      .waitFor({ timeout: 30_000 });
    console.log(`smoke: ${await page.title()} shows All projects, the sidebar and the project`);
  } finally {
    await app.close();
  }
} catch (error) {
  failed = true;
  console.error("smoke: failed", error);
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

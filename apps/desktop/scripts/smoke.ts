/**
 * Smoke test of the packaged app on Linux, Windows or macOS: registers a project with the bundled
 * `baked`, launches the app under a throwaway home, and checks that All projects lists that
 * project next to the sidebar, and that the bundled speech engine transcribes. On Linux run it under a display, for example
 * `xvfb-run -a bun run smoke`.
 *
 *   bun run smoke [-- --app <executable>]
 *
 * The default executable is the unpacked build of this platform and architecture:
 * dist/linux-unpacked/baked-desktop, dist/win-unpacked/BAKED.exe, or
 * dist/mac-arm64/BAKED.app/Contents/MacOS/BAKED (dist/mac/... for x64).
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

function defaultExecutable(): string {
  if (process.platform === "win32") return join(root, "dist", "win-unpacked", "BAKED.exe");
  if (process.platform === "darwin") {
    const folder = process.arch === "arm64" ? "mac-arm64" : "mac";
    return join(root, "dist", folder, "BAKED.app", "Contents", "MacOS", "BAKED");
  }
  return join(root, "dist", "linux-unpacked", "baked-desktop");
}

/** The bundled `baked` in resources/bin, which src/main/backend-command.ts runs. */
function bundledBaked(executable: string): string {
  if (process.platform === "darwin")
    return join(dirname(executable), "..", "Resources", "bin", "baked");
  const exe = process.platform === "win32" ? "baked.exe" : "baked";
  return join(dirname(executable), "resources", "bin", exe);
}

const executable = resolve(values.app ?? defaultExecutable());
const baked = bundledBaked(executable);

const work = mkdtempSync(join(tmpdir(), "baked-desktop-smoke-"));
const home = join(work, "home");
const project = join(work, "smoke-project");
mkdirSync(home);
mkdirSync(project);
/** The throwaway home in the variables each OS reads the home and app data folders from. */
function homeEnv(): Record<string, string> {
  if (process.platform === "win32") {
    const appData = join(home, "AppData");
    mkdirSync(join(appData, "Roaming"), { recursive: true });
    mkdirSync(join(appData, "Local"), { recursive: true });
    return {
      USERPROFILE: home,
      HOME: home,
      APPDATA: join(appData, "Roaming"),
      LOCALAPPDATA: join(appData, "Local"),
    };
  }
  if (process.platform === "darwin") return { HOME: home };
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
  };
}

const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...homeEnv() };
// Linux: the display, and the X authority file xvfb-run creates outside the throwaway home.
// Windows: what processes need to start at all, and the temp folder.
for (const name of [
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
]) {
  const value = process.env[name];
  if (value) env[name] = value;
}

let failed = false;
try {
  execFileSync(baked, ["projects", "add", project], { env, stdio: "inherit", timeout: 60_000 });

  // Linux: the unpacked app's chrome-sandbox is not setuid, and CI runners may run as root.
  const args = process.platform === "linux" ? ["--no-sandbox"] : [];
  const app = await electron.launch({ executablePath: executable, args, env });
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.getByRole("heading", { name: "All projects", level: 1 }).waitFor({ timeout: 30_000 });
    await page.getByRole("navigation", { name: "Main" }).waitFor({ timeout: 10_000 });
    // The card appears only after the bundled baked answered `projects list`.
    await page
      .getByRole("article", { name: basename(project) })
      .waitFor({ timeout: 30_000 });
    console.log(`smoke: ${await page.title()} shows All projects, the sidebar and the project`);
    // The bundled speech engine (resources/voice) transcribes a second of silence.
    const voice = await page.evaluate(async () => {
      const baked = window.baked;
      if (!baked) return "no desktop bridge";
      const status = await baked.voiceStatus();
      if (!status.available) return status.reason ?? "unavailable";
      const result = await baked.transcribe(new Float32Array(16_000), "en");
      return `transcribed ${result.durationSeconds} s`;
    });
    if (!voice.startsWith("transcribed")) throw new Error(`voice input: ${voice}`);
    console.log(`smoke: voice input ${voice}`);
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

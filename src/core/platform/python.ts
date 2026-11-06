import { spawnSync } from "node:child_process";

/**
 * A program in `%LOCALAPPDATA%\Microsoft\WindowsApps`: an App Execution Alias. Windows ships
 * `python.exe` and `python3.exe` aliases there that, without the Store package, print "Python was
 * not found; run without arguments to install from the Microsoft Store" and exit 9009, so a PATH
 * lookup finds a `python3` that runs no Python (#2992).
 */
export const isWindowsAppAlias = (path: string): boolean =>
  /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(path);

const runs = new Map<string, boolean>();

/** Whether the program at `path` starts a Python interpreter; one probe per path. */
function startsPython(path: string): boolean {
  const known = runs.get(path);
  if (known !== undefined) return known;
  const probe = spawnSync(path, ["-c", "import sys"], {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  });
  const ok = probe.status === 0;
  runs.set(path, ok);
  return ok;
}

/**
 * The first of `names` that runs Python: by default `python3` then `python`, and on Windows
 * `python`, `py` then `python3`. A name found only as a Windows App Execution Alias counts when it
 * starts Python (the Store package is installed), and is skipped when it is the Store stub. Null
 * when none does.
 */
export function findPython(
  names?: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    which?: (name: string) => string | null;
    startsPython?: (path: string) => boolean;
  } = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const check = options.startsPython ?? startsPython;
  const candidates =
    names ?? (platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]);
  for (const name of candidates) {
    const path = which(name);
    if (!path) continue;
    if (platform === "win32" && isWindowsAppAlias(path) && !check(path)) continue;
    return name;
  }
  return null;
}

/** The Python program a command names: the one `findPython` finds, else the platform's usual name. */
export const pythonExecutable = (): string =>
  findPython() ?? (process.platform === "win32" ? "python" : "python3");

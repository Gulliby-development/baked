import { describe, expect, test } from "bun:test";
import { findPython, isWindowsAppAlias } from "../src/core/platform/python.js";

// #2992: on a Windows machine with Python from python.org, `python3` resolves only to the Store
// alias in WindowsApps, which prints "Python was not found" and exits 9009.
const STUB = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps";
const REAL = "C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313";

describe("findPython (#2992)", () => {
  test("a Windows Store stub is skipped for the next name that runs Python", () => {
    const probed: string[] = [];
    const found = findPython(["python3", "python"], {
      platform: "win32",
      which: (name) => (name === "python3" ? `${STUB}\\python3.exe` : `${REAL}\\python.exe`),
      startsPython: (path) => {
        probed.push(path);
        return false;
      },
    });
    expect(found).toBe("python");
    // Only the alias is probed; a real install is taken as found.
    expect(probed).toEqual([`${STUB}\\python3.exe`]);
  });

  test("an alias whose Store package is installed counts", () => {
    expect(
      findPython(["python3"], { platform: "win32", which: () => `${STUB}\\python3.exe`, startsPython: () => true }),
    ).toBe("python3");
  });

  test("Windows prefers python, then py, then python3; null when only the stub is there", () => {
    const which = (paths: Record<string, string>) => (name: string) => paths[name] ?? null;
    expect(findPython(undefined, { platform: "win32", which: which({ py: "C:\\Windows\\py.exe", python3: `${REAL}\\python3.exe` }) })).toBe("py");
    expect(findPython(undefined, { platform: "win32", which: which({ python: `${STUB}\\python.exe`, python3: `${STUB}\\python3.exe` }), startsPython: () => false })).toBeNull();
  });

  test("elsewhere python3 comes first and WindowsApps means nothing", () => {
    expect(findPython(undefined, { platform: "linux", which: (name) => `/usr/bin/${name}` })).toBe("python3");
    expect(findPython(undefined, { platform: "darwin", which: (name) => (name === "python" ? "/opt/bin/python" : null) })).toBe("python");
    expect(isWindowsAppAlias("C:/Users/me/AppData/Local/Microsoft/WindowsApps/python3.exe")).toBe(true);
    expect(isWindowsAppAlias(`${REAL}\\python.exe`)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { posix } from "node:path";

const { delimiter } = posix;
import {
  type CliPathHost,
  CliPathResolver,
  describeSearch,
  parseLoginShellPath,
  parseRegistryPath,
  wellKnownBinDirs,
} from "../src/core/platform/cli-path.js";

const LAUNCHD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);

function fakeHost(options: {
  platform?: NodeJS.Platform;
  path?: string;
  files?: string[];
  dirs?: Record<string, string[]>;
  shellPath?: string | null;
  env?: NodeJS.ProcessEnv;
  modified?: Record<string, number>;
  registryPath?: () => string | null;
}): CliPathHost & { shellReads: number } {
  const files = new Set(options.files ?? []);
  const host = {
    platform: options.platform ?? "darwin",
    env: { PATH: options.path ?? LAUNCHD_PATH, ...options.env } as NodeJS.ProcessEnv,
    home: "/Users/dev",
    shellReads: 0,
    isFile: (path: string) => files.has(path),
    listDir: (path: string) => options.dirs?.[path] ?? [],
    loginShellPath: () => {
      host.shellReads++;
      return options.shellPath ?? null;
    },
    modifiedMs: (path: string) => options.modified?.[path] ?? 0,
    registryPath: () => options.registryPath?.() ?? null,
  };
  return host;
}

describe("CLI path resolution", () => {
  test("a CLI on PATH resolves without asking the login shell", () => {
    const host = fakeHost({ path: `/usr/local/bin${delimiter}/usr/bin`, files: ["/usr/local/bin/codex"] });
    const result = new CliPathResolver(host).resolve("codex");
    expect(result).toEqual({ command: "/usr/local/bin/codex", found: true, searched: [] });
    expect(host.shellReads).toBe(0);
  });

  test("a Finder-launched app finds Homebrew CLIs through the login shell PATH", () => {
    const host = fakeHost({
      shellPath: `/opt/homebrew/bin${delimiter}/usr/bin${delimiter}/bin`,
      files: ["/opt/homebrew/bin/codex"],
    });
    const resolver = new CliPathResolver(host);
    expect(resolver.resolve("codex").command).toBe("/opt/homebrew/bin/codex");
    // The shell PATH is merged so the CLI's own `env node` and later tools find their binaries.
    expect(host.env.PATH?.split(delimiter)[0]).toBe("/opt/homebrew/bin");
    expect(host.env.PATH?.split(delimiter)).toContain("/sbin");
    resolver.resolve("claude");
    expect(host.shellReads).toBe(1);
  });

  test("a Claude Code local install reachable only through a shell alias is found", () => {
    const host = fakeHost({ files: ["/Users/dev/.claude/local/claude"] });
    const result = new CliPathResolver(host).resolve("claude");
    expect(result.command).toBe("/Users/dev/.claude/local/claude");
    expect(host.env.PATH?.split(delimiter)[0]).toBe("/Users/dev/.claude/local");
  });

  test("an npm install under nvm is found in the newest Node version", () => {
    const nvm = "/Users/dev/.nvm/versions/node";
    const host = fakeHost({
      dirs: { [nvm]: ["v20.11.0", "v22.3.0", "v9.0.0"] },
      files: [`${nvm}/v20.11.0/bin/codex`, `${nvm}/v22.3.0/bin/codex`],
    });
    expect(new CliPathResolver(host).resolve("codex").command).toBe(`${nvm}/v22.3.0/bin/codex`);
  });

  test("a miss names the searched folders and is checked again later", () => {
    const host = fakeHost({ shellPath: null });
    const resolver = new CliPathResolver(host);
    const miss = resolver.resolve("codex");
    expect(miss.found).toBe(false);
    expect(miss.command).toBe("codex");
    expect(miss.searched).toContain("/usr/bin");
    expect(miss.searched).toContain("/opt/homebrew/bin");
    expect(miss.searched).toContain("/Users/dev/.local/bin");
    expect(describeSearch(miss, 2)).toMatch(/^\/usr\/bin, \/bin and \d+ more$/);

    // Installed while BAKED runs: the next check finds it.
    (host as { isFile: (path: string) => boolean }).isFile = (path) =>
      path === "/Users/dev/.local/bin/codex";
    expect(resolver.resolve("codex").command).toBe("/Users/dev/.local/bin/codex");
    expect(host.shellReads).toBe(1);
  });

  test("Windows keeps spawning the bare name and never runs a login shell", () => {
    const dir = "C:\\Tools";
    const host = fakeHost({
      platform: "win32",
      path: dir,
      files: [`${dir}\\codex.exe`],
      env: { PATHEXT: ".EXE;.CMD" },
    });
    expect(new CliPathResolver(host).resolve("codex")).toEqual({
      command: "codex",
      found: true,
      searched: [],
    });
    const missing = new CliPathResolver(fakeHost({ platform: "win32", path: dir }));
    expect(missing.resolve("claude").found).toBe(false);
    expect(wellKnownBinDirs(fakeHost({ platform: "win32" }))).not.toContain("/opt/homebrew/bin");
  });

  // sketchfold R34 (#1337): the Codex desktop app updated itself mid-run and moved its CLI to a
  // new version folder; the PATH the run held still named the removed one.
  test("Windows finds the Codex app's newest version folder after the app updated itself", () => {
    const bin = "C:\\Users\\dev\\AppData\\Local\\OpenAI\\Codex\\bin";
    const host = fakeHost({
      platform: "win32",
      path: `${bin}\\26.1009.1`,
      env: { PATHEXT: ".EXE", LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
      dirs: { [bin]: ["26.1009.1", "26.1015.2", "26.1001.0"] },
      modified: { [`${bin}\\26.1015.2`]: 3000, [`${bin}\\26.1001.0`]: 1000, [`${bin}\\26.1009.1`]: 2000 },
      files: [`${bin}\\26.1015.2\\codex.exe`, `${bin}\\26.1001.0\\codex.exe`],
    });
    const dirs = wellKnownBinDirs(host);
    expect(dirs.indexOf(`${bin}\\26.1015.2`)).toBeLessThan(dirs.indexOf(`${bin}\\26.1001.0`));
    expect(new CliPathResolver(host).resolve("codex")).toEqual({ command: "codex", found: true, searched: [] });
    // The bare name spawns from the new folder.
    expect(host.env.PATH?.split(";")[0]).toBe(`${bin}\\26.1015.2`);
  });

  test("Windows reads the registry PATH again on every miss", () => {
    let registry: string | null = null;
    let reads = 0;
    const host = fakeHost({
      platform: "win32",
      path: "C:\\Old",
      env: { PATHEXT: ".EXE" },
      files: ["D:\\Tools\\codex.exe"],
      registryPath: () => {
        reads++;
        return registry;
      },
    });
    const resolver = new CliPathResolver(host);
    expect(resolver.resolve("codex").found).toBe(false);
    registry = "C:\\Old;D:\\Tools";
    expect(resolver.resolve("codex").found).toBe(true);
    expect(reads).toBe(2);
    expect(host.env.PATH?.split(";")[0]).toBe("D:\\Tools");
  });

  test("a registry PATH value is parsed and its variables expanded", () => {
    const output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %LOCALAPPDATA%\\Codex;C:\\Bin\r\n";
    expect(parseRegistryPath(output, { LocalAppData: "C:\\L" })).toBe("C:\\L\\Codex;C:\\Bin");
    expect(parseRegistryPath("ERROR: not found", {})).toBeNull();
  });

  test("the login shell PATH is read between markers, ignoring profile output", () => {
    expect(parseLoginShellPath("Welcome!\n__BAKED_PATH__/a:/b__BAKED_PATH__\nbye")).toBe("/a:/b");
    expect(parseLoginShellPath("no markers")).toBeNull();
    expect(parseLoginShellPath("__BAKED_PATH____BAKED_PATH__")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { posix } from "node:path";

const { delimiter } = posix;
import {
  type CliPathHost,
  CliPathResolver,
  describeSearch,
  parseLoginShellPath,
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

  test("the login shell PATH is read between markers, ignoring profile output", () => {
    expect(parseLoginShellPath("Welcome!\n__BAKED_PATH__/a:/b__BAKED_PATH__\nbye")).toBe("/a:/b");
    expect(parseLoginShellPath("no markers")).toBeNull();
    expect(parseLoginShellPath("__BAKED_PATH____BAKED_PATH__")).toBeNull();
  });
});

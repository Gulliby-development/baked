import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bwrapArgv,
  bwrapFailureReason,
  probeSandbox,
  type SandboxDetection,
  type SandboxHost,
  type SandboxProbeDeps,
  type SandboxRequest,
  sandboxProfile,
  seatbeltArgv,
  seatbeltProfile,
} from "../src/core/platform/sandbox.js";
import {
  acceptanceSandbox,
  chatSandbox,
  effectiveSandboxMode,
  resetSandboxWarnings,
  runSandbox,
  SandboxUnavailableError,
  sandboxEnv,
  sandboxLaunch,
  sandboxNotice,
  sandboxSettings,
  sandboxStatus,
  setSandboxOverride,
} from "../src/core/security/sandbox.js";
import { hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { windowsBatchInvocation } from "../src/core/workflows/process-scope.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";

const HOME = "/home/u";

/**
 * A host whose file system holds the directories `paths` and the regular `files` with their
 * content; `links` maps a symlink to its real path.
 */
function host(
  platform: NodeJS.Platform,
  paths: string[],
  links: Record<string, string> = {},
  env: Record<string, string | undefined> = {},
  home = HOME,
  files: Record<string, string> = {},
): SandboxHost {
  const present = new Set(paths);
  const isFile = (path: string) => Object.hasOwn(files, path);
  return {
    platform,
    home,
    env,
    exists: (path) => present.has(path) || path in links || isFile(path),
    isDirectory: (path) => present.has(path),
    realpath: (path) => {
      const linked = links[path];
      if (linked) return linked;
      if (present.has(path) || isFile(path)) return path;
      throw new Error(`ENOENT: ${path}`);
    },
    readFile: (path) => files[path] ?? null,
    list: (dir) => [
      ...new Set(
        [...present, ...Object.keys(files)]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => path.slice(dir.length + 1).split("/")[0] ?? ""),
      ),
    ],
  };
}

const request = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
  mode: "required",
  surface: "workflow",
  writable: ["/w", "/missing"],
  workspaces: ["/w"],
  network: false,
  ...over,
});

const linuxHost = host(
  "linux",
  [
    "/",
    "/w",
    "/w/.git/hooks",
    "/w/.git/config",
    `${HOME}/.ssh`,
    `${HOME}/.npmrc`,
    `${HOME}/.npm`,
    `${HOME}/.cache/go-build`,
    "/run/user/1000",
  ],
  { [`${HOME}/.aws`]: "/data/aws" },
  { XDG_RUNTIME_DIR: "/run/user/1000" },
);

const available: SandboxDetection = {
  backend: "bwrap",
  available: true,
  path: "/usr/bin/bwrap",
  reason: null,
};
const missing: SandboxDetection = {
  backend: "bwrap",
  available: false,
  path: null,
  reason: "bwrap is not installed (apt install bubblewrap)",
};

afterEach(() => {
  resetSandboxWarnings();
  setSandboxOverride(undefined);
});

describe("sandbox profile", () => {
  test("keeps existing paths, protects Git and BAKED state, masks credentials with their real paths", () => {
    expect(sandboxProfile(request(), "/w", linuxHost)).toEqual({
      cwd: "/w",
      writable: ["/w"],
      protectDirs: ["/w/.git/hooks"],
      protectFiles: ["/w/.git/config"],
      caches: [`${HOME}/.cache/go-build`, `${HOME}/.npm`],
      hiddenDirs: [`${HOME}/.ssh`, `${HOME}/.aws`, "/data/aws", "/run/user/1000"],
      hiddenFiles: [`${HOME}/.npmrc`],
      network: false,
    });
  });

  test("workflow processes also keep the definitions read-only; seatbelt protects missing paths", () => {
    const mac = host("darwin", ["/w", "/w/.git/config", `${HOME}/Library/Keychains`]);
    const profile = sandboxProfile(request({ protectDefinitions: true }), "/w", mac);
    expect(profile.protectDirs).toEqual(["/w/.git/hooks", "/w/.baked", "/w/baked"]);
    expect(profile.hiddenDirs).toEqual([`${HOME}/Library/Keychains`]);
  });

  test("a credential directory that holds the workspace stays visible", () => {
    const inside = host("linux", ["/w", `${HOME}/.codex`, `${HOME}/.codex/project`]);
    const profile = sandboxProfile(
      request({ writable: [`${HOME}/.codex/project`], workspaces: [] }),
      `${HOME}/.codex/project`,
      inside,
    );
    expect(profile.hiddenDirs).toEqual([]);
  });

  test("lists the credential stores of Linux and macOS", () => {
    const stores = [
      ".ssh",
      ".aws",
      ".config/gh",
      ".gnupg",
      ".docker/config.json",
      ".git-credentials",
      ".baked/secrets.json",
      "Library/Keychains",
      "Library/Cookies",
    ].map((p) => `${HOME}/${p}`);
    const linux = sandboxProfile(request(), "/w", host("linux", ["/w", ...stores]));
    const mac = sandboxProfile(request(), "/w", host("darwin", ["/w", ...stores]));
    const hidden = (p: { hiddenDirs: string[]; hiddenFiles: string[] }) => [
      ...p.hiddenDirs,
      ...p.hiddenFiles,
    ];
    expect(hidden(linux)).toEqual([
      `${HOME}/.ssh`,
      `${HOME}/.aws`,
      `${HOME}/.gnupg`,
      `${HOME}/.config/gh`,
      `${HOME}/.git-credentials`,
      `${HOME}/.docker/config.json`,
      `${HOME}/.baked/secrets.json`,
    ]);
    expect(hidden(mac)).toContain(`${HOME}/Library/Keychains`);
    expect(hidden(mac)).toContain(`${HOME}/Library/Cookies`);
    expect(hidden(linux)).not.toContain(`${HOME}/Library/Keychains`);
  });
});

describe("Git state", () => {
  const submodules = (platform: NodeJS.Platform) =>
    host(
      platform,
      [
        "/w",
        "/w/.git",
        "/w/.git/hooks",
        "/w/.git/modules",
        "/w/.git/modules/lib",
        "/w/.git/modules/lib/hooks",
        "/w/.git/modules/lib/modules",
        "/w/.git/modules/lib/modules/inner",
        "/w/.git/modules/lib/modules/inner/hooks",
        "/w/.git/modules/vendor",
        "/w/.git/modules/vendor/ui",
      ],
      {},
      {},
      HOME,
      {
        "/w/.git/config": "",
        "/w/.git/modules/lib/HEAD": "",
        "/w/.git/modules/lib/config": "",
        "/w/.git/modules/lib/modules/inner/HEAD": "",
        "/w/.git/modules/lib/modules/inner/config": "",
        "/w/.git/modules/vendor/ui/HEAD": "",
        "/w/.git/modules/vendor/ui/config": "",
      },
    );

  test("submodule configs and hooks stay read-only, nested and slashed names included", () => {
    const linux = sandboxProfile(request(), "/w", submodules("linux"));
    expect(linux.protectDirs).toEqual([
      "/w/.git/hooks",
      "/w/.git/modules/lib/hooks",
      "/w/.git/modules/lib/modules/inner/hooks",
    ]);
    expect(linux.protectFiles).toEqual([
      "/w/.git/config",
      "/w/.git/modules/lib/config",
      "/w/.git/modules/lib/modules/inner/config",
      "/w/.git/modules/vendor/ui/config",
    ]);
    // Seatbelt also denies the hooks directory a submodule does not have yet.
    const mac = sandboxProfile(request(), "/w", submodules("darwin"));
    expect(mac.protectDirs).toContain("/w/.git/modules/vendor/ui/hooks");
    expect(mac.protectDirs.at(-1)).toBe("/w/.baked");
  });

  const worktree = (platform: NodeJS.Platform) =>
    host(
      platform,
      [
        "/r",
        "/r/.git",
        "/r/.git/hooks",
        "/r/.git/modules",
        "/r/.git/modules/lib",
        "/r/.git/worktrees",
        "/r/.git/worktrees/t1",
        "/r/.git/worktrees/other",
        "/wt",
      ],
      {},
      {},
      HOME,
      {
        "/wt/.git": "gitdir: ../r/.git/worktrees/t1\n",
        "/r/.git/config": "",
        "/r/.git/HEAD": "",
        "/r/.git/index": "",
        "/r/.git/modules/lib/HEAD": "",
        "/r/.git/modules/lib/config": "",
        "/r/.git/worktrees/t1/HEAD": "",
        "/r/.git/worktrees/t1/commondir": "../..\n",
        "/r/.git/worktrees/t1/gitdir": "/wt/.git\n",
        "/r/.git/worktrees/other/commondir": "../..\n",
      },
    );
  const inWorktree = (over: Partial<SandboxRequest> = {}) =>
    request({ writable: ["/wt"], workspaces: ["/wt"], ...over });

  test("a worktree protects its .git file and the common directory's config and hooks", () => {
    const profile = sandboxProfile(inWorktree(), "/wt", worktree("linux"));
    expect(profile.writable).toEqual(["/wt"]);
    expect(profile.protectDirs).toEqual(["/r/.git/hooks"]);
    expect(profile.protectFiles).toEqual([
      "/r/.git/config",
      "/r/.git/modules/lib/config",
      "/wt/.git",
    ]);
  });

  test("gitWrite makes the common directory writable and keeps its config, hooks and links", () => {
    const profile = sandboxProfile(inWorktree({ gitWrite: true }), "/wt", worktree("linux"));
    expect(profile.writable).toEqual(["/wt", "/r/.git"]);
    expect(profile.protectDirs).toEqual(["/r/.git/hooks"]);
    expect(profile.protectFiles).toEqual([
      "/r/.git/config",
      "/r/.git/modules/lib/config",
      "/wt/.git",
      "/r/.git/worktrees/other/commondir",
      "/r/.git/worktrees/t1/commondir",
      "/r/.git/worktrees/t1/gitdir",
      "/r/.git/HEAD",
      "/r/.git/index",
    ]);
    // Later mounts win: every protection comes after the writable bind of the common directory.
    const argv = bwrapArgv("/usr/bin/bwrap", profile, "git", ["commit"]);
    const bind = argv.findIndex((arg, i) => arg === "--bind" && argv[i + 1] === "/r/.git");
    const firstProtection = argv.findIndex((arg, i) => arg === "--ro-bind" && i > 6);
    expect(bind).toBeGreaterThan(0);
    expect(firstProtection).toBeGreaterThan(bind);
    expect(argv.slice(firstProtection, firstProtection + 3)).toEqual([
      "--ro-bind",
      "/r/.git/hooks",
      "/r/.git/hooks",
    ]);
  });

  test("seatbelt denies the common directory's Git state after allowing it", () => {
    const profile = sandboxProfile(inWorktree({ gitWrite: true }), "/wt", worktree("darwin"));
    const built = seatbeltProfile(profile);
    expect(built.params.W1).toBe("/r/.git");
    expect(Object.entries(built.params).filter(([key]) => key.startsWith("P"))).toEqual([
      ["P0", "/r/.git/worktrees/t1/hooks"],
      ["P1", "/r/.git/hooks"],
      ["P2", "/r/.git/modules/lib/hooks"],
      ["P3", "/wt/.baked"],
    ]);
    expect(built.params.Q0).toBe("/r/.git/worktrees/t1/config");
    const lines = built.profile.split("\n");
    const allow = lines.findIndex((line) => line.startsWith("(allow file-write*"));
    const deny = lines.findIndex((line) => line.startsWith("(deny file-write* (subpath"));
    expect(lines[allow]).toContain('(subpath (param "W1"))');
    expect(deny).toBeGreaterThan(allow);
  });

  test("gitWrite has no effect on a workspace whose .git is a directory", () => {
    const profile = sandboxProfile(request({ gitWrite: true }), "/w", submodules("linux"));
    expect(profile.writable).toEqual(["/w"]);
  });

  test("a workflow run asks for Git writes only in its worktree", () => {
    const policy = { sandbox: "auto" as const, network: "deny" as const };
    expect(runSandbox(policy, "/wt", { gitWrite: true })?.gitWrite).toBe(true);
    expect(runSandbox(policy, "/w")).not.toHaveProperty("gitWrite");
  });
});

describe("bubblewrap argv", () => {
  test("mounts in order: host read-only, private /tmp, binds, protections, then masks", () => {
    const profile = sandboxProfile(request(), "/w", linuxHost);
    expect(bwrapArgv("/usr/bin/bwrap", profile, "/bin/bun", ["test"])).toEqual([
      "/usr/bin/bwrap",
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-net",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--bind",
      "/w",
      "/w",
      "--bind-try",
      `${HOME}/.cache/go-build`,
      `${HOME}/.cache/go-build`,
      "--bind-try",
      `${HOME}/.npm`,
      `${HOME}/.npm`,
      "--ro-bind",
      "/w/.git/hooks",
      "/w/.git/hooks",
      "--ro-bind",
      "/w/.git/config",
      "/w/.git/config",
      "--tmpfs",
      `${HOME}/.ssh`,
      "--tmpfs",
      `${HOME}/.aws`,
      "--tmpfs",
      "/data/aws",
      "--tmpfs",
      "/run/user/1000",
      "--ro-bind",
      "/dev/null",
      `${HOME}/.npmrc`,
      "--chdir",
      "/w",
      "--",
      "/bin/bun",
      "test",
    ]);
  });

  test("shares the network only when the request grants it", () => {
    const profile = sandboxProfile(request({ network: true }), "/w", linuxHost);
    expect(bwrapArgv("/usr/bin/bwrap", profile, "sh", [])).not.toContain("--unshare-net");
  });
});

describe("seatbelt profile", () => {
  const mac = host("darwin", ["/private/w", `${HOME}/.ssh`, `${HOME}/.netrc`, `${HOME}/.npm`], {
    "/w": "/private/w",
  });

  test("allows writes to the workspace, temp and caches; protections and masks come after", () => {
    const profile = sandboxProfile(request({ writable: ["/w"], workspaces: ["/w"] }), "/w", mac);
    const built = seatbeltProfile(profile);
    expect(built.params).toEqual({
      W0: "/private/w",
      C0: `${HOME}/.npm`,
      P0: "/private/w/.git/hooks",
      P1: "/private/w/.baked",
      Q0: "/private/w/.git/config",
      H0: `${HOME}/.ssh`,
      F0: `${HOME}/.netrc`,
    });
    expect(built.profile).toBe(
      [
        "(version 1)",
        "(allow default)",
        "(deny file-write*)",
        '(allow file-write* (subpath (param "W0")) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/") (subpath (param "C0")))',
        '(deny file-write* (subpath (param "P0")) (subpath (param "P1")) (literal (param "Q0")))',
        '(deny file-read* file-write* (subpath (param "H0")) (literal (param "F0")))',
        '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
        "(deny network*)",
        '(allow network-bind network-inbound (local ip "localhost:*"))',
        '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
        "",
      ].join("\n"),
    );
  });

  test("passes paths as parameters and refuses an executable named like an option", () => {
    const profile = sandboxProfile(request({ writable: ["/w"], network: true }), "/w", mac);
    const argv = seatbeltArgv("/usr/bin/sandbox-exec", profile, "/bin/sh", ["-c", "true"]);
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/sandbox-exec", "-p"]);
    expect(argv[2]).not.toContain("deny network");
    // The keychain daemon is cut only together with the network: some TLS stacks need it.
    expect(argv[2]).not.toContain("SecurityServer");
    expect(argv.slice(3)).toEqual([
      "-D",
      "W0=/private/w",
      "-D",
      `C0=${HOME}/.npm`,
      "-D",
      "P0=/private/w/.git/hooks",
      "-D",
      "P1=/private/w/.baked",
      "-D",
      "Q0=/private/w/.git/config",
      "-D",
      `H0=${HOME}/.ssh`,
      "-D",
      `F0=${HOME}/.netrc`,
      "/bin/sh",
      "-c",
      "true",
    ]);
    expect(() => seatbeltArgv("/usr/bin/sandbox-exec", profile, "-f", [])).toThrow(
      "Refusing to sandbox",
    );
  });
});

describe("backend detection", () => {
  const deps = (over: Partial<SandboxProbeDeps>): SandboxProbeDeps => ({
    platform: "linux",
    find: () => "/usr/bin/bwrap",
    exists: () => true,
    run: () => ({ status: 0, stderr: "" }),
    ...over,
  });

  test("Linux needs bwrap on PATH and a probe that starts", () => {
    expect(probeSandbox(deps({}))).toEqual(available);
    expect(probeSandbox(deps({ find: () => null }))).toEqual(missing);
    expect(
      probeSandbox(
        deps({ run: () => ({ status: 1, stderr: "bwrap: setting up uid map: Permission denied" }) }),
      ),
    ).toEqual({
      backend: "bwrap",
      available: false,
      path: "/usr/bin/bwrap",
      reason: "user namespaces are blocked (container or AppArmor)",
    });
    expect(bwrapFailureReason("bwrap: No permissions to create new namespace")).toBe(
      "user namespaces are blocked (container or AppArmor)",
    );
    expect(bwrapFailureReason("bwrap: something else\n")).toBe(
      "bwrap does not start: bwrap: something else",
    );
  });

  test("macOS uses sandbox-exec; Windows has no backend", () => {
    expect(probeSandbox(deps({ platform: "darwin" }))).toEqual({
      backend: "seatbelt",
      available: true,
      path: "/usr/bin/sandbox-exec",
      reason: null,
    });
    expect(probeSandbox(deps({ platform: "darwin", exists: () => false })).available).toBe(false);
    const windows = probeSandbox(deps({ platform: "win32" }));
    expect(windows).toMatchObject({ backend: "none", available: false, path: null });
    expect(windows.reason).toContain("[Unavailable on Windows]");
  });
});

describe("mode resolution", () => {
  test("a project config can only raise the mode", () => {
    expect(effectiveSandboxMode("off", "auto")).toBe("auto");
    expect(effectiveSandboxMode("required", "off")).toBe("required");
    expect(effectiveSandboxMode("auto", undefined)).toBe("auto");
    expect(effectiveSandboxMode(undefined, "nonsense")).toBe("off");
  });

  test("the chat reads the global setting, tightened by the project config", () => {
    const project = mkdtempSync(join(tmpdir(), "baked-sandbox-mode-"));
    try {
      expect(chatSandbox(project)).toBeNull();
      mkdirSync(join(project, ".baked"));
      writeFileSync(join(project, ".baked", "config.json"), JSON.stringify({ sandbox: "required" }));
      expect(sandboxSettings(project)).toMatchObject({ mode: "off", effective: "required", source: "project" });
      expect(chatSandbox(project, ["/elsewhere"])).toEqual({
        mode: "required",
        surface: "chat",
        writable: [project, "/elsewhere"],
        workspaces: [project],
        network: true,
      });
      setSandboxOverride("auto");
      expect(sandboxSettings(project)).toMatchObject({ mode: "auto", effective: "required" });
      writeFileSync(join(project, ".baked", "config.json"), JSON.stringify({ sandbox: "off" }));
      expect(sandboxSettings(project)).toMatchObject({ effective: "auto", source: "override" });
      expect(sandboxStatus(project, missing)).toMatchObject({
        effectiveMode: "auto",
        available: false,
        active: false,
        reason: missing.reason,
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a run's sandbox follows its frozen policy; only network allow grants the network", () => {
    expect(runSandbox(defaultWorkflowPolicy, "/w")).toBeNull();
    expect(runSandbox({ sandbox: "auto", network: "ask" }, "/w")).toEqual({
      mode: "auto",
      surface: "workflow",
      writable: ["/w"],
      workspaces: ["/w"],
      protectDefinitions: true,
      network: false,
    });
    expect(runSandbox({ sandbox: "required", network: "allow" }, "/w")?.network).toBe(true);
    expect(acceptanceSandbox({ sandbox: "auto", network: "deny" }, "/w", ["/w/data"], true)).toMatchObject({
      surface: "acceptance",
      writable: ["/w/data"],
      network: true,
    });
    expect(acceptanceSandbox({ sandbox: "auto", network: "deny" }, "/w", [], false)?.network).toBe(false);
  });

  test("required without a backend refuses; auto runs the command as it is and notes it once", () => {
    expect(() => sandboxLaunch("sh", ["-c", "true"], request(), "/w", missing, linuxHost)).toThrow(
      SandboxUnavailableError,
    );
    expect(() => sandboxLaunch("sh", [], request(), "/w", missing, linuxHost)).toThrow(
      "Sandbox required but unavailable on linux: bwrap is not installed (apt install bubblewrap). Install bubblewrap",
    );
    const launch = sandboxLaunch("sh", ["-c", "true"], request({ mode: "auto", surface: "chat" }), "/w", missing, linuxHost);
    expect(launch).toEqual({
      executable: "sh",
      args: ["-c", "true"],
      unsetEnv: [],
      setEnv: {},
      applied: { backend: "none", mode: "auto", network: true, reason: missing.reason ?? "" },
    });
    expect(sandboxNotice(launch.applied, "chat")).toBe(
      "[sandbox] bwrap is not installed (apt install bubblewrap); ran without OS sandbox",
    );
    expect(sandboxNotice(launch.applied, "chat")).toBeNull();
    expect(sandboxNotice(launch.applied, "workflow")).not.toBeNull();
  });

  test("a wrapped launch runs bwrap and drops agent sockets from the environment", () => {
    const launch = sandboxLaunch("sh", ["-c", "true"], request(), "/w", available, linuxHost);
    expect(launch.executable).toBe("/usr/bin/bwrap");
    expect(launch.args.slice(-5)).toEqual(["/w", "--", "sh", "-c", "true"]);
    expect(launch.applied).toEqual({ backend: "bwrap", mode: "required", network: false });
    expect(sandboxEnv({ PATH: "/bin", SSH_AUTH_SOCK: "/s", DBUS_SESSION_BUS_ADDRESS: "x", TMPDIR: "/var/t" }, launch)).toEqual({
      PATH: "/bin",
      TMPDIR: "/tmp",
    });
  });

  test("on Windows a batch script is rewritten for cmd.exe and never wrapped", () => {
    const windows = probeSandbox({
      platform: "win32",
      find: () => null,
      exists: () => false,
      run: () => ({ status: 1, stderr: "" }),
    });
    const batch = windowsBatchInvocation("C:\\p\\lint.cmd", ["src"], "cmd.exe");
    const win = host("win32", ["C:\\p"]);
    const launch = sandboxLaunch(batch.executable, batch.args, request({ mode: "auto" }), "C:\\p", windows, win);
    expect([launch.executable, ...launch.args]).toEqual(["cmd.exe", "/d", "/s", "/c", '""C:\\p\\lint.cmd" "src""']);
    expect(launch.applied.backend).toBe("none");
    expect(() => sandboxLaunch(batch.executable, batch.args, request(), "C:\\p", windows, win)).toThrow(
      "Sandbox required but unavailable on win32",
    );
  });
});

describe("run policy", () => {
  test("a policy without sandbox keeps its hash", () => {
    const parsed = PolicySchema.parse(defaultWorkflowPolicy);
    expect("sandbox" in parsed).toBe(false);
    expect(hashJson(parsed)).toBe(hashJson(defaultWorkflowPolicy));
    expect(PolicySchema.parse({ ...defaultWorkflowPolicy, sandbox: "required" }).sandbox).toBe("required");
    expect(() => PolicySchema.parse({ ...defaultWorkflowPolicy, sandbox: "off" })).toThrow();
  });

  test("workflow run and doctor take --sandbox off|auto|required", () => {
    const run = ["run", "--feature", "f", "--prompt", "p", "--sandbox"];
    expect(parseWorkflowArgs([...run, "required"]).flags.sandbox).toBe("required");
    expect(parseWorkflowArgs(["doctor", "--sandbox", "auto"]).flags.sandbox).toBe("auto");
    expect(() => parseWorkflowArgs([...run, "sometimes"])).toThrow("--sandbox accepts off, auto or required");
  });
});

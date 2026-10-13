import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedProcesses } from "../src/core/platform/index.js";
import { detectSandbox, type SandboxRequest } from "../src/core/platform/sandbox.js";
import { WINDOWS_NETWORK_GAP } from "../src/core/platform/windows-sandbox.js";
import { buildSafeEnv } from "../src/core/spawn.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";

// Real processes in the real backend. CI sets BAKED_REQUIRE_SANDBOX to the backend its runner
// installs, so these never skip silently there; elsewhere they run when a backend works.
const detection = detectSandbox();

test("CI provides the sandbox backend it promises", () => {
  const want = process.env.BAKED_REQUIRE_SANDBOX;
  if (want) expect(detection).toMatchObject({ available: true, backend: want });
});

// Commands are Bun scripts, so the same steps run on every backend without a POSIX shell.
const script = (code: string): [string, string[]] => [process.execPath, ["-e", code]];

describe.skipIf(!detection.available)("OS sandbox", () => {
  const root = join(import.meta.dir, "..");
  let home = "";
  let workspace = "";
  let outside = "";
  let previousHome: string | undefined;
  let previousProfile: string | undefined;
  const scope = new ProcessScope();

  beforeAll(() => {
    previousHome = process.env.HOME;
    previousProfile = process.env.USERPROFILE;
    home = mkdtempSync(join(tmpdir(), "baked-sandbox-home-"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "id_test"), "secret key\n");
    writeFileSync(join(home, "visible.txt"), "visible\n");
    // The profile reads the home directory when a command starts (USERPROFILE on Windows).
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    workspace = mkdtempSync(join(tmpdir(), "baked-sandbox-ws-"));
    mkdirSync(join(workspace, ".git", "hooks"), { recursive: true });
    writeFileSync(join(workspace, ".git", "config"), "[core]\n");
    const submodule = join(workspace, ".git", "modules", "x");
    mkdirSync(join(submodule, "hooks"), { recursive: true });
    writeFileSync(join(submodule, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(submodule, "config"), "[core]\n");
    // Outside every temp directory, so neither backend's temp allowance covers it.
    mkdirSync(join(root, "node_modules"), { recursive: true });
    outside = mkdtempSync(join(root, "node_modules", ".baked-sandbox-test-"));
  });

  afterAll(async () => {
    await scope.stop();
    process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    for (const dir of [home, workspace, outside]) rmSync(dir, { recursive: true, force: true });
  });

  const sandbox = (over: Partial<SandboxRequest> = {}): SandboxRequest => ({
    mode: "required",
    surface: "workflow",
    writable: [workspace],
    workspaces: [workspace],
    network: false,
    ...over,
  });
  const run = (
    executable: string,
    args: string[],
    over: Partial<SandboxRequest> = {},
    cwd = workspace,
    timeoutMs = 20_000,
  ) =>
    scope.execute(executable, args, {
      cwd,
      env: buildSafeEnv(),
      timeoutMs,
      signal: new AbortController().signal,
      sandbox: sandbox(over),
    });

  test("runs Bun and records the backend", async () => {
    const result = await run(process.execPath, ["-e", "console.log(6 * 7)"]);
    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe("42");
    expect(result.sandbox).toEqual(
      detection.backend === "restricted-token"
        ? { backend: detection.backend, mode: "required", network: true, reason: WINDOWS_NETWORK_GAP }
        : { backend: detection.backend, mode: "required", network: false },
    );
  });

  test("writes inside the workspace and nowhere else", async () => {
    const write = (path: string) =>
      run(...script(`require("node:fs").writeFileSync(${JSON.stringify(path)}, "ok\\n")`));
    const inside = await write("made.txt");
    expect(inside.exitCode).toBe(0);
    expect(readFileSync(join(workspace, "made.txt"), "utf8")).toBe("ok\n");
    const target = join(outside, "escaped.txt");
    const escaped = await write(target);
    expect(escaped.exitCode).not.toBe(0);
    expect(existsSync(target)).toBe(false);
    // The test home lies in the temp directory. On Linux /tmp is private to the command, so a write
    // there must not reach the host; on macOS the temp directories are writable by design. On
    // Windows only labeled directories are writable, and the temp directory is not one.
    if (process.platform !== "darwin") {
      await write(join(home, "x"));
      expect(existsSync(join(home, "x"))).toBe(false);
    }
  });

  test("keeps Git config and hooks read-only inside the workspace", async () => {
    const config = await run(
      ...script(`require("node:fs").appendFileSync(".git/config", "[core] fsmonitor = evil\\n")`),
    );
    expect(config.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe("[core]\n");
    const hook = await run(
      ...script(`require("node:fs").writeFileSync(".git/hooks/pre-commit", "evil")`),
    );
    expect(hook.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  test("keeps submodule Git config and hooks read-only", async () => {
    const config = await run(
      ...script(`require("node:fs").appendFileSync(".git/modules/x/config", "[core] fsmonitor = evil\\n")`),
    );
    expect(config.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".git", "modules", "x", "config"), "utf8")).toBe("[core]\n");
    const hook = await run(
      ...script(`require("node:fs").writeFileSync(".git/modules/x/hooks/post-checkout", "evil")`),
    );
    expect(hook.exitCode).not.toBe(0);
    expect(existsSync(join(workspace, ".git", "modules", "x", "hooks", "post-checkout"))).toBe(false);
  });

  test("a worktree with gitWrite commits, but its Git config, hooks and .git file stay read-only", async () => {
    const base = mkdtempSync(join(tmpdir(), "baked-sandbox-git-"));
    try {
      const repo = join(base, "repo");
      const tree = join(base, "tree");
      const git = (cwd: string, ...args: string[]) => {
        const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
          cwd,
          encoding: "utf8",
        });
        if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
        return result.stdout.trim();
      };
      mkdirSync(repo);
      git(repo, "init", "-q");
      git(repo, "commit", "-q", "--allow-empty", "-m", "base");
      git(repo, "worktree", "add", "-q", "-b", "task", tree);
      const common = join(repo, ".git");
      const commit = ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "sandboxed"];
      const write = (path: string, text: string, append = false) =>
        script(`require("node:fs").${append ? "appendFileSync" : "writeFileSync"}(${JSON.stringify(path)}, ${JSON.stringify(text)})`);
      const over = { writable: [tree], workspaces: [tree] };
      // Without gitWrite the common directory is read-only (on macOS the temp directory is
      // writable by design, so this holds on Linux only).
      if (process.platform === "linux") {
        const refused = await run("git", commit, over, tree);
        expect(refused.exitCode).not.toBe(0);
      }
      const committed = await run("git", commit, { ...over, gitWrite: true }, tree);
      expect(committed.output).toBe("");
      expect(committed.exitCode).toBe(0);
      expect(git(tree, "log", "-1", "--format=%s")).toBe("sandboxed");
      const hook = await run(...write(join(common, "hooks", "x"), "evil"), { ...over, gitWrite: true }, tree);
      expect(hook.exitCode).not.toBe(0);
      expect(existsSync(join(common, "hooks", "x"))).toBe(false);
      const configBefore = readFileSync(join(common, "config"), "utf8");
      const config = await run(
        ...write(join(common, "config"), "[core] fsmonitor = evil\n", true),
        { ...over, gitWrite: true },
        tree,
      );
      expect(config.exitCode).not.toBe(0);
      expect(readFileSync(join(common, "config"), "utf8")).toBe(configBefore);
      const gitFile = readFileSync(join(tree, ".git"), "utf8");
      const redirect = await run(...write(".git", "gitdir: /tmp/evil\n"), { ...over, gitWrite: true }, tree);
      expect(redirect.exitCode).not.toBe(0);
      expect(readFileSync(join(tree, ".git"), "utf8")).toBe(gitFile);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("hides credential stores even when the home directory is writable", async () => {
    const over = { writable: [home], workspaces: [] };
    const cat = (path: string) =>
      run(
        ...script(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(path)}))`),
        over,
        home,
      );
    const visible = await cat("visible.txt");
    expect(visible.output).toBe("visible\n");
    const key = await cat(join(home, ".ssh", "id_test"));
    expect(key.exitCode).not.toBe(0);
    expect(key.output).not.toContain("secret key");
  });

  test("denies the network but keeps loopback", async () => {
    // The Windows backend does not isolate the network and records it as open.
    if (detection.backend !== "restricted-token") {
      const remote = await run(process.execPath, [
        "-e",
        "const s=require('node:net').connect(80,'1.1.1.1');s.setTimeout(5000,()=>process.exit(4));s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(3));",
      ]);
      expect(remote.exitCode).not.toBe(0);
    }
    const loopback = await run(process.execPath, [
      "-e",
      "const s=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('loop')});fetch(`http://127.0.0.1:${s.port}/`).then(r=>r.text()).then(t=>{console.log(t);s.stop(true);});",
    ]);
    expect(loopback.exitCode).toBe(0);
    expect(loopback.output.trim()).toBe("loop");
  });

  test("a timeout stops every process of the command", async () => {
    let marker = "";
    const [bun, args] = script(
      `const kids=[0,1].map(()=>Bun.spawn([process.execPath,"-e","setTimeout(()=>{},30000)"]));console.log(kids.map(k=>k.pid).join(" "));await Promise.all(kids.map(k=>k.exited));`,
    );
    const result = await scope.execute(bun, args, {
      cwd: workspace,
      env: buildSafeEnv(),
      timeoutMs: 500,
      signal: new AbortController().signal,
      sandbox: sandbox(),
      onSpawn: (_pid, scoped) => {
        marker = scoped;
      },
    });
    expect(result.timedOut).toBe(true);
    let left = scopedProcesses(marker);
    for (let i = 0; i < 40 && left?.length; i++) {
      await Bun.sleep(50);
      left = scopedProcesses(marker);
    }
    expect(left ?? []).toEqual([]);
    // Windows has no process environment table, so the PIDs the command printed must be gone
    // (elsewhere they can be PIDs of the sandbox's own namespace).
    if (left !== null) return;
    const pids = result.output.trim().split(/\s+/).filter(Boolean).map(Number);
    expect(pids).toHaveLength(2);
    for (const pid of pids) {
      let alive = true;
      for (let i = 0; i < 40 && alive; i++) {
        try {
          process.kill(pid, 0);
          await Bun.sleep(50);
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    }
  });

  // The `security` tool asks the keychain daemon, which reads the keychain outside the sandbox.
  describe.skipIf(process.platform !== "darwin")("macOS keychain", () => {
    const service = `baked-sandbox-test-${process.pid}`;
    const find = ["find-generic-password", "-s", service, "-w"];
    let stored = false;

    beforeAll(() => {
      const env = { ...process.env, HOME: previousHome };
      stored =
        spawnSync("security", ["add-generic-password", "-s", service, "-a", "baked", "-w", "s3cret-value"], { env, timeout: 10_000 }).status === 0 &&
        spawnSync("security", find, { env: buildSafeEnv(), timeout: 10_000 }).status === 0;
    });

    afterAll(() => {
      spawnSync("security", ["delete-generic-password", "-s", service], {
        env: { ...process.env, HOME: previousHome },
        timeout: 10_000,
      });
    });

    test("the security tool cannot read the keychain without network", async () => {
      // The item must be readable outside the sandbox first, or the denial proves nothing.
      if (!stored) return;
      const result = await run("security", find);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).not.toContain("s3cret-value");
    });

    test("TLS still works when the network is allowed", async () => {
      const reachable = spawnSync("curl", ["-sI", "--max-time", "10", "https://example.com"]).status === 0;
      if (!reachable) return;
      const result = await run("curl", ["-sI", "--max-time", "10", "https://example.com"], { network: true });
      expect(result.exitCode).toBe(0);
    });
  });
});

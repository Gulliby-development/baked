import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findPlatformDownload,
  type MasonDownload,
  masonTargetsFor,
  parseGenericBin,
  resolveAssetTemplate,
} from "../src/core/intelligence/backends/lsp/installer.ts";

const IS_WIN = process.platform === "win32";
const root = mkdtempSync(join(tmpdir(), "baked-lsp-generic-"));
const installer = resolve("src/core/intelligence/backends/lsp/installer.ts");
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("template rendering", () => {
  test("renders version and strip_prefix", () => {
    expect(resolveAssetTemplate("a-{{ version }}.tgz", "v1.2.0")).toBe("a-v1.2.0.tgz");
    expect(resolveAssetTemplate('a-{{ version | strip_prefix "v" }}-x.tar.gz', "v1.61.0")).toBe(
      "a-1.61.0-x.tar.gz",
    );
    expect(resolveAssetTemplate('{{version|strip_prefix "v"}}', "2.0")).toBe("2.0");
  });
});

describe("target selection", () => {
  const downloads: MasonDownload[] = [
    { target: ["darwin_x64", "darwin_arm64"], files: { a: "mac" } },
    { target: "linux", files: { a: "linux" } },
    { target: "win", files: { a: "win" } },
  ];
  test("matches array and string targets", () => {
    expect(findPlatformDownload(downloads, "darwin", "arm64")?.files.a).toBe("mac");
    expect(findPlatformDownload(downloads, "linux", "arm64")?.files.a).toBe("linux");
    expect(findPlatformDownload(downloads, "win32", "x64")?.files.a).toBe("win");
  });
  test("unix matches linux and darwin but not Windows", () => {
    const unix: MasonDownload[] = [{ target: "unix", files: { a: "unix" } }];
    expect(findPlatformDownload(unix, "linux", "x64")?.files.a).toBe("unix");
    expect(findPlatformDownload(unix, "darwin", "x64")?.files.a).toBe("unix");
    expect(findPlatformDownload(unix, "win32", "x64")).toBeNull();
  });
  test("arch-specific targets and missing entries", () => {
    expect(masonTargetsFor("linux", "x64")).toContain("linux_x64_gnu");
    expect(masonTargetsFor("win32", "arm64")).toEqual(["win", "win_arm64"]);
    const arm: MasonDownload[] = [{ target: "linux_arm64", files: { a: "arm" } }];
    expect(findPlatformDownload(arm, "linux", "x64")).toBeNull();
    expect(findPlatformDownload(undefined, "linux", "x64")).toBeNull();
  });
});

describe("bin parsing", () => {
  test("python, exec, plain and unknown prefixes", () => {
    expect(parseGenericBin("python:bin/jdtls")).toEqual({ kind: "python", path: "bin/jdtls" });
    expect(parseGenericBin("exec:bin/server")).toEqual({ kind: "exec", path: "bin/server" });
    expect(parseGenericBin("bin/server")).toEqual({ kind: "exec", path: "bin/server" });
    expect("error" in parseGenericBin("dotnet:server.dll")).toBe(true);
  });
});

test("installs, reports and uninstalls a generic package", async () => {
  // Build a tarball with the jdtls layout: bin/jdtls and plugins/x.jar.
  const src = join(root, "src");
  mkdirSync(join(src, "bin"), { recursive: true });
  mkdirSync(join(src, "plugins"), { recursive: true });
  writeFileSync(join(src, "bin", "jdtls"), "print('jdtls')\n");
  writeFileSync(join(src, "plugins", "x.jar"), "jar");
  const tarball = join(root, "server.tar.gz");
  const tar = spawnSync("tar", ["-czf", tarball, "-C", src, "bin", "plugins"]);
  expect(tar.status).toBe(0);

  const pkg = {
    name: "baked-test-generic",
    description: "",
    homepage: "",
    licenses: [],
    languages: ["Java"],
    categories: ["LSP"],
    source: {
      id: "pkg:generic/test/baked-test-generic@v1.61.0",
      download: [
        {
          target: ["darwin_x64", "darwin_arm64", "linux", "win"],
          files: {
            "server.tar.gz":
              'https://example.invalid/server-{{ version | strip_prefix "v" }}.tar.gz',
            "extra.jar": "https://example.invalid/extra-{{ version }}.jar",
          },
        },
      ],
    },
    bin: { "baked-test-generic-ls": "python:bin/jdtls" },
  };

  const home = join(root, "home");
  mkdirSync(home);
  const lspDir = join(home, IS_WIN ? "baked" : ".baked", "lsp-servers");
  const pkgDir = join(lspDir, "packages", "baked-test-generic");
  const launcher = join(lspDir, "bin", IS_WIN ? "baked-test-generic-ls.cmd" : "baked-test-generic-ls");
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      const tarball = ${JSON.stringify(tarball)};
      const requested = [];
      globalThis.fetch = async (url) => {
        requested.push(String(url));
        if (String(url).endsWith(".tar.gz")) return new Response(await Bun.file(tarball).arrayBuffer());
        return new Response("extra");
      };
      const api = await import(${JSON.stringify(installer)});
      const pkg = ${JSON.stringify(pkg)};
      const install = await api.installPackage(pkg);
      api.clearPathCache();
      const status = api.checkPackageStatus(pkg);
      const fs = await import("node:fs");
      const launcher = ${JSON.stringify(launcher)};
      const pkgDir = ${JSON.stringify(pkgDir)};
      const between = { installed: status.installed, source: status.source,
        method: status.installMethod, toolchain: status.requiresToolchain,
        launcher: fs.readFileSync(launcher, "utf-8"),
        files: ["bin/jdtls", "plugins/x.jar", "extra.jar"].filter((f) => fs.existsSync(pkgDir + "/" + f)),
        archiveLeft: fs.readdirSync(pkgDir).some((f) => f.startsWith(".download")) };
      const uninstall = await api.uninstallPackage(pkg);
      api.clearPathCache();
      const after = { launcher: fs.existsSync(launcher), pkgDir: fs.existsSync(pkgDir),
        installed: api.checkPackageStatus(pkg).installed };
      console.log(JSON.stringify({ install, requested, between, uninstall, after }));
    `,
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe("");
  expect(exit).toBe(0);
  const result = JSON.parse(output);

  expect(result.install).toEqual({ success: true });
  expect(result.requested).toEqual([
    "https://example.invalid/server-1.61.0.tar.gz",
    "https://example.invalid/extra-v1.61.0.jar",
  ]);
  expect(result.between).toMatchObject({
    installed: true,
    source: "baked",
    method: "generic",
    toolchain: IS_WIN ? "python" : "python3",
    files: ["bin/jdtls", "plugins/x.jar", "extra.jar"],
    archiveLeft: false,
  });
  expect(result.between.launcher).toContain(join(pkgDir, "bin", "jdtls"));
  expect(result.uninstall).toEqual({ success: true });
  expect(result.after).toEqual({ launcher: false, pkgDir: false, installed: false });
});

test("rejects unknown bin prefixes and writes a python launcher", async () => {
  const home = join(root, "home2");
  mkdirSync(home);
  const src = join(root, "src2");
  mkdirSync(join(src, "bin"), { recursive: true });
  writeFileSync(join(src, "bin", "jdtls"), "print('jdtls')\n");
  const tarball = join(root, "server2.tar.gz");
  expect(spawnSync("tar", ["-czf", tarball, "-C", src, "bin"]).status).toBe(0);
  const pkg = {
    name: "baked-test-generic",
    description: "",
    homepage: "",
    licenses: [],
    languages: [],
    categories: ["LSP"],
    source: {
      id: "pkg:generic/test/baked-test-generic@1.0.0",
      download: [{ target: ["unix", "win"], files: { "server.tar.gz": "https://example.invalid/s.tar.gz" } }],
    },
    bin: { "baked-test-generic-ls": "python:bin/jdtls", bad: "dotnet:x.dll" },
  };
  const child = Bun.spawn(
    [
      process.execPath,
      "--eval",
      `
      globalThis.fetch = async () => new Response(await Bun.file(${JSON.stringify(tarball)}).arrayBuffer());
      const api = await import(${JSON.stringify(installer)});
      const pkg = ${JSON.stringify(pkg)};
      const rejected = await api.installPackage(pkg);
      delete pkg.bin.bad;
      const install = await api.installPackage(pkg);
      console.log(JSON.stringify({ rejected, install }));
    `,
    ],
    {
      env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, error, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(error).toBe("");
  expect(exit).toBe(0);
  const result = JSON.parse(output);
  expect(result.rejected.success).toBe(false);
  expect(result.rejected.error).toContain('"dotnet:"');
  expect(result.install).toEqual({ success: true });

  const lspDir = join(home, IS_WIN ? "baked" : ".baked", "lsp-servers");
  const pkgDir = join(lspDir, "packages", "baked-test-generic");
  const launcher = join(lspDir, "bin", IS_WIN ? "baked-test-generic-ls.cmd" : "baked-test-generic-ls");
  const text = readFileSync(launcher, "utf-8");
  expect(text).toContain(join(pkgDir, "bin", "jdtls"));
  expect(text).toContain(IS_WIN ? "python " : "python3 ");
  expect(readFileSync(join(pkgDir, "bin", "jdtls"), "utf-8")).toBe("print('jdtls')\n");
});

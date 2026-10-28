import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { sourceManifest } from "../src/core/verification/snapshot.js";
import { worktreePathChecks } from "../src/core/workflows/doctor.js";
import {
  ALL_DEPENDENCY_DIRS,
  isLinkedDependency,
  linkDependencies,
  PROJECT_PATHS,
  parseLuaTable,
  SHADOW_MARK,
} from "../src/core/workflows/dependency-dirs.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import {
  createTaskWorktree,
  removeTaskWorktree,
  runContentCommit,
  worktreePath,
} from "../src/core/workflows/worktree.js";

// Scenarios of bench round 75. ladlemath-update (PHP, #2362): the worktree linked the whole
// vendor/, and Composer's autoloader resolves the project's namespace from its own location, so a
// class the task created in the worktree's src/ was looked up in the main workspace's src/ and
// every check failed with "Class not found". The same holds for any installed folder that names
// the project: an editable Python install, an npm workspace link. And a Dart worktree (#2361) had
// no `.dart_tool/package_config.json` at all, so nothing resolved.

const IS_WIN = process.platform === "win32";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function write(root: string, path: string, content = "") {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A git project with `files` committed, then `installed` written (ignored), and a worktree of it. */
function project(files: Record<string, string>, installed: (workspace: string) => void) {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "baked-dependency-shapes-")));
  roots.push(workspace);
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "t");
  git(workspace, "config", "user.email", "t@example.com");
  for (const [path, content] of Object.entries(files)) write(workspace, path, content);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "base");
  installed(workspace);
  const runId = "run-shapes";
  const path = worktreePath(runId);
  git(workspace, "worktree", "add", "-q", "-b", "baked/run-shapes", join(workspace, path));
  const root = join(workspace, path);
  linkDependencies(workspace, root);
  const state = { worktree: { path, branch: "baked/run-shapes", baseHead: "", commit: null } };
  const store = {
    workspace,
    run: () => ({ created_at: 1_700_000_000_000 }),
    state: () => state,
  } as unknown as WorkflowStore;
  return { workspace, root, store, runId, worktree: state.worktree };
}

function run(cwd: string, command: string[]): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(`${command.join(" ")}: ${result.stdout.toString()}${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const COMPOSER_JSON = `${JSON.stringify({ name: "acme/ladlemath", autoload: { "psr-4": { "App\\": "src/" } } }, null, 2)}\n`;
const COMPOSER_FILES = {
  ".gitignore": ".baked/\nvendor/\n",
  "composer.json": COMPOSER_JSON,
  "src/Sum.php": "<?php\nnamespace App;\nfinal class Sum {}\n",
};

describe.skipIf(!Bun.which("php") || !Bun.which("composer"))(
  "scenario: ladlemath R75, Composer autoload in a worktree (#2362)",
  () => {
    test("a class the task creates in the worktree loads from the worktree", () => {
      const f = project(COMPOSER_FILES, (workspace) => {
        run(workspace, ["composer", "dump-autoload", "--no-interaction", "--quiet"]);
        write(workspace, "vendor/acme/lib/Lib.php", "<?php\n");
      });
      write(f.root, "src/Product.php", "<?php\nnamespace App;\nfinal class Product {}\n");
      const where = (cls: string) =>
        run(f.root, [
          "php",
          "-r",
          `require "vendor/autoload.php"; echo (new ReflectionClass("App\\\\${cls}"))->getFileName();`,
        ]);
      expect(where("Product")).toBe(join(f.root, "src", "Product.php"));
      expect(where("Sum")).toBe(join(f.root, "src", "Sum.php"));
      // The installed packages are still the project's, not copies.
      expect(lstatSync(join(f.root, "vendor/acme")).isSymbolicLink()).toBe(true);
    });
  },
);

describe("dependency folders that name the project (#2362)", () => {
  test("Composer: vendor/composer and the autoloader are the worktree's own, packages linked", () => {
    const f = project(COMPOSER_FILES, (workspace) => {
      write(workspace, "vendor/autoload.php", "<?php\nrequire_once __DIR__ . '/composer/autoload_real.php';\n");
      write(workspace, "vendor/composer/autoload_psr4.php", "<?php\n$baseDir = dirname(dirname(__DIR__));\n");
      write(workspace, "vendor/bin/phpunit", "#!/usr/bin/env php\n<?php include __DIR__ . '/..'.'/phpunit/phpunit/phpunit';\n");
      write(workspace, "vendor/phpunit/phpunit/phpunit", "<?php\n");
    });
    const vendor = join(f.root, "vendor");
    expect(lstatSync(vendor).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(vendor, "composer")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(vendor, "autoload.php")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(vendor, "bin/phpunit")).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(vendor, "phpunit")).isSymbolicLink() || IS_WIN).toBe(true);
    expect(isLinkedDependency(f.root, "vendor")).toBe(true);
  });

  test.skipIf(IS_WIN || !Bun.which("python3"))(
    "Python: an editable install in .venv imports the worktree's sources",
    () => {
      const f = project(
        { ".gitignore": ".baked/\n.venv/\n", "src/app/__init__.py": "NAME = 'main'\n" },
        (workspace) => {
          run(workspace, ["python3", "-m", "venv", "--without-pip", ".venv"]);
          const lib = join(workspace, ".venv", "lib");
          const site = join(lib, readdirSync(lib)[0] ?? "", "site-packages");
          // What `pip install -e .` writes for a src layout.
          writeFileSync(join(site, "__editable__.app-0.1.pth"), `${join(workspace, "src")}\n`);
        },
      );
      write(f.root, "src/app/__init__.py", "NAME = 'worktree'\n");
      const out = run(f.root, [
        join(f.root, ".venv/bin/python"),
        "-c",
        "import sys, app; print(app.NAME); print(sys.prefix)",
      ]).split("\n");
      expect(out[0]).toBe("worktree");
      expect(out[1]).toBe(join(f.root, ".venv"));
      expect(readFileSync(join(f.workspace, ".venv/pyvenv.cfg"), "utf8")).not.toContain(f.root);
    },
  );

  test.skipIf(IS_WIN)("npm workspaces: the project's own package resolves inside the worktree", () => {
    const f = project(
      {
        ".gitignore": ".baked/\nnode_modules/\n",
        "package.json": '{ "workspaces": ["packages/*"] }\n',
        "packages/app/index.js": "module.exports = 'main';\n",
      },
      (workspace) => {
        write(workspace, "node_modules/left-pad/index.js", "module.exports = 1;\n");
        symlinkSync("../packages/app", join(workspace, "node_modules/app"));
        write(workspace, "node_modules/.bin/tool", "#!/bin/sh\n");
      },
    );
    write(f.root, "packages/app/index.js", "module.exports = 'worktree';\n");
    expect(realpathSync(join(f.root, "node_modules/app"))).toBe(join(f.root, "packages/app"));
    expect(realpathSync(join(f.root, "node_modules/left-pad"))).toBe(
      join(f.workspace, "node_modules/left-pad"),
    );
    expect(run(f.root, ["node", "-p", "require('app')"])).toBe("worktree");
  });

  test("a folder without project paths is still linked whole", () => {
    const f = project({ ".gitignore": ".baked/\nnode_modules/\n" }, (workspace) => {
      write(workspace, "node_modules/left-pad/index.js");
    });
    expect(lstatSync(join(f.root, "node_modules")).isSymbolicLink()).toBe(true);
  });

  test("the snapshot, the content commit and the worktree removal leave a built folder alone", async () => {
    // vendor/ is not ignored here, so only the dependency test keeps it out.
    const f = project({ ...COMPOSER_FILES, ".gitignore": ".baked/\n" }, (workspace) => {
      write(workspace, "vendor/autoload.php", "<?php\n");
      write(workspace, "vendor/composer/autoload_psr4.php", "<?php\n");
      write(workspace, "vendor/acme/lib/Lib.php", "<?php\n");
    });
    // The main workspace tracks no vendor/, so the worktree had none to check out.
    expect(existsSync(join(f.root, "vendor", SHADOW_MARK))).toBe(true);
    write(f.root, "src/Product.php", "<?php\n");
    const manifest = Object.keys(await sourceManifest(f.root));
    expect(manifest).toContain("src/Product.php");
    expect(manifest.filter((path) => path.startsWith("vendor"))).toEqual([]);
    const base = await runContentCommit(f.store, f.runId, f.worktree);
    const files = git(f.workspace, "ls-tree", "-r", "--name-only", base).split("\n");
    expect(files).toContain("src/Product.php");
    expect(files.filter((file) => file.startsWith("vendor"))).toEqual([]);
    const task = await createTaskWorktree(f.store, f.runId, "T001", base);
    expect(existsSync(join(f.workspace, task, "vendor/composer/autoload_psr4.php"))).toBe(true);
    expect((await removeTaskWorktree(f.workspace, task)).removed).toBe(true);
    expect(existsSync(join(f.workspace, "vendor/acme/lib/Lib.php"))).toBe(true);
  });

  test("every dependency folder says whether its installed files name the project", () => {
    expect(Object.keys(PROJECT_PATHS).sort()).toEqual([...ALL_DEPENDENCY_DIRS].sort());
  });
});

describe.skipIf(IS_WIN)("scenario: Dart R75, a worktree resolves its packages (#2361)", () => {
  const bin = mkdtempSync(join(tmpdir(), "baked-fake-dart-"));
  const log = join(bin, "calls.log");
  const savedPath = process.env.PATH;
  for (const tool of ["dart", "flutter"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $* @ $(pwd)" >> '${log}'\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  afterEach(() => rmSync(log, { force: true }));

  test("the worktree runs dart pub get --offline in itself", () => {
    const f = project(
      { ".gitignore": ".baked/\n.dart_tool/\n", "pubspec.yaml": "name: ladle\nenvironment:\n  sdk: ^3.5.0\n" },
      (workspace) => write(workspace, ".dart_tool/package_config.json", "{}\n"),
    );
    expect(calls()).toEqual([`dart pub get --offline @ ${f.root}`]);
  });

  test("a Flutter package runs flutter pub get", () => {
    const f = project(
      {
        ".gitignore": ".baked/\n.dart_tool/\n",
        "pubspec.yaml": "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n",
      },
      () => {},
    );
    expect(calls()).toEqual([`flutter pub get --offline @ ${f.root}`]);
  });

  test("a project that commits its package config resolves without pub get", () => {
    project(
      { "pubspec.yaml": "name: ladle\n", ".dart_tool/package_config.json": "{}\n" },
      () => {},
    );
    expect(calls()).toEqual([]);
  });
});

describe("scenario: Dart R75, a deep workspace (#2361)", () => {
  test("the doctor warns a Dart project whose task worktrees are too deep for dart test", () => {
    const shallow = mkdtempSync(join(tmpdir(), "d-"));
    const deep = join(shallow, "x".repeat(80));
    roots.push(shallow);
    mkdirSync(deep);
    for (const dir of [shallow, deep]) write(dir, "pubspec.yaml", "name: ladle\n");
    write(shallow, "y".repeat(80) + "/package.json", "{}\n");
    expect(worktreePathChecks(shallow)).toEqual([]);
    expect(worktreePathChecks(join(shallow, "y".repeat(80)))).toEqual([]);
    const [line] = worktreePathChecks(deep);
    expect(line).toMatchObject({ id: "worktree.path", status: "warn", subject: "dart test" });
    expect(line?.title).toContain("dart test fails over 120");
  });
});

// #2371: LuaRocks, renv/packrat and opam install a *copy* of the project into the dependency
// folder, so a worktree that links the folder loads the main workspace's last install. The
// project's own entry is left out of the worktree's folder; the rest stays linked.
describe.skipIf(IS_WIN)("dependency folders that hold an installed copy of the project (#2371)", () => {
  const exists = (path: string) => existsSync(path) || isLinkSafe(path);
  const isLinkSafe = (path: string) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  };

  test("LuaRocks: the project's own rock is left out of lua_modules, other rocks stay linked", () => {
    const f = project(
      {
        ".gitignore": ".baked/\nlua_modules/\n",
        "ladle-1.0-1.rockspec": 'package = "ladle"\nversion = "1.0-1"\n',
        "src/ladle/init.lua": "return 'main'\n",
      },
      (workspace) => {
        const rocks = "lua_modules/lib/luarocks/rocks-5.4";
        write(workspace, `${rocks}/manifest`, "repository = {}\n");
        write(
          workspace,
          `${rocks}/ladle/1.0-1/rock_manifest`,
          'rock_manifest = {\n   lua = {\n      ladle = {\n         ["init.lua"] = "aa",\n         ["sum.lua"] = "bb"\n      }\n   },\n   ["ladle-1.0-1.rockspec"] = "cc"\n}\n',
        );
        write(workspace, `${rocks}/inspect/3.1-1/rock_manifest`, "rock_manifest = { lua = { [\"inspect.lua\"] = \"dd\" } }\n");
        write(workspace, "lua_modules/share/lua/5.4/ladle/init.lua", "return 'main install'\n");
        write(workspace, "lua_modules/share/lua/5.4/ladle/sum.lua", "return 1\n");
        write(workspace, "lua_modules/share/lua/5.4/inspect.lua", "return {}\n");
      },
    );
    const tree = join(f.root, "lua_modules");
    expect(isLinkSafe(tree)).toBe(false);
    expect(exists(join(tree, "share/lua/5.4/ladle/init.lua"))).toBe(false);
    expect(exists(join(tree, "share/lua/5.4/ladle/sum.lua"))).toBe(false);
    expect(exists(join(tree, "lib/luarocks/rocks-5.4/ladle"))).toBe(false);
    expect(realpathSync(join(tree, "share/lua/5.4/inspect.lua"))).toBe(
      join(f.workspace, "lua_modules/share/lua/5.4/inspect.lua"),
    );
    expect(exists(join(tree, "lib/luarocks/rocks-5.4/inspect"))).toBe(true);
    expect(isLinkedDependency(f.root, "lua_modules")).toBe(true);
    // The main workspace keeps its install.
    expect(existsSync(join(f.workspace, "lua_modules/share/lua/5.4/ladle/init.lua"))).toBe(true);
  });

  test("renv and packrat: the project's own package is left out of the library", () => {
    const f = project(
      { ".gitignore": ".baked/\nrenv/library/\npackrat/lib/\n", DESCRIPTION: "Package: ladle\nVersion: 0.1.0\n" },
      (workspace) => {
        const renv = "renv/library/R-4.3/x86_64-pc-linux-gnu";
        write(workspace, `${renv}/ladle/DESCRIPTION`, "Package: ladle\n");
        write(workspace, `${renv}/testthat/DESCRIPTION`, "Package: testthat\n");
        const packrat = "packrat/lib/x86_64-pc-linux-gnu/4.3.1";
        write(workspace, `${packrat}/ladle/DESCRIPTION`, "Package: ladle\n");
        write(workspace, `${packrat}/rlang/DESCRIPTION`, "Package: rlang\n");
      },
    );
    expect(exists(join(f.root, "renv/library/R-4.3/x86_64-pc-linux-gnu/ladle"))).toBe(false);
    expect(isLinkSafe(join(f.root, "renv/library/R-4.3/x86_64-pc-linux-gnu/testthat"))).toBe(true);
    expect(exists(join(f.root, "packrat/lib/x86_64-pc-linux-gnu/4.3.1/ladle"))).toBe(false);
    expect(isLinkSafe(join(f.root, "packrat/lib/x86_64-pc-linux-gnu/4.3.1/rlang"))).toBe(true);
  });

  test("opam: the files the project's pinned package installed are left out of _opam", () => {
    const f = project(
      { ".gitignore": ".baked/\n_opam/\n", "ladle.opam": 'opam-version: "2.0"\n', "dune-project": "(lang dune 3.0)\n" },
      (workspace) => {
        write(
          workspace,
          "_opam/.opam-switch/install/ladle.changes",
          'opam-version: "2.0"\nadded: [\n  "bin/ladle" {"F:md5=aa"}\n  "lib/ladle" {"D"}\n  "lib/ladle/META" {"F:md5=bb"}\n  "lib/ladle/ladle.cma" {"F:md5=cc"}\n]\n',
        );
        write(workspace, "_opam/bin/ladle", "main install\n");
        write(workspace, "_opam/bin/dune", "dune\n");
        write(workspace, "_opam/lib/ladle/META", "");
        write(workspace, "_opam/lib/ladle/ladle.cma", "");
        write(workspace, "_opam/lib/fmt/META", "");
      },
    );
    const sw = join(f.root, "_opam");
    expect(exists(join(sw, "bin/ladle"))).toBe(false);
    expect(exists(join(sw, "lib/ladle/META"))).toBe(false);
    expect(exists(join(sw, "lib/ladle/ladle.cma"))).toBe(false);
    expect(isLinkSafe(join(sw, "bin/dune"))).toBe(true);
    expect(isLinkSafe(join(sw, "lib/fmt"))).toBe(true);
  });

  test("a folder without the project's own install is still linked whole", () => {
    const f = project(
      { ".gitignore": ".baked/\nlua_modules/\n", "ladle-1.0-1.rockspec": 'package = "ladle"\n' },
      (workspace) => write(workspace, "lua_modules/share/lua/5.4/inspect.lua", "return {}\n"),
    );
    expect(isLinkSafe(join(f.root, "lua_modules"))).toBe(true);
  });

  test("reads a rock_manifest as LuaRocks writes it", () => {
    expect(
      parseLuaTable(
        'rock_manifest = {\n   bin = {\n      ladle = "11"\n   },\n   lua = {\n      ["ladle.lua"] = "22",\n      ladle = {\n         ["util.lua"] = "33"\n      }\n   },\n   ["ladle-1.0-1.rockspec"] = "44"\n}\n',
      ),
    ).toEqual({
      bin: { ladle: "11" },
      lua: { "ladle.lua": "22", ladle: { "util.lua": "33" } },
      "ladle-1.0-1.rockspec": "44",
    });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { executeCheckCommand } from "../src/core/verification/check-runner.js";
import { detectGates } from "../src/core/workflows/gates.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { linkedWorktreeRoot, withProjectRoot, withProjectRootEnv } from "../src/core/workflows/project-root.js";

// #3011: bench round 108, OCaml. BAKED ran the `dune build` gate in the task's worktree,
// `.baked/worktrees/RUN/main` inside the project's own checkout. dune takes the OUTERMOST
// directory with a `dune-project` as its root, so it built the main checkout's tree and the check
// failed before the task changed a file; `dune build --root .` in the worktree built it. Go has
// the same walk for `go.work`, which a project often leaves out of git: a worktree has none, and
// `go` used the main checkout's. Here stand-ins for dune and go report the root they would take,
// by the tools' own rules, from a real `git worktree add` under `.baked/worktrees`.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** A stand-in `name` on PATH that runs `script` with bun. */
function standIn(bin: string, name: string, script: string) {
  const file = join(bin, `${name}.js`);
  writeFileSync(file, script);
  const launcher = join(bin, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(
    launcher,
    process.platform === "win32"
      ? `@"${process.execPath}" "${file}" %*\r\n`
      : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${file}' "$@"\n`,
  );
  if (process.platform !== "win32") chmodSync(launcher, 0o755);
}

// dune's root: `--root`, else DUNE_ROOT (3.21+), else the outermost `dune-workspace`, else the
// outermost `dune-project` from the working directory up.
const DUNE = `
const { existsSync, realpathSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const args = process.argv.slice(2);
const at = args.indexOf("--root");
let root = at >= 0 ? resolve(args[at + 1]) : process.env.DUNE_ROOT;
if (!root) {
  const dirs = [];
  for (let dir = process.cwd(); ; dir = dirname(dir)) { dirs.push(dir); if (dirname(dir) === dir) break; }
  dirs.reverse();
  root = dirs.find((d) => existsSync(join(d, "dune-workspace"))) ?? dirs.find((d) => existsSync(join(d, "dune-project")));
}
process.stdout.write("root=" + realpathSync(root) + "\\n");
`;
// go's workspace: GOWORK=off, else the nearest go.work from the working directory up.
const GO = `
const { existsSync, realpathSync } = require("node:fs");
const { dirname, join } = require("node:path");
let work = "off";
if (process.env.GOWORK !== "off")
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "go.work"))) { work = realpathSync(join(dir, "go.work")); break; }
    if (dirname(dir) === dir) break;
  }
process.stdout.write("gowork=" + work + "\\n");
`;

function project(files: Record<string, string>, ignored: Record<string, string> = {}) {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "baked-worktree-root-")));
  cleanups.push(() => rmSync(main, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(main, path), text);
  writeFileSync(join(main, ".gitignore"), [".baked/", ...Object.keys(ignored)].join("\n"));
  git(main, "init", "-q");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
  for (const [path, text] of Object.entries(ignored)) writeFileSync(join(main, path), text);
  const worktree = join(main, ".baked", "worktrees", "R108", "main");
  mkdirSync(join(main, ".baked", "worktrees", "R108"), { recursive: true });
  git(main, "worktree", "add", "-q", "--detach", worktree);
  const bin = mkdtempSync(join(tmpdir(), "baked-worktree-root-bin-"));
  cleanups.push(() => rmSync(bin, { recursive: true, force: true }));
  standIn(bin, "dune", DUNE);
  standIn(bin, "go", GO);
  const scope = new ProcessScope();
  cleanups.push(() => scope.stop());
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  delete env.DUNE_ROOT;
  delete env.GOWORK;
  const run = async (executable: string, args: string[]) =>
    (await executeCheckCommand(scope, executable, args, { cwd: worktree, env, timeoutMs: 60000, signal: new AbortController().signal, sandbox: null })).output.trim();
  return { main, worktree, run };
}

const DUNE_PROJECT = { "dune-project": "(lang dune 3.0)\n", "bin.ml": "let () = ()\n" };

describe("scenario: R108, the dune gate in a task's worktree builds the worktree (#3011)", () => {
  test("the detected `dune build` and `dune test` gates take the worktree as dune's root", async () => {
    const { worktree, run } = project(DUNE_PROJECT);
    const gates = detectGates(worktree).filter((s) => s.check.executable === "dune");
    expect(gates.map((s) => s.check.id)).toEqual(["dune-build", "dune-test"]);
    for (const { check } of gates) expect(await run(check.executable, check.args)).toBe(`root=${worktree}`);
  });

  test("a dune command a project names itself (`dune build @all`, a stored gate without --root) is rooted too", async () => {
    const { worktree, run } = project(DUNE_PROJECT);
    // On main dune took the main checkout: root=<main>.
    expect(await run("dune", ["build", "@all"])).toBe(`root=${worktree}`);
    expect(await run("dune", ["test"])).toBe(`root=${worktree}`);
  });

  test("a `make` or script that runs dune gets DUNE_ROOT, and a go.work left out of git is not the worktree's", async () => {
    const { worktree, run } = project({ ...DUNE_PROJECT, "go.mod": "module x\n\ngo 1.22\n" }, { "go.work": "go 1.22\n\nuse .\n" });
    const env = withProjectRootEnv(worktree, {});
    expect(env.DUNE_ROOT).toBe(worktree);
    expect(env.GOWORK).toBe("off");
    // On main go used the main checkout's go.work: gowork=<main>/go.work.
    expect(await run("go", ["test", "./..."])).toBe("gowork=off");
  });
});

describe("withProjectRoot: only a linked worktree under another checkout's root files", () => {
  test("a tracked go.work stays the worktree's own; the main checkout and a plain directory are left alone", () => {
    const { main, worktree } = project({ "go.mod": "module x\n", "go.work": "go 1.22\n\nuse .\n", ...DUNE_PROJECT });
    expect(linkedWorktreeRoot(worktree)).toBe(worktree);
    expect(withProjectRootEnv(worktree, {}).GOWORK).toBeUndefined();
    // The main checkout is not a linked worktree: dune's own walk is the owner's (a dune workspace that vendors it).
    expect(linkedWorktreeRoot(main)).toBeNull();
    expect(withProjectRoot({ executable: "dune", args: ["build"] }, main)).toEqual(["build"]);
    expect(withProjectRootEnv(main, { A: "1" })).toEqual({ A: "1" });
  });

  test("an explicit --root and an option before the subcommand are kept as written", () => {
    const { worktree } = project(DUNE_PROJECT);
    expect(withProjectRoot({ executable: "dune", args: ["build", "--root", "sub"] }, worktree)).toEqual(["build", "--root", "sub"]);
    expect(withProjectRoot({ executable: "dune", args: ["--version"] }, worktree)).toEqual(["--version"]);
    expect(withProjectRoot({ executable: "dune", args: ["build"] }, join(worktree, "bin"))).toEqual(["build", "--root", ".."]);
    expect(withProjectRoot({ executable: "sh", args: ["-c", "dune build"] }, worktree)).toEqual(["-c", "dune build --root ."]);
  });
});

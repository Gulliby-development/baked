import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { toolchainCommand } from "./toolchain.js";

/**
 * A build tool that looks for its project root in the directories above it stops at the checkout
 * the command runs in (#3011). BAKED's worktrees live inside the project's own checkout
 * (`.baked/worktrees/RUN/main`), so above a worktree's root is the main checkout and its files:
 * - dune takes the OUTERMOST directory with a `dune-workspace` or `dune-project` as its root. In a
 *   worktree that is the main checkout, so `dune build` built (and failed on) the main checkout's
 *   tree before the task changed a file (R108, OCaml). `--root DIR` (every dune version; the
 *   `DUNE_ROOT` variable only since 3.21) names the root dune would take in the checkout alone.
 * - Go takes the nearest `go.work` above the module. A `go.work` is often left out of git, so a
 *   worktree has none and `go` used the main checkout's, which names the main checkout's modules,
 *   not the worktree's. `GOWORK=off` is what Go does in the checkout alone.
 * Tools that take the NEAREST root file the project tracks are not affected: a worktree holds the
 * same file (Cargo's `[workspace]`, `build.zig`, Gradle's settings, `package.json`, `.mvn`).
 */

/** The checkout `cwd` is in: the nearest directory with `.git` (a worktree's is a file), or null. */
export function checkoutRoot(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The linked worktree (`git worktree add`) `cwd` is in, or null: its `.git` is a file naming a
 * gitdir under the repository's `worktrees/`. A submodule's names `modules/` and is not one, and
 * nor is a checkout of its own: a root above those may be the one their owner means (a dune
 * workspace that vendors repositories), while above a worktree is another checkout of the project.
 */
export function linkedWorktreeRoot(cwd: string): string | null {
  const top = checkoutRoot(cwd);
  if (!top) return null;
  try {
    const dotGit = join(top, ".git");
    if (!statSync(dotGit).isFile()) return null;
    const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"))?.[1] ?? "";
    return /[\\/]worktrees[\\/][^\\/]+$/.test(gitdir) ? top : null;
  } catch {
    return null;
  }
}

/** The files that make a directory dune's root. */
const DUNE_ROOT_FILES = ["dune-workspace", "dune-project"];

/** The directories from `cwd` up to `top`, nearest first. */
function upTo(cwd: string, top: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.push(dir);
    if (dir === top || dirname(dir) === dir) return dirs;
  }
}

/** Whether a directory above the checkout `top` holds one of `names`. */
function aboveHas(top: string, names: readonly string[]): boolean {
  const parent = dirname(top);
  if (parent === top) return false;
  return upTo(parent, resolve("/")).some((dir) =>
    names.some((name) => existsSync(join(dir, name))),
  );
}

/** dune's root as the checkout alone gives it: the outermost `dune-workspace`, else `dune-project`. */
function duneRoot(cwd: string, top: string): string | null {
  const dirs = upTo(cwd, top).reverse();
  return (
    dirs.find((dir) => existsSync(join(dir, "dune-workspace"))) ??
    dirs.find((dir) => existsSync(join(dir, "dune-project"))) ??
    null
  );
}

/**
 * The command's arguments with dune's root named (`--root`) when the checkout has one: after the
 * subcommand (`dune build --root . @all`), and before a `--` that ends dune's own options.
 */
export function withProjectRoot(
  command: { executable: string; args: readonly string[] },
  cwd: string,
): string[] {
  const launched = toolchainCommand(command.executable, command.args);
  const args = [...launched.args];
  if (launched.program !== "dune" || args.length === 0 || (args[0] ?? "").startsWith("-"))
    return [...command.args];
  if (args.some((arg) => arg === "--root" || arg.startsWith("--root="))) return [...command.args];
  const top = linkedWorktreeRoot(cwd);
  const root = top && aboveHas(top, DUNE_ROOT_FILES) ? duneRoot(cwd, top) : null;
  if (!root) return [...command.args];
  const named = relative(resolve(cwd), root) || ".";
  args.splice(1, 0, "--root", named);
  return launched.launch(args)?.args ?? [...command.args];
}

/**
 * The environment of a command run in a checkout, whatever program it starts (a `make test` or a
 * script that runs dune or go as well), where a directory above the checkout has a root file:
 * `DUNE_ROOT` names dune's root in the checkout (read by dune 3.21 and later; `withProjectRoot`
 * passes `--root` to a dune command itself), and `GOWORK=off` when the checkout has no `go.work`.
 * A variable the environment already names is kept.
 */
export function withProjectRootEnv(cwd: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const top = linkedWorktreeRoot(cwd);
  if (!top) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  if (next.DUNE_ROOT === undefined && aboveHas(top, DUNE_ROOT_FILES)) {
    const root = duneRoot(cwd, top);
    if (root) next.DUNE_ROOT = root;
  }
  if (
    next.GOWORK === undefined &&
    !upTo(cwd, top).some((dir) => existsSync(join(dir, "go.work"))) &&
    aboveHas(top, ["go.work"])
  )
    next.GOWORK = "off";
  return next;
}

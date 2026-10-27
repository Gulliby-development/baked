import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isNoRow,
  type LanguageRecord,
  none,
  SUPPORTED_LANGUAGES,
} from "../intelligence/language-records.js";

const JS = ["node_modules"] as const;

/**
 * The folders a language's package manager installs into the project (#2330): a worktree or a
 * copy of the project gets them as links, so its checks run without a reinstall. Only folders a
 * check reads belong here; build outputs that a check rewrites (`_build`, `.build`, `target`) do
 * not, since a link would let a worktree's build overwrite the project's.
 */
export const DEPENDENCY_DIRS: LanguageRecord<readonly string[]> = {
  typescript: JS,
  javascript: JS,
  vue: JS,
  svelte: JS,
  rescript: JS,
  // Hardhat projects install through npm; Foundry's `lib/` are submodules, so they are checked out.
  solidity: JS,
  python: [".venv", "venv"],
  // Composer (#1491): `vendor/bin/phpunit`, `vendor/bin/pint` and the autoloader.
  php: ["vendor"],
  // Bundler with a local path (`bundle config set path vendor/bundle`) and its config.
  ruby: ["vendor/bundle", ".bundle"],
  elixir: ["deps"],
  // A project-local LuaRocks tree (`luarocks --tree lua_modules`).
  lua: ["lua_modules"],
  // renv's and packrat's project libraries (#1500).
  r: ["renv/library", "packrat/lib"],
  // A local opam switch (`opam switch create .`).
  ocaml: ["_opam"],
  objc: ["Pods"],
  // dbt's installed packages (#1499).
  sql: ["dbt_packages"],
  go: none("modules live in the module cache; a vendor/ folder is committed and checked out"),
  rust: none("crates live in ~/.cargo; target/ is build output"),
  java: none("Maven and Gradle caches are global"),
  kotlin: none("Maven and Gradle caches are global"),
  scala: none("sbt and Coursier caches are global"),
  csharp: none("NuGet packages live in the global cache; bin/ and obj/ are build output"),
  c: none("no package manager installs into the project"),
  cpp: none("no package manager installs into the project; build/ is output"),
  swift: none("SwiftPM caches packages globally; .build/ is build output"),
  dart: none("pub keeps packages in the global cache; .dart_tool/ is written by pub get"),
  zig: none("zig fetch keeps packages in the global cache"),
  bash: none("no package manager"),
  powershell: none("modules install per user, not per project"),
};

/** Every dependency folder of the record, for code that does not know the project's languages. */
export const ALL_DEPENDENCY_DIRS: readonly string[] = [
  ...new Set(
    SUPPORTED_LANGUAGES.flatMap((language) => {
      const row = DEPENDENCY_DIRS[language];
      return isNoRow(row) ? [] : row;
    }),
  ),
];

/**
 * Links the dependency folders `workspace` has into `root`, a worktree or copy of it, where `root`
 * has none: a folder the project tracks is checked out there and stays as it is. Returns the
 * folders linked.
 */
export function linkDependencies(workspace: string, root: string): string[] {
  const linked: string[] = [];
  for (const dir of ALL_DEPENDENCY_DIRS) {
    const source = join(workspace, dir);
    const target = join(root, dir);
    if (!existsSync(source) || existsSync(target) || isLink(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(dir);
    } catch {
      // A missing link only makes checks that need dependencies fail in the worktree.
    }
  }
  return linked;
}

/** Whether `path` is a link: a dangling one fails `existsSync` but still takes the name. */
export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Whether `path` (relative, `/`-separated) is a dependency folder linked into a worktree. Git
 * sees a link as a file, so a `vendor/` rule in .gitignore does not cover it: the snapshot and
 * the run's content commit leave it out by this test.
 */
export const isLinkedDependency = (root: string, path: string): boolean =>
  ALL_DEPENDENCY_DIRS.includes(path) && isLink(join(root, path));

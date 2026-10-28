import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  isNoRow,
  type LanguageRecord,
  type NoRow,
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
 * The parts of an installed dependency folder that hold paths of the project itself (#2362), so a
 * worktree that links the whole folder would run the main workspace's code instead of its own.
 * `walk` names the folders (globs of `/`-separated names, `*` for one name) that become real
 * folders in the worktree, entry by entry; `own` the entries copied there, with the workspace's
 * path in their text replaced by the worktree's. Every other entry is linked, and a link inside a
 * walked folder (an npm workspace package, `node_modules/app -> ../packages/app`) is made again
 * with the same target, so a relative one resolves inside the worktree.
 */
export interface ProjectPaths {
  walk: readonly string[];
  own: readonly string[];
}

/** The site-packages folders of a virtual environment, POSIX and Windows layouts. */
const SITE_PACKAGES = ["lib/*/site-packages", "Lib/site-packages"];
const PYTHON_PATHS: ProjectPaths = {
  walk: ["lib", "lib/*", ...SITE_PACKAGES, "Lib"],
  // The interpreter's `pyvenv.cfg` and scripts name the environment's folder; the `.pth` files and
  // `__editable__` finders of an editable install name the project's source folder.
  own: [
    "pyvenv.cfg",
    "bin",
    "Scripts",
    ...SITE_PACKAGES.flatMap((d) => [`${d}/*.pth`, `${d}/__editable__*`]),
  ],
};

/** Whether a file names the workspace by its absolute path, in any of its spellings. */
const namesWorkspace = (file: string, workspace: string) => {
  try {
    const text = readFileSync(file, "utf8");
    return spellings(workspace).some((spelling) => text.includes(spelling));
  } catch {
    return false;
  }
};

/**
 * For each dependency folder of `DEPENDENCY_DIRS`, how to tell that an installed copy holds paths
 * of the project, or `none(reason)` when its files never do (#2362). A folder whose function
 * returns null is linked whole, as before.
 */
export const PROJECT_PATHS: Readonly<
  Record<string, ((source: string, workspace: string) => ProjectPaths | null) | NoRow>
> = {
  // npm, pnpm, Yarn and Bun workspaces link the project's own packages into node_modules.
  node_modules: (source, workspace) =>
    entries(source).some(
      (name) =>
        projectLink(join(source, name), workspace) ||
        (name.startsWith("@") &&
          entries(join(source, name)).some((n) => projectLink(join(source, name, n), workspace))),
    )
      ? { walk: [".bin", "@*"], own: [] }
      : null,
  // Composer's autoloader resolves the project's namespaces from its own location (`$baseDir =
  // dirname($vendorDir)`), and the `vendor/bin` proxies load it: R75 ladlemath-update (#2362).
  vendor: (source) =>
    existsSync(join(source, "composer"))
      ? { walk: [], own: ["composer", "autoload.php", "bin"] }
      : null,
  // An editable install of the project (`pip install -e .`, `uv sync`, `poetry install`).
  ".venv": (source, workspace) => (editableInstall(source, workspace) ? PYTHON_PATHS : null),
  venv: (source, workspace) => (editableInstall(source, workspace) ? PYTHON_PATHS : null),
  "vendor/bundle": none(
    "gems are copies; a path gem of the project is read from the Gemfile's folder",
  ),
  ".bundle": none("Bundler's config holds relative paths"),
  deps: none("Mix keeps dependencies only; the project compiles into _build"),
  lua_modules: none("a rock of the project itself is a copy, not a path (follow-up #2371)"),
  "renv/library": none(
    "a package of the project itself is an installed copy, not a path (follow-up #2371)",
  ),
  "packrat/lib": none(
    "a package of the project itself is an installed copy, not a path (follow-up #2371)",
  ),
  _opam: none("a pinned package of the project is an installed copy, not a path (follow-up #2371)"),
  Pods: none("development pods are read relative to the Podfile"),
  dbt_packages: none("local packages are read relative to the project"),
};

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A link whose target is inside the workspace but outside the dependency folder it sits in. */
function projectLink(path: string, workspace: string): boolean {
  if (!isLink(path)) return false;
  try {
    const target = resolve(dirname(path), readlinkSync(path));
    return inside(target, workspace) && !inside(target, join(workspace, "node_modules"));
  } catch {
    return false;
  }
}

const inside = (path: string, dir: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function editableInstall(source: string, workspace: string): boolean {
  return siteFolders(source).some((site) =>
    entries(site).some(
      (name) =>
        (name.endsWith(".pth") || name.startsWith("__editable__")) &&
        namesWorkspace(join(site, name), workspace),
    ),
  );
}

function siteFolders(venv: string): string[] {
  return [
    ...entries(join(venv, "lib")).map((version) => join(venv, "lib", version, "site-packages")),
    join(venv, "Lib", "site-packages"),
  ].filter((dir) => existsSync(dir));
}

/** The ways a file can spell an absolute path: native, with `/`, and with escaped `\\`. */
function spellings(path: string): string[] {
  const forward = path.replaceAll("\\", "/");
  return [...new Set([path, forward, path.replaceAll("\\", "\\\\")])].filter(Boolean);
}

/** Whether `path` matches one of `patterns`, where `*` stands for any part of one name. */
const matches = (patterns: readonly string[], path: string) =>
  patterns.some((pattern) => {
    const want = pattern.split("/");
    const have = path.split("/");
    return (
      want.length === have.length &&
      want.every((part, i) => {
        const glob = part.split("*").map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
        return new RegExp(`^${glob.join(".*")}$`).test(have[i] ?? "");
      })
    );
  });

/** Links `source` at `target`: a folder as a directory link (a junction on Windows), a file as a file link or, on Windows, a copy. */
function linkEntry(source: string, target: string): void {
  const folder = statSync(source).isDirectory();
  if (process.platform === "win32")
    folder ? symlinkSync(source, target, "junction") : copyFileSync(source, target);
  else symlinkSync(source, target, folder ? "dir" : "file");
}

/** Copies `source` to `target` (recursively), naming `root` in the text where it named `workspace`. */
function copyOwn(source: string, target: string, workspace: string, root: string): void {
  if (isLink(source)) {
    relink(source, target, workspace, root);
    return;
  }
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of entries(source))
      copyOwn(join(source, name), join(target, name), workspace, root);
    return;
  }
  const bytes = readFileSync(source);
  // A binary file (a Windows launcher) is copied as it is.
  if (bytes.includes(0)) {
    writeFileSync(target, bytes, { mode: statSync(source).mode });
    return;
  }
  let text = bytes.toString("utf8");
  const targets = spellings(root);
  spellings(workspace).forEach((spelling, i) => {
    text = text.replaceAll(spelling, targets[i] ?? root);
  });
  writeFileSync(target, text, { mode: statSync(source).mode });
}

/** Makes the link at `source` again at `target`, an absolute target in the workspace moved to `root`. */
function relink(source: string, target: string, workspace: string, root: string): void {
  const to = readlinkSync(source);
  const moved = isAbsolute(to) && inside(to, workspace) ? join(root, relative(workspace, to)) : to;
  let folder = false;
  try {
    folder = statSync(source).isDirectory();
  } catch {
    // A dangling link is made again as a file link.
  }
  if (process.platform === "win32" && folder)
    symlinkSync(resolve(dirname(target), moved), target, "junction");
  else symlinkSync(moved, target, folder ? "dir" : "file");
}

/** Builds `target` from `source` by `paths`: walked folders real, own entries copied, the rest linked. */
function shadow(
  source: string,
  target: string,
  paths: ProjectPaths,
  workspace: string,
  root: string,
  at = "",
): void {
  mkdirSync(target, { recursive: true });
  for (const name of entries(source)) {
    const path = at ? `${at}/${name}` : name;
    const from = join(source, name);
    const to = join(target, name);
    if (matches(paths.own, path)) copyOwn(from, to, workspace, root);
    else if (isLink(from)) relink(from, to, workspace, root);
    else if (matches(paths.walk, path) && statSync(from).isDirectory())
      shadow(from, to, paths, workspace, root, path);
    else linkEntry(from, to);
  }
  if (!at) writeFileSync(join(target, SHADOW_MARK), "");
}

/**
 * The file that marks a dependency folder built entry by entry for a worktree (#2362): like a
 * link, it holds the project's installed packages, not its sources.
 */
export const SHADOW_MARK = ".baked-linked";

/**
 * A command that resolves a language's packages into a new worktree or copy when the project keeps
 * its resolution in a generated, ignored file that a link would get wrong (#2361), or
 * `none(reason)`. It runs offline, once, after the folders are linked; null when not needed.
 */
export const DEPENDENCY_PREPARE: LanguageRecord<(root: string) => string[] | null> = {
  // pub writes `.dart_tool/package_config.json` with absolute paths of the machine's pub cache and
  // a project-relative root, so a worktree resolves its packages itself, from the cache.
  dart: (root) => {
    const pubspec = join(root, "pubspec.yaml");
    if (!existsSync(pubspec) || existsSync(join(root, ".dart_tool", "package_config.json")))
      return null;
    const flutter = /^\s+sdk:\s*flutter\b/m.test(readFileSync(pubspec, "utf8"));
    return [flutter ? "flutter" : "dart", "pub", "get", "--offline"];
  },
  ...Object.fromEntries(
    SUPPORTED_LANGUAGES.filter((language) => language !== "dart").map((language) => [
      language,
      none(
        isNoRow(DEPENDENCY_DIRS[language])
          ? "its packages live in a global cache or the build resolves them"
          : "its installed folder is linked",
      ),
    ]),
  ),
} as LanguageRecord<(root: string) => string[] | null>;

/**
 * The longest working directory a language's test tool handles, for a project its manifest names,
 * or `none(reason)` (#2361): a task worktree is about 60 characters deeper than the workspace, and
 * the doctor warns when that crosses the limit.
 */
export const WORKTREE_PATH_LIMITS: LanguageRecord<{
  manifest: string;
  chars: number;
  tool: string;
}> = {
  // Measured in R75 latcell: every test file fails to load from 126 to 156 characters on.
  dart: { manifest: "pubspec.yaml", chars: 120, tool: "dart test" },
  ...Object.fromEntries(
    SUPPORTED_LANGUAGES.filter((language) => language !== "dart").map((language) => [
      language,
      none("no working-directory length limit observed"),
    ]),
  ),
} as LanguageRecord<{ manifest: string; chars: number; tool: string }>;

/** How long a prepare command may take before the worktree goes on without it. */
const PREPARE_MS = 120_000;

/**
 * Runs the prepare commands of `DEPENDENCY_PREPARE` in `root`. A command that is missing or fails
 * leaves the worktree as it is: its checks then report the unresolved packages. Returns the
 * commands that ran and succeeded.
 */
export function prepareDependencies(root: string): string[][] {
  const ran: string[][] = [];
  for (const language of SUPPORTED_LANGUAGES) {
    const row = DEPENDENCY_PREPARE[language];
    if (isNoRow(row)) continue;
    const command = row(root);
    const program = command && Bun.which(command[0] ?? "", { PATH: process.env.PATH ?? "" });
    if (!command || !program) continue;
    const launch = /\.(?:bat|cmd)$/i.test(program) ? ["cmd", "/d", "/c", program] : [program];
    try {
      const result = Bun.spawnSync([...launch, ...command.slice(1)], {
        cwd: root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: PREPARE_MS,
      });
      if (result.exitCode === 0) ran.push(command);
    } catch {
      // The worktree's checks name the packages they cannot resolve.
    }
  }
  return ran;
}

/**
 * Links the dependency folders `workspace` has into `root`, a worktree or copy of it, where `root`
 * has none: a folder the project tracks is checked out there and stays as it is. A folder that
 * holds paths of the project (`PROJECT_PATHS`) is built entry by entry instead, so the worktree
 * runs its own code (#2362). Then the prepare commands run (#2361). Returns the folders linked.
 */
export function linkDependencies(workspace: string, root: string): string[] {
  const linked: string[] = [];
  for (const dir of ALL_DEPENDENCY_DIRS) {
    const source = join(workspace, dir);
    const target = join(root, dir);
    if (!existsSync(source) || existsSync(target) || isLink(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });
      const detect = PROJECT_PATHS[dir];
      const paths = detect && !isNoRow(detect) ? detect(source, workspace) : null;
      if (paths) shadow(source, target, paths, workspace, root);
      else symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
      linked.push(dir);
    } catch {
      // A missing link only makes checks that need dependencies fail in the worktree.
    }
  }
  prepareDependencies(root);
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
  ALL_DEPENDENCY_DIRS.includes(path) &&
  (isLink(join(root, path)) || existsSync(join(root, path, SHADOW_MARK)));

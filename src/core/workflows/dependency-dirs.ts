import {
  copyFileSync,
  existsSync,
  linkSync,
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
  type SupportedLanguage,
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
 * with the same target, so a relative one resolves inside the worktree. With `mirror`, the other
 * entries are not linked but mirrored: folders made real and files hard-linked (copied where a hard
 * link fails), for a folder whose packages find the project's files from their own real path (#2401).
 */
export interface ProjectPaths {
  walk: readonly string[];
  own: readonly string[];
  mirror?: boolean;
  /**
   * Entries (exact `/`-separated paths) left out of the worktree's folder: an installed copy of the
   * project itself (#2371), so a check loads the worktree's sources or fails clearly instead of
   * running the main workspace's last install. Their parent folders are walked.
   */
  omit?: readonly string[];
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
  // dirname($vendorDir)`), and the `vendor/bin` proxies load it: R75 ladlemath-update (#2362). A
  // package's launcher finds the autoloader from its own real path too (phpstan requires
  // `dirname(Phar::running(false)) . '/../../autoload.php'`, after the one of the working
  // directory), so a linked package loaded the main workspace's autoloader a second time and PHP
  // died on "Cannot redeclare class ComposerAutoloaderInit...": R76 ladlemath-update (#2401). The
  // packages are mirrored, which costs a hard link per file, not a copy.
  vendor: (source) =>
    existsSync(join(source, "composer"))
      ? { walk: [], own: ["composer", "autoload.php", "bin"], mirror: true }
      : null,
  // An editable install of the project (`pip install -e .`, `uv sync`, `poetry install`).
  ".venv": (source, workspace) => (editableInstall(source, workspace) ? PYTHON_PATHS : null),
  venv: (source, workspace) => (editableInstall(source, workspace) ? PYTHON_PATHS : null),
  "vendor/bundle": none(
    "gems are copies; a path gem of the project is read from the Gemfile's folder",
  ),
  ".bundle": none("Bundler's config holds relative paths"),
  deps: none("Mix keeps dependencies only; the project compiles into _build"),
  // `luarocks make --tree lua_modules` installs a copy of the project's own rock (#2371).
  lua_modules: (source, workspace) => omitting(ownRockFiles(source, workspace)),
  // `R CMD INSTALL .` / `devtools::install()` puts a copy of the project's package in the library.
  "renv/library": (source, workspace) => omitting(ownRPackage(source, workspace)),
  "packrat/lib": (source, workspace) => omitting(ownRPackage(source, workspace)),
  // `opam pin add .` installs the project's packages into the local switch.
  _opam: (source, workspace) => omitting(ownOpamFiles(source, workspace)),
  Pods: none("development pods are read relative to the Podfile"),
  dbt_packages: none("local packages are read relative to the project"),
};

const omitting = (omit: string[]): ProjectPaths | null =>
  omit.length ? { walk: [], own: [], omit } : null;

/** The first match of `pattern` in a file of the workspace root whose name ends in `suffix`. */
function manifestValue(workspace: string, suffix: string, pattern: RegExp): string[] {
  return entries(workspace)
    .filter((name) => name.endsWith(suffix))
    .flatMap((name) => {
      try {
        const found = pattern.exec(readFileSync(join(workspace, name), "utf8"));
        return found?.[1] ? [found[1]] : [];
      } catch {
        return [];
      }
    });
}

/**
 * The installed files of the project's own rock in a LuaRocks tree: its folder under
 * `lib/luarocks/rocks-*` and the files its `rock_manifest` lists under `share/lua/*`, `lib/lua/*`
 * and `bin`. The project's rock is the `package` of a rockspec in the workspace root.
 */
function ownRockFiles(source: string, workspace: string): string[] {
  const names = new Set(
    manifestValue(workspace, ".rockspec", /^\s*package\s*=\s*["']([^"']+)["']/m),
  );
  if (!names.size) return [];
  const omit: string[] = [];
  const luarocks = join(source, "lib", "luarocks");
  for (const rocks of entries(luarocks).filter((d) => d === "rocks" || d.startsWith("rocks-"))) {
    const version = rocks.slice("rocks-".length);
    const versions = version ? [version] : entries(join(source, "share", "lua"));
    for (const name of entries(join(luarocks, rocks)).filter((n) => names.has(n))) {
      omit.push(`lib/luarocks/${rocks}/${name}`);
      for (const release of entries(join(luarocks, rocks, name))) {
        let manifest: LuaTable = {};
        try {
          manifest = parseLuaTable(
            readFileSync(join(luarocks, rocks, name, release, "rock_manifest"), "utf8"),
          );
        } catch {
          continue;
        }
        const listed = (key: string) => {
          const value = manifest[key];
          return typeof value === "object" ? luaTablePaths(value) : [];
        };
        for (const v of versions) {
          omit.push(...listed("lua").map((file) => `share/lua/${v}/${file}`));
          omit.push(...listed("lib").map((file) => `lib/lua/${v}/${file}`));
        }
        omit.push(...listed("bin").map((file) => `bin/${file}`));
      }
    }
  }
  return omit.filter((path) => existsSync(join(source, path)) || isLink(join(source, path)));
}

type LuaTable = { [key: string]: string | LuaTable };

/**
 * The `rock_manifest = { ... }` table LuaRocks writes: string keys (`name` or `["name"]`) whose
 * values are an MD5 string or a nested table.
 */
export function parseLuaTable(text: string): LuaTable {
  const tokens: string[] =
    text.match(/\["(?:[^"\\]|\\.)*"\]|"(?:[^"\\]|\\.)*"|[A-Za-z_][\w.-]*|[{}=,]/g) ?? [];
  let at = tokens.indexOf("{");
  const unquote = (token: string) =>
    token.replace(/^\[?"/, "").replace(/"\]?$/, "").replace(/\\(.)/g, "$1");
  const table = (): LuaTable => {
    const out: LuaTable = {};
    at += 1;
    while (at < tokens.length && tokens[at] !== "}") {
      const key = tokens[at] ?? "";
      if (key === ",") {
        at += 1;
        continue;
      }
      if (tokens[at + 1] !== "=") throw new Error(`rock_manifest: expected = after ${key}`);
      at += 2;
      if (tokens[at] === "{") out[unquote(key)] = table();
      else out[unquote(key)] = unquote(tokens[at] ?? "");
      at += 1;
    }
    return out;
  };
  if (at < 0) throw new Error("rock_manifest: no table");
  return table();
}

function luaTablePaths(table: LuaTable, prefix = ""): string[] {
  return Object.entries(table).flatMap(([key, value]) =>
    typeof value === "object" ? luaTablePaths(value, `${prefix}${key}/`) : [`${prefix}${key}`],
  );
}

/**
 * The installed copy of the project's own R package in an renv or packrat library: a folder named
 * as the `Package:` of the workspace's DESCRIPTION, with a DESCRIPTION of its own, up to three
 * levels down (`R-4.3/x86_64-pc-linux-gnu/pkg`, `x86_64-pc-linux-gnu/4.3.1/pkg`).
 */
function ownRPackage(source: string, workspace: string): string[] {
  const [name] = manifestValue(workspace, "DESCRIPTION", /^Package:\s*(\S+)/m);
  if (!name) return [];
  const found: string[] = [];
  const visit = (dir: string, at: string, depth: number) => {
    for (const entry of entries(dir)) {
      const path = at ? `${at}/${entry}` : entry;
      const full = join(dir, entry);
      if (entry === name && existsSync(join(full, "DESCRIPTION"))) found.push(path);
      else if (depth < 3 && !isLink(full) && isDirectory(full)) visit(full, path, depth + 1);
    }
  };
  visit(source, "", 1);
  return found;
}

/**
 * The files the project's own opam packages installed into a local switch, from the switch's
 * `.opam-switch/install/<name>.changes` record; without one, their `lib/<name>` folder. The
 * project's packages are the `<name>.opam` files of the workspace root.
 */
function ownOpamFiles(source: string, workspace: string): string[] {
  const names = entries(workspace)
    .filter((n) => n.endsWith(".opam") && n.length > ".opam".length)
    .map((n) => n.slice(0, -".opam".length));
  const omit: string[] = [];
  for (const name of names) {
    let changes = "";
    try {
      changes = readFileSync(join(source, ".opam-switch", "install", `${name}.changes`), "utf8");
    } catch {
      // An older switch records no changes file.
    }
    const added = /added:\s*\[([\s\S]*?)\n\]/.exec(changes)?.[1] ?? "";
    // Files and links the package added; folders stay (others may share them) and are walked.
    for (const entry of added.matchAll(/"([^"]+)"\s*\{"([FL])/g)) if (entry[1]) omit.push(entry[1]);
    if (!added && existsSync(join(source, "lib", name))) omit.push(`lib/${name}`);
  }
  return omit;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

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

/**
 * Mirrors `source` at `target`: folders real, files hard-linked (a copy across volumes or where the
 * file system refuses), links made again. Code in the mirror sees the mirror as its real path.
 */
function mirror(source: string, target: string, workspace: string, root: string): void {
  if (isLink(source)) {
    relink(source, target, workspace, root);
    return;
  }
  if (statSync(source).isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of entries(source))
      mirror(join(source, name), join(target, name), workspace, root);
    return;
  }
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
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

/** Builds `target` from `source` by `paths`: walked folders real, own entries copied, the rest linked or mirrored. */
function shadow(
  source: string,
  target: string,
  paths: ProjectPaths,
  workspace: string,
  root: string,
  at = "",
): void {
  mkdirSync(target, { recursive: true });
  const omit = paths.omit ?? [];
  for (const name of entries(source)) {
    const path = at ? `${at}/${name}` : name;
    const from = join(source, name);
    const to = join(target, name);
    if (omit.includes(path)) continue;
    // A folder above an omitted entry is walked, so only that entry is left out.
    const aboveOmitted = omit.some((o) => o.startsWith(`${path}/`));
    if (aboveOmitted && !isLink(from) && statSync(from).isDirectory())
      shadow(from, to, paths, workspace, root, path);
    else if (matches(paths.own, path)) copyOwn(from, to, workspace, root);
    else if (isLink(from)) relink(from, to, workspace, root);
    else if (matches(paths.walk, path) && statSync(from).isDirectory())
      shadow(from, to, paths, workspace, root, path);
    else if (paths.mirror) mirror(from, to, workspace, root);
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
 * on the platform it was measured on, or `none(reason)` (#2361, #2454): a task's checks run in
 * `.baked/worktrees/<8 hex digits>/<task>`, about 30 characters deeper than the workspace, and the
 * doctor warns and a run records `worktree_environment` when that crosses the limit.
 */
export const WORKTREE_PATH_LIMITS: LanguageRecord<{
  manifest: string;
  chars: number;
  tool: string;
  platform: NodeJS.Platform;
}> = {
  // `dart test` starts its frontend server by a path relative to the working directory, one `..\`
  // per level, so the limit falls with the depth and with the SDK's own path. Measured on Windows:
  // R75 latcell failed from 126 characters on; R78 latcell-update (a WinGet SDK, 131 characters)
  // failed at 94 and passed at 88.
  dart: { manifest: "pubspec.yaml", chars: 88, tool: "dart test", platform: "win32" },
  ...Object.fromEntries(
    SUPPORTED_LANGUAGES.filter((language) => language !== "dart").map((language) => [
      language,
      none("no working-directory length limit observed"),
    ]),
  ),
} as LanguageRecord<{ manifest: string; chars: number; tool: string; platform: NodeJS.Platform }>;

/** A worktree whose path is longer than a project language's test tool handles. */
export interface WorktreePathRisk {
  language: SupportedLanguage;
  tool: string;
  limit: number;
  path: string;
  length: number;
}

/**
 * The `WORKTREE_PATH_LIMITS` a worktree path crosses, for the languages whose manifest `root`
 * holds, on `platform`.
 */
export function worktreePathRisks(
  root: string,
  path: string,
  platform: NodeJS.Platform = process.platform,
): WorktreePathRisk[] {
  return SUPPORTED_LANGUAGES.flatMap((language) => {
    const limit = WORKTREE_PATH_LIMITS[language];
    if (
      isNoRow(limit) ||
      limit.platform !== platform ||
      path.length <= limit.chars ||
      !existsSync(join(root, limit.manifest))
    )
      return [];
    return [{ language, tool: limit.tool, limit: limit.chars, path, length: path.length }];
  });
}

/** How long a prepare command may take before the worktree goes on without it. */
const PREPARE_MS = 120_000;
/** How much of a failed prepare command's output a finding keeps. */
const PREPARE_OUTPUT_CHARS = 2_000;

/**
 * The commands (program and subcommand) whose checks load the packages a language's prepare
 * command resolves (#2372): when the command did not resolve them, a failure of such a check is
 * the machine's, not the code's. A formatter reads no packages, so `dart format` is not one. Every
 * language with a `DEPENDENCY_PREPARE` row has an entry; the parity test holds them equal.
 */
export const PREPARE_READERS: Readonly<
  Partial<Record<SupportedLanguage, readonly (readonly [string, string])[]>>
> = {
  dart: [
    ["dart", "test"],
    ["dart", "analyze"],
    ["dart", "run"],
    ["flutter", "test"],
    ["flutter", "analyze"],
  ],
};

/** Whether `program args...` is a check that loads the packages of `language`. */
export const readsPackages = (
  language: SupportedLanguage,
  program: string,
  args: readonly string[],
): boolean =>
  (PREPARE_READERS[language] ?? []).some(
    ([reader, sub]) => reader === program && args.find((a) => !a.startsWith("-")) === sub,
  );

/** A prepare command a worktree or copy still needs: it failed, timed out or could not start. */
export interface UnpreparedDependencies {
  language: SupportedLanguage;
  command: string[];
  /** The end of the command's output when it ran in this process and failed; null otherwise. */
  output: string | null;
}

/** The output of the prepare commands that failed, by root and language, for the finding. */
const failedOutput = new Map<string, string>();
const outputKey = (root: string, language: string) => `${resolve(root)}\0${language}`;

/**
 * Runs the prepare commands of `DEPENDENCY_PREPARE` in `root`. A command that is missing or fails
 * leaves the worktree as it is; `unpreparedDependencies` then names it, and the run records it once
 * as an environment finding (#2372). Returns the commands that ran and succeeded.
 */
export function prepareDependencies(root: string): string[][] {
  const ran: string[][] = [];
  for (const language of SUPPORTED_LANGUAGES) {
    const row = DEPENDENCY_PREPARE[language];
    if (isNoRow(row)) continue;
    const command = row(root);
    if (!command) continue;
    const program = Bun.which(command[0] ?? "", { PATH: process.env.PATH ?? "" });
    if (!program) {
      failedOutput.set(outputKey(root, language), `${command[0]} is not on PATH`);
      continue;
    }
    const launch = /\.(?:bat|cmd)$/i.test(program) ? ["cmd", "/d", "/c", program] : [program];
    try {
      const result = Bun.spawnSync([...launch, ...command.slice(1)], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: PREPARE_MS,
      });
      if (result.exitCode === 0) {
        ran.push(command);
        failedOutput.delete(outputKey(root, language));
        continue;
      }
      const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
      failedOutput.set(
        outputKey(root, language),
        output.slice(-PREPARE_OUTPUT_CHARS) || `exit code ${String(result.exitCode)}`,
      );
    } catch (error) {
      failedOutput.set(outputKey(root, language), String(error).slice(0, PREPARE_OUTPUT_CHARS));
    }
  }
  return ran;
}

/**
 * The prepare commands `root` still needs (#2372): a row of `DEPENDENCY_PREPARE` that names a
 * command means its packages are not resolved there. Read from the files, so a check of a
 * worktree made by another process knows it too.
 */
export function unpreparedDependencies(root: string): UnpreparedDependencies[] {
  const out: UnpreparedDependencies[] = [];
  for (const language of SUPPORTED_LANGUAGES) {
    const row = DEPENDENCY_PREPARE[language];
    const command = isNoRow(row) ? null : row(root);
    if (!command) continue;
    out.push({
      language,
      command,
      output: failedOutput.get(outputKey(root, language)) ?? null,
    });
  }
  return out;
}

/** The one line a finding and a check's note give for packages a worktree could not resolve. */
export function unpreparedProblem(unprepared: UnpreparedDependencies): string {
  const command = unprepared.command.join(" ");
  const online = unprepared.command.filter((part) => part !== "--offline").join(" ");
  return `Dependencies not available offline: \`${command}\` could not resolve the packages in this worktree, so its checks that load packages fail on unresolved imports. Run \`${online}\` in the project once so the package cache has them.`;
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

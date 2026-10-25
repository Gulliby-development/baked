import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../intelligence/language-records.js";

/**
 * The commands a project installs, and how the project's own toolchain runs each from the
 * workspace (#1821). A README documents the program the project builds (`routeshadow tree
 * app.txt`, `stampbook status`), whose name is never a check's executable, so the documented
 * example runner, `run_repro` and `run_probe` refused all 27 README examples of bench round 55.
 * The launcher starts a program the checks already start (cargo, python, go, dotnet, java, bun),
 * so it adds no program the approval did not cover.
 */
export interface EntryPoint {
  /** The command a reader types: the binary, script or tool name. */
  name: string;
  /** The program and leading arguments that run it from the project root; the example's arguments follow. */
  launcher: string[];
  /**
   * Build output directories the launcher reads or writes (`target` for Cargo and Maven): a copy
   * of the workspace links them, so the checks' build is reused instead of rebuilt per example.
   */
  link?: string[];
}

interface EntryReader {
  /** The manifest's file name. */
  name: RegExp;
  read: (path: string, text: string, root: string) => EntryPoint[];
}

/** The `key = "value"` pairs of a TOML table, by its header. */
function tomlTable(text: string, header: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const table = /^\[([^\]]+)\]$/.exec(line)?.[1];
    if (table !== undefined) {
      inside = table.trim() === header;
      continue;
    }
    const pair = inside ? /^"?([\w.-]+)"?\s*=\s*"([^"]*)"/.exec(line) : null;
    if (pair) out.set(pair[1] as string, pair[2] as string);
  }
  return out;
}

/** Each `[[bin]]` of a Cargo manifest with its name, else the package when it has `src/main.rs`. */
function cargoEntries(path: string, text: string, root: string): EntryPoint[] {
  const dir = dirname(path);
  const bins = [...text.matchAll(/^\s*\[\[bin\]\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)]
    .map((m) => /^\s*name\s*=\s*"([^"]+)"/m.exec(m[1] ?? "")?.[1])
    .filter((name): name is string => Boolean(name));
  const pkg = tomlTable(text, "package").get("name");
  if (!bins.length && pkg && existsSync(join(root, dir, "src", "main.rs"))) bins.push(pkg);
  const manifest = dir === "." ? [] : ["--manifest-path", path];
  return bins.map((name) => ({
    name,
    launcher: ["cargo", "run", "--quiet", ...manifest, "--bin", name, "--"],
    link: ["target"],
  }));
}

/** A Python call of a `module:function` entry point, with `sys.argv[0]` set to the script name. */
const pythonLauncher = (name: string, target: string): string[] | null => {
  const entry = /^([\w.]+):([\w.]+)$/.exec(target.trim());
  if (!entry) return null;
  const [, module, func] = entry;
  const [head, ...rest] = (func as string).split(".");
  const call = [head, ...rest].join(".");
  return [
    "python",
    "-c",
    `import sys; from ${module} import ${head}; sys.argv[0] = ${JSON.stringify(name)}; sys.exit(${call}())`,
  ];
};

/** `[project.scripts]` and Poetry's `[tool.poetry.scripts]` of a pyproject. */
function pyprojectEntries(_path: string, text: string): EntryPoint[] {
  const scripts = new Map([
    ...tomlTable(text, "project.scripts"),
    ...tomlTable(text, "tool.poetry.scripts"),
  ]);
  return [...scripts].flatMap(([name, target]) => {
    const launcher = pythonLauncher(name, target);
    return launcher ? [{ name, launcher }] : [];
  });
}

/** `console_scripts` of setup.cfg's `[options.entry_points]`. */
function setupCfgEntries(_path: string, text: string): EntryPoint[] {
  const section =
    /^\[options\.entry_points\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const block = /console_scripts\s*=\s*([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(section)?.[1] ?? "";
  return block.split(/\r?\n/).flatMap((line) => {
    const pair = /^\s*([\w.-]+)\s*=\s*(\S+)\s*$/.exec(line);
    const launcher = pair ? pythonLauncher(pair[1] as string, pair[2] as string) : null;
    return pair && launcher ? [{ name: pair[1] as string, launcher }] : [];
  });
}

const isGoMain = (file: string): boolean => {
  try {
    return /^\s*package\s+main\b/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
};

/** The `main` packages of a Go module: its root (named after the module) and each `cmd/<name>`. */
function goEntries(path: string, text: string, root: string): EntryPoint[] {
  const dir = join(root, dirname(path));
  const module = /^\s*module\s+(\S+)/m.exec(text)?.[1];
  const mains = (sub: string) => {
    try {
      return readdirSync(join(dir, sub)).some(
        (f) => f.endsWith(".go") && !f.endsWith("_test.go") && isGoMain(join(dir, sub, f)),
      );
    } catch {
      return false;
    }
  };
  const out: EntryPoint[] = [];
  const prefix = dirname(path) === "." ? "." : `./${dirname(path)}`;
  if (module && mains(".")) out.push({ name: basename(module), launcher: ["go", "run", prefix] });
  try {
    for (const name of readdirSync(join(dir, "cmd")))
      if (mains(join("cmd", name)))
        out.push({ name, launcher: ["go", "run", `${prefix}/cmd/${name}`] });
  } catch {
    // No cmd directory.
  }
  return out;
}

/** An executable .NET project: its tool command, its assembly name and its file name. */
function dotnetEntries(path: string, text: string): EntryPoint[] {
  if (!/<OutputType>\s*Exe\s*<\/OutputType>/i.test(text) && !/<PackAsTool>\s*true/i.test(text))
    return [];
  const tag = (name: string) => new RegExp(`<${name}>\\s*([^<\\s]+)\\s*</${name}>`).exec(text)?.[1];
  const launcher = ["dotnet", "run", "--project", path, "--"];
  const names = [
    tag("ToolCommandName"),
    tag("AssemblyName"),
    basename(path).replace(/\.\w+proj$/, ""),
  ];
  return [...new Set(names.filter((n): n is string => Boolean(n)))].map((name) => ({
    name,
    launcher,
  }));
}

/** A Maven project with a main class (`exec-maven-plugin`, the jar manifest or `exec.mainClass`). */
function pomEntries(_path: string, text: string): EntryPoint[] {
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const main = /<(?:mainClass|Main-Class|exec\.mainClass)>\s*([\w.$]+)\s*</.exec(xml)?.[1];
  const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(
    xml
      .replace(/<parent>[\s\S]*?<\/parent>/, "")
      .replace(/<(?:build|dependencies|dependencyManagement)>[\s\S]*$/, ""),
  )?.[1];
  return main && artifact
    ? [{ name: artifact, launcher: ["java", "-cp", "target/classes", main], link: ["target"] }]
    : [];
}

/** A Gradle `application` with its main class, named after the project. */
function gradleEntries(path: string, text: string, root: string): EntryPoint[] {
  const main = /\bmainClass(?:\.set\()?\s*=?\s*["']([\w.$]+)["']/.exec(text)?.[1];
  if (!main || !/\bapplication\b/.test(text)) return [];
  let settings = "";
  for (const name of ["settings.gradle.kts", "settings.gradle"])
    if (existsSync(join(root, dirname(path), name)))
      settings = readFileSync(join(root, dirname(path), name), "utf8");
  const name =
    /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1] ??
    /\bapplicationName\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ??
    basename(join(root, dirname(path)));
  const classes =
    path.endsWith(".kts") || /kotlin\(/.test(text)
      ? "build/classes/kotlin/main"
      : "build/classes/java/main";
  return [{ name, launcher: ["java", "-cp", classes, main], link: ["build"] }];
}

/** The `bin` of a package.json: a map of names to files, or one file named after the package. */
function packageJsonEntries(path: string, text: string): EntryPoint[] {
  let parsed: { name?: unknown; bin?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return [];
  }
  const dir = dirname(path);
  const file = (f: string) => (dir === "." ? f : join(dir, f)).replaceAll("\\", "/");
  const bins: [string, unknown][] =
    typeof parsed.bin === "string" && typeof parsed.name === "string"
      ? [[parsed.name.replace(/^@[^/]+\//, ""), parsed.bin]]
      : parsed.bin && typeof parsed.bin === "object"
        ? Object.entries(parsed.bin)
        : [];
  return bins.flatMap(([name, target]) =>
    typeof target === "string" ? [{ name, launcher: ["bun", file(target)] }] : [],
  );
}

const NPM: readonly EntryReader[] = [{ name: /^package\.json$/, read: packageJsonEntries }];
const JVM: readonly EntryReader[] = [
  { name: /^pom\.xml$/, read: pomEntries },
  { name: /^build\.gradle(?:\.kts)?$/, read: gradleEntries },
];

/**
 * How each supported language's projects declare the commands they install (#1821). A language
 * whose manifest is code, or that installs no command, says why.
 */
export const ENTRY_POINTS: LanguageRecord<readonly EntryReader[]> = {
  typescript: NPM,
  javascript: NPM,
  vue: none("a Vue project builds a web app, not a command"),
  svelte: none("a Svelte project builds a web app, not a command"),
  rescript: none(
    "a ReScript package's bin is declared in its package.json, which the JavaScript row reads",
  ),
  python: [
    { name: /^pyproject\.toml$/, read: pyprojectEntries },
    { name: /^setup\.cfg$/, read: setupCfgEntries },
  ],
  rust: [{ name: /^Cargo\.toml$/, read: cargoEntries }],
  go: [{ name: /^go\.mod$/, read: goEntries }],
  csharp: [{ name: /\.(?:csproj|fsproj|vbproj)$/, read: dotnetEntries }],
  java: JVM,
  kotlin: JVM,
  scala: none(
    "sbt builds are Scala code; a Scala project on Maven or Gradle is read by the Java row",
  ),
  c: none("C builds name their binaries in Makefiles and CMake scripts, which are code"),
  cpp: none("C++ builds name their binaries in CMake scripts and Makefiles, which are code"),
  ruby: none("a gem's executables are listed in its gemspec, which is Ruby code"),
  php: none("Composer bin scripts have no runner among the checks yet"),
  swift: none("Swift Package Manager manifests are Swift code"),
  lua: none("LuaRocks rockspecs are Lua code"),
  elixir: none("Mix escripts are declared in mix.exs, which is Elixir code"),
  dart: none("pub executables have no runner among the checks yet"),
  zig: none("build.zig is Zig code"),
  bash: none("a shell script is run by its path"),
  ocaml: none("dune executables have no runner among the checks yet"),
  objc: none("Xcode projects have no command line runner among the checks"),
  solidity: none("contracts are deployed, not run as commands"),
  sql: none("SQL files are run by a database client, not installed as commands"),
  powershell: none(
    "a script is run by its path; a module's functions are imported, not installed as commands",
  ),
  r: none("an R package exports functions; scripts run with Rscript by their path"),
};

const READERS: readonly EntryReader[] = [
  ...new Set(SUPPORTED_LANGUAGES.flatMap((language) => rowOf(ENTRY_POINTS, language) ?? [])),
];

/** Directories that hold no project manifests of their own. */
const SKIPPED = new Set([
  "node_modules",
  ".git",
  ".baked",
  "target",
  "build",
  "dist",
  "bin",
  "obj",
  ".venv",
  "venv",
]);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The manifests of the workspace, at the root and up to two directories below it. */
function manifests(root: string, dir = "", depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(join(root, dir));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const path = dir ? `${dir}/${name}` : name;
    if (READERS.some((reader) => reader.name.test(name))) out.push(path);
    else if (
      depth < 2 &&
      !SKIPPED.has(name) &&
      !name.startsWith(".") &&
      isDirectory(join(root, path))
    )
      out.push(...manifests(root, path, depth + 1));
  }
  return out;
}

/** Every command the workspace's manifests declare, first declaration of a name winning. */
export function projectEntryPoints(root: string): EntryPoint[] {
  const found = new Map<string, EntryPoint>();
  for (const path of manifests(root)) {
    const reader = READERS.find((r) => r.name.test(basename(path)));
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    for (const entry of reader?.read(path, text, root) ?? [])
      if (!found.has(entry.name)) found.set(entry.name, entry);
  }
  return [...found.values()];
}

/** A program name without its directory or Windows launcher extension. */
const programName = (executable: string): string =>
  basename(executable.replaceAll("\\", "/"))
    .replace(/\.(?:cmd|bat|exe)$/i, "")
    .toLowerCase();

/**
 * The command that runs a project's own command (`routeshadow tree app.txt`) through its
 * launcher, with the launcher's program taken from the programs the checks start (a Python
 * project's environment interpreter for `python`), or null when the first word is no entry point
 * or its launcher is not among them.
 */
export function entryPointCommand(
  root: string,
  argv: readonly string[],
  executables: readonly string[],
): { argv: string[]; entry: EntryPoint } | null {
  const [program, ...args] = argv;
  if (!program || /[\\/]/.test(program)) return null;
  const entry = projectEntryPoints(root).find((e) => e.name === program);
  if (!entry) return null;
  const [launcher, ...prefix] = entry.launcher as [string, ...string[]];
  // A Python project's checks start its environment's interpreter; a package.json bin runs under
  // Bun or Node, whichever the checks start.
  const wanted =
    launcher === "python"
      ? /^python3?$/
      : launcher === "bun"
        ? /^(?:bun|node)$/
        : new RegExp(`^${launcher}$`);
  const executable = executables.find((e) => wanted.test(programName(e)));
  return executable ? { argv: [executable, ...prefix, ...args], entry } : null;
}

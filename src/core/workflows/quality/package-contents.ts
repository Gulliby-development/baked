/**
 * The package contents check (#1984): when a run's manifest edit changes the fields that decide
 * what a built package holds (`[tool.setuptools.package-data]`, `files` of `package.json`,
 * `include` of `Cargo.toml`, a `Pack="true"` item of a project file), the host builds the package
 * in a copy of the delivered tree and lists its files. The listing is review evidence, so a
 * criterion such as "the built wheel contains `py.typed`" is settled by the run: bench round 63
 * (keeplint) ended `inconclusive` on it because no check built the package. Opt-in
 * (`packageContents`). A missing tool or a failed build is a note in the record, never a finding.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../../intelligence/language-records.js";
import { buildWrapper, formatCommandLine, pythonExecutable } from "../gates.js";
import {
  changedFields,
  type FieldMap,
  gradleFields,
  packageJsonFields,
  tomlFields,
} from "./manifest-fields.js";
import type { ChangedFile } from "./rules.js";

/** Artifact of the latest package contents check of a run. */
export const QUALITY_PACKAGE_CONTENTS = "quality/package-contents.json";

/** Where a build writes its package, relative to the package root, inside the run's copy. */
export const PACKAGE_OUT = ".baked-package";

/** At most this many package roots are built per snapshot. */
export const MAX_PACKAGE_BUILDS = 4;

/** At most this many file names are kept per artifact. */
export const MAX_LISTED_FILES = 2000;

/** How much of a failed command's output the record keeps. */
export const PACKAGE_OUTPUT_CHARS = 2000;

export interface PackageCommand {
  executable: string;
  args: string[];
}

export interface PackageArtifact {
  /** The archive's name, or the tool's name for a listing that builds none (`cargo package --list`). */
  file: string;
  files: string[];
  /** File names left out past `MAX_LISTED_FILES`. */
  truncated?: number;
}

/** A manifest a tool reads: its packaging fields, or `whole` when any change of the file counts. */
interface PackageManifest {
  name: RegExp;
  fields: ((text: string) => FieldMap) | "whole";
}

/** What a build sees of the package root. */
export interface PackageRoot {
  /** Absolute directory of the package root. */
  dir: string;
  /** The changed manifest's file name. */
  manifest: string;
  platform: NodeJS.Platform;
}

export interface PackageTool {
  id: "wheel" | "cargo-package" | "maven-jar" | "gradle-jar" | "nupkg" | "npm-pack";
  manifests: readonly PackageManifest[];
  /** The commands that build the package, tried in order until one succeeds. */
  builds: (root: PackageRoot) => PackageCommand[];
  /** The files of what the build made, read from its output folder or its stdout; null when unread. */
  list: (dir: string, stdout: string) => PackageArtifact[] | null;
  timeoutMs: number;
}

// --- Listing parsers -------------------------------------------------------------------------

/**
 * The file names of a zip archive (a wheel, a jar, a nupkg), read from its central directory.
 * Null when the bytes are not a zip this reader understands (a ZIP64 archive of 65535+ entries).
 */
export function zipEntries(bytes: Uint8Array): string[] | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let end = bytes.length - 22; end >= lowest; end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    const count = view.getUint16(end + 10, true);
    if (count === 0xffff) return null;
    let at = view.getUint32(end + 16, true);
    const names: string[] = [];
    for (let n = 0; n < count; n++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
      const nameLength = view.getUint16(at + 28, true);
      const extra = view.getUint16(at + 30, true);
      const comment = view.getUint16(at + 32, true);
      names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
      at += 46 + nameLength + extra + comment;
    }
    return names.filter((name) => !name.endsWith("/"));
  }
  return null;
}

/** The files of `npm pack --dry-run --json`: an array with one entry per package. */
export function npmPackFiles(stdout: string): PackageArtifact[] | null {
  const start = stdout.indexOf("[");
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const out: PackageArtifact[] = [];
    for (const entry of parsed as { filename?: unknown; files?: unknown }[]) {
      if (!Array.isArray(entry?.files)) return null;
      out.push(
        capped(
          typeof entry.filename === "string" ? entry.filename : "npm pack",
          (entry.files as { path?: unknown }[])
            .map((file) => file?.path)
            .filter((path): path is string => typeof path === "string"),
        ),
      );
    }
    return out;
  } catch {
    return null;
  }
}

/** The files of `cargo package --list`: one path per line. */
export function cargoPackageFiles(stdout: string): PackageArtifact[] | null {
  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:warning|error|note|help)\b|^[A-Z][a-z]+ing\s/.test(line));
  return files.length ? [capped("cargo package --list", files)] : null;
}

const capped = (file: string, files: string[]): PackageArtifact => {
  const sorted = [...new Set(files)].sort();
  return sorted.length > MAX_LISTED_FILES
    ? {
        file,
        files: sorted.slice(0, MAX_LISTED_FILES),
        truncated: sorted.length - MAX_LISTED_FILES,
      }
    : { file, files: sorted };
};

/** The zip archives a build left in a folder whose names match, with their files. */
export function listArchives(folder: string, name: RegExp): PackageArtifact[] | null {
  let names: string[];
  try {
    names = readdirSync(folder)
      .filter((entry) => name.test(entry))
      .sort();
  } catch {
    return null;
  }
  const out: PackageArtifact[] = [];
  for (const file of names) {
    const entries = zipEntries(readFileSync(join(folder, file)));
    if (entries) out.push(capped(file, entries));
  }
  return out.length ? out : null;
}

// --- Packaging fields ------------------------------------------------------------------------

/** pyproject.toml: the build backend, its package discovery and data, and entry points. */
export const pyprojectPackaging = (text: string): FieldMap =>
  tomlFields(
    text,
    /^(?:build-system|tool\.setuptools(?:\..+)?|tool\.hatch\.build(?:\..+)?|tool\.pdm\.build|tool\.maturin|tool\.flit\.(?:module|sdist|external-data)|tool\.scikit-build(?:\..+)?|tool\.poetry\.build|project\.(?:scripts|gui-scripts|entry-points(?:\..+)?))$/,
    { "tool.poetry": ["packages", "include", "exclude"], project: ["license-files", "readme"] },
  );

/** setup.cfg: package discovery, package data and entry points. */
export const setupCfgPackaging = (text: string): FieldMap =>
  tomlFields(
    text,
    /^(?:options\.(?:package_data|exclude_package_data|packages\.find|data_files|entry_points))$/,
    {
      options: [
        "packages",
        "package_dir",
        "py_modules",
        "include_package_data",
        "data_files",
        "scripts",
      ],
      metadata: ["license_files"],
    },
  );

/** Cargo.toml: what `cargo package` includes. */
export const cargoPackaging = (text: string): FieldMap =>
  tomlFields(text, /(?!)/, {
    package: ["include", "exclude", "readme", "license-file", "build", "workspace"],
  });

/** package.json: what `npm pack` includes and the scripts that run while it packs. */
export function packageJsonPackaging(text: string): FieldMap {
  const out: FieldMap = new Map();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const field of ["files", "types", "typings", "directories", "man"])
    if (parsed[field] !== undefined) out.set(field, JSON.stringify(parsed[field]));
  for (const [key, value] of packageJsonFields(text))
    if (/^(?:main|module|browser|exports|bin|scripts\.(?:prepack|prepare|postpack))$/.test(key))
      out.set(key, value);
  return out;
}

const xmlBlocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}\\s*>)`, "g"))].map((m) =>
    m[0].replace(/\s+/g, " "),
  );

/** pom.xml: the packaging, resources, source folders, final name and plugins of the build. */
export function pomPackaging(text: string): FieldMap {
  const out: FieldMap = new Map();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["packaging", "resources", "sourceDirectory", "finalName", "plugins"]) {
    const blocks = xmlBlocks(xml, tag);
    if (blocks.length) out.set(tag, blocks.join("\n"));
  }
  return out;
}

/** A Gradle build script: plugins, source sets and the jar and resource tasks. */
export function gradlePackaging(text: string): FieldMap {
  const out: FieldMap = new Map();
  for (const [key, body] of gradleFields(text)) {
    const name = key.split(" ")[0] ?? key;
    if (
      /^(?:plugins|jar|sourceSets|processResources|java|base)$/.test(name) ||
      (name.startsWith("tasks") && /\b(?:jar|Jar|processResources)\b/.test(body))
    )
      out.set(key, body);
  }
  return out;
}

const MSBUILD_PACK_PROPERTY =
  /^(?:IsPackable|IncludeBuildOutput|IncludeContentInPack|IncludeSymbols|IncludeSource|SuppressDependenciesWhenPacking|Nuspec\w*|Package(?:ReadmeFile|Icon|LicenseFile|Type)|ContentTargetFolders|BuildOutputTargetFolder|TargetFrameworks?|GeneratePackageOnBuild)$/;

/** An MSBuild project file: items packed into the nupkg and the properties that shape it. */
export function msbuildPackaging(text: string): FieldMap {
  const out: FieldMap = new Map();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const packed = [...xml.matchAll(/<ItemGroup\b[^>]*>([\s\S]*?)<\/ItemGroup\s*>/g)]
    .flatMap((group) => [...(group[1] ?? "").matchAll(/<(\w+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g)])
    .map((m) => m[0])
    .filter((item) => /\bPack\s*=|<Pack>|\bPackagePath\s*=|<PackagePath>/.test(item))
    .map((item) => item.replace(/\s+/g, " "));
  if (packed.length) out.set("packed items", packed.join("\n"));
  for (const m of xml.matchAll(/<([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g))
    if (m[1] && MSBUILD_PACK_PROPERTY.test(m[1])) out.set(m[1], (m[2] ?? "").trim());
  return out;
}

// --- Tools -----------------------------------------------------------------------------------

const venvPython = (dir: string, platform: NodeJS.Platform): string | null => {
  for (const folder of [".venv", "venv"]) {
    const path =
      platform === "win32"
        ? join(dir, folder, "Scripts", "python.exe")
        : join(dir, folder, "bin", "python");
    if (existsSync(path)) return path;
  }
  return null;
};

const WHEEL: PackageTool = {
  id: "wheel",
  manifests: [
    { name: /^pyproject\.toml$/, fields: pyprojectPackaging },
    { name: /^setup\.cfg$/, fields: setupCfgPackaging },
    { name: /^setup\.py$/, fields: "whole" },
    { name: /^MANIFEST\.in$/, fields: "whole" },
  ],
  // `build` makes the wheel the way a release does; without it, pip builds one with the project's
  // installed backend first (offline), then in an isolated environment.
  builds: ({ dir, platform }) => {
    const python = venvPython(dir, platform) ?? pythonExecutable();
    return [
      ...(existsSync(join(dir, "uv.lock"))
        ? [{ executable: "uv", args: ["build", "--wheel", "--out-dir", PACKAGE_OUT] }]
        : []),
      { executable: python, args: ["-m", "build", "--wheel", "--outdir", PACKAGE_OUT] },
      {
        executable: python,
        args: [
          "-m",
          "pip",
          "wheel",
          "--no-deps",
          "--no-build-isolation",
          "--wheel-dir",
          PACKAGE_OUT,
          ".",
        ],
      },
      {
        executable: python,
        args: ["-m", "pip", "wheel", "--no-deps", "--wheel-dir", PACKAGE_OUT, "."],
      },
    ];
  },
  list: (dir) => listArchives(join(dir, PACKAGE_OUT), /\.whl$/),
  timeoutMs: 300_000,
};

const CARGO: PackageTool = {
  id: "cargo-package",
  manifests: [{ name: /^Cargo\.toml$/, fields: cargoPackaging }],
  builds: () => [{ executable: "cargo", args: ["package", "--list", "--allow-dirty"] }],
  list: (_, stdout) => cargoPackageFiles(stdout),
  timeoutMs: 300_000,
};

/** A built jar, not its sources, javadoc or test jars. */
const MAIN_JAR = /^(?!.*-(?:sources|javadoc|tests|test-sources)\.jar$).*\.jar$/;

const MAVEN: PackageTool = {
  id: "maven-jar",
  manifests: [{ name: /^pom\.xml$/, fields: pomPackaging }],
  builds: ({ dir, platform }) => {
    const mvn = buildWrapper(dir, "mvnw", "mvn", platform);
    return [
      { executable: mvn.executable, args: [...mvn.args, "-B", "-q", "package", "-DskipTests"] },
    ];
  },
  list: (dir) => listArchives(join(dir, "target"), MAIN_JAR),
  timeoutMs: 900_000,
};

const GRADLE: PackageTool = {
  id: "gradle-jar",
  manifests: [{ name: /^build\.gradle(?:\.kts)?$/, fields: gradlePackaging }],
  builds: ({ dir, platform }) => {
    const gradle = buildWrapper(dir, "gradlew", "gradle", platform);
    return [
      { executable: gradle.executable, args: [...gradle.args, "--console=plain", "-q", "jar"] },
    ];
  },
  list: (dir) => listArchives(join(dir, "build", "libs"), MAIN_JAR),
  timeoutMs: 900_000,
};

const NUPKG: PackageTool = {
  id: "nupkg",
  manifests: [
    { name: /\.(?:csproj|fsproj|vbproj)$/, fields: msbuildPackaging },
    { name: /\.nuspec$/, fields: "whole" },
  ],
  builds: ({ manifest }) => [
    {
      executable: "dotnet",
      args: ["pack", ...(/proj$/.test(manifest) ? [manifest] : []), "--nologo", "-o", PACKAGE_OUT],
    },
  ],
  list: (dir) => listArchives(join(dir, PACKAGE_OUT), /\.nupkg$/),
  timeoutMs: 600_000,
};

const NPM: PackageTool = {
  id: "npm-pack",
  manifests: [
    { name: /^package\.json$/, fields: packageJsonPackaging },
    { name: /^\.npmignore$/, fields: "whole" },
  ],
  builds: () => [{ executable: "npm", args: ["pack", "--dry-run", "--json"] }],
  list: (_, stdout) => npmPackFiles(stdout),
  timeoutMs: 300_000,
};

/**
 * The package each supported language builds, and how to list it (#1984): a tool per packaging
 * system, or `none(reason)` where no package is built or its build is not supported here.
 */
export const PACKAGE_CONTENTS: LanguageRecord<readonly PackageTool[]> = {
  typescript: [NPM],
  javascript: [NPM],
  vue: [NPM],
  svelte: [NPM],
  rescript: [NPM],
  python: [WHEEL],
  rust: [CARGO],
  java: [MAVEN, GRADLE],
  kotlin: [GRADLE, MAVEN],
  csharp: [NUPKG],
  scala: none("sbt packaging is not built (sbt builds are Scala code)"),
  go: none("Go modules are published as source from version control; no package is built"),
  ruby: none("gemspecs are Ruby code and .gem archives (tar of gzip) are not read yet"),
  php: none("Composer packages are source archives of the repository; no package is built"),
  swift: none("Swift packages are published as source from version control"),
  lua: none("LuaRocks packaging is not built yet"),
  elixir: none("Hex packaging (mix hex.build) is not built yet"),
  dart: none("pub packaging (dart pub publish --dry-run) is not built yet"),
  zig: none("Zig packages are source archives fetched by URL"),
  c: none("C has no package format"),
  cpp: none("Conan and vcpkg packaging is not built yet"),
  bash: none("shell scripts have no package format"),
  ocaml: none("opam packages are source archives; no package is built"),
  objc: none("CocoaPods packaging is not built yet"),
  solidity: none("Solidity libraries are published through npm, read by the npm row"),
  sql: none("SQL files are deployed as migrations or models, not built into a package"),
};

const TOOLS: readonly PackageTool[] = [
  ...new Set(SUPPORTED_LANGUAGES.flatMap((language) => rowOf(PACKAGE_CONTENTS, language) ?? [])),
];

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".");

/** The tool and manifest entry that read a path, by its file name. */
function readerOf(path: string): { tool: PackageTool; manifest: PackageManifest } | null {
  const name = fileName(path);
  for (const tool of TOOLS)
    for (const manifest of tool.manifests) if (manifest.name.test(name)) return { tool, manifest };
  return null;
}

const fieldsOf = (manifest: PackageManifest, text: string): FieldMap =>
  manifest.fields === "whole" ? new Map([["file", text]]) : manifest.fields(text);

/** The packaging fields a manifest declares, for the language parity golden. */
export function packagingFields(
  path: string,
  text: string,
): { tool: PackageTool["id"]; fields: string[] } | null {
  const reader = readerOf(path);
  return reader
    ? { tool: reader.tool.id, fields: [...fieldsOf(reader.manifest, text).keys()] }
    : null;
}

/** Whether a path is a manifest one of the tools reads. */
export const isPackagingManifest = (path: string): boolean => readerOf(path) !== null;

/** A package root to build: the tool, its directory and the changed fields that call for it. */
export interface PackagingChange {
  tool: PackageTool;
  /** The package root, relative to the run's root (`.` at the top). */
  dir: string;
  /** The changed manifest the build is named after (a project file for `dotnet pack`). */
  manifest: string;
  /** `path: field` for every packaging field that changed. */
  fields: string[];
}

/**
 * The package roots whose packaging fields the run changed (#1984), per manifest: a field added,
 * removed or changed, every field of a manifest the run created, and every field of one whose
 * content before the run was not kept. One build per tool and directory.
 */
export function packagingChanges(changed: readonly ChangedFile[]): PackagingChange[] {
  const out = new Map<string, PackagingChange>();
  for (const file of changed) {
    const reader = readerOf(file.path);
    if (!reader) continue;
    const read = (text: string) => fieldsOf(reader.manifest, text);
    const fields =
      typeof file.before === "string"
        ? changedFields(read, file.before, file.content)
        : [...read(file.content).keys()];
    if (!fields.length) continue;
    const dir = dirName(file.path);
    const key = `${reader.tool.id}\0${dir}`;
    const entry = out.get(key) ?? {
      tool: reader.tool,
      dir,
      manifest: fileName(file.path),
      fields: [],
    };
    // `dotnet pack` takes the project file; a nuspec alone builds the folder's project.
    if (/proj$/.test(fileName(file.path))) entry.manifest = fileName(file.path);
    entry.fields.push(...fields.map((field) => `${file.path}: ${field}`));
    out.set(key, entry);
  }
  return [...out.values()];
}

// --- Record ----------------------------------------------------------------------------------

export interface PackageAttempt {
  command: string;
  result: "listed" | "missing" | "failed" | "timeout" | "unread";
  /** The end of the output of an attempt that did not list the package. */
  output?: string;
}

export interface PackageBuild {
  tool: PackageTool["id"];
  dir: string;
  fields: string[];
  status: "listed" | "failed" | "missing";
  attempts: PackageAttempt[];
  artifacts: PackageArtifact[];
}

export interface PackageContents {
  schemaVersion: 1;
  snapshotId: string;
  builds: PackageBuild[];
  note?: string;
}

/** The status of a build from its attempts: listed by one, else no tool at all, else failed. */
export const buildStatus = (attempts: readonly PackageAttempt[]): PackageBuild["status"] =>
  attempts.some((a) => a.result === "listed")
    ? "listed"
    : attempts.every((a) => a.result === "missing")
      ? "missing"
      : "failed";

export const commandText = (command: PackageCommand): string =>
  formatCommandLine(command.executable, command.args);

/** What the spec author, the spec reviewer and the reviewers are told when the check is on. */
export const PACKAGE_CONTENTS_NOTE = {
  spec: "The host runs the package contents check: when the run changes a manifest's packaging fields (package data, included files, packed items, build backend), it builds the package in a copy of the delivered tree (a Python wheel, `cargo package --list`, a Maven or Gradle jar, `dotnet pack`, `npm pack --dry-run`) and records the files it holds. A criterion that the built package contains, or leaves out, a named file is automated: name the file and the package, not a build you expect a person to run.",
  analysis:
    "The host runs the package contents check (the package built in a copy of the delivered tree when a manifest's packaging fields change, its file list recorded as evidence quality/package-contents.json), so a criterion that the built package contains or leaves out a named file is automated and checkable; it is never a finding for needing a build.",
  review:
    "Evidence quality/package-contents.json is the package contents check: for each package root whose packaging fields the run changed, the build commands tried (attempts) and the files of each artifact built (artifacts[].files, paths inside the archive). Settle a criterion that the built package contains, or leaves out, a file from it. A build with status missing or failed lists nothing: such a criterion stays inconclusive and is not a defect of the code; read the attempt's output for the reason.",
} as const;

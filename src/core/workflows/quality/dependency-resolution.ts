/**
 * The resolved dependencies of a tree, for the baseline replay (#1954). Update briefs ask that "the
 * resolved dependencies are unchanged" (bench round 61 taskplan: "baseline and updated Maven
 * dependency resolution ... identical"); the replay lists them in its copy as delivered and again
 * after the changed files went back, and records the difference, so such a criterion has evidence.
 *
 * Each source reads a lock file when the folder has one, else runs the toolchain's listing. A
 * folder whose dependency files the run did not change resolves the same by construction and runs
 * nothing.
 */
import { posix } from "node:path";

/** Each dependency's resolved versions, by its name. */
export type Resolution = Map<string, string>;

export interface ResolutionSource {
  id: string;
  /** Whether a folder with these file names resolves through this source. */
  applies: (names: readonly string[]) => boolean;
  /** The lock file the source reads. */
  lock?: { file: string; parse: (text: string) => Resolution };
  /** The listing the source runs: the executable (a wrapper when the folder has one) and its arguments. */
  command?: {
    executable: (names: readonly string[]) => string;
    args: readonly string[];
    parse: (output: string) => Resolution | null;
  };
}

/** The difference in one folder's resolution between the code before the change and the delivery. */
export interface ResolutionDiff {
  source: string;
  /** The folder, relative to the workspace. */
  folder: string;
  /** True when both sides list the same dependencies at the same versions. */
  identical: boolean;
  /** `name version` the delivery resolves and the code before the change did not. */
  added: string[];
  /** `name version` the code before the change resolved and the delivery does not. */
  removed: string[];
  /** `name before -> after`. */
  changed: string[];
  /** Why the folder was not compared, or why one side could not be listed. */
  note?: string;
}

const add = (out: Resolution, name: string, version: string): void => {
  if (!name || !version) return;
  const versions = new Set((out.get(name) ?? "").split(", ").filter(Boolean));
  versions.add(version);
  out.set(name, [...versions].sort().join(", "));
};

const parseJson = (text: string): unknown => {
  try {
    // bun.lock is JSON with trailing commas.
    return JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** `package-lock.json`: every installed package, by the name after its last `node_modules/`. */
export function packageLockResolution(text: string): Resolution {
  const out: Resolution = new Map();
  const lock = record(parseJson(text));
  for (const [path, entry] of Object.entries(record(lock.packages))) {
    const at = path.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const version = record(entry).version;
    if (typeof version === "string") add(out, path.slice(at + "node_modules/".length), version);
  }
  // Lockfile version 1 nests its dependencies.
  const walk = (deps: unknown): void => {
    for (const [name, entry] of Object.entries(record(deps))) {
      const version = record(entry).version;
      if (typeof version === "string") add(out, name, version);
      walk(record(entry).dependencies);
    }
  };
  if (!lock.packages) walk(lock.dependencies);
  return out;
}

/** `bun.lock`: each package's first array element is `name@version`. */
export function bunLockResolution(text: string): Resolution {
  const out: Resolution = new Map();
  for (const entry of Object.values(record(record(parseJson(text)).packages))) {
    const coordinate = Array.isArray(entry) ? entry[0] : null;
    if (typeof coordinate !== "string") continue;
    const at = coordinate.lastIndexOf("@");
    if (at > 0) add(out, coordinate.slice(0, at), coordinate.slice(at + 1));
  }
  return out;
}

/** A TOML lock's `[[package]]` names and versions (`Cargo.lock`, `uv.lock`, `poetry.lock`). */
export function tomlLockResolution(text: string): Resolution {
  const out: Resolution = new Map();
  for (const block of text.split(/^\s*\[\[package\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\s*\[(?!package\.)/m)[0] ?? "";
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    const version = /^\s*version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
    if (name && version) add(out, name, version);
  }
  return out;
}

/** NuGet `packages.lock.json`: each target framework's resolved packages. */
export function nugetLockResolution(text: string): Resolution {
  const out: Resolution = new Map();
  for (const framework of Object.values(record(record(parseJson(text)).dependencies)))
    for (const [name, entry] of Object.entries(record(framework))) {
      const resolved = record(entry).resolved;
      if (typeof resolved === "string") add(out, name, resolved);
    }
  return out;
}

/** `go list -m all`: `module version`, the main module (no version) left out. */
export function goListResolution(output: string): Resolution | null {
  const out: Resolution = new Map();
  for (const line of output.split(/\r?\n/)) {
    const [module, version, arrow, replacement, replaced] = line.trim().split(/\s+/);
    if (!module || !version || version.startsWith("=")) continue;
    add(
      out,
      module,
      arrow === "=>" ? `${version} => ${replacement}${replaced ? ` ${replaced}` : ""}` : version,
    );
  }
  return out.size || /^\S+\s*$/m.test(output) ? out : null;
}

const MAVEN_SCOPE = /^(?:compile|runtime|test|provided|system|import)$/;

/** `mvn dependency:list`: `group:artifact:type[:classifier]:version:scope` lines. */
export function mavenListResolution(output: string): Resolution | null {
  const out: Resolution = new Map();
  for (const line of output.split(/\r?\n/)) {
    const coordinate = /^\[INFO\]\s+([\w.-]+(?::[\w.-]+){4,5})(?:\s|$)/.exec(line)?.[1];
    const parts = coordinate?.split(":") ?? [];
    if (parts.length < 5 || !MAVEN_SCOPE.test(parts.at(-1) ?? "")) continue;
    add(out, `${parts[0]}:${parts[1]}`, parts.at(-2) ?? "");
  }
  return out.size || /BUILD SUCCESS/.test(output) ? out : null;
}

/** `gradle dependencies`: `+--- group:name:version` lines, with `-> version` where conflict resolution moved it. */
export function gradleResolution(output: string): Resolution | null {
  const out: Resolution = new Map();
  for (const line of output.split(/\r?\n/)) {
    const m = /[+\\]---\s+([\w.-]+):([\w.-]+)(?::([^\s:]+))?(?:\s+->\s+([^\s]+))?/.exec(line);
    if (m?.[1] && m[2]) add(out, `${m[1]}:${m[2]}`, m[4] ?? m[3] ?? "");
  }
  return out.size || /BUILD SUCCESSFUL|No dependencies/.test(output) ? out : null;
}

/** `dotnet list package --include-transitive`: `> Name requested resolved` (top level) and `> Name resolved`. */
export function dotnetListResolution(output: string): Resolution | null {
  const out: Resolution = new Map();
  for (const line of output.split(/\r?\n/)) {
    const fields = /^\s*>\s+(.+)$/.exec(line)?.[1]?.trim().split(/\s+/);
    if (fields && fields.length >= 2) add(out, fields[0] ?? "", fields.at(-1) ?? "");
  }
  return out.size || /has the following package references|No packages were found/.test(output)
    ? out
    : null;
}

const has =
  (...files: string[]) =>
  (names: readonly string[]) =>
    files.some((file) => names.includes(file));
const wrapper = (script: string, tool: string) => (names: readonly string[]) =>
  names.includes(script) ? (process.platform === "win32" ? `${script}.cmd` : `./${script}`) : tool;

/**
 * Where each toolchain's resolution comes from, in order: a folder takes every source that applies
 * to it. java, kotlin (Maven, Gradle), rust, go, python (uv, poetry), typescript and javascript
 * (npm, bun) and csharp; a python project without a lock (requirements files) and yarn or pnpm
 * locks are not read.
 */
export const RESOLUTION_SOURCES: readonly ResolutionSource[] = [
  {
    id: "npm",
    applies: has("package-lock.json"),
    lock: { file: "package-lock.json", parse: packageLockResolution },
  },
  { id: "bun", applies: has("bun.lock"), lock: { file: "bun.lock", parse: bunLockResolution } },
  {
    id: "cargo",
    applies: has("Cargo.lock"),
    lock: { file: "Cargo.lock", parse: tomlLockResolution },
  },
  { id: "uv", applies: has("uv.lock"), lock: { file: "uv.lock", parse: tomlLockResolution } },
  {
    id: "poetry",
    applies: has("poetry.lock"),
    lock: { file: "poetry.lock", parse: tomlLockResolution },
  },
  {
    id: "nuget",
    applies: has("packages.lock.json"),
    lock: { file: "packages.lock.json", parse: nugetLockResolution },
  },
  {
    id: "dotnet",
    applies: (names) =>
      !names.includes("packages.lock.json") &&
      names.some((name) => /\.(?:sln|slnx|csproj|fsproj|vbproj)$/.test(name)),
    command: {
      executable: () => "dotnet",
      args: ["list", "package", "--include-transitive"],
      parse: dotnetListResolution,
    },
  },
  {
    id: "go",
    applies: has("go.mod"),
    command: { executable: () => "go", args: ["list", "-m", "all"], parse: goListResolution },
  },
  {
    id: "maven",
    applies: has("pom.xml"),
    command: {
      executable: wrapper("mvnw", "mvn"),
      args: ["-B", "dependency:list", "-DincludeScope=test"],
      parse: mavenListResolution,
    },
  },
  {
    id: "gradle",
    applies: has("build.gradle", "build.gradle.kts"),
    command: {
      executable: wrapper("gradlew", "gradle"),
      args: ["-q", "dependencies", "--configuration", "testRuntimeClasspath"],
      parse: gradleResolution,
    },
  },
];

/** The files that decide a folder's resolution: a change to one of them can change it. */
const RESOLUTION_INPUTS =
  /^(?:package(?:-lock)?\.json|bun\.lockb?|Cargo\.(?:toml|lock)|uv\.lock|poetry\.lock|pyproject\.toml|packages\.lock\.json|Directory\.Packages\.props|Directory\.Build\.props|[^/]+\.(?:csproj|fsproj|vbproj)|go\.(?:mod|sum)|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|libs\.versions\.toml|gradle\.properties)$/;

/** Whether a changed path can change the resolution of its folder. */
export const isResolutionInput = (path: string): boolean =>
  RESOLUTION_INPUTS.test(posix.basename(path));

/** `name version` lines of a resolution. */
const lines = (resolution: Resolution): string[] =>
  [...resolution].map(([name, version]) => `${name} ${version}`);

/** The difference between the resolution before the change and the delivered one. */
export function resolutionDiff(
  source: string,
  folder: string,
  before: Resolution,
  after: Resolution,
): ResolutionDiff {
  const added = lines(after).filter((line) => !before.has(line.split(" ")[0] ?? ""));
  const removed = lines(before).filter((line) => !after.has(line.split(" ")[0] ?? ""));
  const changed = [...after]
    .filter(([name, version]) => before.has(name) && before.get(name) !== version)
    .map(([name, version]) => `${name} ${before.get(name)} -> ${version}`);
  return {
    source,
    folder,
    identical: !added.length && !removed.length && !changed.length,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/** What `listResolutions` reads and runs, relative to the copy. */
export interface ResolutionIo {
  /** The file names in a folder; empty when it does not exist. */
  names: (folder: string) => string[];
  /** A file's text, or null when it cannot be read. */
  read: (path: string) => string | null;
  /** Runs a listing in a folder. */
  run: (
    folder: string,
    executable: string,
    args: readonly string[],
  ) => Promise<{ status: "passed" | "failed" | "timeout"; output: string }>;
}

/** Each source's resolution of each folder, by `source\tfolder`; a string says why none was read. */
export async function listResolutions(
  folders: readonly string[],
  io: ResolutionIo,
): Promise<Map<string, Resolution | string>> {
  const out = new Map<string, Resolution | string>();
  for (const folder of folders) {
    const names = io.names(folder);
    for (const source of RESOLUTION_SOURCES.filter((s) => s.applies(names))) {
      const key = `${source.id}\t${folder}`;
      if (source.lock) {
        const text = io.read(posix.join(folder, source.lock.file));
        out.set(
          key,
          text === null ? `${source.lock.file} could not be read` : source.lock.parse(text),
        );
      } else if (source.command) {
        const executable = source.command.executable(names);
        const result = await io.run(folder, executable, source.command.args);
        const parsed = result.status === "passed" ? source.command.parse(result.output) : null;
        out.set(
          key,
          parsed ??
            `${[executable, ...source.command.args].join(" ")} ${result.status === "timeout" ? "timed out" : "did not list the dependencies"}: ${result.output.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300)}`,
        );
      }
    }
  }
  return out;
}

/** The note of a folder whose dependency files the run did not change. */
export const UNCHANGED_RESOLUTION_NOTE =
  "the run changed no dependency manifest or lock file here, so both sides resolve the same";

/** The differences between the delivered resolutions (`after`) and those before the change. */
export function compareResolutions(
  after: Map<string, Resolution | string>,
  before: Map<string, Resolution | string>,
): ResolutionDiff[] {
  return [...new Set([...after.keys(), ...before.keys()])].sort().map((key) => {
    const [source = "", folder = "."] = key.split("\t");
    const now = after.get(key) ?? new Map();
    const old = before.get(key) ?? new Map();
    if (typeof now === "string" || typeof old === "string")
      return {
        source,
        folder,
        identical: false,
        added: [],
        removed: [],
        changed: [],
        note: [
          typeof old === "string" ? `before the change: ${old}` : "",
          typeof now === "string" ? `delivered: ${now}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    return resolutionDiff(source, folder, old, now);
  });
}

/**
 * The replay's dependency comparison (#1954): lists the folders whose dependency files the run
 * changed as delivered, calls `revert` (which puts the changed files back), lists them again, and
 * returns the differences, with an unchanged entry for each source of the other `folders`.
 */
export async function replayResolution(
  changed: readonly string[],
  folders: readonly string[],
  io: ResolutionIo,
  revert: () => void,
): Promise<ResolutionDiff[]> {
  const touched = [
    ...new Set(changed.filter(isResolutionInput).map((path) => posix.dirname(path))),
  ].sort();
  const delivered = await listResolutions(touched, io);
  revert();
  const original = await listResolutions(touched, io);
  const unchanged = [...new Set(folders)]
    .filter((folder) => !touched.includes(folder))
    .flatMap((folder) =>
      RESOLUTION_SOURCES.filter((source) => source.applies(io.names(folder))).map(
        (source): ResolutionDiff => ({
          source: source.id,
          folder,
          identical: true,
          added: [],
          removed: [],
          changed: [],
          note: UNCHANGED_RESOLUTION_NOTE,
        }),
      ),
    );
  return [...compareResolutions(delivered, original), ...unchanged];
}

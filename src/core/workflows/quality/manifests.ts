/**
 * Dependencies declared in package manifests and bare imports of JS/TS code, for the
 * dependency check (#640). Parsing is line-based and tolerant: a manifest it cannot read
 * declares nothing, so a broken file is reported by the project's own checks, not here.
 */
import { builtinModules } from "node:module";
import {
  type LanguageRecord,
  none,
  rowOf,
  SUPPORTED_LANGUAGES,
} from "../../intelligence/language-records.js";
import {
  cargoFields,
  changedFields,
  type FieldMap,
  gemfileFields,
  goModFields,
  gradleFields,
  msbuildFields,
  packageJsonFields,
  pipfileFields,
  pomFields,
  pyprojectFields,
  requirementsFields,
  setupCfgFields,
  versionCatalogFields,
} from "./manifest-fields.js";

export type Ecosystem = "npm" | "pypi" | "crates" | "go" | "nuget" | "maven" | "rubygems";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** The manifest or source file that declares or imports it. */
  file: string;
  line: number;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

function packageJson(path: string, text: string): Dependency[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: Dependency[] = [];
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = parsed[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      // Workspace, file and link specs name local packages, not the registry.
      if (typeof spec === "string" && /^(workspace:|file:|link:|portal:)/.test(spec)) continue;
      const at = text.indexOf(`"${name}"`);
      out.push({ ecosystem: "npm", name, file: path, line: at < 0 ? 1 : lineOf(text, at) });
    }
  }
  return out;
}

/** The distribution name of a PEP 508 requirement, normalized (PEP 503). */
const pypiName = (requirement: string): string | null => {
  const name = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(requirement)?.[1];
  return name ? name.toLowerCase().replace(/[-_.]+/g, "-") : null;
};

function requirementsTxt(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^(git\+|https?:|\.|\/)/.test(line)) return;
    const name = pypiName(line);
    if (name) out.push({ ecosystem: "pypi", name, file: path, line: i + 1 });
  });
  return out;
}

/** Lines of a TOML table, by header, e.g. `[dependencies]`. */
function tomlTables(text: string): { header: string; line: number; body: string }[] {
  const lines = text.split("\n");
  const out: { header: string; line: number; body: string }[] = [];
  let current: { header: string; line: number; body: string } | null = null;
  lines.forEach((line, i) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];
    if (header) {
      current = { header: header.trim(), line: i + 1, body: "" };
      out.push(current);
    } else if (current) current.body += `${line}\n`;
  });
  return out;
}

/**
 * The string items of each `key = [...]` array of a TOML file, with the table it is in. The array
 * is read token by token, so a `]` inside a string (`"requests[socks]"`) does not end it: a lazy
 * bracket match stopped there and lost every later dependency (#1682).
 */
function tomlStringArrays(
  text: string,
): { table: string; key: string; items: { value: string; index: number }[] }[] {
  const out: { table: string; key: string; items: { value: string; index: number }[] }[] = [];
  for (const match of text.matchAll(/^\s*([\w.-]+|"[^"]+")\s*=\s*\[/gm)) {
    const items: { value: string; index: number }[] = [];
    let depth = 0;
    for (let i = (match.index ?? 0) + match[0].length - 1; i < text.length; i++) {
      const char = text[i];
      if (char === '"' || char === "'") {
        const end = text.indexOf(char, i + 1);
        if (end === -1) break;
        if (depth === 1) items.push({ value: text.slice(i + 1, end), index: i });
        i = end;
      } else if (char === "#") {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
      } else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const table = tomlTables(text.slice(0, match.index ?? 0)).at(-1)?.header ?? "";
    out.push({ table, key: (match[1] ?? "").replace(/^"|"$/g, ""), items });
  }
  return out;
}

/** The arrays of PEP 508 requirements a pyproject.toml declares. */
const PYPROJECT_ARRAYS = (table: string, key: string): boolean =>
  (table === "project" && key === "dependencies") ||
  table === "project.optional-dependencies" ||
  // PEP 735 groups, where `uv add --dev` writes, and uv's older dev list.
  table === "dependency-groups" ||
  (table === "tool.uv" && (key === "dev-dependencies" || key === "constraint-dependencies")) ||
  (table === "build-system" && key === "requires");

function pyprojectToml(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const array of tomlStringArrays(text)) {
    if (!PYPROJECT_ARRAYS(array.table, array.key)) continue;
    for (const item of array.items) {
      const name = pypiName(item.value);
      if (name) out.push({ ecosystem: "pypi", name, file: path, line: lineOf(text, item.index) });
    }
  }
  // Poetry: keys of [tool.poetry.dependencies] and its groups.
  for (const table of tomlTables(text))
    if (/^tool\.poetry\.(?:dev-)?(?:group\.[\w-]+\.)?dependencies$/.test(table.header))
      table.body.split("\n").forEach((line, i) => {
        const key = /^\s*([A-Za-z0-9][\w.-]*)\s*=/.exec(line)?.[1];
        if (key && key.toLowerCase() !== "python")
          out.push({
            ecosystem: "pypi",
            name: pypiName(key) ?? key,
            file: path,
            line: table.line + i + 1,
          });
      });
  return out;
}

function cargoToml(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const table of tomlTables(text)) {
    // `[dependencies.tokio]` with `version = "1"` in its body: the table form of one dependency.
    const single = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(
      table.header,
    )?.[1];
    if (single) {
      if (/^\s*(?:path|git)\s*=/m.test(table.body)) continue;
      const renamed = /^\s*package\s*=\s*"([^"]+)"/m.exec(table.body)?.[1];
      out.push({ ecosystem: "crates", name: renamed ?? single, file: path, line: table.line });
      continue;
    }
    if (!/(?:^|\.)(?:dev-|build-)?dependencies$/.test(table.header)) continue;
    table.body.split("\n").forEach((line, i) => {
      const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
      if (!match) return;
      // A path or git dependency is not from crates.io; `package = "x"` renames one that is.
      const value = match[2] ?? "";
      if (/\b(?:path|git)\s*=/.test(value)) return;
      const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(value)?.[1];
      out.push({
        ecosystem: "crates",
        name: renamed ?? match[1] ?? "",
        file: path,
        line: table.line + i + 1,
      });
    });
  }
  return out;
}

function goMod(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  let block = false;
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) block = true;
    else if (block && line === ")") block = false;
    const module = block
      ? /^([\w.-]+\/[^\s]+)\s+v/.exec(line)?.[1]
      : /^require\s+([\w.-]+\/[^\s]+)\s+v/.exec(line)?.[1];
    if (module) out.push({ ecosystem: "go", name: module, file: path, line: i + 1 });
  });
  return out;
}

function csproj(path: string, text: string): Dependency[] {
  return [...text.matchAll(/<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g)].map((m) => ({
    ecosystem: "nuget" as const,
    name: m[1] ?? "",
    file: path,
    line: lineOf(text, m.index ?? 0),
  }));
}

function pomXml(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const m of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(m[1] ?? "")?.[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[1] ?? "")?.[1];
    if (group && artifact && !group.includes("${"))
      out.push({
        ecosystem: "maven",
        name: `${group}:${artifact}`,
        file: path,
        line: lineOf(text, m.index ?? 0),
      });
  }
  return out;
}

/** Literal Maven coordinates in Gradle dependency blocks, in Groovy or Kotlin syntax. */
function gradle(path: string, text: string): Dependency[] {
  // Blank comments without shifting offsets or treating comment markers in strings as comments.
  const code = text.replace(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (token) => (token.startsWith("/") ? token.replace(/[^\n]/g, " ") : token),
  );
  const out: Dependency[] = [];
  const blocks: boolean[] = [];
  let previous = "";
  for (const token of code.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\w]+|[{}]/g)) {
    const value = token[0];
    if (value === "{") blocks.push(previous === "dependencies" || blocks.at(-1) === true);
    else if (value === "}") blocks.pop();
    else if (blocks.at(-1)) {
      const coordinate = /^["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']$/.exec(value);
      if (coordinate)
        out.push({
          ecosystem: "maven",
          name: `${coordinate[1]}:${coordinate[2]}`,
          file: path,
          line: lineOf(text, token.index),
        });
      // Groovy `group: 'g', name: 'a'` and Kotlin `group = "g", name = "a"`.
      if (value === "group") {
        const notation =
          /^group\s*[:=]\s*["']([\w.-]+)["']\s*,\s*name\s*[:=]\s*["']([\w.-]+)["']/.exec(
            code.slice(token.index),
          );
        if (notation)
          out.push({
            ecosystem: "maven",
            name: `${notation[1]}:${notation[2]}`,
            file: path,
            line: lineOf(text, token.index),
          });
      }
    }
    previous = value;
  }
  return out;
}

/** Gemfile declarations, including gems inside groups and source blocks. */
function gemfile(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  const code = text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|#[^\n]*/g, (token) =>
    token.startsWith("#") ? "" : token,
  );
  code.split("\n").forEach((line, i) => {
    const match = /^\s*gem\s*(?:\(\s*)?["']([\w.-]+)["'](.*)$/.exec(line);
    if (!match || /\b(?:git|github|path)\s*:|:(?:git|github|path)\s*=>/.test(match[2] ?? ""))
      return;
    out.push({ ecosystem: "rubygems", name: match[1] ?? "", file: path, line: i + 1 });
  });
  return out;
}

/** Pipfile: the keys of `[packages]` and `[dev-packages]`. */
function pipfile(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const table of tomlTables(text))
    if (table.header === "packages" || table.header === "dev-packages")
      table.body.split("\n").forEach((line, i) => {
        const match = /^\s*"?([A-Za-z0-9][\w.-]*)"?\s*=\s*(.*)$/.exec(line);
        if (!match || /\b(?:path|git|file)\s*=/.test(match[2] ?? "")) return;
        const name = pypiName(match[1] ?? "");
        if (name) out.push({ ecosystem: "pypi", name, file: path, line: table.line + i + 1 });
      });
  return out;
}

/** setup.cfg: `install_requires` of `[options]` and every list of `[options.extras_require]`. */
function setupCfg(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  let section = "";
  let inList = false;
  text.split("\n").forEach((raw, i) => {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(raw)?.[1];
    if (header) {
      section = header.trim();
      inList = false;
      return;
    }
    const assignment = /^([\w.-]+)\s*=\s*(.*)$/.exec(raw);
    let value: string | null = null;
    if (assignment) {
      inList =
        (section === "options" &&
          ["install_requires", "setup_requires", "tests_require"].includes(assignment[1] ?? "")) ||
        section === "options.extras_require";
      value = inList ? (assignment[2] ?? "") : null;
    } else if (inList && /^\s+\S/.test(raw)) value = raw;
    else if (raw.trim()) inList = false;
    const requirement = value?.replace(/#.*$/, "").trim();
    const name = requirement ? pypiName(requirement) : null;
    if (name) out.push({ ecosystem: "pypi", name, file: path, line: i + 1 });
  });
  return out;
}

/** Central .NET package versions: `<PackageVersion Include="...">` (Directory.Packages.props). */
function packageVersions(path: string, text: string): Dependency[] {
  return [...text.matchAll(/<PackageVersion\s+[^>]*Include\s*=\s*"([^"]+)"/g)].map((m) => ({
    ecosystem: "nuget" as const,
    name: m[1] ?? "",
    file: path,
    line: lineOf(text, m.index ?? 0),
  }));
}

/** A Gradle version catalog: the coordinates of each entry of `[libraries]`. */
function versionCatalog(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  const libraries = tomlTables(text).find((table) => table.header === "libraries");
  libraries?.body.split("\n").forEach((line, i) => {
    const value = /^\s*[\w.-]+\s*=\s*(.*)$/.exec(line)?.[1] ?? "";
    const coordinate =
      /^"([\w.-]+):([\w.-]+)(?::[^"]*)?"/.exec(value) ??
      /\bmodule\s*=\s*"([\w.-]+):([\w.-]+)"/.exec(value) ??
      /\bgroup\s*=\s*"([\w.-]+)"\s*,\s*name\s*=\s*"([\w.-]+)"/.exec(value);
    if (coordinate)
      out.push({
        ecosystem: "maven",
        name: `${coordinate[1]}:${coordinate[2]}`,
        file: path,
        line: libraries.line + i + 1,
      });
  });
  return out;
}

/** The registry dependencies a manifest declares. */
/** A dependency manifest by file name, and how to read the dependencies it declares. */
interface ManifestReader {
  name: RegExp;
  read: (path: string, text: string) => Dependency[];
  /**
   * The fields of the manifest that run code or choose where code comes from, which the manifest
   * field gate holds to what the request names (#1793). A new manifest states them here.
   */
  fields: (text: string) => FieldMap;
}

const NPM: readonly ManifestReader[] = [
  { name: /^package\.json$/, read: packageJson, fields: packageJsonFields },
];
const MAVEN_GRADLE: readonly ManifestReader[] = [
  { name: /^pom\.xml$/, read: pomXml, fields: pomFields },
  { name: /^(?:build|settings)\.gradle(?:\.kts)?$/, read: gradle, fields: gradleFields },
  { name: /^libs\.versions\.toml$/, read: versionCatalog, fields: versionCatalogFields },
];

/**
 * The dependency manifests of each supported language (#1682, #1717): every form a package
 * manager of the language writes, so a dependency declared in any of them reaches the
 * dependency check.
 */
export const DEPENDENCY_MANIFESTS: LanguageRecord<readonly ManifestReader[]> = {
  typescript: NPM,
  javascript: NPM,
  vue: NPM,
  svelte: NPM,
  rescript: NPM,
  python: [
    { name: /^pyproject\.toml$/, read: pyprojectToml, fields: pyprojectFields },
    { name: /^requirements[\w.-]*\.txt$/, read: requirementsTxt, fields: requirementsFields },
    { name: /^Pipfile$/, read: pipfile, fields: pipfileFields },
    { name: /^setup\.cfg$/, read: setupCfg, fields: setupCfgFields },
  ],
  rust: [{ name: /^Cargo\.toml$/, read: cargoToml, fields: cargoFields }],
  go: [{ name: /^go\.mod$/, read: goMod, fields: goModFields }],
  csharp: [
    { name: /\.(?:csproj|fsproj|vbproj)$/, read: csproj, fields: msbuildFields },
    { name: /^Directory\.Build\.props$/, read: csproj, fields: msbuildFields },
    {
      name: /^Directory\.Packages\.props$/,
      read: (path, text) => [...csproj(path, text), ...packageVersions(path, text)],
      fields: msbuildFields,
    },
  ],
  java: MAVEN_GRADLE,
  kotlin: MAVEN_GRADLE,
  scala: none(
    "sbt builds are Scala code; a Scala project on Maven or Gradle is read by the Java row",
  ),
  ruby: [{ name: /^Gemfile$/, read: gemfile, fields: gemfileFields }],
  php: none("Packagist has no registry check yet (#1491)"),
  swift: none("Swift Package Manager manifests are Swift code, not read"),
  lua: none("LuaRocks has no registry check yet (#1495)"),
  elixir: none("Hex has no registry check yet"),
  dart: none("pub.dev has no registry check yet"),
  zig: none("Zig packages are URLs with hashes, not registry names"),
  c: none("C has no package registry"),
  cpp: none("Conan and vcpkg have no registry check yet"),
  bash: none("shell scripts have no package manifest"),
  ocaml: none("opam has no registry check yet"),
  objc: none("CocoaPods has no registry check yet"),
  solidity: none("Solidity libraries come from npm or git submodules, read by the npm row"),
};

const READERS: readonly ManifestReader[] = [
  ...new Set(
    SUPPORTED_LANGUAGES.flatMap((language) => rowOf(DEPENDENCY_MANIFESTS, language) ?? []),
  ),
];

const readerOf = (path: string): ManifestReader | undefined => {
  const name = base(path);
  return READERS.find((reader) => reader.name.test(name));
};

/** Whether a path is a manifest this module reads. */
export const isManifestPath = (path: string): boolean => readerOf(path) !== undefined;

export function manifestDependencies(path: string, text: string): Dependency[] {
  return readerOf(path)?.read(path, text) ?? [];
}

/** The executable fields of a manifest that differ between two versions of it (#1793). */
export function manifestFieldChanges(path: string, before: string, after: string): string[] {
  const reader = readerOf(path);
  return reader ? changedFields(reader.fields, before, after) : [];
}

const BUILTIN = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const JS_CODE = /\.(?:[cm]?[jt]sx?)$/;

/** The npm package a bare import specifier names, or null for relative, builtin and alias paths. */
export function packageOfSpecifier(specifier: string): string | null {
  if (/^(?:\.|\/|node:|bun:|npm:|jsr:|https?:|data:|virtual:|#|~|@\/)/.test(specifier)) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  if (!name || BUILTIN.has(name) || BUILTIN.has(specifier)) return null;
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) return null;
  return name;
}

/** Bare npm imports on the given lines (0-based) of a JS/TS file. */
export function importedPackages(path: string, text: string, lines: Set<number>): Dependency[] {
  if (!JS_CODE.test(path)) return [];
  const out: Dependency[] = [];
  text.split("\n").forEach((line, i) => {
    if (!lines.has(i)) return;
    for (const m of line.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g,
    )) {
      const name = packageOfSpecifier(m[1] ?? "");
      if (name) out.push({ ecosystem: "npm", name, file: path, line: i + 1 });
    }
  });
  return out;
}

/**
 * Dependencies declared in package manifests and bare imports of JS/TS code, for the
 * dependency check (#640). Parsing is line-based and tolerant: a manifest it cannot read
 * declares nothing, so a broken file is reported by the project's own checks, not here.
 */
import { builtinModules } from "node:module";

export type Ecosystem = "npm" | "pypi" | "crates" | "go" | "nuget" | "maven";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  /** The manifest or source file that declares or imports it. */
  file: string;
  line: number;
}

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Whether a path is a manifest this module reads. */
export function isManifestPath(path: string): boolean {
  const name = base(path);
  return (
    name === "package.json" ||
    name === "pyproject.toml" ||
    /^requirements[\w.-]*\.txt$/.test(name) ||
    name === "Cargo.toml" ||
    name === "go.mod" ||
    /\.(csproj|fsproj|vbproj)$/.test(name) ||
    name === "pom.xml"
  );
}

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

function pyprojectToml(path: string, text: string): Dependency[] {
  const out: Dependency[] = [];
  // PEP 621: dependencies = ["requests>=2", ...] and optional-dependencies tables.
  for (const match of text.matchAll(/^\s*(?:dependencies|[\w-]+)\s*=\s*\[([\s\S]*?)\]/gm)) {
    const table = tomlTables(text.slice(0, match.index ?? 0)).at(-1)?.header ?? "";
    if (table !== "project" && table !== "project.optional-dependencies") continue;
    for (const item of (match[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const name = pypiName(item[1] ?? "");
      if (name)
        out.push({
          ecosystem: "pypi",
          name,
          file: path,
          line: lineOf(text, (match.index ?? 0) + (item.index ?? 0)),
        });
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

/** The registry dependencies a manifest declares. */
export function manifestDependencies(path: string, text: string): Dependency[] {
  const name = base(path);
  if (name === "package.json") return packageJson(path, text);
  if (name === "pyproject.toml") return pyprojectToml(path, text);
  if (/^requirements[\w.-]*\.txt$/.test(name)) return requirementsTxt(path, text);
  if (name === "Cargo.toml") return cargoToml(path, text);
  if (name === "go.mod") return goMod(path, text);
  if (/\.(csproj|fsproj|vbproj)$/.test(name)) return csproj(path, text);
  if (name === "pom.xml") return pomXml(path, text);
  return [];
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

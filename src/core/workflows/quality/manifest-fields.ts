/**
 * The executable fields of each dependency manifest: the parts that run code, choose where code
 * comes from or what a build or install executes (`package.json` scripts, `[build-system]`,
 * `build = "build.rs"`, a `go.mod` replace, an MSBuild target, a Maven plugin, Gradle code). A
 * request that names a manifest for one edit exempts the write from a person (#1547), but the
 * approval sees a path, never content; the manifest field gate compares these fields before and
 * after the run and holds every change the request does not name (#1793).
 *
 * Each extractor maps a field label to its normalized text; a field that differs between the two
 * sides (added, removed or changed) is a change. Parsing is line-based and tolerant, like the
 * dependency readers: a file it cannot read has no fields, and the project's checks report it.
 */

export type FieldMap = Map<string, string>;

/** The text of each `[table]` and `[[array]]` of a TOML or INI file, by its header. */
function sections(text: string): FieldMap {
  const out: FieldMap = new Map();
  let header = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[#;].*$/, "").trimEnd();
    const table = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)?.[1];
    if (table) {
      header = table.trim();
      out.set(header, `${out.get(header) ?? ""}\n`);
    } else if (line.trim()) out.set(header, `${out.get(header) ?? ""}${line.trim()}\n`);
  }
  return out;
}

/** The value text of each `key = value` line of a section body, continuation lines included. */
function keys(body: string): FieldMap {
  const out: FieldMap = new Map();
  let key: string | null = null;
  for (const line of body.split("\n")) {
    const assignment = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (assignment?.[1]) {
      key = assignment[1];
      out.set(key, assignment[2] ?? "");
    } else if (key && line) out.set(key, `${out.get(key)}\n${line}`);
  }
  return out;
}

/** Whole sections whose header matches, and listed keys of named sections. */
function tomlFields(
  text: string,
  whole: RegExp,
  keyed: Record<string, readonly string[]> = {},
): FieldMap {
  const out: FieldMap = new Map();
  for (const [header, body] of sections(text)) {
    if (whole.test(header)) out.set(header, body);
    for (const key of keyed[header] ?? []) {
      const value = keys(body).get(key);
      if (value !== undefined) out.set(`${header}.${key}`, value);
    }
  }
  return out;
}

/** `package.json` fields that run code on install, test or import, or redirect packages. */
const PACKAGE_JSON_FIELDS = [
  "bin",
  "main",
  "module",
  "browser",
  "exports",
  "imports",
  "workspaces",
  "trustedDependencies",
  "overrides",
  "resolutions",
  "patchedDependencies",
  "packageManager",
] as const;

export function packageJsonFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  const scripts = parsed.scripts;
  if (scripts && typeof scripts === "object")
    for (const [name, command] of Object.entries(scripts as Record<string, unknown>))
      out.set(`scripts.${name}`, JSON.stringify(command));
  for (const field of PACKAGE_JSON_FIELDS)
    if (parsed[field] !== undefined) out.set(field, JSON.stringify(parsed[field]));
  return out;
}

/** The build backend, entry points, build hooks and package sources of `pyproject.toml`. */
export const pyprojectFields = (text: string): FieldMap =>
  tomlFields(
    text,
    /^(?:build-system|project\.(?:scripts|gui-scripts|entry-points(?:\..+)?)|tool\.(?:hatch\.build(?:\..+)?|setuptools(?:\..+)?|poetry\.(?:scripts|plugins|build|source)|pdm\.(?:scripts|build)|uv\.(?:index|sources)|maturin))$/,
  );

/** Install options and direct references of a requirements file (`-e`, `--index-url`, URLs). */
export function requirementsFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const option = /^(-[\w-]+)/.exec(line)?.[1];
    const key = option ?? (/:\/\/|\s@\s/.test(line) ? "direct reference" : null);
    if (key) out.set(key, `${out.get(key) ?? ""}${line}\n`);
  }
  return out;
}

/** Pipfile package sources and scripts. */
export const pipfileFields = (text: string): FieldMap => tomlFields(text, /^(?:source|scripts)$/);

/** setup.cfg entry points, command classes and build options. */
export const setupCfgFields = (text: string): FieldMap =>
  tomlFields(text, /^(?:options\.entry_points|build_ext|build_py|aliases)$/, {
    options: ["cmdclass", "scripts", "setup_requires"],
  });

/** Cargo build scripts, binaries, patches and native links. */
export const cargoFields = (text: string): FieldMap =>
  tomlFields(text, /^(?:bin|lib|patch(?:\..+)?|replace|target\..+)$/, {
    package: ["build", "links", "default-run"],
  });

/** `go.mod` replace directives and the toolchain line. */
export function goModFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  let block: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (line === ")") block = null;
      else if (line) out.set(`${block} ${line.split(/\s+/)[0]}`, line);
      continue;
    }
    const open = /^(replace|toolchain|godebug)\s*\($/.exec(line)?.[1];
    if (open) block = open;
    else {
      const directive = /^(replace|toolchain|godebug)\s+(\S+)/.exec(line);
      if (directive) out.set(`${directive[1]} ${directive[2]}`, line);
    }
  }
  return out;
}

/** Properties that run commands, chain or import targets, or redirect restore and tool paths. */
export const MSBUILD_ACTIVE_PROPERTY =
  /(?:Event|DependsOn|Targets?|Props|Command|Exe|ToolPath|Tasks?)$|^(?:Custom|MSBuild|Restore|NuGet)/i;

/** MSBuild targets, tasks, imports, the project SDK and properties that hook the build. */
export function msbuildFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  const sdk = /<Project\b[^>]*\bSdk\s*=\s*"([^"]*)"/.exec(xml)?.[1];
  if (sdk !== undefined) out.set("Project Sdk", sdk);
  for (const tag of ["Target", "UsingTask", "Import", "Sdk"]) {
    const elements = [
      ...xml.matchAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}\\s*>)`, "g")),
    ].map((m) => m[0].replace(/\s+/g, " "));
    if (elements.length) out.set(tag, elements.join("\n"));
  }
  for (const m of xml.matchAll(/<([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/\1\s*>/g))
    if (m[1] && MSBUILD_ACTIVE_PROPERTY.test(m[1])) out.set(m[1], (m[2] ?? "").trim());
  return out;
}

/** Maven plugins, extensions, repositories and profiles. */
export function pomFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  const xml = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["plugins", "extensions", "repositories", "pluginRepositories", "profiles"]) {
    const blocks = [...xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"))].map((m) =>
      m[0].replace(/\s+/g, " "),
    );
    if (blocks.length) out.set(tag, blocks.join("\n"));
  }
  return out;
}

/**
 * The top-level statements of a Gradle build script other than its dependencies, by their
 * leading name (`plugins`, `tasks.register`, `application`): the script is code, so every other
 * statement but a literal property can run something. Strings and comments are not parsed; braces and parentheses are
 * counted to find where a statement ends.
 */
const PLAIN_ASSIGNMENT = /^[\w.]+\s*=\s*(?:"[^"$\\]*"|'[^'$\\]*'|-?\d[\w.]*|true|false)$/;

export function gradleFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  let depth = 0;
  let statement = "";
  const flush = () => {
    const body = statement.trim();
    statement = "";
    if (!body) return;
    const name = /^[\w.]+/.exec(body)?.[0] ?? body.slice(0, 40);
    // A property set to a literal (`rootProject.name = "app"`, `version = "1.0"`) runs nothing.
    if (name === "dependencies" || PLAIN_ASSIGNMENT.test(body)) return;
    const key = out.has(name) ? `${name} ${body.replace(/\s+/g, " ").slice(0, 80)}` : name;
    out.set(key, body.replace(/\s+/g, " "));
  };
  for (const char of source) {
    if (char === "{" || char === "(") depth++;
    if (char === "}" || char === ")") depth = Math.max(0, depth - 1);
    if (char === "\n" && depth === 0) flush();
    else statement += char;
  }
  flush();
  return out;
}

/** A Gradle version catalog's plugins. */
export const versionCatalogFields = (text: string): FieldMap => tomlFields(text, /^plugins$/);

/**
 * Gemfile lines other than gem declarations and their groups: a Gemfile is Ruby code, so
 * `source`, `git`, `path`, `plugin`, `eval_gemfile` and any other statement can run something.
 */
export function gemfileFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#") || /^(?:gem|group|end|ruby)\b/.test(line)) continue;
    const name = /^[\w.]+/.exec(line)?.[0] ?? line;
    out.set(out.has(name) ? `${name} ${line}` : name, line);
  }
  return out;
}

/** The labels of the executable fields that differ between two versions of a manifest. */
export function changedFields(
  read: (text: string) => FieldMap,
  before: string,
  after: string,
): string[] {
  const old = read(before);
  const now = read(after);
  return [...new Set([...old.keys(), ...now.keys()])].filter(
    (key) => old.get(key) !== now.get(key),
  );
}

/**
 * Whether a request or spec names a field: the field's label, or its last segment (`engines`,
 * `postinstall` of `scripts.postinstall`, the module of a `go.mod` replace), as a whole word.
 */
export function namesField(text: string, label: string): boolean {
  const lower = text.toLowerCase();
  const segments = [label, label.split(/[.\s]/).at(-1) ?? label].map((s) => s.toLowerCase());
  return segments.some(
    (segment) =>
      segment.length > 1 &&
      new RegExp(`(?:^|[^\\w-])${segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(
        lower,
      ),
  );
}

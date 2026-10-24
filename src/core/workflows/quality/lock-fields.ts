/**
 * The entries of a lock file other than the project's own (#1934). A request that names a version
 * bump of the project and the one lock line that follows it exempts the lock from a person under
 * `autoApproval.requestedManifestEdits`; the manifest field check then holds every other entry of
 * the lock to what it was. The project's own entries (the root of `package-lock.json`, the path
 * packages of `Cargo.lock` and `Gemfile.lock`, the editable or virtual package of `uv.lock`) are
 * left out: they follow the manifest edit. Anything else a lock changes (a dependency's version,
 * source or checksum, the lockfile format) is a change, whatever the request names: a lock that a
 * dependency change rewrites stays with a person.
 */
import type { FieldMap } from "./manifest-fields.js";

/** `[[package]]` blocks of a TOML lock (with their `[package.*]` subtables) and the rest. */
function tomlPackages(text: string): { blocks: string[]; rest: string } {
  const blocks: string[] = [];
  let rest = "";
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line)?.[1]?.trim();
    if (header === "package" && line.trimStart().startsWith("[[")) {
      if (current !== null) blocks.push(current);
      current = "";
      continue;
    }
    if (header !== undefined && !header.startsWith("package.")) {
      if (current !== null) blocks.push(current);
      current = null;
    }
    if (current !== null) current += `${line.trim()}\n`;
    else rest += `${line.trim()}\n`;
  }
  if (current !== null) blocks.push(current);
  return { blocks, rest };
}

const tomlValue = (block: string, key: string): string | undefined =>
  new RegExp(`^${key}\\s*=\\s*(.*)$`, "m").exec(block)?.[1]?.trim();

function tomlLockFields(text: string, own: (block: string) => boolean): FieldMap {
  const out: FieldMap = new Map();
  const { blocks, rest } = tomlPackages(text);
  if (rest.trim()) out.set("lockfile", rest);
  for (const block of blocks) {
    if (own(block)) continue;
    const name = tomlValue(block, "name")?.replace(/^"|"$/g, "") ?? "?";
    const version = tomlValue(block, "version")?.replace(/^"|"$/g, "") ?? "";
    out.set(`package ${name} ${version}`.trim(), block);
  }
  return out;
}

/** `Cargo.lock`: a package without a `source` is a path package of the workspace. */
export const cargoLockFields = (text: string): FieldMap =>
  tomlLockFields(text, (block) => tomlValue(block, "source") === undefined);

/** `uv.lock`: the project is the package whose source is `editable` or `virtual`. */
export const uvLockFields = (text: string): FieldMap =>
  tomlLockFields(text, (block) =>
    /^\{\s*(?:editable|virtual)\s*=/.test(tomlValue(block, "source") ?? ""),
  );

/** `package-lock.json`: the root and the workspace packages (no `node_modules` in the key) are own. */
export function packageLockFields(text: string): FieldMap {
  const out: FieldMap = new Map();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") return out;
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "name" || key === "version") continue;
    if (key === "packages" && value && typeof value === "object") {
      for (const [path, entry] of Object.entries(value as Record<string, unknown>))
        if (path.includes("node_modules/")) out.set(`package ${path}`, JSON.stringify(entry));
    } else if (key === "dependencies" && value && typeof value === "object") {
      for (const [name, entry] of Object.entries(value as Record<string, unknown>))
        out.set(`dependency ${name}`, JSON.stringify(entry));
    } else out.set(key, JSON.stringify(value));
  }
  return out;
}

/**
 * `Gemfile.lock`: the specs of a `PATH` section with `remote: .` are the project's own gems, also
 * left out of `DEPENDENCIES` and `CHECKSUMS`. Every other spec, dependency, checksum and section
 * line is a field.
 */
export function gemfileLockFields(text: string): FieldMap {
  const lines = text.split(/\r?\n/);
  const own = new Set<string>();
  let section = "";
  let remote = "";
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.trim();
      remote = "";
    } else if (/^ {2}remote:/.test(line)) remote = line.split(":").slice(1).join(":").trim();
    else if (section === "PATH" && remote === "." && /^ {4}\S/.test(line))
      own.add(line.trim().split(/\s+/)[0] ?? "");
  }
  const out: FieldMap = new Map();
  section = "";
  let spec = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^\S/.test(line)) {
      section = line.trim();
      spec = "";
      continue;
    }
    const name = (line.trim().split(/\s+/)[0] ?? "").replace(/!$/, "");
    if (["GEM", "GIT", "PATH"].includes(section) && /^ {4}\S/.test(line)) {
      spec = own.has(name) ? "" : `${section} ${name}`;
      if (spec) out.set(spec, line.trim());
    } else if (["GEM", "GIT", "PATH"].includes(section) && /^ {6}\S/.test(line)) {
      if (spec) out.set(spec, `${out.get(spec)}\n${line.trim()}`);
    } else if (["DEPENDENCIES", "CHECKSUMS"].includes(section) && /^ {2}\S/.test(line)) {
      if (!own.has(name)) out.set(`${section} ${name}`, line.trim());
    } else {
      const key = section;
      out.set(key, `${out.get(key) ?? ""}${line.trim()}\n`);
    }
  }
  return out;
}

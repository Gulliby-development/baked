import { type LanguageRecord, none, rowOf } from "../../intelligence/language-records.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";
import { HOST_CONTENT_MAX_CHARS } from "../schemas.js";
import type { InitiativePlan } from "./plan.js";

/**
 * Skeleton content laid out as a fixed point of the project's formatter (#2222). The decomposer
 * writes a skeleton's registration file in the order the request gives (a brief's layer order of
 * `pub mod` lines), and every later check holds the file to that content up to whitespace
 * (`layoutFree`). A formatter that sorts consecutive declarations (rustfmt's `reorder_modules` and
 * `reorder_imports`, gofmt's import blocks) rewrites the order, so the required format check's
 * fixer turned the content into one the spec's exact-content criterion refuses (evalpin, R70: three
 * review rounds and a converge finding). These formatters sort only within a group of consecutive
 * declarations, so a blank line before each entry that would move keeps the order as written:
 * the change is whitespace only, so the spec, the plan and the review still see the same content.
 * Formatters that sort across blank lines (ruff's and isort's import sorting, Biome's
 * organizeImports, clang-format's include sorting) keep an order only at the tool's own split
 * marker, so in a project whose configuration turns that sorting on, every entry of such a list
 * after the first gets the marker before it (#2233). That adds a comment line, which the spec
 * author and reviewers see in the skeleton like any other host content.
 */
export interface SortedLists {
  /** The formatter whose default sorts these lists, for the record of what was laid out. */
  formatter: string;
  /** The entry a line starts, with the kind of list it belongs to and the key it sorts by. */
  entry: (line: string) => { kind: string; key: string } | null;
  /** Whether an entry whose lines so far are `text` goes on to the next line (a `use` over lines). */
  continues?: (text: string) => boolean;
  /** Lines that belong to the entry below them (attributes, doc comments). */
  attached?: RegExp;
  /** The lines a list may stand between; absent: anywhere in the file. */
  block?: { open: RegExp; close: RegExp };
  /**
   * The lines put before an entry instead of a blank line, for a formatter that sorts across
   * blank lines and keeps an order only at a split marker. Every entry of a list after the first
   * gets them, since sections and categories (stdlib before third-party, `<...>` before `"..."`)
   * can move entries whose names are in order.
   */
  separator?: readonly string[];
  /**
   * Whether the project's configuration turns the sorting on, read through its files by path
   * relative to the root; absent: the formatter's default sorts.
   */
  sorts?: (read: (name: string) => string | null) => boolean;
  /**
   * A file with a list in an order the formatter would change, for the language parity test, and
   * the project files that turn the sorting on.
   */
  sample: { path: string; content: string; config?: Readonly<Record<string, string>> };
}

const VISIBILITY = String.raw`(?:pub(?:\s*\([^)]*\))?\s+)?`;
const RUST_MOD = new RegExp(String.raw`^\s*${VISIBILITY}mod\s+(?:r#)?([A-Za-z_][A-Za-z0-9_]*)\s*;`);
const RUST_USE = new RegExp(String.raw`^\s*${VISIBILITY}use\s+(?:::)?([^;]+?)\s*;?\s*$`);
const RUST_CRATE = new RegExp(
  String.raw`^\s*${VISIBILITY}extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)`,
);
const GO_IMPORT = /^\s*(?:[A-Za-z_.][A-Za-z0-9_]*\s+)?"([^"]+)"/;

const rust: SortedLists = {
  formatter: "rustfmt",
  // rustfmt sorts consecutive `mod x;` lines (reorder_modules), and `use` and `extern crate` lines
  // (reorder_imports), each kind apart; a blank line or a plain comment ends the group.
  entry: (line) => {
    const mod = RUST_MOD.exec(line);
    if (mod?.[1]) return { kind: "mod", key: mod[1] };
    const crate = RUST_CRATE.exec(line);
    if (crate?.[1]) return { kind: "extern crate", key: crate[1] };
    const use = RUST_USE.exec(line);
    if (use?.[1]) return { kind: "use", key: use[1] };
    return null;
  },
  continues: (text) => /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?use\b/.test(text) && !text.includes(";"),
  attached: /^\s*(?:#\[|\/\/\/)/,
  sample: { path: "src/lib.rs", content: "pub mod text;\npub mod io;\n" },
};

const go: SortedLists = {
  formatter: "gofmt",
  // gofmt sorts the specs of a parenthesized import block between blank lines; a comment goes
  // with the spec below it.
  entry: (line) => {
    const spec = GO_IMPORT.exec(line);
    return spec?.[1] ? { kind: "import", key: spec[1] } : null;
  },
  attached: /^\s*\/\//,
  block: { open: /^\s*import\s*\(\s*$/, close: /^\s*\)/ },
  sample: { path: "main.go", content: 'package main\n\nimport (\n\t"strings"\n\t"fmt"\n)\n' },
};

/** The marker comment Biome and clang-format end a sorted chunk at, set apart by blank lines. */
const ORDER_AS_WRITTEN = ["", "// order as written", ""];

/** Ruff's selected rules (`select`, `extend-select`) include its isort rules. */
const RUFF_ISORT = /\b(?:extend-)?select\s*=\s*\[[^\]]*"(?:I|I0|I00|I001|ALL)"/;

const python: SortedLists = {
  formatter: "ruff/isort",
  // isort and ruff's I001 sort the top-level imports of a block across blank lines and comments,
  // by section first; only `# isort: split` ends a block (ruff puts a blank line before it).
  entry: (line) => {
    const found = /^(?:from\s+(\S+)\s+import\b|import\s+(\S+))/.exec(line);
    const key = found?.[1] ?? found?.[2];
    return key ? { kind: "import", key } : null;
  },
  continues: (text) => (text.includes("(") && !text.includes(")")) || /\\\s*$/.test(text),
  attached: /^#(?!\s*isort:\s*split\b)/,
  separator: ["", "# isort: split"],
  sorts: (read) =>
    RUFF_ISORT.test(
      `${read("pyproject.toml") ?? ""}\n${read("ruff.toml") ?? ""}\n${read(".ruff.toml") ?? ""}`,
    ) ||
    /^\s*\[tool\.isort\]/m.test(read("pyproject.toml") ?? "") ||
    read(".isort.cfg") !== null ||
    /^\s*\[(?:tool:)?isort\]/m.test(`${read("setup.cfg") ?? ""}\n${read("tox.ini") ?? ""}`),
  sample: {
    path: "src/pkg/__init__.py",
    content: "from .text import *\nfrom .io import *\n",
    config: { "pyproject.toml": '[tool.ruff.lint]\nselect = ["E", "I"]\n' },
  },
};

const script: SortedLists = {
  formatter: "biome organizeImports",
  // Biome's organizeImports sorts imports and `export ... from` lines across blank lines; a
  // detached comment ends the chunk. The gates run `biome format`, which keeps the order, so only a
  // project whose scripts run `biome check` or `biome ci` sorts.
  entry: (line) =>
    /^(?:import|export)\s+(?:type\s+)?(?:[\w$*{]|\{)/.test(line) &&
    !/^export\s+(?:type\s+)?\{[^}]*\}\s*;?\s*$/.test(line) &&
    (/\bfrom\s*["']/.test(line) || /^(?:import|export)\s+(?:type\s+)?\{[^}]*$/.test(line))
      ? { kind: "module", key: /\bfrom\s*["']([^"']+)/.exec(line)?.[1] ?? "" }
      : null,
  // A brace list over lines goes on to its `from`, or ends at its closing brace (a local export).
  continues: (text) => !/\bfrom\s*["']/.test(text) && !text.includes("}"),
  separator: ORDER_AS_WRITTEN,
  sorts: (read) => {
    const config = read("biome.json") ?? read("biome.jsonc");
    if (config === null) return false;
    if (/"organizeImports"\s*:\s*(?:"off"|\{\s*"enabled"\s*:\s*false)/.test(config)) return false;
    return /\bbiome\s+(?:check|ci)\b/.test(read("package.json") ?? "");
  },
  sample: {
    path: "src/index.ts",
    content: 'export * from "./text";\nexport * from "./io";\n',
    config: {
      "biome.json": "{}\n",
      "package.json": '{ "scripts": { "lint": "biome check ." } }\n',
    },
  },
};

/** clang-format sorts includes when the project has a config that does not turn SortIncludes off. */
const clangSorts = (read: (name: string) => string | null): boolean => {
  const config = read(".clang-format") ?? read("_clang-format");
  return config !== null && !/^\s*SortIncludes:\s*(?:false|Never)\b/m.test(config);
};
const clang = (path: string, header: (name: string) => string): SortedLists => ({
  formatter: "clang-format",
  // SortIncludes sorts a block of `#include` lines; with IncludeBlocks: Regroup (Google style) it
  // merges blocks across blank lines, but any other line, a comment included, ends a block.
  entry: (line) => {
    const found = /^\s*#\s*(?:include|import)\s*([<"][^>"]+[>"])/.exec(line);
    return found?.[1] ? { kind: "include", key: found[1] } : null;
  },
  separator: ORDER_AS_WRITTEN,
  sorts: clangSorts,
  sample: {
    path,
    content: `${header("text")}\n${header("io")}\n`,
    config: { ".clang-format": "BasedOnStyle: Google\n" },
  },
});

const keeps = (formatter: string) => none(`${formatter} keeps the order of lines as written`);
const across = (reason: string) =>
  none(`${reason} across blank lines, with no split marker known to keep an order (#2233)`);

/**
 * The lists each language's formatter sorts. Formatters that sort within groups of consecutive
 * lines get a blank line before each entry they would move; those that sort across blank lines
 * get their split marker (`separator`) when the project turns the sorting on (`sorts`). A
 * language whose formatter sorts across blank lines without a marker that keeps an order is a
 * `none` row that names it; a language whose formatter keeps the order needs none.
 */
export const SORTED_LISTS: LanguageRecord<SortedLists> = {
  rust,
  go,
  typescript: script,
  javascript: { ...script, sample: { ...script.sample, path: "src/index.js" } },
  vue: keeps("Prettier"),
  svelte: keeps("Prettier"),
  python,
  java: across("google-java-format sorts imports"),
  kotlin: across("ktlint's import-ordering rule sorts imports"),
  scala: keeps("scalafmt without the opt-in import rewrites"),
  csharp: across("`dotnet format` sorts using directives"),
  c: clang("src/sum.c", (name) => `#include "${name}.h"`),
  cpp: clang("src/sum.cpp", (name) => `#include "${name}.hpp"`),
  objc: clang("Sources/Sum.m", (name) => `#import "${name}.h"`),
  swift: across("swift-format's OrderedImports rule sorts imports"),
  php: across("php-cs-fixer's and Pint's ordered_imports sort use statements"),
  ruby: keeps("RuboCop's layout cops"),
  lua: keeps("StyLua"),
  elixir: keeps("`mix format`"),
  dart: keeps("`dart format`"),
  zig: keeps("`zig fmt`"),
  bash: keeps("shfmt"),
  ocaml: keeps("ocamlformat"),
  rescript: keeps("`rescript format`"),
  solidity: keeps("`forge fmt` without its opt-in sort_imports"),
  sql: keeps("sqlfluff"),
  powershell: keeps("PSScriptAnalyzer's formatter"),
  r: keeps("styler"),
};

/** `a` strictly before `b` in every order a formatter may sort by: bytes, case-folded, natural. */
function ascending(a: string, b: string): boolean {
  return a < b && a.toLowerCase() < b.toLowerCase() && natural(a, b) < 0;
}

function natural(a: string, b: string): number {
  const parts = (s: string) => s.match(/\d+|\D+/g) ?? [];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? "", y[i] ?? ""];
    if (p === q) continue;
    if (/^\d/.test(p) && /^\d/.test(q) && Number(p) !== Number(q)) return Number(p) - Number(q);
    return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

/** A file's content with a blank line (or a split marker) before each entry its formatter would move. */
export interface LaidOut {
  content: string;
  /** The 1-based lines of the original content a blank line or a split marker now stands before. */
  lines: number[];
  formatter: string;
  /** The split marker put before those lines; absent: a blank line. */
  marker?: string;
}

/**
 * The content laid out so the language's formatter keeps the order of every sorted list as
 * written, or null when the formatter would move nothing (or the language has no row). `read`
 * gives the project's files by relative path, for a formatter that sorts only when configured to;
 * without it such a formatter counts as not sorting.
 */
export function layOutForFormatter(
  path: string,
  content: string,
  read?: (name: string) => string | null,
): LaidOut | null {
  const row = rowOf(SORTED_LISTS, detectLanguageFromPath(path));
  if (!row) return null;
  if (row.sorts && !(read && row.sorts(read))) return null;
  const marker = row.separator?.find((line) => line.trim());
  const eol = content.includes("\r\n") ? "\r" : "";
  const source = content.split("\n");
  const out: string[] = [];
  const lines: number[] = [];
  let inside = !row.block;
  let previous: { kind: string; key: string } | null = null;
  let held: string[] = [];
  let heldFrom = 0;
  for (let i = 0; i < source.length; i++) {
    const line = source[i] ?? "";
    if (row.block && !inside) {
      out.push(line);
      inside = row.block.open.test(line);
      continue;
    }
    if (row.block?.close.test(line)) {
      out.push(...held, line);
      [held, previous, inside] = [[], null, false];
      continue;
    }
    // A split marker already in the file ends the list, like any other line.
    if (row.attached?.test(line) && line.trim() !== marker) {
      if (!held.length) heldFrom = i;
      held.push(line);
      continue;
    }
    const entry = row.entry(line);
    if (!entry) {
      out.push(...held, line);
      [held, previous] = [[], null];
      continue;
    }
    const start = held.length ? heldFrom : i;
    const unit = [...held, line];
    let text = line;
    while (row.continues?.(text) && i + 1 < source.length) {
      unit.push(source[++i] ?? "");
      text += `\n${source[i]}`;
    }
    if (
      previous &&
      previous.kind === entry.kind &&
      (row.separator || !ascending(previous.key, entry.key))
    ) {
      out.push(...(row.separator ?? [""]).map((separator) => `${separator}${eol}`));
      lines.push(start + 1);
    }
    out.push(...unit);
    [held, previous] = [[], entry];
  }
  out.push(...held);
  if (!lines.length) return null;
  return {
    content: out.join("\n"),
    lines,
    formatter: row.formatter,
    ...(marker ? { marker } : {}),
  };
}

/** A skeleton file the layout changes, for the record of the split. */
export interface SkeletonLayout {
  featureId: string;
  path: string;
  formatter: string;
  lines: number[];
  marker?: string;
}

/**
 * The split with every skeleton file laid out for its formatter, and the files that changed. A
 * file the layout would take past the host content limit keeps its content. `read` gives the
 * project's files, for the formatters that sort only when the project configures them to.
 */
export function layOutSkeletons(
  plan: InitiativePlan,
  read?: (name: string) => string | null,
): {
  plan: InitiativePlan;
  files: SkeletonLayout[];
} {
  const files: SkeletonLayout[] = [];
  const features = plan.features.map((feature) => {
    if (!feature.skeleton?.length) return feature;
    const skeleton = feature.skeleton.map((file) => {
      const laid = layOutForFormatter(file.path, file.content, read);
      if (!laid || laid.content.length > HOST_CONTENT_MAX_CHARS) return file;
      files.push({
        featureId: feature.id,
        path: file.path,
        formatter: laid.formatter,
        lines: laid.lines,
        ...(laid.marker ? { marker: laid.marker } : {}),
      });
      return { ...file, content: laid.content };
    });
    return { ...feature, skeleton };
  });
  return { plan: files.length ? { ...plan, features } : plan, files };
}

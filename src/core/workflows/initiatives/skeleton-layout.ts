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
  /** A file with a list in an order the formatter would change, for the language parity test. */
  sample: { path: string; content: string };
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

const keeps = (formatter: string) => none(`${formatter} keeps the order of lines as written`);
const across = (reason: string) =>
  none(`${reason} across blank lines, so no whitespace layout keeps an order (#2233)`);

/**
 * The lists each language's default formatter sorts within groups of consecutive lines. A language
 * whose formatter sorts across blank lines has no layout that keeps the order and is a `none` row
 * that says so; a language whose formatter keeps the order needs none.
 */
export const SORTED_LISTS: LanguageRecord<SortedLists> = {
  rust,
  go,
  typescript: none(
    "Prettier and `biome format`, the formatters the gates run, keep import and export order (#2233 for Biome's organizeImports)",
  ),
  javascript: none(
    "Prettier and `biome format`, the formatters the gates run, keep import and export order (#2233 for Biome's organizeImports)",
  ),
  vue: keeps("Prettier"),
  svelte: keeps("Prettier"),
  python: none(
    "`ruff format` keeps import order; isort and ruff's opt-in I001 sort across blank lines (#2233)",
  ),
  java: across("google-java-format sorts imports"),
  kotlin: across("ktlint's import-ordering rule sorts imports"),
  scala: keeps("scalafmt without the opt-in import rewrites"),
  csharp: across("`dotnet format` sorts using directives"),
  c: across("clang-format's SortIncludes may regroup includes (IncludeBlocks: Regroup)"),
  cpp: across("clang-format's SortIncludes may regroup includes (IncludeBlocks: Regroup)"),
  objc: across("clang-format's SortIncludes may regroup imports (IncludeBlocks: Regroup)"),
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

/** A file's content with a blank line before each entry its formatter would move. */
export interface LaidOut {
  content: string;
  /** The 1-based lines of the original content a blank line now stands before. */
  lines: number[];
  formatter: string;
}

/**
 * The content laid out so the language's formatter keeps the order of every sorted list as
 * written, or null when the formatter would move nothing (or the language has no row).
 */
export function layOutForFormatter(path: string, content: string): LaidOut | null {
  const row = rowOf(SORTED_LISTS, detectLanguageFromPath(path));
  if (!row) return null;
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
    if (row.attached?.test(line)) {
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
    if (previous && previous.kind === entry.kind && !ascending(previous.key, entry.key)) {
      out.push(eol);
      lines.push(start + 1);
    }
    out.push(...unit);
    [held, previous] = [[], entry];
  }
  out.push(...held);
  return lines.length ? { content: out.join("\n"), lines, formatter: row.formatter } : null;
}

/** A skeleton file the layout changes, for the record of the split. */
export interface SkeletonLayout {
  featureId: string;
  path: string;
  formatter: string;
  lines: number[];
}

/**
 * The split with every skeleton file laid out for its formatter, and the files that changed. A
 * file the layout would take past the host content limit keeps its content.
 */
export function layOutSkeletons(plan: InitiativePlan): {
  plan: InitiativePlan;
  files: SkeletonLayout[];
} {
  const files: SkeletonLayout[] = [];
  const features = plan.features.map((feature) => {
    if (!feature.skeleton?.length) return feature;
    const skeleton = feature.skeleton.map((file) => {
      const laid = layOutForFormatter(file.path, file.content);
      if (!laid || laid.content.length > HOST_CONTENT_MAX_CHARS) return file;
      files.push({
        featureId: feature.id,
        path: file.path,
        formatter: laid.formatter,
        lines: laid.lines,
      });
      return { ...file, content: laid.content };
    });
    return { ...feature, skeleton };
  });
  return { plan: files.length ? { ...plan, features } : plan, files };
}

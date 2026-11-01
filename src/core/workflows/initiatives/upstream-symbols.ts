import { basename, dirname } from "node:path";
import {
  isSupportedLanguage,
  type LanguageRecord,
  none,
  rowOf,
  type SupportedLanguage,
} from "../../intelligence/language-records.js";
import { isTestFile } from "../../intelligence/language-traits.js";
import { detectLanguageFromPath } from "../../intelligence/types.js";
import type { Spec } from "../schemas.js";
import type { InitiativePlan } from "./plan.js";

/**
 * Wording that makes a clause depend on a later need: "if encoding needs ...", "any needed ...",
 * "as needed", "if required" (#2135).
 */
const CONDITIONAL =
  /\b(?:if\b[^.;]*\b(?:needs?|needed|requires?|required|necessary)\b|any needed\b|as needed\b|when needed\b|if (?:necessary|required)\b)/i;
/** A sentence of a contract: it ends at `.`, `;` or `!` before a space, or at a line break. */
const SENTENCES = /[^.;!\n]+(?:[.;!](?=\s|$)|$)/g;

/** A glob in a boundary (`src/**`) names no one file. plan.ts imports this module, so it is not imported back. */
const isGlob = (path: string) => /[*?[\]{}]/.test(path);

/** The names a feature is known by in another feature's text: its id and its files' stems. */
function featureNames(feature: InitiativePlan["features"][number]): string[] {
  const stems = feature.boundary.paths
    .filter((path) => !isGlob(path))
    .map((path) => basename(path).replace(/\.[^.]+$/, ""));
  return [feature.id, ...stems].filter((name) => name.length >= 3);
}

const wordIn = (text: string, word: string) =>
  new RegExp(
    `(?<![A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_])`,
    "i",
  ).test(text);

/**
 * Contract clauses that make another feature's work conditional on a need nobody decides (#2135).
 * R68 ewvet: reader's contract said "If encoding needs auxiliary syntax classification, keep it in
 * a public Reader helper ... exposed through Scan", scanner's "Expose any needed Reader-backed
 * encoding token classification through Scan". reader found no need and shipped no helper;
 * scanner, planned ahead, made the helper a `must` and spent 4.5M tokens on a symbol upstream did
 * not have. Each problem names the change the decomposer can make.
 */
export function conditionalContractProblems(plan: InitiativePlan): string[] {
  const problems: string[] = [];
  for (const feature of plan.features) {
    const others = plan.features.filter((other) => other.id !== feature.id);
    for (const match of feature.contract.matchAll(SENTENCES)) {
      const sentence = match[0].trim();
      if (!CONDITIONAL.test(sentence)) continue;
      const named = others.filter((other) =>
        featureNames(other).some((name) => wordIn(sentence, name)),
      );
      if (!named.length) continue;
      problems.push(
        `${feature.id}'s contract makes work across features conditional ("${sentence}", naming ${named.map((other) => other.id).join(", ")}): no feature decides whether it is needed. State it as a requirement of the one feature that owns it, with the symbol and when it is required, or remove the clause.`,
      );
    }
  }
  return problems;
}

/**
 * The files whose accepted text holds a released feature's upstream symbols: the paths its
 * dependencies list that no other feature lists, each with the dependency planned last that lists
 * it. A path the released feature, a feature planned after it or any other non-dependency also
 * lists is that feature's code, whoever owns its stub: R69 ewvet's base folded the skeleton, so its boundary listed all 27 stub files, and 6 of 7
 * released features recorded a would-stop for the members they write themselves (`Base64.Decode`
 * of bytes, #2192).
 */
export function upstreamFiles(
  plan: InitiativePlan,
  feature: InitiativePlan["features"][number],
): { featureId: string; path: string }[] {
  const upstream = plan.features.filter((f) => feature.dependsOn.includes(f.id));
  const elsewhere = new Set(
    plan.features.filter((f) => !feature.dependsOn.includes(f.id)).flatMap((f) => f.boundary.paths),
  );
  // A path several dependencies list (a stub and its filler) belongs to the one planned last, the
  // filler, so a gap names the feature that wrote the member.
  const owners = new Map<string, string>();
  for (const f of upstream)
    for (const path of f.boundary.paths)
      if (!isGlob(path) && !elsewhere.has(path)) owners.set(path, f.id);
  return [...owners].map(([path, featureId]) => ({ featureId, path }));
}

/** A symbol of an upstream feature that a downstream spec names and the accepted code lacks. */
export interface UpstreamSymbolGap {
  /** The requirement or criterion that names it. */
  ref: string;
  /** `Reader.IsEncodingToken`, or the helper phrase when the spec names no member. */
  symbol: string;
  featureId: string;
  path: string;
}

/**
 * One way a language writes a member of a type, module or package in prose. `pattern` is a regular
 * expression source whose `type` and `member` groups name them; `example` is a sentence it reads,
 * for the language parity test.
 */
export interface MemberSpelling {
  readonly pattern: string;
  readonly example: string;
}

const spelling = (pattern: string, example: string): MemberSpelling => ({ pattern, example });
const NAME = "[A-Za-z_][A-Za-z0-9_]*";
/** `Reader.IsEncodingToken`: an uppercase type, module or class, read in every language. */
const DOTTED = spelling(
  String.raw`\b(?<type>[A-Z][A-Za-z0-9_]*)(?<sep>\.)(?<member>${NAME})\b`,
  "Scanner delegates to Reader.IsEncodingToken.",
);
/** `Reader::new`, `reader::read`, `Reader::class`. */
const PATH = spelling(
  String.raw`\b(?<type>${NAME})(?<sep>::)(?<member>${NAME})\b`,
  "Scanner calls Reader::is_encoding_token.",
);
/** `Reader#read`, as API docs write an instance method. */
const HASH = spelling(
  String.raw`\b(?<type>[A-Z][A-Za-z0-9_]*)(?<sep>#)(?<member>[A-Za-z_][A-Za-z0-9_]*[?!]?)`,
  "Scanner calls Reader#isEncodingToken per token.",
);
/** `reader.read(...)` or `` `reader.read` ``: a lowercase module's function, called or quoted. */
const MODULE_CALL = spelling(
  String.raw`\b(?<type>[a-z_][a-z0-9_]*)(?<sep>\.)(?<member>${NAME})(?=\(|\x60)`,
  "Scanner calls `reader.is_encoding_token` per token.",
);

/**
 * How each language writes a member in prose (#2199): the upstream-symbol check reads the
 * spellings of the languages of the upstream files, besides `Type.Member`, which every language's
 * prose uses. A language without a qualified name for a member is a `none` row.
 */
export const MEMBER_SYNTAX: LanguageRecord<readonly MemberSpelling[]> = {
  typescript: [DOTTED, HASH],
  javascript: [DOTTED, HASH],
  vue: [DOTTED, HASH],
  svelte: [DOTTED, HASH],
  python: [DOTTED, MODULE_CALL],
  // An exported Go name is capitalized, so `lines.Line` is a package member however it is quoted.
  go: [
    DOTTED,
    spelling(
      String.raw`\b(?<type>[a-z][a-z0-9_]*)(?<sep>\.)(?<member>[A-Z][A-Za-z0-9_]*)\b`,
      "Scanner calls reader.IsEncodingToken for each token.",
    ),
  ],
  rust: [PATH, DOTTED],
  java: [DOTTED, { ...PATH, example: "Scanner passes Reader::isEncodingToken as the filter." }],
  kotlin: [DOTTED, { ...PATH, example: "Scanner passes Reader::isEncodingToken as the filter." }],
  scala: [DOTTED, HASH],
  csharp: [DOTTED],
  c: none("C has no qualified member names: a header's functions carry a prefix (`reader_read`)"),
  cpp: [PATH, DOTTED],
  ruby: [
    DOTTED,
    { ...HASH, example: "Scanner calls Reader#encoding_token? per token." },
    { ...PATH, example: "Scanner reads Reader::ENCODINGS." },
  ],
  php: [PATH],
  swift: [DOTTED],
  lua: [
    DOTTED,
    MODULE_CALL,
    // A method call: `reader:read(...)`.
    spelling(
      String.raw`\b(?<type>${NAME})(?<sep>:)(?<member>${NAME})(?=\()`,
      "Scanner calls reader:is_encoding_token(token).",
    ),
  ],
  elixir: [DOTTED],
  dart: [DOTTED],
  zig: [DOTTED, MODULE_CALL],
  bash: none("shell functions have no member syntax"),
  ocaml: [DOTTED],
  objc: [
    DOTTED,
    spelling(
      String.raw`(?<sep>[-+]?\[)(?<type>[A-Z][A-Za-z0-9_]*)\s+(?<member>[a-z_][A-Za-z0-9_]*)`,
      "Scanner sends [Reader isEncodingToken:] for each token.",
    ),
  ],
  rescript: [DOTTED],
  solidity: [DOTTED],
  sql: none("SQL objects are qualified by schema or table, not by a file's type"),
  powershell: [
    spelling(
      String.raw`\[(?:[A-Za-z_][\w.]*\.)?(?<type>${NAME})\](?<sep>::)(?<member>${NAME})`,
      "Scanner calls [Reader]::IsEncodingToken for each token.",
    ),
    DOTTED,
  ],
  // `reader::read` for a package's function, `Reader$read` for an R6 method.
  r: [
    PATH,
    spelling(
      String.raw`\b(?<type>[A-Z][A-Za-z0-9_]*)(?<sep>\$)(?<member>${NAME})`,
      "Scanner calls Reader$is_encoding_token for each token.",
    ),
  ],
};

/** The spellings read for upstream files of `languages`, `Type.Member` always, each once. */
function memberPatterns(languages: Iterable<string>): RegExp[] {
  const sources = new Set([DOTTED.pattern]);
  for (const language of languages)
    for (const { pattern } of rowOf(MEMBER_SYNTAX, language) ?? []) sources.add(pattern);
  // A lookahead finds overlapping names, so `crate::reader::read` gives `reader::read` too.
  return [...sources].map((source) => new RegExp(`(?=${source})`, "g"));
}

/** A .NET or MSBuild project file: its stem is the project's root namespace, not a type. */
const PROJECT_EXTENSIONS = ["csproj", "fsproj", "vbproj", "sln", "slnx", "props", "targets"];
const isProjectFile = (path: string) =>
  PROJECT_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(`.${extension}`));

/**
 * The extensions of files that are not a type's members: data, config and source files
 * (`config.yaml`, `` `reader.py` ``), and binaries, archives, packages and project files
 * (`Maskback.dll`, `Maskback.csproj`, R75 maskback, #2365). One list: a new kind of file joins it.
 */
const FILE_EXTENSIONS = [
  ...["json", "jsonc", "yaml", "yml", "toml", "txt", "md", "csv", "tsv", "ini", "cfg", "conf"],
  ...["xml", "html", "htm", "lock", "log", "env", "sh", "ps1"],
  ...["py", "pyi", "go", "rs", "ts", "tsx", "js", "jsx", "mjs", "rb", "php", "lua", "zig", "sql"],
  ...["r", "java", "kt", "kts", "scala", "cs", "fs", "fsi", "fsx", "vb", "swift", "dart", "ex"],
  ...["exs", "ml", "res", "sol", "vue", "svelte", "c", "h", "cc", "cpp", "hpp", "m"],
  ...["dll", "exe", "so", "dylib", "a", "o", "lib", "bin", "jar", "war", "whl", "gem", "nupkg"],
  ...PROJECT_EXTENSIONS,
];
const FILE_EXTENSION = new RegExp(`^(?:${FILE_EXTENSIONS.join("|")})$`);

const languagesOf = (paths: readonly string[]): SupportedLanguage[] =>
  paths.map((path) => detectLanguageFromPath(path)).filter(isSupportedLanguage);
/** "a public Reader helper", "Reader's public helper": a helper of a type, with no member named. */
const HELPER = /\b(?:public\s+)?([A-Z][A-Za-z0-9_]*)(?:'s)?\s+(?:public\s+)?helper\b/g;
/**
 * "the given Rows helper", "the supplied Rows helper": the phrase names a helper file the request
 * hands over, not a member missing from it (#2566). R83 bytemerge: the spec's "the given Rows
 * helper" was `Rows.java`, a verbatim block of the request that the upstream feature installed,
 * and was recorded as a gap of that file.
 */
const GIVEN = /\b(?:given|supplied|provided|verbatim)\s+(?:public\s+)?$/i;

/** A name compared in any letter case, without `_` and `-`. */
const keyOf = (name: string) => name.replace(/[_-]/g, "").toLowerCase();
/** A type's or a file's name: a file's last extension is dropped, a folder's name is whole. */
const nameOf = (name: string) => keyOf(name.replace(/\.[^.]+$/, ""));
/**
 * Whether a file is the type a spec names: its stem (`Reader.cs`, `reader.py`), or its folder,
 * since a Go package, a Python package or a Rust module directory is named by it
 * (`lines/parse.go` for `lines.Line`, #2199). A folder name is compared whole: `tests/Maskback.Tests/`
 * is no folder `Maskback` (R75 maskback, #2365).
 */
const isTypeFile = (path: string, type: string) => {
  const name = nameOf(type);
  return nameOf(basename(path)) === name || keyOf(basename(dirname(path))) === name;
};

/**
 * Whether `Type.Member` is a namespace rather than a member of an upstream type (#2365): a path of
 * the released feature's own boundary has `Type/Member` as a folder and a folder or file below it
 * (`Maskback.Core` for `src/Maskback/Core/Scanner.cs`: the feature writes it), or `Type` is the
 * stem of a project file (`Maskback.csproj`, the root namespace) and no other file's stem.
 */
function isNamespace(
  type: string,
  member: string,
  upstream: readonly { path: string }[],
  own: readonly string[],
): boolean {
  const pair = `${keyOf(type)}/${keyOf(member)}`;
  const ownPair = own.some((path) => {
    const segments = path.split("/");
    const last = segments.length - 1;
    const keys = segments.map((segment, i) => (i === last ? nameOf(segment) : keyOf(segment)));
    return keys.some((key, i) => i < last && `${key}/${keys[i + 1]}` === pair);
  });
  if (ownPair) return true;
  const stems = (paths: readonly string[]) =>
    paths.filter((path) => nameOf(basename(path)) === nameOf(type));
  const named = stems([...upstream.map((file) => file.path), ...own]);
  return named.some(isProjectFile) && named.every(isProjectFile);
}

/**
 * The files the plan and the released run know, sorted: every feature's boundary paths, skeleton
 * files and implemented stubs, and `known`, the run's own (its host-written files, its tasks'
 * writes, the files at the release base that a boundary covers). A spec's `Type.Member` whose
 * member is one of these files' modules names that file, not a member of the type's file (#2619).
 */
export function plannedFiles(plan: InitiativePlan, known: readonly string[] = []): string[] {
  const paths = plan.features.flatMap((feature) => [
    ...feature.boundary.paths,
    ...(feature.skeleton ?? []).map((file) => file.path),
    ...(feature.implements ?? []),
  ]);
  return [...new Set([...paths, ...known])].sort();
}

/**
 * A test module's name in every language's convention: `GroupsTest`, `FooTests`, `ReaderSpec`,
 * `foo_test`, `reader_spec`. `NAMETest`, a request's placeholder for a family of test files, is one.
 */
const TEST_MODULE = /(?:[A-Za-z0-9]Tests?|[A-Za-z0-9]Specs?|_tests?|_spec)$/;

/**
 * Whether `Type.Member` names another file's module rather than a member of the type's file
 * (#2619): the member is the stem of a file the plan knows, compared as `keyOf`
 * (`Tokbill.GroupsTest` for `test/groups_test.exs`, `Tokbill.RowCase` for
 * `test/support/row_case.ex`, `App.FooTests` for `FooTests.cs`, `app::foo_test` for
 * `foo_test.rs`), or a test module's name while the plan has a test path. R85 tbl: all three
 * `upstream_symbol` would-stops were test modules and the host-written test support module, read
 * as missing members of the root module `lib/tokbill.ex`. The file list is the plan's, so it holds
 * in every language.
 */
function isPlannedModule(member: string, planned: readonly string[]): boolean {
  const key = keyOf(member);
  if (planned.some((path) => !isGlob(path) && nameOf(basename(path)) === key)) return true;
  return TEST_MODULE.test(member) && planned.some(isTestFile);
}

/**
 * The members a planned-ahead spec names on the files of its upstream features that the accepted
 * upstream code does not define (#2135). A member is read by the spellings of the upstream files'
 * languages (`MEMBER_SYNTAX`: `Reader::new`, `Reader#read`, `lines.Line`, #2199). A type is matched
 * to a file by its stem or its folder in any letter case (`Reader` to `Reader.cs`, `reader.go`,
 * `reader/mod.rs`), so it works in every language; a member is looked up as a word in that file. A helper the spec names by its type alone is a gap
 * too: nothing upstream decided it exists, unless the spec calls it given and its file is upstream
 * (#2566). `upstream` holds each upstream boundary file and its
 * text at the release base, null when absent; `own` is the released feature's boundary, whose
 * folders name namespaces it writes itself, not upstream members (#2365). `planned` is every file
 * the plan knows (`plannedFiles`): a member that is one of their modules is not a gap (#2619).
 */
export function upstreamSymbolGaps(
  spec: Pick<Spec, "requirements" | "criteria">,
  upstream: readonly { featureId: string; path: string; text: string | null }[],
  own: readonly string[] = [],
  planned: readonly string[] = [],
): UpstreamSymbolGap[] {
  const gaps: UpstreamSymbolGap[] = [];
  const seen = new Set<string>();
  const texts = [
    ...spec.requirements.map((r) => ({ ref: r.id, text: r.text })),
    ...spec.criteria.map((c) => ({ ref: c.id, text: `${c.given}\n${c.when}\n${c.then}` })),
  ];
  const patterns = memberPatterns(languagesOf(upstream.map((file) => file.path)));
  for (const { ref, text } of texts) {
    const named = new Set<string>();
    const members = patterns.flatMap((pattern) => [...text.matchAll(pattern)]);
    for (const { groups } of members) {
      const { type = "", sep = ".", member = "" } = groups ?? {};
      const files = upstream.filter((file) => isTypeFile(file.path, type));
      // `Reader.cs` and `config.yaml` are file names, not members.
      if (sep === "." && FILE_EXTENSION.test(member)) continue;
      if (!files.length || files.some((file) => file.path.endsWith(`.${member}`))) continue;
      if (sep === "." && isNamespace(type, member, upstream, own)) continue;
      if (isPlannedModule(member, planned)) continue;
      named.add(nameOf(type));
      if (files.some((file) => file.text !== null && wordIn(file.text, member))) continue;
      const symbol = sep.endsWith("[") ? `${sep}${type} ${member}]` : `${type}${sep}${member}`;
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      const file = files[0];
      if (file) gaps.push({ ref, symbol, featureId: file.featureId, path: file.path });
    }
    for (const match of text.matchAll(HELPER)) {
      const type = match[1] ?? "";
      const file = upstream.find((f) => isTypeFile(f.path, type));
      if (!file || named.has(nameOf(type)) || seen.has(match[0])) continue;
      if (file.text !== null && GIVEN.test(text.slice(Math.max(0, match.index - 40), match.index)))
        continue;
      seen.add(match[0]);
      gaps.push({ ref, symbol: match[0], featureId: file.featureId, path: file.path });
    }
  }
  return gaps;
}

/**
 * How the initiative answers a planned-ahead feature's request for an amendment of an accepted
 * upstream feature (#2157), under `workflows.upstreamAmendments`. `replan`: the owner runs again
 * from research (origin `replan`) with the request in its prompt, and the requesting feature waits
 * for that result; `write` (#2183): the requesting feature writes the file itself, its boundary
 * takes the path and its run plans again on the accepted result, so the owner does not run again;
 * `none`: nothing is reopened and the release goes on as before (the `upstream_symbol` would-stop
 * is still recorded).
 */
export type AmendmentAnswer = "replan" | "write" | "none";

export interface AmendmentInput {
  /** The status of the owner's current run; null when it has none. */
  ownerRunStatus: string | null;
  initiativeStatus: string;
  /** The requesting feature already asked this owner under the approved split. */
  requested: boolean;
  /** `workflows.upstreamAmendments`: `"write"` lets a small gap be written by the requester. */
  mode?: boolean | "write";
  /** Every gap the requesting feature has, across its owners. */
  gaps?: readonly UpstreamSymbolGap[];
  /** Another feature whose run is not finished owns the gap's file too. */
  pathOpen?: boolean;
}

/**
 * The one rule: reopen an owner whose run has finished, once per request, in a live initiative.
 * Under `"write"` a gap of one symbol in one file, which no unfinished feature owns, is written by
 * the requester instead: one helper added beside an accepted contract does not change it, and a
 * whole owner run for it costs a feature run (#2183).
 */
export function amendmentAnswer(input: AmendmentInput): AmendmentAnswer {
  if (input.requested) return "none";
  if (input.initiativeStatus !== "active" && input.initiativeStatus !== "paused") return "none";
  if (input.ownerRunStatus !== "completed") return "none";
  const gaps = input.gaps ?? [];
  return input.mode === "write" && gaps.length === 1 && !input.pathOpen ? "write" : "replan";
}

/** A request an owner's reopened run gets in its prompt. */
export interface AmendmentRequest {
  /** The requesting feature. */
  from: string;
  gaps: UpstreamSymbolGap[];
}

/** The prompt lines of the amendments an owner's run was reopened for. */
export function amendmentLines(requests: readonly AmendmentRequest[]): string[] {
  if (!requests.length) return [];
  return [
    "",
    "Amendments requested by features planned on this feature's accepted result. Add each, keeping what the features that depend on this one already use:",
    ...requests.map(
      (r) =>
        `- ${r.from} needs ${r.gaps.map((g) => `${g.symbol} in ${g.path} (its ${g.ref})`).join(", ")}.`,
    ),
  ];
}

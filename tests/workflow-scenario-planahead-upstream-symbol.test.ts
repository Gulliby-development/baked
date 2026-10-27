import { describe, expect, test } from "bun:test";
import { type InitiativePlan, planStructureProblems, validateInitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { amendmentAnswer, amendmentLines, conditionalContractProblems, upstreamFiles, upstreamSymbolGaps } from "../src/core/workflows/initiatives/upstream-symbols.js";
import type { Spec } from "../src/core/workflows/schemas.js";

// Bench round 68, ewvet (#2135): reader's contract said "If encoding needs auxiliary syntax
// classification, keep it in a public Reader helper in the allowed existing file, exposed through
// Scan", scanner's "Expose any needed Reader-backed encoding token classification through Scan".
// Nobody owned the "if needed". reader found no need and shipped `Reader.Read` only; scanner,
// planned ahead on a provisional base, made "a public Scanner facade that delegates to Reader's
// public helper" a `must`, and its release onto the accepted reader compared nothing. The feature
// spent 4.5M tokens on the missing helper.

const feature = (id: string, path: string, contract: string, dependsOn: string[] = []) => ({
  id, title: id, size: "medium" as const, workflow: "sdd", boundary: { scope: id, paths: [path, `tests/${id}_test.txt`] },
  contract, dependsOn, mandatory: true,
});
const ewvet = (reader: string, scanner: string): InitiativePlan => ({
  schemaVersion: 1, title: "ewvet", goals: ["Check encodings"], completionCriteria: ["Encodings are checked"],
  features: [
    feature("reader", "src/Reader.cs", reader),
    feature("scanner", "src/Scanner.cs", scanner, ["reader"]),
    feature("codec", "src/Codec.cs", "Codec encodes the scanned tokens.", ["scanner"]),
  ],
});

describe("a conditional clause across features is returned to the decomposer (#2135)", () => {
  test("the ewvet contracts are rejected with the change to make", () => {
    const plan = ewvet(
      "Reader reads the file. If encoding needs auxiliary syntax classification, keep it in a public Reader helper in the allowed existing file, exposed through Scan rather than duplicated in Codec.",
      "Scanner scans tokens. Expose any needed Reader-backed encoding token classification through Scan without duplicating syntax checks.",
    );
    const problems = conditionalContractProblems(plan);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("reader's contract makes work across features conditional");
    expect(problems[0]).toContain("naming codec");
    expect(problems[1]).toContain("naming reader");
    expect(problems[1]).toContain("State it as a requirement of the one feature that owns it, with the symbol and when it is required, or remove the clause.");
    // The decomposer's own check and the initiative's start both see it.
    expect(planStructureProblems(plan)).toEqual(expect.arrayContaining(problems));
    expect(validateInitiativePlan(plan)).toEqual(expect.arrayContaining(problems));
  });

  test("a clause that is not conditional, or conditional within one feature, passes", () => {
    const plan = ewvet(
      "Reader reads the file and exposes `Reader.IsEncodingToken(string)` for scanner.",
      "Scanner scans tokens; escape printf sequences as needed.",
    );
    expect(conditionalContractProblems(plan)).toEqual([]);
  });
});

const spec = (text: string): Pick<Spec, "requirements" | "criteria"> => ({
  requirements: [{ id: "FR-004", text, priority: "must", verification: "automated", sourceRefs: [] }],
  criteria: [],
});

/** The upstream reader file of each language, with `read` and without the classification helper. */
const LANGUAGES: [string, string, string, string][] = [
  ["csharp", "src/Reader.cs", "public static class Reader { public static Token[] Read(string text) => []; }", "IsEncodingToken"],
  ["go", "reader.go", "package ewvet\n\nfunc Read(text string) []Token { return nil }\n", "IsEncodingToken"],
  ["java", "src/main/java/ewvet/Reader.java", "public final class Reader { public static Token[] read(String text) { return new Token[0]; } }", "isEncodingToken"],
  ["python", "ewvet/reader.py", "def read(text):\n    return []\n", "is_encoding_token"],
  ["typescript", "src/reader.ts", "export function read(text: string): Token[] { return []; }\n", "isEncodingToken"],
];

describe("a released feature's spec is checked against the accepted upstream code (#2135)", () => {
  for (const [language, path, text, member] of LANGUAGES) {
    test(`${language}: a member upstream lacks is a gap, one it has is not`, () => {
      const upstream = [{ featureId: "reader", path, text }];
      expect(upstreamSymbolGaps(spec(`Scanner delegates to Reader.${member} for encoding tokens.`), upstream)).toEqual([
        { ref: "FR-004", symbol: `Reader.${member}`, featureId: "reader", path },
      ]);
      const read = language === "csharp" ? "Read" : "read";
      expect(upstreamSymbolGaps(spec(`Scanner calls Reader.${read} once per file.`), upstream)).toEqual([]);
    });
  }

  // #2199: the member spellings of the upstream files' languages, besides `Type.Member`.
  const MEMBERS: [string, string, string, string, string][] = [
    ["rust", "src/reader.rs", "pub fn read(text: &str) -> Vec<Token> { vec![] }\n", "Scanner calls reader::is_encoding_token per token.", "reader::is_encoding_token"],
    ["rust, through a module path", "src/reader/mod.rs", "pub fn read() {}\n", "Scanner calls crate::reader::is_encoding_token.", "reader::is_encoding_token"],
    ["cpp", "src/Reader.hpp", "class Reader { public: static void read(); };\n", "Scanner calls Reader::isEncodingToken().", "Reader::isEncodingToken"],
    ["php", "src/Reader.php", "<?php\nfinal class Reader { public static function read(): array { return []; } }\n", "Scanner calls Reader::isEncodingToken() per token.", "Reader::isEncodingToken"],
    ["ruby", "lib/reader.rb", "class Reader\n  def read = []\nend\n", "Scanner calls Reader#encoding_token? per token.", "Reader#encoding_token?"],
    ["go, a package by its folder", "lines/parse.go", "package lines\n\nfunc Parse(text string) []string { return nil }\n", "Scanner splits with lines.Line values.", "lines.Line"],
    ["python, a module function", "ewvet/reader.py", "def read(text):\n    return []\n", "Scanner calls `reader.is_encoding_token` per token.", "reader.is_encoding_token"],
    ["r", "R/reader.R", "read <- function(text) list()\n", "Scanner calls reader::is_encoding_token per token.", "reader::is_encoding_token"],
  ];
  for (const [language, path, text, sentence, symbol] of MEMBERS)
    test(`${language}: ${symbol} is read, and is quiet once the file defines it (#2199)`, () => {
      const upstream = [{ featureId: "reader", path, text }];
      expect(upstreamSymbolGaps(spec(sentence), upstream)).toEqual([{ ref: "FR-004", symbol, featureId: "reader", path }]);
      const member = symbol.split(/::|#|\./).pop() ?? "";
      expect(upstreamSymbolGaps(spec(sentence), [{ ...upstream[0], text: `${text}\n${member}\n` } as (typeof upstream)[0]])).toEqual([]);
    });

  test("spellings of languages the upstream does not use, and file names, are not members (#2199)", () => {
    const upstream = [{ featureId: "reader", path: "ewvet/reader.py", text: "def read(text):\n    return []\n" }];
    // `reader::x` is Rust or C++, `reader.IsX` Go: a Python upstream reads neither.
    expect(upstreamSymbolGaps(spec("Scanner calls reader::is_encoding_token and reader.IsEncodingToken."), upstream)).toEqual([]);
    // A quoted file name is no module function.
    expect(upstreamSymbolGaps(spec("Scanner reads `reader.json` and `reader.toml`."), upstream)).toEqual([]);
    // A shell upstream has no member syntax: `Reader.Member` is still read, as in every language.
    const shell = [{ featureId: "reader", path: "lib/reader.sh", text: "read_all() { :; }\n" }];
    expect(upstreamSymbolGaps(spec("Scanner calls Reader.IsEncodingToken."), shell).map((g) => g.symbol)).toEqual(["Reader.IsEncodingToken"]);
  });

  test("the ewvet requirement, a helper named only by its type, is a gap", () => {
    const upstream = [{ featureId: "reader", path: "src/Reader.cs", text: LANGUAGES[0]?.[2] ?? "" }];
    const gaps = upstreamSymbolGaps(spec("Expose any needed encoding-token classification through a public Scanner facade that delegates to Reader's public helper."), upstream);
    expect(gaps).toEqual([{ ref: "FR-004", symbol: "Reader's public helper", featureId: "reader", path: "src/Reader.cs" }]);
  });

  test("a file name is not a member, and a type of no upstream file is not checked", () => {
    const upstream = [{ featureId: "reader", path: "src/Reader.cs", text: "class Reader {}" }];
    expect(upstreamSymbolGaps(spec("Scanner reads Reader.cs and calls Console.WriteLine."), upstream)).toEqual([]);
  });
});

describe("a planned-ahead feature asks the owner for the missing symbol (#2157)", () => {
  test("an owner whose run finished is reopened once, in a live initiative", () => {
    expect(amendmentAnswer({ ownerRunStatus: "completed", initiativeStatus: "active", requested: false })).toBe("replan");
    expect(amendmentAnswer({ ownerRunStatus: "completed", initiativeStatus: "paused", requested: false })).toBe("replan");
    expect(amendmentAnswer({ ownerRunStatus: "completed", initiativeStatus: "active", requested: true })).toBe("none");
    expect(amendmentAnswer({ ownerRunStatus: "running", initiativeStatus: "active", requested: false })).toBe("none");
    expect(amendmentAnswer({ ownerRunStatus: null, initiativeStatus: "active", requested: false })).toBe("none");
    expect(amendmentAnswer({ ownerRunStatus: "completed", initiativeStatus: "completed", requested: false })).toBe("none");
  });

  // #2183: `write` only under the explicit value, for one symbol in one file no open feature owns.
  test("under \"write\" one symbol in one file is written by the requester; otherwise the owner is re-planned", () => {
    const gap = (symbol: string, path = "src/Reader.cs") => ({ ref: "FR-003", symbol, featureId: "reader", path });
    const ask = { ownerRunStatus: "completed", initiativeStatus: "active", requested: false };
    expect(amendmentAnswer({ ...ask, mode: "write", gaps: [gap("Reader.IsEncodingToken")] })).toBe("write");
    // `true`, the #2157 value, keeps re-planning the owner.
    expect(amendmentAnswer({ ...ask, mode: true, gaps: [gap("Reader.IsEncodingToken")] })).toBe("replan");
    expect(amendmentAnswer({ ...ask, mode: "write", gaps: [gap("Reader.IsEncodingToken"), gap("Reader.Peek")] })).toBe("replan");
    expect(amendmentAnswer({ ...ask, mode: "write", gaps: [gap("Reader.IsEncodingToken")], pathOpen: true })).toBe("replan");
    expect(amendmentAnswer({ ...ask, mode: "write", requested: true, gaps: [gap("Reader.IsEncodingToken")] })).toBe("none");
    expect(amendmentAnswer({ ...ask, mode: "write", ownerRunStatus: "running", gaps: [gap("Reader.IsEncodingToken")] })).toBe("none");
  });

  test("the reopened owner's prompt names the requester, the symbol, the file and the clause", () => {
    const lines = amendmentLines([{ from: "scanner", gaps: [{ ref: "FR-003", symbol: "Reader.IsEncodingToken", featureId: "reader", path: "src/Reader.cs" }] }]);
    expect(lines.at(-1)).toBe("- scanner needs Reader.IsEncodingToken in src/Reader.cs (its FR-003).");
    expect(amendmentLines([])).toEqual([]);
  });
});

// Bench round 69, ewvet (#2192): the base feature folded the skeleton, so its boundary listed every
// stub file (`// Implementation is supplied by the owning feature.`). Each released feature's spec
// names the members it writes itself (bytes: `Base64.Decode` in Base64.cs), and 6 of 7 releases
// recorded an `upstream_symbol` would-stop for them.
describe("a skeleton owner's stubs are not upstream code (#2192)", () => {
  const STUB = "// Implementation is supplied by the owning feature.\n";
  const skeleton = (id: string, paths: string[], dependsOn: string[] = []) => ({ ...feature(id, paths[0] ?? "", `${id} works.`, dependsOn), boundary: { scope: id, paths } });
  const plan: InitiativePlan = {
    schemaVersion: 1, title: "ewvet", goals: ["Check encodings"], completionCriteria: ["Encodings are checked"],
    features: [
      skeleton("base", ["src/Base64.cs", "src/Reader.cs", "src/Codec.cs", "src/Ewvet.csproj"]),
      skeleton("bytes", ["src/Base64.cs"], ["base"]),
      skeleton("reader", ["src/Reader.cs"], ["base"]),
      skeleton("scan", ["src/Scanner.cs"], ["base", "reader"]),
      skeleton("codec", ["src/Codec.cs"], ["scan"]),
    ],
  };
  const at = (texts: Record<string, string>) => (file: { featureId: string; path: string }) => ({ ...file, text: texts[file.path] ?? STUB });
  const byId = (id: string) => plan.features.find((f) => f.id === id) ?? plan.features[0]!;

  test("a released feature's own files, and a sibling's, are left out", () => {
    expect(upstreamFiles(plan, byId("bytes"))).toEqual([{ featureId: "base", path: "src/Ewvet.csproj" }]);
    const files = upstreamFiles(plan, byId("bytes")).map(at({}));
    expect(upstreamSymbolGaps(spec("Base64.Decode returns the bytes and Reader.Read the tokens."), files)).toEqual([]);
  });

  test("a member a filler planned later has not delivered is not a gap", () => {
    // codec fills the base's Codec.cs stub and depends on scan: scan's release reads only its own upstream.
    const files = upstreamFiles(plan, byId("scan")).map(at({}));
    expect(files.map((f) => f.path)).not.toContain("src/Codec.cs");
    expect(upstreamSymbolGaps(spec("Scanner hands tokens to Codec.Encode."), files)).toEqual([]);
  });

  test("the R68 case still records the gap: the accepted upstream file lacks the member", () => {
    const files = upstreamFiles(plan, byId("scan")).map(at({ "src/Reader.cs": LANGUAGES[0]?.[2] ?? "" }));
    // The base's stub and reader's filler are the same file; the gap names reader, which wrote it.
    expect(files.filter((f) => f.path === "src/Reader.cs").map((f) => f.featureId)).toEqual(["reader"]);
    expect(upstreamSymbolGaps(spec("Scanner delegates to Reader.IsEncodingToken for encoding tokens."), files)).toEqual([
      { ref: "FR-004", symbol: "Reader.IsEncodingToken", featureId: "reader", path: "src/Reader.cs" },
    ]);
    expect(upstreamSymbolGaps(spec("Scanner calls Reader.Read once per file."), files)).toEqual([]);
  });
});

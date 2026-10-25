import { describe, expect, test } from "bun:test";
import { type InitiativePlan, planStructureProblems, validateInitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { conditionalContractProblems, upstreamSymbolGaps } from "../src/core/workflows/initiatives/upstream-symbols.js";
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

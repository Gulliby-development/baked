import { describe, expect, test } from "bun:test";
import { type InitiativeFeature, type InitiativePlan, mergeSmallSiblings, rowOwnerProblems, testOwnershipProblems } from "../src/core/workflows/initiatives/plan.js";

// Bench round 58, wheeltags (Python, #1873). Asked to shorten a critical path in which front was
// 39 percent, the decomposer moved the unit tests of base, names and targets into two features of
// tests only, core-checks and selection-checks, that depend on front. base shipped five source
// files and no test, its `tests` check collected nothing, and the run blocked after 622k tokens;
// the chain grew by one feature. The relaunch of the same brief kept the tests in each layer.

const feature = (id: string, paths: string[], dependsOn: string[] = [], extra: Partial<InitiativeFeature> = {}): InitiativeFeature => ({
  id, title: id, boundary: { scope: `Own ${id}`, paths }, contract: `${id} works`, dependsOn, mandatory: true, ...extra,
});
const plan = (features: InitiativeFeature[]): InitiativePlan => ({ schemaVersion: 1, title: "wheeltags", goals: ["Tags"], completionCriteria: ["Every command works"], features });
const src = (...names: string[]) => names.map((n) => `src/wheeltags/${n}.py`);

/** The accepted second answer of the first R58 decomposition (12 features, abridged to the chain). */
const r58 = plan([
  feature("base", src("text", "options", "streams", "version", "errors"), [], { testedBy: "core-checks" }),
  feature("names", src("names", "normalize", "parse", "specifiers", "markers"), ["base"], { testedBy: "core-checks" }),
  feature("targets", src("targets", "platforms"), ["base"], { testedBy: "selection-checks" }),
  feature("tags", [...src("tags", "tagsets", "select"), "tests/test_tags.py"], ["names", "targets"]),
  feature("front", [...src("cli", "commands", "output"), "tests/test_cli.py"], ["tags"]),
  feature("core-checks", ["tests/test_text.py", "tests/test_options_streams.py", "tests/test_version.py", "tests/test_tagsets.py", "tests/test_names.py"], ["front", "base", "names"]),
  feature("selection-checks", ["tests/test_targets.py", "tests/test_select.py", "tests/test_platforms.py", "tests/test_markers.py"], ["front", "names", "targets"]),
  feature("docs", ["README.md", "docs/usage.md"], ["front", "core-checks", "selection-checks"]),
]);

/** The relaunch's answer: every layer holds its own tests. */
const relaunch = plan([
  feature("base", [...src("text", "options", "streams", "version", "errors"), "tests/test_text.py", "tests/test_options_streams.py"]),
  feature("names", [...src("names", "normalize", "parse", "specifiers", "markers"), "tests/test_names.py"], ["base"]),
  feature("targets", [...src("targets", "platforms"), "tests/test_targets.py"], ["base"]),
  feature("tags", [...src("tags", "tagsets", "select"), "tests/test_tags.py"], ["names", "targets"]),
  feature("front", [...src("cli", "commands", "output"), "tests/test_cli.py"], ["tags"]),
  feature("docs", ["README.md", "docs/usage.md"], ["front"]),
]);

describe("testedBy names a later feature whose code the tests need (#1873)", () => {
  test("the R58 split is refused: base builds on nothing, names and targets name features of tests only", () => {
    const problems = testOwnershipProblems(r58);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toStartWith("base has source paths but no writable test path, and it builds on no other feature's code");
    expect(problems[1]).toContain("testedBy names core-checks, a feature of tests only");
    expect(problems[2]).toContain("testedBy names selection-checks, a feature of tests only");
  });

  test("the relaunch's split, with each layer's tests in the layer, is accepted", () => {
    expect(testOwnershipProblems(relaunch)).toEqual([]);
  });

  test("a feature whose integration test needs the front's entry point may still name it", () => {
    const split = plan([
      feature("base", [...src("text"), "tests/test_text.py"]),
      feature("names", src("names", "parse", "markers"), ["base"], { testedBy: "front" }),
      feature("front", [...src("cli"), "tests/test_cli.py", "tests/test_names_cli.py"], ["names"]),
    ]);
    expect(testOwnershipProblems(split)).toEqual([]);
  });

  test("a feature after only host-written stubs builds on no code", () => {
    const split = plan([
      feature("stubs", ["src/wheeltags/__init__.py"], [], { skeleton: [{ path: "src/wheeltags/__init__.py", content: "" }] }),
      feature("base", src("text", "options", "streams"), ["stubs"], { testedBy: "front" }),
      feature("front", [...src("cli"), "tests/test_cli.py"], ["base"]),
    ]);
    expect(testOwnershipProblems(split)[0]).toContain("base has source paths but no writable test path, and it builds on no other feature's code");
  });

  // Test layouts of the supported languages: a root feature without its own tests, and an owner
  // of tests only, are refused whatever the language's test path looks like.
  // The third entry is a test-support file a check-only feature also holds: it is not code, so the
  // feature still writes nothing its tests need.
  const layouts: [string, string[], string[], string][] = [
    ["Go", ["internal/hdr/text.go", "internal/hdr/options.go"], ["internal/hdr/text_test.go", "internal/hdr/options_test.go"], "internal/hdr/testdata/in.txt"],
    ["Rust", ["src/text.rs", "src/options.rs"], ["tests/text.rs", "tests/options.rs"], "tests/common/mod.rs"],
    ["Java", ["src/main/java/tags/Text.java", "src/main/java/tags/Options.java"], ["src/test/java/tags/TextTest.java", "src/test/java/tags/OptionsTest.java"], "src/test/resources/tags.txt"],
    ["C#", ["src/Tags/Text.cs", "src/Tags/Options.cs"], ["tests/Tags.Tests/TextTests.cs", "tests/Tags.Tests/OptionsTests.cs"], "tests/Tags.Tests/Tags.Tests.csproj"],
    ["TypeScript", ["src/text.ts", "src/options.ts"], ["tests/text.test.ts", "tests/options.test.ts"], "tests/fixtures/tags.json"],
    ["JavaScript", ["src/text.js", "src/options.js"], ["test/text.test.js", "test/options.test.js"], "test/fixtures/tags.json"],
    ["Python", src("text", "options"), ["tests/test_text.py", "tests/test_options.py"], "tests/conftest.py"],
  ];
  for (const [language, code, tests, support] of layouts)
    test(`${language}: tests moved out of a root feature or into a feature of tests only are refused`, () => {
      const split = plan([
        feature("base", code, [], { testedBy: "checks" }),
        feature("cli", [code[0]?.replace(/text/i, "cli") ?? "cli", tests[0] ?? ""], ["base"]),
        feature("checks", tests, ["cli", "base"]),
      ]);
      const problems = testOwnershipProblems(split);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("builds on no other feature's code");
      const mid = plan([
        feature("core", [code[0] ?? "", tests[0] ?? ""]),
        feature("base", [code[1] ?? ""], ["core"], { testedBy: "checks" }),
        feature("checks", [tests[1] ?? "", support], ["base"]),
      ]);
      expect(testOwnershipProblems(mid)[0]).toContain("a feature of tests only");
    });

  test("a feature of tests only merged with a small docs sibling is still no test owner", () => {
    // Ownership is checked after the host merges small siblings; checks and docs both follow front.
    const split = plan([
      feature("base", [...src("text"), "tests/test_text.py"]),
      feature("names", src("names", "parse", "markers"), ["base"], { testedBy: "checks" }),
      feature("front", [...src("cli", "commands"), "tests/test_cli.py"], ["names"]),
      feature("checks", ["tests/test_names.py"], ["front"]),
      feature("docs", ["README.md"], ["front"]),
    ]);
    const merged = mergeSmallSiblings(split);
    expect(merged.merged).toHaveLength(1);
    const problems = testOwnershipProblems(merged.plan);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names has source paths but no writable test path, and testedBy names");
    expect(problems[0]).toContain("a feature of tests only");
  });
});

// Bench round 80, ratdec (Elixir, #2487): the plan gave all 16 rows of `test/stdin_test.exs` to
// core, while the row `eval --as mixed` on stdin needs the mixed output representations writes.
// Core's test check ran the row; a task rewrote it to pass and representations failed on it.
describe("a prescribed row file whose rows a feature cannot all pass (#2487)", () => {
  const fence = "```";
  const rowBlock = (name: string, path: string, rows: string[]) => `${fence}text\n${name} in ${path} (${rows.length} rows: stdin | args | stdout)\n${rows.join("\n")}\n${fence}`;
  // One row file per topic through one entry point; the split is by layer.
  const layouts: [string, string[], string, string, string][] = [
    ["Elixir", ["lib/ratdec/cli.ex", "lib/ratdec/rat.ex"], "lib/ratdec/format.ex", "test/stdin_test.exs", "test/mixed_test.exs"],
    ["TypeScript", ["src/cli.ts", "src/rat.ts"], "src/format.ts", "tests/stdin.test.ts", "tests/mixed.test.ts"],
    ["Go", ["internal/cli/cli.go", "internal/rat/rat.go"], "internal/format/format.go", "internal/cli/stdin_test.go", "internal/format/mixed_test.go"],
    ["Python", ["src/ratdec/cli.py", "src/ratdec/rat.py"], "src/ratdec/format.py", "tests/test_stdin.py", "tests/test_mixed.py"],
    ["Rust", ["src/cli.rs", "src/rat.rs"], "src/format.rs", "tests/stdin.rs", "tests/mixed.rs"],
    ["C#", ["src/Ratdec/Cli.cs", "src/Ratdec/Rat.cs"], "src/Ratdec/Format.cs", "tests/Ratdec.Tests/StdinTests.cs", "tests/Ratdec.Tests/MixedTests.cs"],
  ];
  const request = (stdin: string, mixed: string) => [
    "Build ratdec, an exact rational calculator.",
    rowBlock("StdinTest", stdin, ["7/3 | eval | 7/3", "1/2+1/3 | eval | 5/6", "7/3 | eval --as mixed | 2 1/3"]),
    rowBlock("MixedTest", mixed, ["| eval 7/3 --as mixed | 2 1/3", "| eval -7/3 --as mixed | -2 1/3"]),
  ].join("\n\n");
  const ratdec = (code: string[], format: string, stdin: string, mixed: string, stdinOwner: "core" | "representations") => plan([
    // Core keeps a row file of its own topic either way.
    feature("core", [...code, stdin.replace("stdin", "literals").replace("Stdin", "Literals"), ...(stdinOwner === "core" ? [stdin] : [])], [], { contract: "`ratdec eval` reads an expression on stdin and prints the exact fraction, `7/3`." }),
    feature("representations", [format, mixed, ...(stdinOwner === "representations" ? [stdin] : [])], ["core"], { contract: "`--as mixed` prints a mixed number such as `2 1/3`; `ratdec eval` keeps its fraction output." }),
    feature("docs", ["README.md"], ["core", "representations"], { contract: "The README documents `ratdec eval`." }),
  ]);
  for (const [language, code, format, stdin, mixed] of layouts) {
    test(`${language}: the earlier feature owning a row file with a later feature's literal is refused when enforced`, () => {
      const split = ratdec(code, format, stdin, mixed, "core");
      const given = request(stdin, mixed);
      const found = rowOwnerProblems(split, given);
      expect(found).toEqual([expect.objectContaining({ path: stdin, owner: "core", needs: "representations", row: "7/3 | eval --as mixed | 2 1/3", literal: "--as mixed", rows: 1 })]);
      const problems = testOwnershipProblems(split, { request: given, mode: "enforce" });
      expect(problems).toEqual([`${stdin} holds a row that only representations can pass (\`7/3 | eval --as mixed | 2 1/3\` holds \`--as mixed\`, which the contract or scope of representations cites): give the file to representations (it depends on core), or ask for the row in the brief to be split into a file of representations.`]);
      // Shadow (the default) leaves the split to the would-stop record.
      expect(testOwnershipProblems(split, { request: given, mode: "shadow" })).toEqual([]);
      expect(testOwnershipProblems(split)).toEqual([]);
    });

    test(`${language}: the row file given to the later feature, or rows of the owner's own literals, pass`, () => {
      const given = request(stdin, mixed);
      expect(testOwnershipProblems(ratdec(code, format, stdin, mixed, "representations"), { request: given, mode: "enforce" })).toEqual([]);
      // Without the mixed row, the entry point both contracts cite is shared vocabulary, not a later feature's.
      const frac = given.replace("\n7/3 | eval --as mixed | 2 1/3", "");
      expect(testOwnershipProblems(ratdec(code, format, stdin, mixed, "core"), { request: frac, mode: "enforce" })).toEqual([]);
    });
  }
});

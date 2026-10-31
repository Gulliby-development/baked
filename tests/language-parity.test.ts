import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  isNoRow,
  type LanguageRecord,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "../src/core/intelligence/language-records.js";
import {
  isManifestFile,
  isTestContent,
  isTestFile,
  MANIFEST_NAMES,
  TEST_CONVENTIONS,
  TEST_MARKERS,
} from "../src/core/intelligence/language-traits.js";
import { detectLanguageFromPath, EXT_TO_LANGUAGE } from "../src/core/intelligence/types.js";
import { declaredTests, TEST_DECLARATIONS } from "../src/core/intelligence/test-declarations.js";
import {
  failureSignature,
  TEST_RUNNERS,
  testCount,
} from "../src/core/verification/output-counts.js";
import { ENTRY_POINTS, projectEntryPoints } from "../src/core/verification/entry-points.js";
import { EXAMPLE_BUILD } from "../src/core/verification/example-build.js";
import { edgeTaxonomy, NUMERIC_LIMITS } from "../src/core/verification/edge-inputs.js";
import { FILE_FORMATTERS, formatWrittenChecks } from "../src/core/workflows/format-written.js";
import { detectGates, formatCommandLine, GATE_TOOLCHAINS } from "../src/core/workflows/gates.js";
import { PLACEHOLDERS } from "../src/core/workflows/quality/builtin-rules.js";
import { DEPENDENCY_MANIFESTS, manifestDependencies } from "../src/core/workflows/quality/manifests.js";
import { detectMutationTool, MUTATION_TOOLS } from "../src/core/workflows/quality/mutation-tools.js";
import { PROPERTY_LIBRARIES, propertyTestKind } from "../src/core/workflows/quality/properties.js";
import { checkBuiltinRules } from "../src/core/workflows/quality/rules.js";
import { INLINE_HARNESS, inlineRowFile } from "../src/core/workflows/acceptance-rows-inline.js";
import { TEST_GATES, testGateFlags } from "../src/core/workflows/test-gates.js";
import { declaredTestClasses, TEST_CLASSES } from "../src/core/workflows/test-classes.js";
import { ROW_FILE_SHAPES, rowFilePlan, rowFileRefusal } from "../src/core/workflows/row-file.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { TreeSitterBackend } from "../src/core/intelligence/backends/tree-sitter.js";
import { CALL_SYNTAX, callContext, functionsIn } from "../src/core/intelligence/call-context.js";
import { TaskSchema } from "../src/core/workflows/schemas.js";
import { MASK_SYNTAX, maskNonCode, stripComments } from "../src/core/workflows/quality/code-mask.js";
import { GENERATED_VALUE_SHAPES, generatedValues, RUNTIME_PATH_SOURCES, runtimePathNames } from "../src/core/verification/generated-values.js";
import { PACKAGE_CONTENTS, packagingFields } from "../src/core/workflows/quality/package-contents.js";
import { isStaticCheck, isWholeUnitCheck } from "../src/core/workflows/check-policy.js";
import { isTestCheck } from "../src/core/workflows/quality/mutation.js";
import { STATIC_TOOLS } from "../src/core/workflows/static-tools.js";
import { layOutForFormatter, SORTED_LISTS } from "../src/core/workflows/initiatives/skeleton-layout.js";
import { CHECK_CONFIGS, checkConfigOf } from "../src/core/workflows/quality/check-configs.js";
import { MEMBER_SYNTAX, upstreamSymbolGaps } from "../src/core/workflows/initiatives/upstream-symbols.js";
import { SUPPRESSION_SPELLINGS } from "../src/core/workflows/quality/suppressions.js";
import { suppressionsIn } from "../src/core/workflows/test-integrity.js";
import type { Check } from "../src/core/workflows/types.js";
import { rowOf } from "../src/core/intelligence/language-records.js";
import { DEPENDENCY_DIRS, DEPENDENCY_PREPARE, linkDependencies, WORKTREE_PATH_LIMITS } from "../src/core/workflows/dependency-dirs.js";
import { sourceManifest } from "../src/core/verification/snapshot.js";

// Language parity (#1717): every language-bound record has a row for every supported language,
// and every row is exercised by the language's fixture project in `tests/fixtures/languages/`.
// A fixture's `expected` holds the golden output of each record's function over its files:
// `null` where the record's row is `none(reason)`, a non-empty list where the row has data.

type Files = Record<string, string>;
interface Fixture {
  files: Files;
  /** Check output the language's test runner prints: a failing run, and the same run with one more passing test. */
  outputs?: { tests: string; testsGrown: string };
  /** A test file per language that builds inputs from generated values beside a literal twin and a commented copy (#2344). */
  generated?: Files;
  expected: Record<string, string[] | null>;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The fixture's files in a temporary directory, for code that reads a workspace. */
function workspace(files: Files): string {
  const root = mkdtempSync(join(tmpdir(), "baked-language-parity-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const ofLanguage = (language: SupportedLanguage, files: Files) =>
  Object.entries(files).filter(([path]) => detectLanguageFromPath(path) === language);

/** The language-bound records and the public function that reads each, over a fixture's files. */
const RECORDS: Record<
  string,
  {
    record: LanguageRecord<unknown>;
    run: (language: SupportedLanguage, fixture: Fixture) => string[] | Promise<string[]>;
    /** Outputs a row with data must never give, whatever its golden says. */
    never?: string[];
  }
> = {
  tests: {
    record: TEST_CONVENTIONS,
    run: (language, { files }) =>
      Object.keys(files).filter((path) => detectLanguageFromPath(path) === language && isTestFile(path)),
  },
  // The fixture's test files that hold a test marker, and its source files named like a test that
  // hold none, which are not tests (#1848).
  testMarkers: {
    record: TEST_MARKERS,
    run: (language, { files }) =>
      ofLanguage(language, files)
        .filter(([path]) => isTestFile(path))
        .map(([path, text]) => `${path}: ${isTestContent(path, text) ? "test" : "source"}`),
  },
  // The tests the row's example declares, and each class's where the row groups them: what the
  // brief's per-file and per-class test caps count (#2368). The examples hold a commented-out test.
  testDeclarations: {
    record: TEST_DECLARATIONS,
    run: (language) => {
      const row = rowOf(TEST_DECLARATIONS, language);
      if (!row) return [];
      const found = declaredTests(row.example.path, row.example.text);
      if (!found) return ["not counted"];
      const perClass = found.units.length ? `, per class ${found.units.join(", ")}` : "";
      return [`${row.example.path}: ${String(found.tests)} tests${perClass}`];
    },
    never: ["not counted"],
  },
  manifests: {
    record: MANIFEST_NAMES,
    run: (_, { files }) => Object.keys(files).filter(isManifestFile),
  },
  dependencies: {
    record: DEPENDENCY_MANIFESTS,
    run: (_, { files }) =>
      Object.entries(files).flatMap(([path, text]) =>
        manifestDependencies(path, text).map((d) => `${d.file}: ${d.ecosystem} ${d.name}`),
      ),
  },
  placeholders: {
    record: PLACEHOLDERS,
    run: (language, { files }) =>
      checkBuiltinRules(
        Object.entries(files)
          .filter(([path]) => detectLanguageFromPath(path) === language)
          .map(([path, content]) => ({ path, content, before: null })),
        {},
      )
        .filter((finding) => finding.rule === "placeholder-body")
        .map((finding) => `${finding.file}:${finding.line}`),
  },
  gates: {
    record: GATE_TOOLCHAINS,
    run: (_, { files }) => detectGates(workspace(files)).map((s) => s.check.id),
  },
  // The format-written check the language's code files get when the project offers a formatter (#1837).
  formatters: {
    record: FILE_FORMATTERS,
    run: (language, { files }) =>
      formatWrittenChecks(
        workspace(files),
        [],
        ofLanguage(language, files).map(([path]) => ({ path, action: "create" })),
        (command) => `/usr/bin/${command}`,
      ).map((c) => `${c.id}: ${formatCommandLine(c.executable, c.args)}`),
  },
  entryPoints: {
    record: ENTRY_POINTS,
    run: (_, { files }) =>
      projectEntryPoints(workspace(files)).map((e) => `${e.name}: ${e.launcher.join(" ")}`),
  },
  // How a documented example reuses the build the checks made (#2505): the toolchain's build-and-run
  // command, the flags that skip its build, and the build directories linked into the copy.
  exampleBuild: {
    record: EXAMPLE_BUILD,
    run: (language) => {
      const row = EXAMPLE_BUILD[language];
      if (isNoRow(row)) return [];
      return [`${[row.program, ...row.subcommand, ...row.noBuild].join(" ")}; link ${row.link.join(", ")}`];
    },
  },
  numericLimits: {
    record: NUMERIC_LIMITS,
    // The runtime limits the edge-input probe is told for the fixture's own files (#1808).
    run: (language, { files }) =>
      edgeTaxonomy(Object.keys(files).map((path) => detectLanguageFromPath(path)))
        .limits.filter((row) => row.language === language)
        .flatMap((row) => [...row.limits]),
  },
  testRunners: {
    record: TEST_RUNNERS,
    // The runner's count, and whether the failure signature ignores one more passing test (#1425).
    run: (_, { outputs }) => {
      if (!outputs) return [];
      const count = testCount(outputs.tests);
      const stable =
        failureSignature(outputs.tests, "/repo") === failureSignature(outputs.testsGrown, "/repo");
      return [count ? `${count.tool} ${count.count}` : "no count", stable ? "signature stable" : "signature changed"];
    },
    never: ["no count", "signature changed"],
  },
  // The gate flags a gated test file of the language gets in its written-tests check (#1832).
  testGates: {
    record: TEST_GATES,
    run: (language, { files }) =>
      [...testGateFlags(ofLanguage(language, files).map(([path, text]) => ({ path, text })))].map(
        ([program, flags]) => `${program} ${flags.join(" ")}`,
      ),
  },
  // The generated test inputs the case walk records where literal examples are asked for (#2344):
  // the fixture's `generated` file holds each kind its row spells, a literal twin and a commented
  // copy, which are never marked.
  generatedValues: {
    record: GENERATED_VALUE_SHAPES,
    run: (_, { generated = {} }) =>
      Object.entries(generated).flatMap(([path, text]) =>
        generatedValues(path, text, new Set(["repeat", "format", "interpolate", "pack", "loop"])).map((g) => `${g.path}:${g.line} ${g.kind}`),
      ),
  },
  // The names a test file binds to a path made at run time (#2469): the fixture's `generated`
  // runtime file builds a value from one by interpolation or format, which `generatedValues`
  // above never marks.
  runtimePaths: {
    record: RUNTIME_PATH_SOURCES,
    run: (_, { generated = {} }) =>
      Object.entries(generated).flatMap(([path, text]) => {
        const names = [...runtimePathNames(path, text)].sort();
        return names.length ? [`${path}: ${names.join(", ")}`] : [];
      }),
  },
  // The test classes a written-tests run selects by name (#2363): the row's example, a file whose
  // class is not named like it, and each test file of the fixture ("by its name" when it declares
  // no type that holds a test, so the run falls back to the file's name).
  testClasses: {
    record: TEST_CLASSES,
    run: (language, { files }) => {
      const row = rowOf(TEST_CLASSES, language);
      const classes = (path: string, text: string) =>
        `${path}: ${(declaredTestClasses(path, text) ?? []).map((c) => c.name).join(", ") || "by its name"}`;
      return [
        ...(row ? [classes(row.example.path, row.example.text)] : []),
        ...ofLanguage(language, files)
          .filter(([path]) => isTestFile(path))
          .map(([path, text]) => classes(path, text)),
      ];
    },
  },
  // The prescribed row file the host writes from the row's example shape and rows (#2528): the
  // written file's lines, the shape's preamble and epilogue around one row per line.
  rowFileShapes: {
    record: ROW_FILE_SHAPES,
    run: (language) => {
      const row = rowOf(ROW_FILE_SHAPES, language);
      if (!row) return [];
      const { path, reference, rows } = row.example;
      const { inputs, content } = rowFilePlan(path, rows, { source: "reference", text: reference });
      return content === null ? ["declined", rowFileRefusal(path, inputs) ?? ""] : [path, ...content.split("\n")];
    },
    never: ["declined"],
  },
  // The comment and string syntax the case walk and the integrity guards read code by (#1846): the
  // lines a string or a comment covers, marked `comment` when stripping comments alone blanks them.
  codeMask: {
    record: MASK_SYNTAX,
    run: (language, { files }) =>
      ofLanguage(language, files).flatMap(([path, text]) => {
        const masked = maskNonCode(path, text).split("\n");
        const stripped = stripComments(path, text).split("\n");
        return text.split("\n").flatMap((line, i) =>
          masked[i] === line ? [] : [`${path}:${i + 1}${stripped[i] === line ? "" : " comment"}`],
        );
      }),
  },
  // The review's call-graph context (#1845): the callers and importers of the first function of the
  // language's source files that tree-sitter finds.
  callGraph: {
    record: CALL_SYNTAX,
    run: async (language, { files }) => {
      const all = Object.entries(files).map(([path, text]) => ({ path, text }));
      const spans = await functionsIn(treeSitter(), ofLanguage(language, files).map(([path, text]) => ({ path, text })));
      const fn = spans.find((s) => !isTestFile(s.file));
      if (!fn) return [];
      const [context] = callContext([fn], spans, all);
      return [
        ...(context?.callers ?? []).map((p) => `${fn.name} called at ${p.file}:${p.line}`),
        ...(context?.importers ?? []).map((path) => `${fn.file} imported by ${path}`),
      ];
    },
  },
  mutation: {
    record: MUTATION_TOOLS,
    // Every tool counts as installed, so the record alone decides which one the files get.
    run: (language, { files }) => {
      const found = detectMutationTool(
        ofLanguage(language, files).map(([path, content]) => ({ path, content, before: null })),
        {
          root: "/repo",
          scratch: "/scratch",
          platform: "linux",
          run: async () => ({ exitCode: 0, output: "", timedOut: false }),
          read: (path) => files[path] ?? "pitest-maven info.solidsoft.pitest",
          exists: () => true,
          remove: () => {},
          which: (command) => `/usr/bin/${command}`,
          now: () => 0,
        },
      );
      return found ? [`${found.tool}: ${found.files.map((f) => f.path).join(", ")}`] : [];
    },
  },
  // The package a manifest edit builds for the package contents check (#1984), with the packaging
  // fields the fixture's manifests declare.
  packageContents: {
    record: PACKAGE_CONTENTS,
    run: (_, { files }) =>
      Object.entries(files).flatMap(([path, text]) => {
        const found = packagingFields(path, text);
        return found ? [`${path}: ${found.tool}${found.fields.length ? ` [${found.fields.join(", ")}]` : ""}`] : [];
      }),
  },
  // How a check named after each of the language's linters, formatters and type checkers is
  // classified when it runs on the test files (#2110): static, never a test check.
  staticTools: {
    record: STATIC_TOOLS,
    run: (language) =>
      (rowOf(STATIC_TOOLS, language) ?? []).map(({ tool, kind }) => {
        const [executable = "", ...args] = tool.split(" ");
        const check = { id: tool.replaceAll(" ", "-"), executable, args: [...args, "tests/"] } as unknown as Check;
        const as = [
          isStaticCheck(check) ? kind : "not static",
          ...(isTestCheck(check) ? ["test"] : []),
          ...(isWholeUnitCheck(check) ? ["whole unit"] : []),
        ];
        return `${tool}: ${as.join(", ")}`;
      }),
  },
  // The lists a language's formatter sorts, and the lines of the row's sample a host-written
  // skeleton gets a blank line (#2222) or the formatter's split marker (#2233) before so the order
  // stays, in a project configured as the row's sample says.
  sortedLists: {
    record: SORTED_LISTS,
    run: (language) => {
      const row = rowOf(SORTED_LISTS, language);
      const laid = row
        ? layOutForFormatter(row.sample.path, row.sample.content, (name) => row.sample.config?.[name] ?? null)
        : null;
      const before = laid?.marker ? `"${laid.marker}"` : "blank line";
      return laid ? [`${row?.sample.path}: ${laid.formatter} ${before} before ${laid.lines.join(", ")}`] : [];
    },
  },
  // The check-defining configs auto-approval protects and holds to named tightenings (#2221): each
  // row's example file, the tool it is for, and how a plain edit of it reads ("loosens" for every
  // change of a config read as text).
  checkConfigs: {
    record: CHECK_CONFIGS,
    run: (language) =>
      (rowOf(CHECK_CONFIGS, language) ?? []).map((config) => {
        const found = checkConfigOf(config.example);
        return `${config.example}: ${found?.tool ?? "unmatched"}${found === config ? "" : " (another row)"}${config.format === "text" ? ", read as text" : ""}`;
      }),
    never: ["unmatched"],
  },
  // Each member spelling's example, in a planned-ahead spec over an upstream file of the language
  // named by the example's type (#2199): the symbol the upstream-symbol check reports while the
  // file lacks the member, and whether it is quiet once the file defines it.
  memberSyntax: {
    record: MEMBER_SYNTAX,
    run: (language, { files }) => {
      const [sample] = ofLanguage(language, files)[0] ?? [];
      if (!sample) return ["no file of the language"];
      const ext = /\.[^./]+$/.exec(sample)?.[0] ?? "";
      return (rowOf(MEMBER_SYNTAX, language) ?? []).map(({ pattern, example }) => {
        const { type = "", member = "" } = new RegExp(pattern).exec(example)?.groups ?? {};
        const path = `src/${type}${ext}`;
        const spec = {
          requirements: [{ id: "FR-001", text: example, priority: "must" as const, verification: "automated" as const, sourceRefs: [] }],
          criteria: [],
        };
        const gaps = upstreamSymbolGaps(spec, [{ featureId: "upstream", path, text: "" }]).map((gap) => gap.symbol);
        const defined = upstreamSymbolGaps(spec, [{ featureId: "upstream", path, text: `${member}\n` }]);
        return `${example}: ${gaps.join(", ") || "not read"}${defined.length ? ", still a gap when defined" : ""}`;
      });
    },
    never: ["no file of the language"],
  },
  // Each suppression spelling's example line, added to a file of the language (#2274): what the
  // test-integrity guard counts and whether the lint-suppression quality rule reports it, and the
  // same line inside a string literal, which is test data and no suppression (#1549).
  suppressions: {
    record: SUPPRESSION_SPELLINGS,
    run: (language, { files }) => {
      const [path] = ofLanguage(language, files)[0] ?? [];
      if (!path) return ["no file of the language"];
      return (rowOf(SUPPRESSION_SPELLINGS, language) ?? []).map(({ example, kind }) => {
        const counted = suppressionsIn(path, `${example}\n`);
        const quoted = suppressionsIn(path, `${JSON.stringify(example)}\n`);
        const linted = checkBuiltinRules([{ path, content: `${example}\n`, before: null }], {}).some(
          (finding) => finding.rule === "lint-suppression",
        );
        // Named verbatim by the request it is prescribed, unless it is a bare marker; named only to
        // forbid it, it still counts (#2270).
        const prescribed = suppressionsIn(path, `${example}\n`, `Keep ${example} on the stub.`) === 0;
        const forbidden = suppressionsIn(path, `${example}\n`, `Do not add ${example} anywhere.`) === 0;
        return `${example}: ${counted === 1 ? kind : `counted ${String(counted)}`}${linted ? ", linted" : ""}${prescribed ? ", prescribable" : ""}${quoted ? ", quoted counted" : ""}${forbidden ? ", forbidden not counted" : ""}`;
      });
    },
    never: ["no file of the language"],
  },
  // The language's dependency folders, installed in the fixture project, that a worktree or copy
  // of it links, and whether the copy's source manifest leaves the link out (#2330).
  dependencyDirs: {
    record: DEPENDENCY_DIRS,
    run: async (language, { files }) => {
      const dirs = rowOf(DEPENDENCY_DIRS, language) ?? [];
      const root = workspace({ ...files, ...Object.fromEntries(dirs.map((d) => [`${d}/installed`, ""])) });
      const copy = workspace({});
      const linked = linkDependencies(root, copy);
      const manifest = Object.keys(await sourceManifest(copy));
      const listed = linked.filter((d) => manifest.some((path) => path.startsWith(d)));
      return [...linked.map((d) => `${d}: linked`), ...(listed.length ? ["in the manifest"] : [])];
    },
    never: ["in the manifest"],
  },
  // The command that resolves the fixture project's packages in a new worktree or copy, when its
  // resolution is a generated, ignored file that holds machine paths (#2361).
  dependencyPrepare: {
    record: DEPENDENCY_PREPARE,
    run: (language, { files }) => {
      const row = DEPENDENCY_PREPARE[language];
      const command = isNoRow(row) ? null : row(workspace(files));
      return command ? [command.join(" ")] : [];
    },
  },
  // The fixture project's manifest that makes the doctor check a task worktree's path length (#2361).
  worktreePathLimits: {
    record: WORKTREE_PATH_LIMITS,
    run: (language, { files }) => {
      const row = WORKTREE_PATH_LIMITS[language];
      return isNoRow(row) || !(row.manifest in files) ? [] : [`${row.manifest}: ${row.tool} over ${String(row.chars)} characters`];
    },
  },
  properties: {
    record: PROPERTY_LIBRARIES,
    run: (language, { files }) =>
      ofLanguage(language, files).flatMap(([path, content]) => {
        const kind = propertyTestKind(path, content);
        return kind ? [`${path}: ${kind}`] : [];
      }),
  },
};

let backend: TreeSitterBackend | null = null;
const treeSitter = () => (backend ??= new TreeSitterBackend());
afterAll(() => backend?.dispose());

const dir = join(import.meta.dir, "fixtures", "languages");
const fixture = (language: string): Fixture =>
  JSON.parse(readFileSync(join(dir, `${language}.json`), "utf8")) as Fixture;

test("every supported language has a fixture project, and every fixture a supported language", () => {
  const fixtures = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  expect(fixtures).toEqual([...SUPPORTED_LANGUAGES].sort());
});

for (const language of SUPPORTED_LANGUAGES)
  describe(`language parity: ${language}`, () => {
    for (const [name, { record, run, never = [] }] of Object.entries(RECORDS))
      test(name, async () => {
        const data = fixture(language);
        const golden = data.expected?.[name];
        const actual = await run(language, data);
        const row = record[language];
        // A missing golden prints what the record gives, ready to paste into the fixture.
        expect({ [name]: golden === undefined ? "missing" : golden }).toEqual({
          [name]: isNoRow(row) ? null : actual,
        });
        if (isNoRow(row)) return;
        expect(actual.length).toBeGreaterThan(0);
        for (const output of never) expect(actual).not.toContain(output);
      });
  });

// #1763: every acceptance-rows framework has both modes, and the inline block needs no file or
// dependency the brief may forbid: only the language's standard library and its test framework.
describe("acceptance rows: every framework has the file and the inline mode (#1763)", () => {
  const frameworks = TaskSchema.shape.rowTest.unwrap().options[0].shape.framework.options;
  test.each(frameworks.map((framework) => [framework]))("%s", (framework) => {
    expect(INLINE_HARNESS[framework]).toBeTruthy();
    const pkg = framework === "go" ? "calc" : framework === "junit" ? "com.ex.calc" : "Calc.Tests";
    const test = { bun: "tests/a.test.ts", pytest: "tests/test_a.py", go: "calc/a_test.go", junit: "src/test/java/com/ex/calc/ATest.java", rust: "tests/a.rs", xunit: "Calc.Tests/ATest.cs", rspec: "spec/a_spec.rb", phpunit: "tests/ATest.php", testthat: "tests/testthat/test-a.R", busted: "spec/a_spec.lua", minitest: "test/a_test.rb", pest: "tests/ATest.php", exunit: "test/a_test.exs", dart: "test/a_test.dart" }[framework];
    const file = inlineRowFile({ mode: "inline", framework, test, package: pkg }, [{ id: "AC-001:1", criterionId: "AC-001", input: 1, expected: 2, source: "1 | 2" }]);
    expect(file.tail).toContain(INLINE_HARNESS[framework]);
    expect(file.tail).not.toMatch(/serde_json|import junit|org\.json|Newtonsoft/);
  });
});

// #2363: a written-tests run that selects tests by class (dotnet's `--filter`, maven's `-Dtest`,
// gradle's `--tests`) names the classes a file declares, never the file's name. A language whose
// test files such a runner takes has a `TEST_CLASSES` row, whose example's classes the filter names;
// a new class-filter runner joins `CLASS_RUNNERS`, and this fails for each language it takes
// without a row.
describe("class-filter runners select the declared classes (#2363)", () => {
  const CLASS_RUNNERS = [
    { id: "tests", executable: "dotnet", args: ["test"] },
    { id: "tests", executable: "mvn", args: ["test"] },
    { id: "tests", executable: "gradle", args: ["test"] },
  ].map((c) => ({ ...c, cwd: ".", envNames: [], timeoutMs: 300_000, required: true, scope: "feature", writes: [] }) as unknown as Check);
  const extensionOf = (language: SupportedLanguage) =>
    Object.entries(EXT_TO_LANGUAGE).find(([, l]) => l === language)?.[0] ?? `.${language}`;
  test.each(SUPPORTED_LANGUAGES.map((language) => [language]))("%s", (language) => {
    const row = rowOf(TEST_CLASSES, language);
    const ext = extensionOf(language);
    const paths = row ? [row.example.path] : [`src/test/${language}/com/example/UnitTest1${ext}`, `App.Tests/UnitTest1${ext}`];
    for (const path of paths) {
      const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.\w+$/, "");
      const root = workspace({ [path]: row?.example.text ?? "" });
      for (const runner of CLASS_RUNNERS) {
        const args = writtenTestsCheck(root, [runner], [{ path, action: "create" }])?.args.join(" ") ?? "";
        if (!row) {
          expect({ runner: runner.executable, path, selectsByName: args.includes(stem) }).toEqual({ runner: runner.executable, path, selectsByName: false });
          continue;
        }
        if (!args) continue;
        const declared = (declaredTestClasses(path, row.example.text) ?? []).map((c) => c.name);
        for (const name of declared) expect(args).toContain(name);
        // Kotlin's `UnitTest1Kt` is a declared class; the file's name alone is not.
        expect(declared.reduce((rest, name) => rest.replaceAll(name, ""), args)).not.toContain(stem);
      }
    }
  });
});

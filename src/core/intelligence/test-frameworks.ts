import { detectLanguageFromPath, type Language } from "./types.js";

/**
 * Test and assertion conventions of test frameworks, next to the language table (#1488), so the
 * test-integrity guard and the criteria-case walk read one list (#1650, #1651). A framework
 * without `languages` is read in every file: its patterns are distinct enough, and the guard has
 * always read them so. A scoped one is read only in files of its languages.
 */
interface TestFramework {
  name: string;
  languages?: readonly Language[];
  /** One match per test case: a test function, a case row, a spec block or a subtest. */
  cases?: string;
  /** Tests named on the line that starts them; the `name` group holds the name. */
  named?: readonly NamedTest[];
  /** An attribute that marks the function below it as a test, which names it. */
  attribute?: string;
  /** One match per assertion. */
  assertions?: string;
  /** One match per skip, focus or pending marker the framework spells its own way. */
  skips?: string;
  /** Assertion calls whose diagnostic arguments are not evidence of what a test checks. */
  calls?: readonly AssertionCall[];
  /** A named argument that carries a message, wherever it stands: `msg=`, `because:`. */
  messageArgument?: string;
}

export interface NamedTest {
  pattern: RegExp;
  /** A subtest, named after the test function it runs in: `TestParse/empty`. */
  sub?: true;
}

export interface CallContext {
  /** The whole file with comments and string content masked. */
  code: string;
  /** The statement's code before the call, back to the previous `;`, `{` or `}`. */
  chain: string;
}

export interface AssertionCall {
  /** The callee with its receiver (`assert_eq!`, `self.assertEqual`), or `.as` for a fluent call. */
  callee: RegExp;
  /** The indices of the diagnostic arguments of one call, given its arguments' code. */
  messages(args: readonly string[], context: CallContext): number[];
}

/** Arguments from index `n` on. */
const from =
  (n: number) =>
  (args: readonly string[]): number[] =>
    args.map((_, i) => i).filter((i) => i >= n);
const none = (): number[] => [];
const isString = (arg: string | undefined): boolean => /^\s*[@$]?"/.test(arg ?? "");

/** JUnit 4 puts the message first (`assertEquals(message, expected, actual)`); JUnit 5 last. */
const JUNIT4 = /\bimport\s+(?:static\s+)?(?:org\.junit\.(?:Assert|Test)\b|junit\.framework\.)/;
const junit =
  (base: number) =>
  (args: readonly string[], { code }: CallContext) =>
    JUNIT4.test(code) && !/\borg\.junit\.jupiter\./.test(code)
      ? args.length > base && isString(args[0])
        ? [0]
        : []
      : from(base)(args);

const JVM: readonly Language[] = ["java", "kotlin", "scala"];

const FRAMEWORKS: readonly TestFramework[] = [
  {
    name: "Jest, Vitest, Mocha, node:test",
    cases: String.raw`(?:^|[^.\w$])(?:it|test)(?:\.(?:each|concurrent|only|skip|todo|failing)\b[^(]*)?\s*\(`,
    named: [
      {
        pattern:
          /(?:^|[^.\w$])(?:it|test)(?:\.(?:concurrent|only|skip|todo|failing))?\s*\(\s*(["'`])(?<name>(?:(?!\1)[^\\\n])+)\1/d,
      },
    ],
    assertions: String.raw`\bexpect\s*\(|\bassert\w*\b`,
    calls: [{ callee: /^(?:expect|assert)$/, messages: from(1) }],
  },
  {
    name: "Node assert, Chai assert",
    languages: ["javascript", "typescript"],
    calls: [
      {
        callee:
          /^assert\.(?:ok|isOk|isNotOk|isTrue|isFalse|isNull|isNotNull|isUndefined|isDefined|exists|notExists|isEmpty|isNotEmpty|isNaN|isNotNaN)$/,
        messages: from(1),
      },
      { callee: /^assert\.fail$/, messages: from(0) },
      { callee: /^assert\.\w+$/, messages: from(2) },
    ],
  },
  {
    name: "pytest, unittest",
    languages: ["python"],
    cases: String.raw`^\s*(?:async\s+)?def\s+test\w*\s*\(`,
    named: [{ pattern: /^\s*(?:async\s+)?def\s+(?<name>test\w*)\s*\(/d }],
    calls: [
      { callee: /^(?:self\.)?assert(?:True|False|IsNone|IsNotNone)$/, messages: from(1) },
      // Their message is a keyword argument only.
      {
        callee: /^(?:self\.)?assert(?:Raises|RaisesRegex|Warns|WarnsRegex|Logs|NoLogs)$/,
        messages: none,
      },
      { callee: /^(?:self\.)?assert[A-Z]\w*$/, messages: from(2) },
      { callee: /^pytest\.fail$/, messages: from(0) },
    ],
    messageArgument: String.raw`^\s*msg\s*=`,
  },
  {
    name: "Go testing, testify",
    languages: ["go"],
    cases: String.raw`^func\s+Test\w*\s*\(|\b[a-z]\w*\.Run\s*\(`,
    named: [
      { pattern: /^func\s+(?<name>Test\w*)\s*\(/d },
      { pattern: /\b[a-z]\w*\.Run\s*\(\s*(["`])(?<name>(?:(?!\1)[^\\\n])+)\1/d, sub: true },
    ],
    assertions: String.raw`\bt\.(?:Error|Errorf|Fatal|Fatalf)\b|\brequire\.\w+\s*\(`,
    calls: [
      { callee: /^\w+\.(?:Fatalf?|Errorf?)$/, messages: from(0) },
      {
        callee:
          /^(?:assert|require)\.(?:True|False|Nil|NotNil|Empty|NotEmpty|NoError|Error|Zero|NotZero|Panics|NotPanics|Positive|Negative|Condition|FileExists|NoFileExists|DirExists|NoDirExists)f?$/,
        messages: from(2),
      },
      { callee: /^(?:assert|require)\.(?:Fail|FailNow)f?$/, messages: from(1) },
      {
        callee:
          /^(?:assert|require)\.(?:InDelta\w*|InEpsilon\w*|WithinDuration|WithinRange|Eventually\w*|Never)f?$/,
        messages: from(4),
      },
      { callee: /^(?:assert|require)\.[A-Z]\w*$/, messages: from(3) },
    ],
  },
  {
    name: "Rust test, tokio, rstest, test_case",
    languages: ["rust"],
    cases: String.raw`#\[(?:\w+::)*test\b(?:\([^\]]*\))?\]|#\[(?:rstest|test_case|case)\b`,
    attribute: String.raw`#\[(?:\w+::)*test\b(?:\([^\]]*\))?\]|#\[(?:rstest|test_case)\b`,
    calls: [
      { callee: /^(?:debug_|prop_)?assert!$/, messages: from(1) },
      { callee: /^(?:debug_|prop_)?assert_\w+!$/, messages: from(2) },
    ],
  },
  {
    // The guard has always read these attributes in every file.
    name: "JUnit, TestNG, xUnit, NUnit, MSTest",
    cases: String.raw`@(?:Test|ParameterizedTest)\b|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b`,
    attribute: String.raw`@(?:Test|ParameterizedTest)\b|\[(?:Fact|Theory|Test|TestMethod|TestCase)\b`,
    assertions: String.raw`\bAssert\.\w+`,
  },
  {
    name: "JUnit, kotlin.test, Hamcrest, AssertJ",
    languages: JVM,
    calls: [
      {
        callee:
          /^(?:(?:Assert|Assertions|kotlin\.test)\.)?(?:assertEquals|assertNotEquals|assertArrayEquals|assertSame|assertNotSame|assertIterableEquals|assertLinesMatch|assertInstanceOf|assertThrows|assertTimeout)$/,
        messages: junit(2),
      },
      {
        callee:
          /^(?:(?:Assert|Assertions|kotlin\.test)\.)?(?:assertTrue|assertFalse|assertNull|assertNotNull|assertDoesNotThrow)$/,
        messages: junit(1),
      },
      { callee: /^(?:(?:Assert|Assertions)\.)?fail$/, messages: from(0) },
      // Hamcrest's reason comes first: `assertThat(reason, actual, matcher)`.
      { callee: /^(?:\w+\.)?assertThat$/, messages: (args) => (args.length >= 3 ? [0] : []) },
      {
        callee: /^(?:Assertions\.)?assertAll$/,
        messages: (args) => (isString(args[0]) ? [0] : []),
      },
      {
        callee: /^\.(?:as|describedAs|withFailMessage|overridingErrorMessage)$/,
        messages: from(0),
      },
    ],
    messageArgument: String.raw`^\s*message\s*=`,
  },
  {
    name: "Kotest",
    languages: ["kotlin"],
    // StringSpec and FreeSpec blocks (`"parses a list" { }`), ShouldSpec, FeatureSpec and
    // BehaviorSpec leaves. FunSpec `test("...")` and DescribeSpec `it("...")` are read above.
    cases: String.raw`^\s*"[^"\n]*"\s*(?:-\s*)?\{|\b(?:should|scenario|[Tt]hen)\s*\(\s*"`,
    named: [
      { pattern: /^\s*"(?<name>[^"\n]+)"\s*\{/d },
      { pattern: /\b(?:should|scenario|[Tt]hen)\s*\(\s*"(?<name>[^"\n]+)"/d },
    ],
    assertions: String.raw`\bshould[A-Z]\w*`,
    calls: [{ callee: /^withClue$/, messages: (args) => (args.length ? [0] : []) }],
  },
  {
    // Ruby calls take no parentheses: `it "adds" do`, `assert_equal 3, sum`.
    name: "RSpec, Minitest, Test::Unit",
    languages: ["ruby"],
    cases: String.raw`^\s*[xf]?(?:it|specify|example|scenario)\b\s*\(?\s*(?:["':]|\{|do\b)|^\s*test\s*\(?\s*["']|^\s*def\s+test_\w*`,
    named: [
      {
        pattern:
          /^\s*[xf]?(?:it|specify|example|scenario|test)\s*\(?\s*(["'])(?<name>(?:(?!\1)[^\\\n])+)\1/d,
      },
      { pattern: /^\s*def\s+(?<name>test_\w+)/d },
    ],
    assertions: String.raw`\bexpect\s*\{|\bis_expected\b|\.(?:must|wont)_\w+|\b(?:assert|refute)(?:_\w+)?\b|\bflunk\b`,
    skips: String.raw`^\s*x(?:it|specify|example|scenario|describe|context|feature)\b|^\s*f(?:it|specify|example|describe|context)\b|^\s*(?:skip|pending)\b(?!\s*[=.:(]\s*[^"'\s)])|,\s*(?::skip\b|skip:\s|:focus\b|focus:\s*true\b)`,
    calls: [
      {
        callee: /^(?:assert|refute|assert_(?:nil|empty|predicate)|refute_(?:nil|empty))$/,
        messages: from(1),
      },
      { callee: /^(?:assert|refute)_raises$/, messages: none },
      { callee: /^flunk$/, messages: from(0) },
      { callee: /^(?:assert|refute)_\w+$/, messages: from(2) },
    ],
  },
  {
    name: "xUnit, NUnit, MSTest asserts, FluentAssertions",
    languages: ["csharp"],
    assertions: String.raw`\.Should\s*\(\s*\)`,
    calls: [
      {
        callee: /^(?:Assert|ClassicAssert)\.That$/,
        messages: (args) => from(isString(args[1]) ? 1 : 2)(args),
      },
      {
        callee:
          /^(?:Assert|ClassicAssert|CollectionAssert|StringAssert)\.(?:Fail|Pass|Inconclusive|Ignore|Warn)$/,
        messages: from(0),
      },
      // Their later arguments are code that asserts: `Assert.All(items, x => Assert.Equal(1, x))`.
      {
        callee:
          /^(?:Assert|ClassicAssert)\.(?:All|Collection|Multiple|Raises\w*|Throws\w*|Catch\w*|DoesNotThrow\w*)$/,
        messages: none,
      },
      {
        callee:
          /^(?:Assert|ClassicAssert|CollectionAssert|StringAssert)\.(?:True|False|IsTrue|IsFalse|Null|NotNull|IsNull|IsNotNull|IsEmpty|IsNotEmpty|Empty|NotEmpty|Zero|NotZero|Positive|Negative|IsNaN|AllItemsAreNotNull|AllItemsAreUnique|Single)$/,
        messages: from(1),
      },
      {
        callee: /^(?:Assert|ClassicAssert|CollectionAssert|StringAssert)\.\w+$/,
        messages: from(2),
      },
      // FluentAssertions: `x.Should().Be(4, "because ...")`; the reason follows the expected value.
      {
        callee:
          /^\.(?:BeTrue|BeFalse|BeNull|NotBeNull|BeEmpty|NotBeEmpty|BeNullOrEmpty|NotBeNullOrEmpty|BeNullOrWhiteSpace|NotBeNullOrWhiteSpace|HaveValue|NotHaveValue|BePositive|BeNegative|BeDefault|NotBeDefault|Throw|ThrowAsync|ThrowExactly|ThrowExactlyAsync|NotThrow|NotThrowAsync|BeInAscendingOrder|BeInDescendingOrder|OnlyHaveUniqueItems|NotContainNulls)$/,
        messages: (args, { chain }) => (FLUENT.test(chain) ? from(0)(args) : []),
      },
      {
        callee:
          /^\.(?!Should$|And$|Which$|Subject$|Where$|WithMessage$|WithInnerException$)[A-Z]\w*$/,
        messages: (args, { chain }) => (FLUENT.test(chain) ? from(1)(args) : []),
      },
    ],
    messageArgument: String.raw`^\s*(?:because|message|userMessage)\s*:`,
  },
  {
    // `It 'adds two numbers' { $x | Should -Be 4 }`: a command, so no parentheses around the
    // name, and `-Because` is a parameter rather than an argument.
    name: "Pester",
    languages: ["powershell"],
    cases: String.raw`^\s*It\s+['"]`,
    named: [{ pattern: /^\s*It\s+(['"])(?<name>(?:(?!\1)[^\n])+)\1/d }],
    assertions: String.raw`\bShould\s+-(?:Not)?[A-Z]\w*|\bShould-[A-Z]\w*`,
  },
  {
    // `test_that("adds", { expect_equal(add(1, 2), 3, info = "...") })` (#1500).
    name: "testthat",
    languages: ["r"],
    cases: String.raw`\btest_that\s*\(`,
    named: [{ pattern: /\btest_that\s*\(\s*(["'])(?<name>(?:(?!\1)[^\\\n])+)\1/d }],
    assertions: String.raw`\bexpect_\w+\s*\(`,
    calls: [{ callee: /^(?:testthat::)?fail$/, messages: from(0) }],
    messageArgument: String.raw`^\s*(?:info|label)\s*=`,
  },
];

const FLUENT = /\.Should\s*\(\s*\)/;

interface Conventions {
  cases: RegExp;
  named: NamedTest[];
  attribute: RegExp;
  assertions: RegExp;
  skips: RegExp;
  calls: AssertionCall[];
  messageArgument: RegExp | null;
}

const NEVER = "(?!)";
const byLanguage = new Map<Language, Conventions>();

/** The test and assertion conventions read in a file. */
export function testConventions(path: string): Conventions {
  const language = detectLanguageFromPath(path);
  const known = byLanguage.get(language);
  if (known) return known;
  const frameworks = FRAMEWORKS.filter((f) => !f.languages || f.languages.includes(language));
  const join = (parts: (string | undefined)[]) =>
    parts.filter((part): part is string => part !== undefined).join("|") || NEVER;
  const messageArguments = frameworks.flatMap((f) =>
    f.messageArgument ? [f.messageArgument] : [],
  );
  const conventions: Conventions = {
    cases: new RegExp(join(frameworks.map((f) => f.cases)), "g"),
    named: frameworks.flatMap((f) => f.named ?? []),
    attribute: new RegExp(join(frameworks.map((f) => f.attribute))),
    assertions: new RegExp(join(frameworks.map((f) => f.assertions)), "g"),
    skips: new RegExp(join(frameworks.map((f) => f.skips)), "g"),
    // Scoped frameworks first: their rules are more specific than the shared `assert(...)`.
    calls: [
      ...frameworks.filter((f) => f.languages),
      ...frameworks.filter((f) => !f.languages),
    ].flatMap((f) => f.calls ?? []),
    messageArgument: messageArguments.length ? new RegExp(messageArguments.join("|")) : null,
  };
  byLanguage.set(language, conventions);
  return conventions;
}

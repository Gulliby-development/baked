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
  /**
   * Read only by the guard's shadow measure (`testConventions(path, true)`, #2147): a language
   * that gains test titles also gains `test-removed` findings it never reported, so its row is
   * measured in shadow until bench rounds show what it would raise. Promoting it drops the flag.
   */
  shadow?: true;
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
    // XCTest and swift-testing. `@Test` is read by the JUnit row, `#expect(...)` by the
    // JavaScript row's `expect` (#1492). Test titles are the shadow row below.
    name: "XCTest, swift-testing",
    languages: ["swift"],
    assertions: String.raw`\bXCTAssert\w*\s*\(|\bXCTFail\s*\(|#require\s*\(`,
    skips: String.raw`\bXCTSkip(?:If|Unless)?\s*\(|\.disabled\s*\(|\bXCTExpectFailure\s*\(|\bwithKnownIssue\b`,
    calls: [
      {
        callee: /^XCTAssert(?:True|False|Nil|NotNil|NoThrow|ThrowsError)?$/,
        messages: from(1),
      },
      { callee: /^XCTUnwrap$/, messages: from(1) },
      { callee: /^XCTFail$/, messages: from(0) },
      { callee: /^XCTAssert\w+$/, messages: from(2) },
      { callee: /^(?:expect|require)$/, messages: from(1) },
    ],
  },
  {
    // XCTest `func testAdds()` and swift-testing `@Test func adds()`, measured in shadow (#2147).
    name: "XCTest, swift-testing titles",
    languages: ["swift"],
    shadow: true,
    cases: String.raw`^\s*func\s+test\w*\s*\(`,
    named: [
      { pattern: /^\s*func\s+(?<name>test\w*)\s*\(/d },
      { pattern: /@Test\b[^\n]*?\bfunc\s+(?<name>\w+)\s*\(/d },
    ],
  },
  {
    // `test("...")` (FunSuite, munit) and `assert(...)` are read by the JavaScript row, JUnit-style
    // `assertEquals` by the JVM row above (#1496).
    name: "ScalaTest, munit",
    languages: ["scala"],
    cases: String.raw`^\s*ignore\s*\(\s*"|(?:\b(?:it|they)|"[^"\n]*")\s+(?:should|must|can|ignore)\s+"[^"\n]*"\s+(?:in|ignore)\b|"[^"\n]*"\s+in\s*\{`,
    named: [
      { pattern: /^\s*ignore\s*\(\s*"(?<name>[^"\n]+)"/d },
      {
        pattern:
          /(?:\b(?:it|they)|"[^"\n]*")\s+(?:should|must|can)\s+"(?<name>[^"\n]+)"\s+(?:in|ignore)\b/d,
      },
    ],
    assertions: String.raw`\b(?:shouldBe|shouldEqual|shouldNot\w*|mustBe|mustEqual)\b|\b(?:should|must)\s+(?:be|equal|contain|have|include|startWith|endWith|matchPattern)\b|\b(?:intercept|assertThrows)\s*\[|\bassertResult\s*\(`,
    skips: String.raw`^\s*ignore\s*\(|(?:\b(?:it|they)|"[^"\n]*")\s+ignore\b|\b(?:should|must|can)\s+"[^"\n]*"\s+ignore\b|"[^"\n]*"\s*\.(?:ignore|only|flaky)\b|\bpending\b(?!\s*[=:(.])|\bcancel\s*\(`,
    calls: [
      { callee: /^withClue$/, messages: (args) => (args.length ? [0] : []) },
      { callee: /^assertResult$/, messages: none },
    ],
  },
  {
    // busted's `it("adds", function()` and luassert's `assert.are.equal` are read by the shared
    // rows above; LuaUnit names its tests `function TestSum:testAdds()` (#1495).
    name: "busted, LuaUnit",
    languages: ["lua"],
    cases: String.raw`^\s*function\s+[Tt]est\w*(?:[.:][Tt]est\w*)?\s*\(`,
    named: [{ pattern: /^\s*function\s+(?<name>[Tt]est\w*(?:[.:][Tt]est\w*)?)\s*\(/d }],
    skips: String.raw`(?:^|[^.\w])pending\s*\(|\blu\.skip(?:If|Unless)?\s*\(`,
  },
  {
    // bats: `@test "adds" {`, checks with `[ ... ]`, `[[ ... ]]` and bats-assert's `assert_output`;
    // shunit2: `testAdds() {` with `assertEquals` (#1497).
    name: "bats, shunit2",
    languages: ["bash"],
    cases: String.raw`^\s*@test\s+["']|^\s*(?:function\s+)?test\w+\s*\(\s*\)`,
    named: [
      { pattern: /^\s*@test\s+(["'])(?<name>(?:(?!\1)[^\\\n])+)\1/d },
      { pattern: /^\s*(?:function\s+)?(?<name>test\w+)\s*\(\s*\)/d },
    ],
    assertions: String.raw`^\s*\[\[?\s|\b(?:assert|refute)_\w+|\bassert[A-Z]\w*`,
    skips: String.raw`^\s*skip\b|\bstartSkipping\b`,
  },
  {
    // GoogleTest `TEST(SumTest, Adds)` (`TEST_F`, `TEST_P`, typed tests), Catch2 and doctest
    // `TEST_CASE("adds")`, Boost.Test `BOOST_AUTO_TEST_CASE(adds)`, and C's Unity `void
    // test_adds(void)` and Check `START_TEST(adds)` (#1490). A GoogleTest `DISABLED_` name, a
    // `GTEST_SKIP()`, Catch2's hidden `[.]` tag and `SKIP()`, Unity's `TEST_IGNORE()` and CMocka's
    // `skip()` keep a test from running.
    name: "GoogleTest, Catch2, doctest, Boost.Test, Unity, Check",
    languages: ["c", "cpp"],
    cases: String.raw`^\s*(?:(?:TYPED_)?TEST(?:_F|_P)?|TYPED_TEST_P|TEST_CASE|SCENARIO|BOOST_AUTO_TEST_CASE|START_TEST)\s*\(|^\s*void\s+test_?\w*\s*\(\s*void\s*\)`,
    named: [
      { pattern: /^\s*(?:TYPED_)?TEST(?:_F|_P)?\s*\(\s*\w+\s*,\s*(?<name>\w+)\s*\)/d },
      { pattern: /^\s*(?:TEST_CASE|SCENARIO)\s*\(\s*"(?<name>[^"\n]+)"/d },
      { pattern: /^\s*(?:BOOST_AUTO_TEST_CASE|START_TEST)\s*\(\s*(?<name>\w+)/d },
      { pattern: /^\s*void\s+(?<name>test_?\w*)\s*\(\s*void\s*\)/d },
    ],
    assertions: String.raw`\b(?:EXPECT|ASSERT)_[A-Z_]+\s*\(|\b(?:REQUIRE|CHECK)(?:_[A-Z_]+)?\s*\(|\bBOOST_(?:CHECK|REQUIRE|TEST)\w*\s*\(|\bTEST_ASSERT\w*\s*\(|\bck_assert\w*\s*\(|\bassert(?:_\w+)?\s*\(`,
    skips: String.raw`\bGTEST_SKIP\s*\(|\bDISABLED_\w|\bSKIP\s*\(|\bTEST_IGNORE(?:_MESSAGE)?\s*\(|^\s*skip\s*\(\s*\)|\bTEST_CASE\s*\([^)\n]*"[^"\n]*\[\.[^\]\n]*\]`,
  },
  {
    // package:test and flutter_test. `test("...")`, `group` and `expect(actual, matcher)` are read
    // by the JavaScript row above; the matcher is what the test checks, and the reason is named.
    name: "package:test, flutter_test",
    languages: ["dart"],
    cases: String.raw`(?:^|[^.\w$])testWidgets\s*\(`,
    named: [{ pattern: /(?:^|[^.\w$])testWidgets\s*\(\s*(["'])(?<name>(?:(?!\1)[^\\\n])+)\1/d }],
    assertions: String.raw`\bexpectLater\s*\(|(?:^|[^.\w$])fail\s*\(`,
    skips: String.raw`\bskip:\s*(?!false\b|null\b)\S|@Skip\b|\bsolo:\s*true\b|\bmarkTestSkipped\s*\(`,
    calls: [
      { callee: /^(?:expect|expectLater)$/, messages: none },
      { callee: /^fail$/, messages: from(0) },
    ],
    messageArgument: String.raw`^\s*reason\s*:`,
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
    // PHPUnit `public function testAdds(): void`. Pest's `it('adds', ...)` and `test(...)`, and
    // `$this->assertSame(...)`, are read by the JavaScript row; skips by the guard's own list.
    name: "PHPUnit",
    languages: ["php"],
    shadow: true,
    cases: String.raw`^\s*(?:(?:public|protected|private|static|final)\s+)*function\s+test\w*\s*\(`,
    named: [
      {
        pattern:
          /^\s*(?:(?:public|protected|private|static|final)\s+)*function\s+(?<name>test\w*)\s*\(/d,
      },
    ],
  },
  {
    // ExUnit `test "adds" do` (and `test "adds", %{conn: conn} do`); `assert` is read by the
    // JavaScript row.
    name: "ExUnit",
    languages: ["elixir"],
    shadow: true,
    cases: String.raw`^\s*test\s+"`,
    named: [{ pattern: /^\s*test\s+"(?<name>[^"\n]+)"/d }],
    assertions: String.raw`\brefute(?:_\w+)?\b`,
    skips: String.raw`@(?:module)?tag\s+(?::skip\b|skip:)`,
  },
  {
    // `test "adds" {` and decltests `test adds {`; `try testing.expect(...)` is read by the
    // JavaScript row's `expect`, its other `expect*` helpers here.
    name: "zig test",
    languages: ["zig"],
    shadow: true,
    cases: String.raw`^\s*test\b\s*(?:"[^"\n]*"|[A-Za-z_]\w*)?\s*\{`,
    named: [
      { pattern: /^\s*test\s+"(?<name>[^"\n]+)"\s*\{/d },
      { pattern: /^\s*test\s+(?<name>[A-Za-z_]\w*)\s*\{/d },
    ],
    assertions: String.raw`\bexpect(?:Equal|Error|Fmt|Approx|String|Deep)\w*\s*\(`,
    skips: String.raw`\berror\.SkipZigTest\b`,
  },
  {
    // Alcotest `test_case "adds" Quick f`, OUnit `"adds" >:: f`, ppx_inline_test and
    // ppx_expect `let%test "adds" =`. OUnit's `assert_equal` is read by the JavaScript row.
    name: "Alcotest, OUnit, ppx_inline_test",
    languages: ["ocaml"],
    shadow: true,
    cases: String.raw`\btest_case\s+"|"[^"\n]*"\s*>::|^\s*let%(?:test|test_unit|expect_test)\s+"`,
    named: [
      { pattern: /\btest_case\s+"(?<name>[^"\n]+)"/d },
      { pattern: /"(?<name>[^"\n]+)"\s*>::/d },
      { pattern: /^\s*let%(?:test|test_unit|expect_test)\s+"(?<name>[^"\n]+)"/d },
    ],
    assertions: String.raw`\bAlcotest\.check\b|\(\s*check\s+[\w.]+\s*\)|\[%expect\b`,
    skips: String.raw`\bAlcotest\.skip\b|\bskip_if\b`,
  },
  {
    // XCTest in Objective-C: `- (void)testAdds {`.
    name: "XCTest (Objective-C)",
    languages: ["objc"],
    shadow: true,
    cases: String.raw`^\s*-\s*\(\s*void\s*\)\s*test\w*`,
    named: [{ pattern: /^\s*-\s*\(\s*void\s*\)\s*(?<name>test\w*)/d }],
    assertions: String.raw`\bXCTAssert\w*\s*\(|\bXCTFail\s*\(`,
    skips: String.raw`\bXCTSkip(?:If|Unless)?\b`,
  },
  {
    // Foundry `function test_Adds() public` (`testFuzz_`, `testFail`); `assertEq` is read by the
    // JavaScript row.
    name: "Foundry",
    languages: ["solidity"],
    shadow: true,
    cases: String.raw`^\s*function\s+test\w*\s*\(`,
    named: [{ pattern: /^\s*function\s+(?<name>test\w*)\s*\(/d }],
    assertions: String.raw`\bvm\.expect(?:Revert|Emit|Call)\w*\s*\(`,
    skips: String.raw`\bvm\.skip\s*\(\s*true\b`,
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
const byLanguage = new Map<string, Conventions>();

/** Whether a file's language has a framework row read only in shadow (#2147). */
export function hasShadowTitles(path: string): boolean {
  const language = detectLanguageFromPath(path);
  return FRAMEWORKS.some((f) => f.shadow && f.languages?.includes(language));
}

/**
 * The test and assertion conventions read in a file; `shadow` also reads the rows measured in
 * shadow (#2147).
 */
export function testConventions(path: string, shadow = false): Conventions {
  const language = detectLanguageFromPath(path);
  const key = `${language}${shadow ? ":shadow" : ""}`;
  const known = byLanguage.get(key);
  if (known) return known;
  const frameworks = FRAMEWORKS.filter(
    (f) => (!f.languages || f.languages.includes(language)) && (shadow || !f.shadow),
  );
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
  byLanguage.set(key, conventions);
  return conventions;
}

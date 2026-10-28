import { posix } from "node:path";
import type { AcceptanceRow } from "./acceptance-rows-model.js";
import type { Task } from "./types.js";

/**
 * Inline acceptance rows (#1763): the host writes the audited rows and their parameterized test
 * into a marked block of a test file the task already writes, and the agent defines the harness
 * in the same file. A brief that names its test files leaves no room for the harness, test and
 * data files of the file mode, so 248 audited rows of bench round 52 were all re-typed by agents.
 * Every block uses only the language's standard library and its test framework.
 */
export type InlineRowTest = Extract<NonNullable<Task["rowTest"]>, { mode: "inline" }>;
type Framework = InlineRowTest["framework"];

/** The harness function each framework's block calls; the agent defines it in the test file. */
export const INLINE_HARNESS: Record<Framework, string> = {
  bun: "acceptanceActual",
  pytest: "acceptance_actual",
  go: "acceptanceActual",
  junit: "acceptanceActual",
  rust: "acceptance_actual",
  xunit: "AcceptanceActual",
  rspec: "acceptance_actual",
  phpunit: "acceptanceActual",
  testthat: "acceptance_actual",
  busted: "acceptance_actual",
  minitest: "acceptance_actual",
  pest: "$acceptanceActual",
  exunit: "acceptance_actual",
};

/**
 * The class of the JUnit and xUnit blocks, nested in the file's own class so the file keeps one
 * top-level type (#1804), as a written-tests run names it: the binary name of a JUnit `@Nested`
 * class, and the reflection name xUnit gives a nested class.
 */
export const INLINE_ROWS_CLASS = {
  junit: (cls: string) => `${cls}$AcceptanceRows`,
  xunit: (cls: string) => `${cls}+AcceptanceRows`,
};

/**
 * The first line of a block, in any framework, indented when it is nested in a class. The words
 * after the colon may change (#2004): blocks written before still match.
 */
export const INLINE_ROWS_BEGIN = /^[ \t]*(?:\/\/|#|--) BEGIN acceptance rows:/m;

/**
 * A host-written block of a test file: `tail` ends the file, `head` (Go imports) follows its
 * package clause. With `nest`, `tail` goes inside the file's own class instead, before its closing
 * brace and indented one level, since Java and C# briefs keep one top-level type per file (#1804).
 */
export interface InlineRowFile {
  path: string;
  inline: true;
  head?: string;
  tail: string;
  /** The file the host starts when the test file does not exist yet. */
  skeleton: string;
  nest?: {
    language: "java" | "csharp" | "php" | "elixir";
    className: string;
    namespace?: string;
  };
}

const comment = (framework: Framework): string =>
  framework === "busted"
    ? "--"
    : framework === "pytest" ||
        framework === "rspec" ||
        framework === "minitest" ||
        framework === "testthat" ||
        framework === "exunit"
      ? "#"
      : "//";
/**
 * Python's first line stays within ruff's and black's 88 columns, so its comment takes two (#1927),
 * and so does Java's, whose comment google-java-format wraps at 100 columns (#1961), and R's,
 * whose lintr default is 80.
 */
const begin = (framework: Framework, what = "acceptance rows"): string =>
  `${comment(framework)} BEGIN ${what}: cases from the spec's acceptance table.${framework === "pytest" || framework === "junit" || framework === "testthat" ? `\n${comment(framework)}` : ""} Edit ${INLINE_HARNESS[framework]}, not this block.`;
const end = (framework: Framework, what = "acceptance rows"): string =>
  `${comment(framework)} END ${what}`;
/**
 * gofmt and mix format separate a comment that follows a closing brace or `end` by a blank line, and ruff
 * and black put two blank lines between a function and a top-level comment.
 */
const block = (framework: Framework, body: string, what?: string): string =>
  `${begin(framework, what)}\n${body.replace(/\n+$/, "")}\n${framework === "go" || framework === "exunit" ? "\n" : framework === "pytest" ? "\n\n" : ""}${end(framework, what)}\n`;

const className = (path: string, suffix: string): string => posix.basename(path, suffix);
const camel = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("");
/**
 * Characters a host-written literal never holds raw (#1995): controls, format characters (U+FEFF,
 * U+200B, bidi marks) and separators other than the space (U+00A0, U+2028, U+3000). Go rejects a
 * U+FEFF anywhere but the start of a file, C# ends a line at U+2028, and none of them can be seen
 * in a diff. cfgquill (bench round 64) spent 9.7M tokens on a Go block that held a raw U+FEFF.
 */
export const LITERAL_ESCAPED = /(?! )[\p{Cc}\p{Cf}\p{Z}]/gu;

/** `text` with each character of `LITERAL_ESCAPED` written by `write`, the rest as it is. */
export const escapeInvisible = (text: string, write: (code: number) => string): string =>
  text.replace(LITERAL_ESCAPED, (ch) => write(ch.codePointAt(0) ?? 0));

/** `\uXXXX` per UTF-16 unit: JSON, JavaScript and Java read an astral character as a pair. */
export const utf16Escape = (code: number): string =>
  String.fromCodePoint(code)
    .split("")
    .map((unit) => `\\u${(unit.charCodeAt(0) ?? 0).toString(16).padStart(4, "0")}`)
    .join("");

/** JSON text whose strings escape every `LITERAL_ESCAPED` character, so it reads the same anywhere. */
export const jsonText = (value: unknown): string =>
  escapeInvisible(JSON.stringify(value), utf16Escape);

const data = (rows: AcceptanceRow[]): string =>
  jsonText(rows.map(({ id, input, expected }) => ({ id, input, expected })));
/**
 * JSON.stringify of the JSON text is a valid string literal in Python, Go, TypeScript and C#; the
 * text itself (`jsonText`) holds no character those languages read differently (#1995).
 */
const quoted = (text: string): string => escapeInvisible(JSON.stringify(text), utf16Escape);

/**
 * A Python string literal in the quotes ruff and black choose: double, unless single quotes need
 * fewer escapes.
 */
const pythonString = (text: string): string => {
  const quote = (text.match(/"/g)?.length ?? 0) > (text.match(/'/g)?.length ?? 0) ? "'" : '"';
  const body = [...text]
    .map((ch) => {
      if (ch === "\\" || ch === quote) return `\\${ch}`;
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return `\\x${code.toString(16).padStart(2, "0")}`;
      return escapeInvisible(ch, (c) =>
        c > 0xffff
          ? `\\U${c.toString(16).padStart(8, "0")}`
          : `\\u${c.toString(16).padStart(4, "0")}`,
      );
    })
    .join("");
  return `${quote}${body}${quote}`;
};

/**
 * The rows' JSON text as short string literals written by `write`, one row per literal, a long row
 * split over more, each at most 74 columns with its quotes, so a list of them stays within 79 and
 * ruff and black keep its layout at any line length (#1927), and RuboCop's 120 columns hold it
 * indented. A row's id starts its first literal.
 */
const literalChunks = (
  rows: AcceptanceRow[],
  write: (text: string) => string,
  width = 74,
): string[] => {
  const items = rows.map(({ id, input, expected }) => jsonText({ id, input, expected }));
  const pieces = items.length
    ? items.map((item, i) => `${i ? "" : "["}${item}${i < items.length - 1 ? "," : "]"}`)
    : ["[]"];
  const chunks: string[] = [];
  for (const piece of pieces) {
    let chunk = "";
    for (const ch of piece) {
      if (chunk && write(chunk + ch).length > width) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += ch;
    }
    if (chunk) chunks.push(chunk);
  }
  return chunks.map(write);
};

/**
 * A Ruby or PHP string literal: single-quoted, where only `\\` and `\'` are escapes, which is the
 * quote RuboCop's and Pint's defaults choose. A text holding a character of `LITERAL_ESCAPED`, which
 * a single-quoted literal can only hold raw, is double-quoted with `\u{...}` escapes (#1995), and
 * its interpolation sigil (`#` in Ruby, `$` in PHP) escaped. The rows' JSON text (`jsonText`)
 * never needs that.
 */
const singleQuoted =
  (sigil: "#" | "$") =>
  (text: string): string =>
    text.search(LITERAL_ESCAPED) < 0
      ? `'${text.replace(/[\\']/g, "\\$&")}'`
      : `"${escapeInvisible(
          text.replace(sigil === "#" ? /[\\"#]/g : /[\\"$]/g, "\\$&"),
          (code) => `\\u{${code.toString(16)}}`,
        )}"`;
export const rubyString = singleQuoted("#");
export const phpString = singleQuoted("$");

/**
 * An R string literal in the double quotes lintr's and styler's defaults ask for; a character of
 * `LITERAL_ESCAPED` is written as `\u{...}` or, beyond the BMP, `\U{...}` (#1995).
 */
export const rString = (text: string): string =>
  `"${escapeInvisible(text.replace(/[\\"]/g, "\\$&"), (code) =>
    code > 0xffff ? `\\U{${code.toString(16)}}` : `\\u{${code.toString(16)}}`,
  )}"`;

/**
 * A Java string literal; control characters are octal escapes, never \u (read before lexing). A
 * long text is split into literals of at most 60 characters joined by `+`, before a space where
 * one is near, as the pytest block's chunks are, so google-java-format finds no literal over its
 * line limit to reflow (#1961).
 */
export const javaString = (text: string, width = 60): string => {
  const chunks = [""];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Controls (U+0085 too) as octal, never \u, which Java reads before lexing; other invisible
    // characters as \u, which is safe for them (#1995).
    const unit =
      ch === '"' || ch === "\\"
        ? `\\${ch}`
        : code < 0x20 || (code >= 0x7f && code <= 0x9f)
          ? `\\${code.toString(8).padStart(3, "0")}`
          : escapeInvisible(ch, utf16Escape);
    const chunk = chunks.at(-1) ?? "";
    if (chunk.length + unit.length > width) {
      // At a space in its second half when there is one, which then starts the next literal.
      const space = chunk.lastIndexOf(" ");
      const at = space > width / 2 ? space : chunk.length;
      chunks[chunks.length - 1] = chunk.slice(0, at);
      chunks.push(chunk.slice(at));
    }
    chunks[chunks.length - 1] += unit;
  }
  return chunks.map((chunk) => `"${chunk}"`).join(" + ");
};
export const javaValue = (value: unknown): string => {
  if (value === null) return "(Object) null";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isInteger(value) ? `${value}L` : `${value}d`;
  if (typeof value === "string") return javaString(value);
  if (Array.isArray(value)) return `list(${value.map(javaValue).join(", ")})`;
  return `map(${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${javaString(key)}, ${javaValue(item)}`)
    .join(", ")})`;
};

const rustString = (text: string): string =>
  `"${[...text]
    .map((ch) => {
      if (ch === '"' || ch === "\\") return `\\${ch}`;
      return escapeInvisible(ch, (c) => `\\u{${c.toString(16)}}`);
    })
    .join("")}"`;
const rustNumber = (value: number): string => {
  const text = String(value);
  return `${/[.e]/.test(text) ? text : `${text}.0`}_f64`;
};
const rustValue = (value: unknown): string => {
  if (value === null) return "AcceptanceJson::Null";
  if (typeof value === "boolean") return `AcceptanceJson::Bool(${value})`;
  if (typeof value === "number") return `AcceptanceJson::Number(${rustNumber(value)})`;
  if (typeof value === "string") return `AcceptanceJson::String(${rustString(value)}.to_string())`;
  if (Array.isArray(value))
    return `AcceptanceJson::Array(vec![${value.map(rustValue).join(", ")}])`;
  return `AcceptanceJson::Object(vec![${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `(${rustString(key)}.to_string(), ${rustValue(item)})`)
    .join(", ")}])`;
};

/** Instance methods: a static member of an inner class needs Java 16. */
const JAVA_HELPERS = `  private java.util.Map<String, Object> map(Object... entries) {
    java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
    for (int i = 0; i < entries.length; i += 2) out.put((String) entries[i], entries[i + 1]);
    return out;
  }

  private java.util.List<Object> list(Object... items) {
    return new java.util.ArrayList<>(java.util.Arrays.asList(items));
  }

  /** JSON numbers compare by value: 2, 2L and 2.0 are equal; collections compare as lists. */
  private Object normal(Object value) {
    if (value == null || value instanceof String || value instanceof Boolean) return value;
    if (value instanceof Character || value instanceof Enum) return value.toString();
    if (value instanceof Double || value instanceof Float || value instanceof java.math.BigDecimal) {
      double number = ((Number) value).doubleValue();
      return number == Math.rint(number) && Math.abs(number) <= 9007199254740991d ? (Object) (long) number : (Object) number;
    }
    if (value instanceof Number) return ((Number) value).longValue();
    if (value instanceof java.util.Map) {
      java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
      for (java.util.Map.Entry<?, ?> entry : ((java.util.Map<?, ?>) value).entrySet())
        out.put(String.valueOf(entry.getKey()), normal(entry.getValue()));
      return out;
    }
    java.util.List<Object> out = new java.util.ArrayList<>();
    if (value instanceof Iterable) {
      for (Object item : (Iterable<?>) value) out.add(normal(item));
      return out;
    }
    if (value.getClass().isArray()) {
      for (int i = 0; i < java.lang.reflect.Array.getLength(value); i++) out.add(normal(java.lang.reflect.Array.get(value, i)));
      return out;
    }
    return value;
  }`;

/**
 * The JSON value of the Rust block. No lint attribute: test integrity counts an added allow as a
 * suppression, so the accessors are a trait (never dead code) and the test builds every variant.
 */
const RUST_JSON = `/// A JSON value: the harness's input and result. Numbers compare by value, objects by their entries.
#[derive(Clone, Debug)]
pub enum AcceptanceJson {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<AcceptanceJson>),
    Object(Vec<(String, AcceptanceJson)>),
}

impl PartialEq for AcceptanceJson {
    fn eq(&self, other: &Self) -> bool {
        use AcceptanceJson::*;
        match (self, other) {
            (Null, Null) => true,
            (Bool(a), Bool(b)) => a == b,
            (Number(a), Number(b)) => a == b,
            (String(a), String(b)) => a == b,
            (Array(a), Array(b)) => a == b,
            (Object(a), Object(b)) => {
                a.len() == b.len() && a.iter().all(|(k, v)| b.iter().any(|(l, w)| k == l && v == w))
            }
            _ => false,
        }
    }
}

/// Reads an AcceptanceJson: each accessor is None for another kind of value.
pub trait AcceptanceJsonRead {
    fn as_f64(&self) -> Option<f64>;
    fn as_i64(&self) -> Option<i64>;
    fn as_bool(&self) -> Option<bool>;
    fn as_str(&self) -> Option<&str>;
    fn as_array(&self) -> Option<&[AcceptanceJson]>;
    fn get(&self, key: &str) -> Option<&AcceptanceJson>;
    fn is_null(&self) -> bool;
}

impl AcceptanceJsonRead for AcceptanceJson {
    fn as_f64(&self) -> Option<f64> {
        if let AcceptanceJson::Number(n) = self { Some(*n) } else { None }
    }
    fn as_i64(&self) -> Option<i64> {
        self.as_f64().filter(|n| n.fract() == 0.0).map(|n| n as i64)
    }
    fn as_bool(&self) -> Option<bool> {
        if let AcceptanceJson::Bool(b) = self { Some(*b) } else { None }
    }
    fn as_str(&self) -> Option<&str> {
        if let AcceptanceJson::String(s) = self { Some(s) } else { None }
    }
    fn as_array(&self) -> Option<&[AcceptanceJson]> {
        if let AcceptanceJson::Array(items) = self { Some(items) } else { None }
    }
    fn get(&self, key: &str) -> Option<&AcceptanceJson> {
        if let AcceptanceJson::Object(entries) = self {
            entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
        } else {
            None
        }
    }
    fn is_null(&self) -> bool {
        matches!(self, AcceptanceJson::Null)
    }
}

impl From<bool> for AcceptanceJson {
    fn from(value: bool) -> Self { AcceptanceJson::Bool(value) }
}
impl From<f64> for AcceptanceJson {
    fn from(value: f64) -> Self { AcceptanceJson::Number(value) }
}
impl From<i64> for AcceptanceJson {
    fn from(value: i64) -> Self { AcceptanceJson::Number(value as f64) }
}
impl From<i32> for AcceptanceJson {
    fn from(value: i32) -> Self { AcceptanceJson::Number(value as f64) }
}
impl From<u64> for AcceptanceJson {
    fn from(value: u64) -> Self { AcceptanceJson::Number(value as f64) }
}
impl From<usize> for AcceptanceJson {
    fn from(value: usize) -> Self { AcceptanceJson::Number(value as f64) }
}
impl From<&str> for AcceptanceJson {
    fn from(value: &str) -> Self { AcceptanceJson::String(value.to_string()) }
}
impl From<String> for AcceptanceJson {
    fn from(value: String) -> Self { AcceptanceJson::String(value) }
}
impl<T: Into<AcceptanceJson>> From<Vec<T>> for AcceptanceJson {
    fn from(value: Vec<T>) -> Self { AcceptanceJson::Array(value.into_iter().map(Into::into).collect()) }
}
impl<T: Into<AcceptanceJson>> From<Option<T>> for AcceptanceJson {
    fn from(value: Option<T>) -> Self { value.map_or(AcceptanceJson::Null, Into::into) }
}`;

type Template = (
  test: InlineRowTest,
  rows: AcceptanceRow[],
) => Omit<InlineRowFile, "path" | "inline">;

/**
 * What the RSpec blocks share: the rows as examples, each result compared as JSON data. No quote
 * inside an interpolation, which StandardRB's double quotes would end the message at.
 */
export const rspecExamples = (call: string): string =>
  `RSpec.describe 'acceptance rows' do\n  acceptance_rows.each do |row|\n    id = row['id']\n    it id do\n      got = JSON.parse(JSON.generate([${call}(row['input'])]))[0]\n      want = row['expected']\n      expect(got).to eq(want), "#{id}: got #{JSON.generate([got])}, want #{JSON.generate([want])}"\n    end\n  end\nend`;

/**
 * What the Minitest blocks share: a test class assigned to a constant named after the file, so no
 * two files share a class, whose block keeps the file's locals, with one test per row named by its
 * id. The failure message starts with the id and what the harness got, since Minitest prints the
 * test's name on a line of its own and the replay reads the row from a failure line. A null row
 * uses `assert_nil`, as Minitest 6 asks (#2348).
 */
export const minitestRows = (name: string, call: string): string =>
  `${name} = Class.new(Minitest::Test) do\n  acceptance_rows.each do |row|\n    id = row['id']\n    define_method("test_#{id}") do\n      got = JSON.parse(JSON.generate([${call}(row['input'])]))[0]\n      want = row['expected']\n      message = "#{id}: got #{JSON.generate([got])}"\n      want.nil? ? assert_nil(got, message) : assert_equal(want, got, message)\n    end\n  end\nend`;

/** The constant of a Minitest rows class, from its test file's name. */
export const minitestClass = (test: string): string =>
  `AcceptanceRows${camel(posix.basename(test, ".rb"))}`;

/**
 * The PHPUnit test method and its JSON normalizer, which both modes share. The method is named
 * `test`, which Pint's snake case and PHP-CS-Fixer's camel case both keep; it compares every row
 * and fails once, naming each failing row with what it got (#2335).
 */
export const phpunitMethods = (call: string, normal: string, rows: string): string =>
  `public function test(): void\n{\n${rows}\n    $failed = [];\n    foreach ($rows as $row) {\n        $actual = ${call}($row['input']);\n        $got = self::${normal}(json_decode(json_encode([$actual], JSON_THROW_ON_ERROR), true)[0]);\n        $want = self::${normal}($row['expected']);\n        if ($got !== $want) {\n            $failed[] = $row['id'].': got '.json_encode($got).', want '.json_encode($want);\n        }\n    }\n    $this->assertSame([], $failed, implode("\\n", $failed));\n}\n\n/** JSON numbers compare by value, so 2 and 2.0 are equal; objects compare by their entries. */\nprivate static function ${normal}(mixed $value): mixed\n{\n    if (is_float($value) && floor($value) === $value && abs($value) <= 9007199254740991) {\n        return (int) $value;\n    }\n    if (is_array($value)) {\n        $value = array_map(self::${normal}(...), $value);\n        ksort($value);\n    }\n\n    return $value;\n}`;

/**
 * A Lua string literal in the quotes StyLua's default (`AutoPreferDouble`) chooses: double, unless
 * single quotes need fewer escapes. A character of `LITERAL_ESCAPED` is written as decimal escapes of
 * its UTF-8 bytes, which Lua 5.1 and LuaJIT read too (#1995).
 */
export const luaString = (text: string): string => {
  const quote = (text.match(/"/g)?.length ?? 0) > (text.match(/'/g)?.length ?? 0) ? "'" : '"';
  const body = text.replace(quote === '"' ? /[\\"]/g : /[\\']/g, "\\$&");
  return `${quote}${escapeInvisible(body, (code) =>
    [...new TextEncoder().encode(String.fromCodePoint(code))].map((byte) => `\\${byte}`).join(""),
  )}${quote}`;
};

/**
 * What the busted blocks share: one `it` per row, named by its id, whose failure message starts
 * with the id and says what it got, since busted prints the test's name on a line of its own and
 * the replay reads the row from a failure line. dkjson decodes null as its own `null` value, so a null in a table is kept, and the
 * result goes through JSON as the expected value came; `assert.same` compares tables by their
 * entries. dkjson is no new dependency: busted itself requires it (#2348). Tabs, as StyLua's
 * default indents.
 */
export const bustedRows = (call: string): string =>
  `describe("acceptance rows", function()\n\tfor _, row in ipairs(acceptance_rows) do\n\t\tit(row.id, function()\n\t\t\tlocal got = ${call}(row.input)\n\t\t\tif got == nil then\n\t\t\t\tgot = acceptance_json.null\n\t\t\tend\n\t\t\tlocal text = acceptance_json.encode({ got })\n\t\t\tlocal value = acceptance_json.decode(text, 1, acceptance_json.null)[1]\n\t\t\tassert.same(row.expected, value, row.id .. ": got " .. text)\n\t\tend)\n\tend\nend)`;

/**
 * What the testthat blocks share: one `test_that` per row, named by its id, so a failure line names
 * the row. The result goes through JSON as the expected value came, so a length-one vector is a
 * scalar, NULL is null and a named list an object, whose entries compare by name. jsonlite is no
 * new dependency: testthat 3 imports it (#2348).
 */
export const testthatRows = (call: string): string =>
  `acceptance_normal <- function(value) {\n  if (is.list(value) && !is.null(names(value))) {\n    value <- value[order(names(value))]\n  }\n  if (is.list(value)) {\n    value <- lapply(value, acceptance_normal)\n  }\n  value\n}\n\nfor (acceptance_row in acceptance_rows) {\n  test_that(acceptance_row$id, {\n    got <- jsonlite::fromJSON(\n      jsonlite::toJSON(\n        list(${call}(acceptance_row$input)),\n        auto_unbox = TRUE,\n        digits = NA,\n        null = "null"\n      ),\n      simplifyVector = FALSE\n    )[[1]]\n    expect_equal(\n      acceptance_normal(got),\n      acceptance_normal(acceptance_row$expected)\n    )\n  })\n}`;

/**
 * What the Pest blocks share: one `test` per row, named by its id, so Pest's FAILED line names the
 * row. The harness and the JSON normalizer are closures in variables, which Pest's include of each
 * test file keeps to that file, so no two files share a function name (#2348).
 */
export const pestRows = (): string =>
  `$acceptanceNormal = function (mixed $value) use (&$acceptanceNormal): mixed {\n    // JSON numbers compare by value, so 2 and 2.0 are equal; objects compare by their entries.\n    if (is_float($value) && floor($value) === $value && abs($value) <= 9007199254740991) {\n        return (int) $value;\n    }\n    if (is_array($value)) {\n        $value = array_map($acceptanceNormal, $value);\n        ksort($value);\n    }\n\n    return $value;\n};\n\nforeach ($acceptanceRows as $acceptanceRow) {\n    test($acceptanceRow['id'], function () use ($acceptanceRow, $acceptanceActual, $acceptanceNormal) {\n        $actual = $acceptanceActual($acceptanceRow['input']);\n        $got = $acceptanceNormal(json_decode(json_encode([$actual], JSON_THROW_ON_ERROR), true)[0]);\n        expect($got)->toBe($acceptanceNormal($acceptanceRow['expected']));\n    });\n}`;

/**
 * An Elixir string literal: double-quoted, with `#{` escaped so nothing interpolates, and a
 * character of `LITERAL_ESCAPED` written as `\u{...}` (#1995).
 */
export const elixirString = (text: string): string =>
  `"${escapeInvisible(
    text.replace(/[\\"]/g, "\\$&").replace(/#\{/g, "\\#{"),
    (code) => `\\u{${code.toString(16)}}`,
  )}"`;

/**
 * What the ExUnit blocks share: one `test` per row, named by its id, defined when the module
 * compiles with the row in a module attribute. The result goes through JSON as the expected value
 * came, and `==` compares 2 with 2.0 and maps by their entries. The failure message starts with
 * the id and what it got, since ExUnit prints the test's name on a line with no failure word and
 * the replay reads the row from a failure line. JSON is Elixir's own from 1.18 (#2348).
 */
export const exunitRows = (rows: string, context: string, call: string): string =>
  `for acceptance_row <- ${rows} do\n  @acceptance_row acceptance_row\n\n  test @acceptance_row["id"]${context} do\n    row = @acceptance_row\n    [got] = JSON.decode!(JSON.encode!([${call}(row["input"])]))\n    want = row["expected"]\n    assert got == want, "#{row["id"]}: got #{JSON.encode!(got)}, want #{JSON.encode!(want)}"\n  end\nend`;

/** The module of an ExUnit test file, from its name: `CalcTest` for `calc_test.exs`. */
export const exunitModule = (test: string): string => camel(posix.basename(test, ".exs"));

/** The import of a PHP test file the host starts, so Pint finds no fully qualified name. */
const PHPUNIT_USE = "use PHPUnit\\Framework\\TestCase;";

/** A PHP namespace from a row package, which spells its separators as dots. */
export const phpNamespace = (pkg: string): string => pkg.replaceAll(".", "\\");

const TEMPLATES: Record<Framework, Template> = {
  // No type literal: a semicolon-free formatter drops its member separators (#1948). A destructured
  // parameter keeps its parentheses under any arrowParens option (#1961).
  bun: ({ test }, rows) => ({
    skeleton: "",
    tail: block(
      "bun",
      `import { expect as acceptanceExpect, test as acceptanceTest } from "bun:test";\nconst acceptanceRows${/\.tsx?$/.test(test) ? ": Record<string, unknown>[]" : ""} = JSON.parse(${quoted(data(rows))});\nacceptanceTest.each(acceptanceRows)("$id", async ({ input, expected }) => {\n  acceptanceExpect(await acceptanceActual(input)).toEqual(expected);\n});`,
    ),
  }),
  // No import statement: below the file's own code one is E402 and an import block of its own for
  // isort (I001), and the formatter checks run on the whole file (#1927).
  pytest: (_, rows) => {
    const text = literalChunks(rows, pythonString)
      .map((chunk) => `    ${chunk},\n`)
      .join("");
    return {
      skeleton: "",
      tail: block(
        "pytest",
        `_acceptance_json = __import__("json")\n_acceptance_pytest = __import__("pytest")\n\n_ACCEPTANCE_TEXT = [\n${text}]\n_ACCEPTANCE_ROWS = _acceptance_json.loads("".join(_ACCEPTANCE_TEXT))\n\n\n@_acceptance_pytest.mark.parametrize(\n    "row",\n    _ACCEPTANCE_ROWS,\n    ids=[row["id"] for row in _ACCEPTANCE_ROWS],\n)\ndef test_acceptance_row(row):\n    assert acceptance_actual(row["input"]) == row["expected"]`,
      ),
    };
  },
  go: ({ test, package: pkg }, rows) => ({
    skeleton: `package ${pkg}\n`,
    head: block(
      "go",
      `import (\n\tacceptancejson "encoding/json"\n\tacceptancereflect "reflect"\n\tacceptancetesting "testing"\n)`,
      "acceptance rows imports",
    ),
    tail: block(
      "go",
      `func TestAcceptanceRows${camel(posix.basename(test, "_test.go"))}(t *acceptancetesting.T) {\n\tvar rows []struct {\n\t\tID       string \`json:"id"\`\n\t\tInput    any    \`json:"input"\`\n\t\tExpected any    \`json:"expected"\`\n\t}\n\tif err := acceptancejson.Unmarshal([]byte(${quoted(data(rows))}), &rows); err != nil {\n\t\tt.Fatal(err)\n\t}\n\tfor _, row := range rows {\n\t\trow := row\n\t\tt.Run(row.ID, func(t *acceptancetesting.T) {\n\t\t\tgot, err := acceptanceActual(row.Input)\n\t\t\tif err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\ttext, err := acceptancejson.Marshal(got)\n\t\t\tif err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\tvar value any\n\t\t\tif err := acceptancejson.Unmarshal(text, &value); err != nil {\n\t\t\t\tt.Fatal(err)\n\t\t\t}\n\t\t\tif !acceptancereflect.DeepEqual(value, row.Expected) {\n\t\t\t\twant, _ := acceptancejson.Marshal(row.Expected)\n\t\t\t\tt.Fatalf("got %s, want %s", text, want)\n\t\t\t}\n\t\t})\n\t}\n}`,
    ),
  }),
  // A @Nested class in the file's own class: JUnit runs it with the outer class.
  junit: ({ test, package: pkg }, rows) => {
    const cls = className(test, ".java");
    return {
      skeleton: `package ${pkg};\n`,
      nest: { language: "java", className: cls },
      tail: block(
        "junit",
        `@org.junit.jupiter.api.Nested\nclass AcceptanceRows {\n  @org.junit.jupiter.api.TestFactory\n  java.util.stream.Stream<org.junit.jupiter.api.DynamicTest> acceptanceRows() {\n    return java.util.stream.Stream.of(\n${rows.map((row) => `        row(${javaString(row.id)}, ${javaValue(row.input)}, ${javaValue(row.expected)})`).join(",\n")});\n  }\n\n  private org.junit.jupiter.api.DynamicTest row(String id, Object input, Object expected) {\n    return org.junit.jupiter.api.DynamicTest.dynamicTest(\n        id, () -> org.junit.jupiter.api.Assertions.assertEquals(normal(expected), normal(${cls}.acceptanceActual(input)), id));\n  }\n\n${JAVA_HELPERS}\n}`,
      ),
    };
  },
  rust: (_, rows) => ({
    skeleton: "",
    tail: block(
      "rust",
      `${RUST_JSON}\n\n#[test]\nfn acceptance_rows() {\n    // Every kind of value, so none reads as dead code.\n    let kinds = [AcceptanceJson::Null, AcceptanceJson::Bool(false), AcceptanceJson::Number(0.0), AcceptanceJson::String(String::new()), AcceptanceJson::Array(Vec::new()), AcceptanceJson::Object(Vec::new())];\n    assert_eq!(kinds.len(), 6);\n    let rows: Vec<(&str, AcceptanceJson, AcceptanceJson)> = vec![\n${rows.map((row) => `        (${rustString(row.id)}, ${rustValue(row.input)}, ${rustValue(row.expected)}),`).join("\n")}\n    ];\n    let mut failed = Vec::new();\n    for (id, input, expected) in &rows {\n        let got = acceptance_actual(input);\n        if &got != expected {\n            failed.push(format!("{}: got {:?}, want {:?}", id, got, expected));\n        }\n    }\n    assert!(failed.is_empty(), "{}", failed.join("\\n"));\n}`,
    ),
  }),
  // A public class nested in the file's own class, which xUnit discovers; it names the harness fully.
  xunit: ({ test, package: pkg }, rows) => {
    const cls = className(test, ".cs");
    return {
      skeleton: "",
      nest: { language: "csharp", className: cls, ...(pkg ? { namespace: pkg } : {}) },
      tail: block(
        "xunit",
        `public class AcceptanceRows\n{\n    private const string Rows = ${quoted(data(rows))};\n\n    public static global::System.Collections.Generic.IEnumerable<object[]> Data()\n    {\n        foreach (var row in global::System.Text.Json.Nodes.JsonNode.Parse(Rows)!.AsArray())\n            yield return new object[]\n            {\n                (string)row!["id"]!,\n                row["input"]?.ToJsonString() ?? "null",\n                row["expected"]?.ToJsonString() ?? "null",\n            };\n    }\n\n    [global::Xunit.Theory]\n    [global::Xunit.MemberData(nameof(Data))]\n    public void AcceptanceRow(string id, string input, string expected)\n    {\n        var actual = global::System.Text.Json.JsonSerializer.SerializeToNode(global::${pkg}.${cls}.AcceptanceActual(global::System.Text.Json.Nodes.JsonNode.Parse(input)));\n        global::Xunit.Assert.True(\n            global::System.Text.Json.Nodes.JsonNode.DeepEquals(actual, global::System.Text.Json.Nodes.JsonNode.Parse(expected)),\n            $"{id}: got {actual?.ToJsonString() ?? "null"}, want {expected}");\n    }\n}`,
      ),
    };
  },
  // Top-level locals, which each spec file has its own of, and the harness captured as a Method
  // when the file loads, so a later file that defines acceptance_actual again changes nothing here.
  rspec: (_, rows) => ({
    skeleton: "",
    tail: block(
      "rspec",
      `require 'json'\n\nacceptance_harness = method(:acceptance_actual)\nacceptance_rows = JSON.parse(\n  [\n${literalChunks(
        rows,
        rubyString,
      )
        .map((chunk) => `    ${chunk}`)
        .join(",\n")}\n  ].join\n)\n\n${rspecExamples("acceptance_harness.call")}`,
    ),
  }),
  // Closures in the file's own variables: Pest includes each test file in a scope of its own.
  pest: (_, rows) => ({
    skeleton: "<?php\n",
    tail: block(
      "pest",
      `$acceptanceRows = json_decode(implode('', [\n${literalChunks(rows, phpString)
        .map((chunk) => `    ${chunk},\n`)
        .join("")}]), true, 512, JSON_THROW_ON_ERROR);\n\n${pestRows()}`,
    ),
  }),
  // The harness captured as a Method when the file loads, as in RSpec, and the rows as a class of
  // the file's own name, since Minitest loads every test file into one process. The file loads
  // Minitest itself (a second require of minitest/autorun is RuboCop's Lint/DuplicateRequire).
  minitest: ({ test }, rows) => ({
    skeleton: "",
    tail: block(
      "minitest",
      `require 'json'\n\nacceptance_harness = method(:acceptance_actual)\nacceptance_rows = JSON.parse(\n  [\n${literalChunks(
        rows,
        rubyString,
      )
        .map((chunk) => `    ${chunk}`)
        .join(
          ",\n",
        )}\n  ].join\n)\n\n${minitestRows(minitestClass(test), "acceptance_harness.call")}`,
    ),
  }),
  // In the file's own module, before its `end`, so the block calls the module's own
  // acceptance_actual, private or public, and the file keeps the module mix test names it by.
  exunit: ({ test }, rows) => ({
    skeleton: "",
    nest: { language: "elixir", className: exunitModule(test) },
    tail: block(
      "exunit",
      `@acceptance_text [\n${literalChunks(rows, elixirString)
        .map((chunk) => `  ${chunk}`)
        .join(
          ",\n",
        )}\n]\n\n${exunitRows("JSON.decode!(Enum.join(@acceptance_text))", "", "acceptance_actual")}`,
    ),
  }),
  // Methods of the file's own class, which PSR-1 keeps to one per file; the harness is its static
  // method, so two test files never share a name.
  phpunit: ({ test, package: pkg }, rows) => {
    const cls = className(test, ".php");
    const text = literalChunks(rows, phpString)
      .map((chunk) => `        ${chunk},\n`)
      .join("");
    return {
      skeleton: `<?php\n${pkg ? `\nnamespace ${phpNamespace(pkg)};\n` : ""}\n${PHPUNIT_USE}\n`,
      nest: { language: "php", className: cls },
      tail: block(
        "phpunit",
        phpunitMethods(
          "self::acceptanceActual",
          "acceptanceNormal",
          `    $text = implode('', [\n${text}    ]);\n    $rows = json_decode($text, true, 512, JSON_THROW_ON_ERROR);`,
        ),
      ),
    };
  },
  // Locals of the spec file, so two spec files never share a name; the harness is a local
  // function above the block.
  busted: (_, rows) => ({
    skeleton: "",
    tail: block(
      "busted",
      `local acceptance_json = require("dkjson")\nlocal acceptance_text = {\n${literalChunks(
        rows,
        luaString,
      )
        .map((chunk) => `\t${chunk},\n`)
        .join(
          "",
        )}}\nlocal acceptance_rows = acceptance_json.decode(table.concat(acceptance_text), 1, acceptance_json.null)\n\n${bustedRows("acceptance_actual")}`,
    ),
  }),
  // testthat runs each file in an environment of its own, so the block's names are the file's.
  testthat: (_, rows) => ({
    skeleton: "",
    tail: block(
      "testthat",
      `acceptance_rows <- jsonlite::fromJSON(\n  paste0(\n${literalChunks(rows, rString)
        .map((chunk) => `    ${chunk}`)
        .join(",\n")}\n  ),\n  simplifyVector = FALSE\n)\n\n${testthatRows("acceptance_actual")}`,
    ),
  }),
};

export function inlineRowFile(test: InlineRowTest, rows: AcceptanceRow[]): InlineRowFile {
  return { path: test.test, inline: true, ...TEMPLATES[test.framework](test, rows) };
}

/**
 * The lines of the marked block of `file` in `text`, or null: from its BEGIN line, found by the
 * marker up to its first colon so a block written under older wording is found too, to its END
 * line. Either may be indented.
 */
function blockLines(text: string, file: string): { from: number; to: number } | null {
  const lines = file.trimEnd().split("\n");
  const first = (lines[0] ?? "").trim();
  const marker = first.slice(0, first.indexOf(":") + 1) || first;
  const last = (lines.at(-1) ?? "").trim();
  const all = text.split("\n");
  const from = all.findIndex((line) => line.trim().startsWith(marker));
  if (from < 0) return null;
  const to = all.findIndex((line, i) => i > from && line.trim() === last);
  return to < 0 ? null : { from, to };
}

/** The marked block of `text` as character offsets, its final newline included, or null. */
function span(text: string, file: string): { from: number; to: number } | null {
  const lines = blockLines(text, file);
  if (!lines) return null;
  const all = text.split("\n");
  const offset = (line: number) => all.slice(0, line).reduce((sum, l) => sum + l.length + 1, 0);
  const to = offset(lines.to) + (all[lines.to]?.length ?? 0);
  return { from: offset(lines.from), to: text[to] === "\n" ? to + 1 : to };
}

/** Whitespace and a closing bracket, read at a set position. */
const CLOSER = /\s*[)\]}]/y;
/** Files whose statements end at a line without a semicolon. */
const OPTIONAL_SEMICOLONS = /\.[cm]?[jt]sx?$/;
/**
 * Whether the semicolon at `at` ends or starts its line (spaces and tabs aside) or comes before a
 * closing brace.
 */
function optionalSemicolon(text: string, at: number): boolean {
  let before = at - 1;
  while (text[before] === " " || text[before] === "\t") before--;
  if (before < 0 || text[before] === "\n") return true;
  let after = at + 1;
  while (text[after] === " " || text[after] === "\t" || text[after] === "\r") after++;
  return after >= text.length || text[after] === "\n" || text[after] === "}";
}

/** A single bare arrow parameter with or without its parentheses, read at a set position. */
const ARROW_PARAMETER = /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>|([A-Za-z_$][\w$]*)\s*=>/y;
/** A `+` and the quote of the string literal it joins, read after a literal. */
const JOINED_LITERAL = /\s*\+\s*(["'])/y;
/** What may come before a literal that a `+` joins to the next: nothing that binds tighter. */
const joinsAfter = (out: string): boolean =>
  out === "" || "(,=+[{:?!&|".includes(out.at(-1) ?? "") || out.endsWith("return");
/** What may come after it. */
const JOIN_AFTER = /\s*(?:$|[),;+\]}:?])/y;

/** The end of the string literal opened at `at` on its line, and its value, or null. */
function literal(text: string, at: number): { end: number; value: string } | null {
  const quote = text[at];
  let value = "";
  let j = at + 1;
  for (; j < text.length && text[j] !== quote && text[j] !== "\n"; j++) {
    if (text[j] === "\\" && j + 1 < text.length && text[j + 1] !== "\n") {
      const next = text[j + 1] ?? "";
      value += next === '"' || next === "'" ? next : `\\${next}`;
      j++;
    } else value += text[j];
  }
  return text[j] === quote ? { end: j, value } : null;
}

/** A literal's text with its escape sequences read as the languages of the templates read them. */
function decodeEscapes(text: string): string {
  return text.replace(
    /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2})|([0-7]{1,3})|([\s\S]))/g,
    (_match, braced, unit, wide, hex, octal, other: string | undefined) => {
      if (unit) return String.fromCharCode(Number.parseInt(unit, 16));
      const code = braced ?? wide ?? hex;
      if (code) return String.fromCodePoint(Number.parseInt(code, 16));
      if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
      const simple: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        v: "\v",
      };
      return simple[other ?? ""] ?? other ?? "";
    },
  );
}

/**
 * What a literal holding JSON text (the bun, Go and xUnit blocks) means: its rows, whatever escapes
 * spell them, or null for any other literal. An edit that writes a character of a row as an escape
 * keeps the block (#1995): in bench round 64 the host restored a raw U+FEFF that Go rejects after
 * every model escaped it, 9.7M tokens on cfgquill lint.
 */
function jsonMeaning(value: string): string | null {
  const text = decodeEscapes(value);
  if (!/^\s*[[{]/.test(text)) return null;
  try {
    return `json:${JSON.stringify(JSON.parse(text))}`;
  } catch {
    return null;
  }
}

/**
 * The text as a formatter cannot change it: whitespace and a trailing comma before a closing
 * bracket dropped outside string literals, and a literal's escaped quotes unescaped, so either
 * quote style reads the same. ruff, black, gofmt, rustfmt, prettier, biome and dotnet format
 * change only these in a block; a formatter gate's fixer must not count as editing the rows
 * (#1927). A quote with no closing one on its line (an apostrophe in a comment) is plain text.
 * String literals joined by `+` read as one, by their decoded value, as google-java-format's reflow
 * of a long literal writes them (#1961). For a JavaScript or TypeScript `path`, a semicolon that
 * ends or starts a line, or comes before a closing brace, is dropped too: Prettier's `semi: false`
 * and Biome's `asNeeded` remove it, and the leading `;` they add before a line opening with a
 * bracket reads the same (#1936); and a single bare arrow parameter reads the same with or without
 * its parentheses (Prettier's `arrowParens`, Biome's `arrowParentheses`, #1961).
 */
export function layoutFree(text: string, path = ""): string {
  const script = OPTIONAL_SEMICOLONS.test(path);
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      const first = literal(text, i);
      if (first) {
        let { end, value } = first;
        // Join only where `+` is the outermost operator on both sides, so the value is the same.
        if (ch !== "`" && joinsAfter(out)) {
          for (;;) {
            JOINED_LITERAL.lastIndex = end + 1;
            const join = JOINED_LITERAL.exec(text);
            const next = join ? literal(text, JOINED_LITERAL.lastIndex - 1) : null;
            if (!next) break;
            JOIN_AFTER.lastIndex = next.end + 1;
            if (!JOIN_AFTER.test(text)) break;
            value += next.value;
            end = next.end;
          }
        }
        out += `\u0000${jsonMeaning(value) ?? value}\u0000`;
        i = end;
        continue;
      }
    }
    if (/\s/.test(ch)) continue;
    if (script && (ch === "(" || !/[\w$]/.test(text[i - 1] ?? ""))) {
      ARROW_PARAMETER.lastIndex = i;
      const arrow = ARROW_PARAMETER.exec(text);
      if (arrow) {
        out += `(${arrow[1] ?? arrow[2]})=>`;
        i = ARROW_PARAMETER.lastIndex - 1;
        continue;
      }
    }
    CLOSER.lastIndex = i + 1;
    if (ch === "," && CLOSER.test(text)) continue;
    if (ch === ";" && script && optionalSemicolon(text, i)) continue;
    out += ch;
  }
  return out;
}

/** The words of the first line before #2004, which blocks written then still carry. */
const EARLIER_BEGIN_WORDS = ": host-written from the audited spec table.";

/** Whether `text` holds the block of `file` as it is or as a formatter laid it out. */
function sameBlock(text: string, file: string, path: string): boolean {
  const lines = blockLines(text, file);
  if (!lines) return false;
  const found = text
    .split("\n")
    .slice(lines.from, lines.to + 1)
    .join("\n")
    .replace(EARLIER_BEGIN_WORDS, ": cases from the spec's acceptance table.");
  return layoutFree(found, path) === layoutFree(file, path);
}

/**
 * The text with every comment, string and character literal blanked to spaces (newlines kept), so
 * braces and declarations are found in code only. Java text blocks and C# verbatim, raw and
 * interpolated strings are literals too; an interpolation hole's own strings are skipped with it.
 */
function codeOnly(text: string, language?: "java" | "csharp" | "php"): string {
  const out = [...text];
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  /** The end of a plain or verbatim string that starts at `at` (its opening quote). */
  const stringEnd = (at: number, verbatim: boolean, interpolated: boolean): number => {
    let depth = 0;
    for (let i = at + 1; i < text.length; i++) {
      const ch = text[i];
      if (depth > 0) {
        if (ch === '"') i = stringEnd(i, false, false) - 1;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        continue;
      }
      if (interpolated && ch === "{") {
        if (text[i + 1] === "{") i++;
        else depth = 1;
      } else if (!verbatim && ch === "\\") i++;
      else if (ch === '"') {
        if (verbatim && text[i + 1] === '"') i++;
        else return i + 1;
      } else if (!verbatim && ch === "\n") return i;
    }
    return text.length;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    let end = i;
    if (ch === "/" && next === "/")
      end = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    else if (ch === "/" && next === "*")
      end = text.indexOf("*/", i + 2) < 0 ? text.length : text.indexOf("*/", i + 2) + 2;
    else if (text.startsWith('"""', i)) {
      const quotes = /^"+/.exec(text.slice(i))?.[0] ?? '"""';
      const close = text.indexOf(quotes, i + quotes.length);
      end = close < 0 ? text.length : close + quotes.length;
    } else if (ch === '"') {
      const prefix = text.slice(Math.max(0, i - 2), i);
      end = stringEnd(i, /@\$?$|\$@$/.test(prefix), /\$@?$|@\$$/.test(prefix));
    } else if (language === "php" && (ch === "'" || (ch === "#" && next !== "["))) {
      // A PHP single-quoted string, whatever its length, and a `#` comment (`#[` opens an attribute).
      const close =
        ch === "#"
          ? /^#[^\n]*/.exec(text.slice(i))
          : /^'(?:\\[\s\S]|[^'\\])*'?/.exec(text.slice(i));
      end = i + (close?.[0].length ?? 1);
    } else if (ch === "'" && /[^A-Za-z0-9_]/.test(text[i - 1] ?? " ")) {
      const close = /^'(?:\\.|[^'\\\n]){1,8}'/.exec(text.slice(i));
      if (close) end = i + close[0].length;
    }
    if (end > i) {
      blank(i, end);
      i = end - 1;
    }
  }
  return out.join("");
}

/** The offset of the brace that closes the one opened at `open`, in code-only text. */
function closingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The braces of the file's own type: the class, record or struct named after the file, or else
 * the first type the file declares. Null when the file declares none.
 */
function primaryType(
  text: string,
  className: string,
  language?: NonNullable<InlineRowFile["nest"]>["language"],
): { open: number; end: number } | null {
  if (language === "elixir") return elixirModuleSpan(text, className);
  const code = codeOnly(text, language);
  const declared = (name: string) =>
    new RegExp(`\\b(?:class|record|struct|interface|enum)\\s+${name}\\b[^{;]*\\{`).exec(code);
  const found = declared(className) ?? declared("[A-Za-z_]\\w*");
  if (!found) return null;
  const open = found.index + found[0].length - 1;
  const end = closingBrace(code, open);
  return end < 0 ? null : { open, end };
}

/** A top-level `defmodule Name do` line, as mix format writes it. */
const ELIXIR_MODULE = /^defmodule[ \t]+([A-Z][\w.]*)[ \t]+do[ \t]*$/gm;

/**
 * The span of the file's own Elixir module, the one named after the file (also under a namespace,
 * `App.CalcTest`) or else the first: from the end of its `do` to its `end`. mix format indents
 * every inner `end`, so the module's own is the first `end` at the start of a line after it.
 */
function elixirModuleSpan(text: string, className: string): { open: number; end: number } | null {
  const found = [...text.matchAll(ELIXIR_MODULE)];
  const own = found.find((m) => m[1] === className || m[1]?.endsWith(`.${className}`)) ?? found[0];
  if (!own) return null;
  const open = own.index + own[0].length - 1;
  const close = /^end\b/m.exec(text.slice(open));
  return close ? { open, end: open + close.index } : null;
}

/** Whether the block of `file` lies in the braces of the file's own type. */
function insideType(text: string, file: string, nest: NonNullable<InlineRowFile["nest"]>): boolean {
  const lines = blockLines(text, file);
  const type = primaryType(text, nest.className, nest.language);
  if (!lines || !type) return false;
  const at = text.split("\n").slice(0, lines.from).join("\n").length + 1;
  return at > type.open && at < type.end;
}

/** The leading whitespace of the line `at` is on. */
const indentAt = (text: string, at: number): string =>
  /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1))?.[0] ?? "";

/** The text without the marked block, wherever and however indented it is, and the blank line before it. */
function withoutBlock(text: string, file: string): string {
  const lines = blockLines(text, file);
  if (!lines) return text;
  const { from, to } = lines;
  const all = text.split("\n");
  const start = from > 0 && all[from - 1]?.trim() === "" ? from - 1 : from;
  return [...all.slice(0, start), ...all.slice(to + 1)].join("\n");
}

/** The nested block in the file's own type, indented one level in from its closing brace. */
function nested(
  text: string,
  file: InlineRowFile,
  nest: NonNullable<InlineRowFile["nest"]>,
): string {
  let body = withoutBlock(text, file.tail);
  let type = primaryType(body, nest.className, nest.language);
  if (!type) {
    // No type yet: the host declares the file's class around the block.
    const head = body.replace(/\s+$/, "");
    const wrapper =
      nest.language === "elixir"
        ? `defmodule ${nest.className} do\n  use ExUnit.Case\nend\n`
        : nest.language === "php"
          ? `final class ${nest.className} extends ${head.includes(PHPUNIT_USE) ? "" : "\\PHPUnit\\Framework\\"}TestCase\n{\n}\n`
          : nest.language === "java" || !nest.namespace || /^\s*namespace\s+[\w.]+\s*;/m.test(head)
            ? nest.language === "java"
              ? `class ${nest.className} {\n}\n`
              : `public class ${nest.className}\n{\n}\n`
            : `namespace ${nest.namespace}\n{\n    public class ${nest.className}\n    {\n    }\n}\n`;
    // A PHP file starts with its open tag.
    const start = nest.language === "php" && !/^\s*<\?php/.test(head) ? `<?php\n\n${head}` : head;
    body = start.trim() ? `${start.replace(/\s+$/, "")}\n\n${wrapper}` : wrapper;
    type = primaryType(body, nest.className, nest.language);
    if (!type) return body;
  }
  const { end } = type;
  const base = indentAt(body, end);
  const lineStart = body.lastIndexOf("\n", end - 1) + 1;
  // The class's least indented member line sets the unit; four spaces when the class is empty.
  const inner = body
    .slice(type.open + 1, lineStart)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => /^[ \t]*/.exec(line)?.[0] ?? "")
    .filter((indent) => indent.length > base.length)
    .sort((a, b) => a.length - b.length)[0];
  const unit = inner?.startsWith(base)
    ? inner.slice(base.length)
    : nest.language === "elixir"
      ? "  "
      : "    ";
  const indented = file.tail
    .trimEnd()
    .split("\n")
    .map((line) => (line ? `${base}${unit}${line}` : line))
    .join("\n");
  const own = body.slice(lineStart, end).trim() === "";
  // Blank lines before the brace collapse, so one blank line separates the block from the members.
  const before = own
    ? body.slice(0, lineStart).replace(/\n(?:[ \t]*\n)+$/, "\n")
    : `${body.slice(0, end).trimEnd()}\n`;
  const opened = (nest.language === "elixir" ? /\bdo\s*$/ : /\{\s*$/).test(before);
  return `${before}${opened ? "" : "\n"}${indented}\n${base}${body.slice(end)}`;
}

/**
 * The test file with the host's blocks in place: an existing block is replaced, a missing one is
 * appended (Go's imports follow the package clause), and a missing file starts from the skeleton.
 * A nested block goes before the closing brace of the file's own type.
 */
export function withInlineRows(existing: string | null, file: InlineRowFile): string {
  // A block the project's formatter laid out stays as it is: putting the host's layout back
  // would fail the formatter gate again (#1927).
  if (
    existing !== null &&
    sameBlock(existing, file.tail, file.path) &&
    (!file.head || sameBlock(existing, file.head, file.path)) &&
    (!file.nest || insideType(existing, file.tail, file.nest))
  )
    return existing;
  let text = existing ?? file.skeleton;
  if (file.nest) return nested(text, file, file.nest);
  if (file.head) {
    const at = span(text, file.head);
    if (at) text = text.slice(0, at.from) + file.head + text.slice(at.to);
    else {
      const clause = /^package\s+\w+[^\n]*\n?/m.exec(text);
      const offset = clause ? clause.index + clause[0].length : 0;
      const prefix = text.slice(0, offset);
      text = `${prefix}${prefix && !prefix.endsWith("\n") ? "\n" : ""}\n${file.head}${text.slice(offset)}`;
    }
  }
  const at = span(text, file.tail);
  if (at) return text.slice(0, at.from) + file.tail + text.slice(at.to);
  const body = text.replace(/\s+$/, "");
  // Two blank lines before a top-level Python comment that follows a function (ruff, black).
  const gap = file.path.endsWith(".py") ? "\n\n\n" : "\n\n";
  return body ? `${body}${gap}${file.tail}` : file.tail;
}

/**
 * Whether the test file holds the host's blocks unchanged or only laid out again by a formatter,
 * a nested one in the file's own type.
 */
export const hasInlineRows = (text: string | null, file: InlineRowFile): boolean =>
  text !== null && withInlineRows(text, file) === text;

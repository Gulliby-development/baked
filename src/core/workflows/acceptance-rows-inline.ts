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
};

/**
 * The class the JUnit and xUnit blocks add next to the file's own class, named after it: a
 * written-tests run that names the file's class names this one too.
 */
export const INLINE_ROWS_CLASS = {
  junit: (cls: string) => `${cls}AcceptanceRowsTest`,
  xunit: (cls: string) => `${cls}AcceptanceRows`,
};

/** The first line of a block, in any framework. */
export const INLINE_ROWS_BEGIN = /^(?:\/\/|#) BEGIN acceptance rows: host-written/m;

/** A host-written block of a test file: `tail` ends the file, `head` (Go imports) follows its package clause. */
export interface InlineRowFile {
  path: string;
  inline: true;
  head?: string;
  tail: string;
  /** The file the host starts when the test file does not exist yet. */
  skeleton: string;
}

const comment = (framework: Framework): string => (framework === "pytest" ? "#" : "//");
const begin = (framework: Framework, what = "acceptance rows"): string =>
  `${comment(framework)} BEGIN ${what}: host-written from the audited spec table. Edit ${INLINE_HARNESS[framework]}, not this block.`;
const end = (framework: Framework, what = "acceptance rows"): string =>
  `${comment(framework)} END ${what}`;
/** gofmt separates a comment that follows a closing brace or parenthesis by a blank line. */
const block = (framework: Framework, body: string, what?: string): string =>
  `${begin(framework, what)}\n${body.replace(/\n+$/, "")}\n${framework === "go" ? "\n" : ""}${end(framework, what)}\n`;

const className = (path: string, suffix: string): string => posix.basename(path, suffix);
const camel = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join("");
const data = (rows: AcceptanceRow[]): string =>
  JSON.stringify(rows.map(({ id, input, expected }) => ({ id, input, expected })));
/** JSON.stringify of the JSON text is a valid string literal in Python, Go, TypeScript and C#, but C# ends a line at U+0085, U+2028 and U+2029. */
const quoted = (text: string): string =>
  JSON.stringify(text).replace(
    /[\u0085\u2028\u2029]/g,
    (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
  );

/** A Java string literal; control characters are octal escapes, never \u (read before lexing). */
const javaString = (text: string): string =>
  `"${[...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '"' || ch === "\\") return `\\${ch}`;
      return code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, "0")}` : ch;
    })
    .join("")}"`;
const javaValue = (value: unknown): string => {
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
      const code = ch.codePointAt(0) ?? 0;
      if (ch === '"' || ch === "\\") return `\\${ch}`;
      return code < 0x20 || code === 0x7f ? `\\u{${code.toString(16)}}` : ch;
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

const JAVA_HELPERS = `  private static java.util.Map<String, Object> map(Object... entries) {
    java.util.Map<String, Object> out = new java.util.LinkedHashMap<>();
    for (int i = 0; i < entries.length; i += 2) out.put((String) entries[i], entries[i + 1]);
    return out;
  }

  private static java.util.List<Object> list(Object... items) {
    return new java.util.ArrayList<>(java.util.Arrays.asList(items));
  }

  /** JSON numbers compare by value: 2, 2L and 2.0 are equal; collections compare as lists. */
  private static Object normal(Object value) {
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

const TEMPLATES: Record<Framework, Template> = {
  bun: ({ test }, rows) => ({
    skeleton: "",
    tail: block(
      "bun",
      `import { expect as acceptanceExpect, test as acceptanceTest } from "bun:test";\nconst acceptanceRows${/\.tsx?$/.test(test) ? ": { id: string; input: unknown; expected: unknown }[]" : ""} = JSON.parse(${quoted(data(rows))});\nacceptanceTest.each(acceptanceRows)("$id", async (row) => {\n  acceptanceExpect(await acceptanceActual(row.input)).toEqual(row.expected);\n});`,
    ),
  }),
  pytest: (_, rows) => ({
    skeleton: "",
    tail: block(
      "pytest",
      `import json as _acceptance_json\nimport pytest as _acceptance_pytest\n\n_ACCEPTANCE_ROWS = _acceptance_json.loads(${quoted(data(rows))})\n\n\n@_acceptance_pytest.mark.parametrize("row", _ACCEPTANCE_ROWS, ids=[row["id"] for row in _ACCEPTANCE_ROWS])\ndef test_acceptance_row(row):\n    assert acceptance_actual(row["input"]) == row["expected"]`,
    ),
  }),
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
  // A second top-level class in the test file, named so build tools pick it up as a test (*Test).
  junit: ({ test, package: pkg }, rows) => {
    const cls = className(test, ".java");
    return {
      skeleton: `package ${pkg};\n`,
      tail: block(
        "junit",
        `class ${INLINE_ROWS_CLASS.junit(cls)} {\n  @org.junit.jupiter.api.TestFactory\n  java.util.stream.Stream<org.junit.jupiter.api.DynamicTest> acceptanceRows() {\n    return java.util.stream.Stream.of(\n${rows.map((row) => `        row(${javaString(row.id)}, ${javaValue(row.input)}, ${javaValue(row.expected)})`).join(",\n")});\n  }\n\n  private static org.junit.jupiter.api.DynamicTest row(String id, Object input, Object expected) {\n    return org.junit.jupiter.api.DynamicTest.dynamicTest(\n        id, () -> org.junit.jupiter.api.Assertions.assertEquals(normal(expected), normal(${cls}.acceptanceActual(input))));\n  }\n\n${JAVA_HELPERS}\n}`,
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
  // A second public class, outside or inside the file's namespace, that names the harness fully.
  xunit: ({ test, package: pkg }, rows) => {
    const cls = className(test, ".cs");
    return {
      skeleton: "",
      tail: block(
        "xunit",
        `public class ${INLINE_ROWS_CLASS.xunit(cls)}\n{\n    private const string Rows = ${quoted(data(rows))};\n\n    public static global::System.Collections.Generic.IEnumerable<object[]> Data()\n    {\n        foreach (var row in global::System.Text.Json.Nodes.JsonNode.Parse(Rows)!.AsArray())\n            yield return new object[]\n            {\n                (string)row!["id"]!,\n                row["input"]?.ToJsonString() ?? "null",\n                row["expected"]?.ToJsonString() ?? "null",\n            };\n    }\n\n    [global::Xunit.Theory]\n    [global::Xunit.MemberData(nameof(Data))]\n    public void AcceptanceRow(string id, string input, string expected)\n    {\n        var actual = global::System.Text.Json.JsonSerializer.SerializeToNode(global::${pkg}.${cls}.AcceptanceActual(global::System.Text.Json.Nodes.JsonNode.Parse(input)));\n        global::Xunit.Assert.True(\n            global::System.Text.Json.Nodes.JsonNode.DeepEquals(actual, global::System.Text.Json.Nodes.JsonNode.Parse(expected)),\n            $"{id}: got {actual?.ToJsonString() ?? "null"}, want {expected}");\n    }\n}`,
      ),
    };
  },
};

export function inlineRowFile(test: InlineRowTest, rows: AcceptanceRow[]): InlineRowFile {
  return { path: test.test, inline: true, ...TEMPLATES[test.framework](test, rows) };
}

/** The marked block of `text` that starts with `first` line, or null. */
function span(text: string, file: string): { from: number; to: number } | null {
  const first = file.slice(0, file.indexOf("\n") + 1);
  const trimmed = file.trimEnd();
  const last = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  const from = text.indexOf(first);
  if (from < 0) return null;
  const to = text.indexOf(last, from);
  if (to < 0) return null;
  const after = to + last.length;
  return { from, to: text[after] === "\n" ? after + 1 : after };
}

/**
 * The test file with the host's blocks in place: an existing block is replaced, a missing one is
 * appended (Go's imports follow the package clause), and a missing file starts from the skeleton.
 */
export function withInlineRows(existing: string | null, file: InlineRowFile): string {
  let text = existing ?? file.skeleton;
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
  return body ? `${body}\n\n${file.tail}` : file.tail;
}

/** Whether the test file holds the host's blocks unchanged. */
export const hasInlineRows = (text: string | null, file: InlineRowFile): boolean =>
  !!text?.includes(file.tail) && (!file.head || text.includes(file.head));

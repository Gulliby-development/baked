import { describe, expect, test } from "bun:test";
import {
  formatSyntaxErrors,
  syntaxCheckable,
  syntaxErrors,
} from "../src/core/intelligence/syntax-check.js";

// Idiomatic current code of each checked language: the gate refuses a submission on any error it
// reports, so a valid file must report none (#977).
const VALID: Record<string, string> = {
  "src/lib.rs": [
    "use std::fmt;",
    "#[derive(Debug)]",
    "pub struct P<'a> { s: &'a str }",
    "fn main() {",
    '    let r = r#"he said "hi""#;',
    '    let b = br"x";',
    "    let Some(x) = Some(1) else { return; };",
    "    let c = |x: i32| async move { x };",
    '    println!("{r} {x:?}");',
    "    let v: Vec<_> = (0..3).map(|i| i * 2).collect();",
    "    match v.as_slice() { [a, .., b] => {}, _ => {} }",
    "    let ch = '\\u{1F600}';",
    "    let n = 'outer: loop { break 'outer 1; };",
    "}",
    "impl fmt::Display for P<'_> {",
    "    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, \"{}\", self.s) }",
    "}",
    "pub fn items(xs: &[u8]) -> impl Iterator<Item = &u8> + '_ { xs.iter() }",
    "",
  ].join("\n"),
  "main.go": [
    "package main",
    'import "fmt"',
    "type Num interface{ ~int | ~float64 }",
    "func Sum[T Num](xs []T) T { var s T; for _, x := range xs { s += x }; return s }",
    "func main() {",
    "\tfor i := range 10 { _ = i }",
    "\tfmt.Println(Sum([]int{1, 2}), `raw",
    "string`)",
    "}",
    "",
  ].join("\n"),
  "src/id.ts": [
    "const id = <T>(x: T): T => x;",
    "let y = <number>id(1);",
    "export type Partial2<B> = { [K in keyof B]?: B[K] };",
    "type Unwrap<T> = T extends Promise<infer U> ? U : never;",
    "enum E { A = 1 }",
    "abstract class C<T> { private readonly x?: T; constructor(public a: string) {} }",
    "declare module 'x' { export function f(): void; }",
    "function assert(v: unknown): asserts v is string {}",
    "let t: `a${string}` = 'ab';",
    "const conf = { a: 1 } satisfies Record<string, number>;",
    "",
  ].join("\n"),
  "src/List.tsx": [
    'import React from "react";',
    "export const List = <T,>({ items }: { items: T[] }) => (",
    "  <ul>{items.map((i, k) => <li key={k}>{String(i)}</li>)}</ul>",
    ");",
    "",
  ].join("\n"),
  "src/a.js": [
    "export const f = async (...a) => { const { x = 1, ...r } = a[0] ?? {}; return x?.y ?? r; };",
    "class K { #p = 1; static { } get v() { return this.#p; } }",
    "const el = <div className=\"x\" />;",
    "",
  ].join("\n"),
  "pkg/a.py": [
    "from dataclasses import dataclass",
    "@dataclass",
    "class P:",
    "    x: int = 0",
    "async def f(a, /, b, *, c):",
    '    name = "w"',
    "    print(f\"{name!r:>10} {a + b = }\", f'{\"q\"}', f\"{f'{a}'}\")",
    "    match a:",
    "        case [x, *rest] if x > 0:",
    "            pass",
    '        case {"k": v}:',
    "            pass",
    "    if (n := len(name)) > 1:",
    "        return [i async for i in g()]",
    "def first[T](xs: list[T]) -> T:",
    "    return xs[0]",
    "type Alias = list[int]",
    "",
  ].join("\n"),
  "src/App.cs": [
    "using System;",
    "namespace App;",
    "public record Person(string Name, int Age);",
    "public record struct Pt(int X, int Y);",
    "public class C {",
    "  public required string Name { get; init; }",
    "  public static void Main() {",
    '    var p = new Person("a", 1) with { Age = 2 };',
    '    var s = $"{p.Name,5} {p.Age:D2}";',
    "    if (p is { Age: > 1 } q) Console.WriteLine(s);",
    '    var r = p.Age switch { < 1 => "x", _ => "y" };',
    '    string? n = null; n ??= "z";',
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/A.java": [
    "package a;",
    "import java.util.*;",
    "public class A {",
    "  record Pt(int x, int y) {}",
    "  sealed interface S permits B {}",
    "  final class B implements S {}",
    "  String m(Object o) {",
    "    var l = List.of(1, 2);",
    '    String t = """',
    "      text block",
    '      """;',
    "    if (o instanceof String s && !s.isEmpty()) {}",
    "    int r = switch (l.size()) { case 1 -> 1; default -> { yield 2; } };",
    "    l.forEach(System.out::println);",
    '    return switch (o) { case Integer i when i > 0 -> "p"; case String s -> s; default -> ""; };',
    "  }",
    "}",
    "",
  ].join("\n"),
};

// A broken file of each language and the line its first error is on.
const BROKEN: [string, string, number][] = [
  ["src/scan.rs", 'fn t() {\n    let ok = "a";\n    let doc = “see”;\n}\n', 3],
  ["main.go", "package main\n\nfunc f() {\n\tx := (1 + \n}\n", 4],
  ["src/a.ts", "export function f(a: number) {\n  return a +;\n}\n", 2],
  ["src/A.tsx", "export const A = () => <div>;\n", 1],
  ["src/a.js", "const a = {\n  b: 1,\n  c: ,\n};\n", 3],
  ["pkg/a.py", "def f():\n    return 1\n\ndef g(:\n    pass\n", 4],
  ["src/A.cs", "class A {\n  void M() {\n    var x = ;\n  }\n}\n", 3],
  ["src/A.java", "class A {\n  void m() {\n    int x = 1\n  }\n}\n", 3],
];

describe("syntaxErrors", () => {
  for (const [path, content] of Object.entries(VALID))
    test(`a valid ${path} has no errors`, async () => {
      expect(await syntaxErrors(path, content)).toEqual([]);
    });

  for (const [path, content, line] of BROKEN)
    test(`a broken ${path} reports its line`, async () => {
      const errors = await syntaxErrors(path, content);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.line).toBe(line);
      expect(errors[0]?.column).toBeGreaterThan(0);
      expect(errors[0]?.message.length).toBeGreaterThan(0);
    });

  test("a missing token is named", async () => {
    const errors = await syntaxErrors("src/A.java", "class A {\n  void m() {\n    int x = 1\n  }\n}\n");
    expect(errors[0]?.message).toBe("missing ;");
  });

  test("a language without a checked grammar passes unchecked", async () => {
    expect(syntaxCheckable("src/Main.kt")).toBe(false);
    expect(syntaxCheckable("README.md")).toBe(false);
    expect(syntaxCheckable("src/lib.RS")).toBe(true);
    expect(await syntaxErrors("src/Main.kt", "fun main( {")).toEqual([]);
    expect(await syntaxErrors("notes.txt", "((((")).toEqual([]);
  });

  test("reports at most five errors", async () => {
    const content = Array.from({ length: 20 }, (_, i) => `let v${String(i)} = “x”;`).join("\n");
    const errors = await syntaxErrors("src/many.rs", `fn f() {\n${content}\n}\n`);
    expect(errors.length).toBe(5);
  });

  test("formats errors as path:line:column: message", () => {
    expect(formatSyntaxErrors("src/a.rs", [{ line: 3, column: 15, message: "missing ;" }])).toEqual([
      "src/a.rs:3:15: missing ;",
    ]);
  });
});

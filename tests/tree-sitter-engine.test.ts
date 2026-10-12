import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter-engine";
import { upgradeLegacyDylink } from "../src/core/intelligence/backends/legacy-dylink.js";

const root = join(import.meta.dir, "..", "node_modules");
const grammar = (name: string) =>
  new Uint8Array(readFileSync(join(root, "tree-sitter-wasms", "out", `tree-sitter-${name}.wasm`)));

test("the intelligence engine is web-tree-sitter 0.27 or newer", () => {
  const { version } = JSON.parse(
    readFileSync(join(root, "web-tree-sitter-engine", "package.json"), "utf-8"),
  ) as { version: string };
  const [major = 0, minor = 0] = version.split(".").map(Number);
  expect(major > 0 || minor >= 27).toBe(true);
});

test("legacy-dylink grammars load into the 0.27 engine once their section is upgraded", async () => {
  await Parser.init({
    locateFile: () => join(root, "web-tree-sitter-engine", "web-tree-sitter.wasm"),
  });
  const parser = new Parser();
  // As shipped, the grammar is refused: 0.27 only reads the `dylink.0` section.
  await expect(Language.load(grammar("python"))).rejects.toThrow();
  for (const [name, source, kind] of [
    ["python", "def greet():\n  pass\n", "function_definition"],
    ["tsx", "export function greet() {}\n", "export_statement"],
    ["go", "package main\nfunc greet() {}\n", "function_declaration"],
    ["rust", "fn greet() {}\n", "function_item"],
    ["c_sharp", "class A { void Greet() {} }\n", "class_declaration"],
  ] as const) {
    parser.setLanguage(await Language.load(upgradeLegacyDylink(grammar(name))));
    const tree = parser.parse(source);
    expect(tree?.rootNode.namedChildren.some((n) => n?.type === kind)).toBe(true);
    tree?.delete();
  }
  parser.delete();
});

test("a module without a legacy section is returned unchanged", () => {
  const plain = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0]);
  expect(upgradeLegacyDylink(plain)).toBe(plain);
});

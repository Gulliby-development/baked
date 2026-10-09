import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { resolveAstGrep, structuralEditTool } from "../src/core/tools/structural-edit.js";

const origCwd = process.cwd();
let dir: string;

// Resolve exactly as production does, so a foreign `sg` on PATH (shadow-utils'
// switch-group on Linux) never makes these tests run against the wrong binary.
function hasAstGrep(): boolean {
  return resolveAstGrep(getCwd()) !== null;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "struct-edit-"));
  // Link the repository's dependencies into the workspace so the dev lookup
  // finds the @ast-grep/cli devDependency, the same binary on every machine.
  // A junction needs no symlink privilege on Windows.
  const deps = join(origCwd, "node_modules");
  if (existsSync(deps)) symlinkSync(deps, join(dir, "node_modules"), "junction");
  setCwd(dir);
});

afterAll(() => {
  setCwd(origCwd);
  // Remove the link itself first so the recursive delete can never walk into
  // the repository's node_modules.
  const link = join(dir, "node_modules");
  try {
    unlinkSync(link);
  } catch {
    try {
      rmdirSync(link);
    } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  // each test writes its own file
});

test("resolves the vendored binary when present in ~/.baked/bin", async () => {
  const { getVendoredPath } = await import("../src/core/setup/install.js");
  const vendored = getVendoredPath("ast-grep");
  if (!vendored) return; // vendored copy not installed in this env — skip
  expect(existsSync(vendored)).toBe(true);
  // A rewrite must succeed regardless of node_modules — proves the prod path
  // (vendored bin, no npm package in cwd) works.
  writeFileSync(join(dir, "vend.go"), "package main\nfunc a() { b() }\n");
  const r = await structuralEditTool.execute({ file: "vend.go", pattern: "b()", rewrite: "c()" });
  expect(r.success).toBe(true);
  expect(readFileSync(join(dir, "vend.go"), "utf-8")).toContain("c()");
});

describe("structural_edit", () => {
  test("rejects TypeScript files (routes to ast_edit)", async () => {
    writeFileSync(join(dir, "a.ts"), "const x = 1;\n");
    const r = await structuralEditTool.execute({
      file: "a.ts",
      pattern: "$X",
      rewrite: "$X",
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("wrong tool");
    expect(r.output).toContain("ast_edit");
  });

  test("rejects unknown file types without explicit lang", async () => {
    writeFileSync(join(dir, "notes.xyz"), "hello\n");
    const r = await structuralEditTool.execute({
      file: "notes.xyz",
      pattern: "$X",
      rewrite: "$X",
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("unsupported");
  });

  test("errors on missing file", async () => {
    const r = await structuralEditTool.execute({
      file: "nope.py",
      pattern: "$X",
      rewrite: "$X",
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("not found");
  });

  test("missing binary returns an install hint (when ast-grep absent)", async () => {
    if (hasAstGrep()) return; // skip when the binary is present
    writeFileSync(join(dir, "svc.py"), "def foo():\n    pass\n");
    const r = await structuralEditTool.execute({
      file: "svc.py",
      pattern: "foo",
      rewrite: "bar",
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("missing-binary");
    expect(r.output).toContain("ast-grep is not yet available");
  });

  test("rewrites a Python function name (when ast-grep present)", async () => {
    if (!hasAstGrep()) return; // skip when the binary is absent
    writeFileSync(join(dir, "rw.py"), "def oldName():\n    return 1\n");
    const r = await structuralEditTool.execute({
      file: "rw.py",
      pattern: "def oldName()",
      rewrite: "def newName()",
    });
    expect(r.success).toBe(true);
    expect(readFileSync(join(dir, "rw.py"), "utf-8")).toContain("newName");
  });

  test("Python: metavariable rename preserving args ($$$ARGS)", async () => {
    if (!hasAstGrep()) return;
    writeFileSync(join(dir, "meta.py"), "def greet(name, punct):\n    return name\n");
    const r = await structuralEditTool.execute({
      file: "meta.py",
      pattern: "def greet($$$ARGS)",
      rewrite: "def hello($$$ARGS)",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(join(dir, "meta.py"), "utf-8");
    expect(out).toContain("def hello(name, punct)");
    expect(out).not.toContain("greet");
  });

  test("Rust: rewrite a function signature with captured params + body", async () => {
    if (!hasAstGrep()) return;
    writeFileSync(join(dir, "lib.rs"), "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n");
    const r = await structuralEditTool.execute({
      file: "lib.rs",
      pattern: "fn add($$$P) -> $R { $$$B }",
      rewrite: "fn sum($$$P) -> $R { $$$B }",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(join(dir, "lib.rs"), "utf-8");
    expect(out).toContain("fn sum(a: i32, b: i32)");
    expect(out).not.toContain("fn add");
  });

  test("C++: rewrite a return expression", async () => {
    if (!hasAstGrep()) return;
    writeFileSync(join(dir, "calc.cpp"), "int diff(int a, int b) {\n    return a + b;\n}\n");
    const r = await structuralEditTool.execute({
      file: "calc.cpp",
      pattern: "return a + b;",
      rewrite: "return a - b;",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(join(dir, "calc.cpp"), "utf-8");
    expect(out).toContain("return a - b;");
    expect(out).not.toContain("a + b");
  });

  test("Go: rename a function call across the file", async () => {
    if (!hasAstGrep()) return;
    writeFileSync(
      join(dir, "main.go"),
      "package main\n\nfunc oldFn() int { return 1 }\n\nfunc main() { oldFn(); oldFn() }\n",
    );
    const r = await structuralEditTool.execute({
      file: "main.go",
      pattern: "oldFn()",
      rewrite: "newFn()",
    });
    expect(r.success).toBe(true);
    const out = readFileSync(join(dir, "main.go"), "utf-8");
    // The pattern `oldFn()` matches call expressions, not the func declaration,
    // so both call sites are rewritten while `func oldFn()` stays.
    expect((out.match(/newFn\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).toContain("func oldFn()");
  });

  test("preview does not write to disk", async () => {
    if (!hasAstGrep()) return;
    const original = "def keep():\n    return 1\n";
    writeFileSync(join(dir, "prev.py"), original);
    const r = await structuralEditTool.execute({
      file: "prev.py",
      pattern: "def keep()",
      rewrite: "def changed()",
      preview: true,
    });
    expect(r.success).toBe(true);
    // file unchanged on disk
    expect(readFileSync(join(dir, "prev.py"), "utf-8")).toBe(original);
  });

  // Broad matrix: the languages verified to rewrite cleanly via expression /
  // metavariable patterns. Guards against a regression in language detection
  // or the binary resolver across the polyglot set.
  const MATRIX: Array<{ name: string; file: string; src: string; pat: string; rw: string; want: string }> = [
    { name: "Java", file: "M.java", src: "class M {\n  int f() { return 1 + 2; }\n}\n", pat: "1 + 2", rw: "3", want: "return 3;" },
    { name: "Ruby", file: "m.rb", src: "def m(a)\n  a\nend\n", pat: "def m($$$A)", rw: "def n($$$A)", want: "def n(a)" },
    { name: "C", file: "m.c", src: "int f(void) {\n  return 1 + 2;\n}\n", pat: "1 + 2", rw: "3", want: "return 3;" },
    { name: "C#", file: "M.cs", src: "class M {\n  int F() { return 1 + 2; }\n}\n", pat: "1 + 2", rw: "3", want: "return 3;" },
    { name: "Kotlin", file: "m.kt", src: "fun f(): Int { return 1 + 2 }\n", pat: "1 + 2", rw: "3", want: "return 3" },
    { name: "Lua", file: "m.lua", src: "local function f()\n  return 1 + 2\nend\n", pat: "1 + 2", rw: "3", want: "return 3" },
    { name: "PHP", file: "m.php", src: "<?php\nfunction f() { return 1 + 2; }\n", pat: "1 + 2", rw: "3", want: "return 3;" },
    { name: "Scala", file: "m.scala", src: "def f(): Int = 1 + 2\n", pat: "1 + 2", rw: "3", want: "= 3" },
  ];

  for (const c of MATRIX) {
    test(`matrix: ${c.name} rewrites cleanly`, async () => {
      if (!hasAstGrep()) return;
      writeFileSync(join(dir, c.file), c.src);
      const r = await structuralEditTool.execute({ file: c.file, pattern: c.pat, rewrite: c.rw });
      expect(r.success).toBe(true);
      expect(readFileSync(join(dir, c.file), "utf-8")).toContain(c.want);
    });
  }
});

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStaticCheck, isWholeUnitCheck } from "../src/core/workflows/check-policy.js";
import { detectGates, executeGate } from "../src/core/workflows/gates.js";
import { addedDependencies } from "../src/core/workflows/quality/dependencies.js";
import { detectMutationTool, type ToolShell } from "../src/core/workflows/quality/mutation-tools.js";
import { isTestCheck } from "../src/core/workflows/quality/mutation.js";
import { propertyTestKind } from "../src/core/workflows/quality/properties.js";

/**
 * The gate matrix (#854): every supported stack against every quality gate's decision, without a
 * model. Bench rounds 12 and 13 lost whole rounds to gates that did not know a toolchain or a
 * project layout (#796, #835, #844, #840, #842); each of those is a cell here.
 *
 * A cell that is known to be wrong names its issue in `KNOWN` and is skipped; the PR that fixes the
 * issue removes the entry, so the cell runs from then on. A fix PR for a gate finding adds its
 * failing cell first.
 *
 * The toolchain tier at the end runs each stack's detected gates on a minimal valid project with
 * the real tools. It needs the toolchains, so it runs only with BAKED_GATE_MATRIX_TOOLCHAINS=1 (the
 * CI job `gate-matrix` sets it); the rest of the file is hermetic.
 */

type Stack = "bun" | "npm" | "python" | "go" | "rust" | "maven" | "dotnet";
const STACKS: Stack[] = ["bun", "npm", "python", "go", "rust", "maven", "dotnet"];

/** Cells known to be wrong today: `<stack>:<cell>` -> issue. */
const KNOWN: Record<string, string> = {
  "maven:test-check": "#844",
};

interface Fixture {
  /** Files that make the gate detector see the stack, as the bench loop's scaffolds write them. */
  files: Record<string, string>;
  /** The preselected gates detectGates proposes, in order. */
  gates: string[];
  /** The gates that analyze the whole compilation unit and so run at integration, not per task. */
  wholeUnit: string[];
  /** A manifest change that adds one dependency, and the dependency it adds. */
  manifest: { path: string; before: string; after: string; added: string };
  /** A library-free property test (allowed when the project forbids new dependencies) and one with the library. */
  property: { path: string; seeded: string; library: string };
  /** What makes the stack's mutation tool detectable (files and commands on PATH), or null when only the built-in engine exists. */
  mutation: { tool: string; source: string; files: Record<string, string>; on: string[] } | null;
}

const FIXTURES: Record<Stack, Fixture> = {
  bun: {
    files: {
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { test: "bun test", lint: "biome check .", typecheck: "tsc --noEmit" },
      }),
      "bun.lock": "{}",
    },
    gates: ["typecheck", "lint", "tests"],
    wholeUnit: ["typecheck"],
    manifest: {
      path: "package.json",
      before: JSON.stringify({ name: "fixture", dependencies: {} }),
      after: JSON.stringify({ name: "fixture", dependencies: { zod: "^3.0.0" } }),
      added: "zod",
    },
    property: {
      path: "test/sum.test.ts",
      seeded:
        "import { expect, test } from 'bun:test';\nfunction mulberry32(a: number) { return () => (a = (a + 0x6d2b79f5) | 0) / 2 ** 32; }\ntest('sum is commutative', () => {\n  const rand = mulberry32(42);\n  for (let i = 0; i < 100; i++) {\n    const a = rand(), b = rand();\n    expect(a + b).toBe(b + a);\n  }\n});\n",
      library:
        "import fc from 'fast-check';\nimport { test } from 'bun:test';\ntest('sum', () => { fc.assert(fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a)); });\n",
    },
    mutation: {
      tool: "stryker",
      source: "src/sum.ts",
      files: { "node_modules/@stryker-mutator/core/bin/stryker.js": "" },
      on: ["node"],
    },
  },
  npm: {
    files: {
      "package.json": JSON.stringify({
        name: "fixture",
        scripts: { test: "vitest run", lint: "eslint .", build: "vite build" },
      }),
      "package-lock.json": "{}",
    },
    gates: ["lint", "tests"],
    wholeUnit: [],
    manifest: {
      path: "package.json",
      before: JSON.stringify({ name: "fixture", devDependencies: {} }),
      after: JSON.stringify({ name: "fixture", devDependencies: { vitest: "^3.0.0" } }),
      added: "vitest",
    },
    property: {
      path: "src/sum.test.js",
      seeded:
        "import { expect, test } from 'vitest';\nconst seed = 7;\nlet s = seed;\nconst prng = () => (s = (s * 1103515245 + 12345) % 2 ** 31);\ntest('sum', () => {\n  for (let i = 0; i < 50; i++) { const a = prng(), b = prng(); expect(a + b).toBe(b + a); }\n});\n",
      library:
        "const fc = require('fast-check');\ntest('sum', () => { fc.assert(fc.property(fc.nat(), (a) => a + 0 === a)); });\n",
    },
    mutation: {
      tool: "stryker",
      source: "src/sum.js",
      files: { "node_modules/@stryker-mutator/core/bin/stryker.js": "" },
      on: ["node"],
    },
  },
  python: {
    files: {
      "pyproject.toml":
        "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
    },
    gates: ["pytest", "ruff"],
    wholeUnit: [],
    manifest: {
      path: "pyproject.toml",
      before: "[project]\nname = 'fixture'\nversion = '0.1.0'\ndependencies = []\n",
      after: "[project]\nname = 'fixture'\nversion = '0.1.0'\ndependencies = ['requests>=2']\n",
      added: "requests",
    },
    property: {
      path: "tests/test_sum.py",
      seeded:
        "import random\n\n\ndef test_sum_commutes():\n    rng = random.Random(42)\n    for _ in range(100):\n        a, b = rng.randint(0, 9), rng.randint(0, 9)\n        assert a + b == b + a\n",
      library:
        "from hypothesis import given, strategies as st\n\n\n@given(st.integers(), st.integers())\ndef test_sum(a, b):\n    assert a + b == b + a\n",
    },
    mutation: { tool: "mutmut", source: "fixture/sum.py", files: {}, on: ["mutmut"] },
  },
  go: {
    files: { "go.mod": "module example.com/fixture\n\ngo 1.22\n" },
    gates: ["go-vet", "go-test"],
    wholeUnit: ["go-vet"],
    manifest: {
      path: "go.mod",
      before: "module example.com/fixture\n\ngo 1.22\n",
      after: "module example.com/fixture\n\ngo 1.22\n\nrequire github.com/google/uuid v1.6.0\n",
      added: "github.com/google/uuid",
    },
    property: {
      path: "sum_test.go",
      seeded:
        'package fixture\n\nimport (\n\t"math/rand"\n\t"testing"\n)\n\nfunc TestSum(t *testing.T) {\n\tr := rand.New(rand.NewSource(42))\n\tfor i := 0; i < 100; i++ {\n\t\ta, b := r.Intn(9), r.Intn(9)\n\t\tif a+b != b+a {\n\t\t\tt.Fatal(a, b)\n\t\t}\n\t}\n}\n',
      library:
        'package fixture\n\nimport (\n\t"testing"\n\t"testing/quick"\n)\n\nfunc TestSum(t *testing.T) {\n\tif err := quick.Check(func(a, b int) bool { return a+b == b+a }, nil); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n',
    },
    mutation: { tool: "go-mutesting", source: "sum.go", files: {}, on: ["go-mutesting"] },
  },
  rust: {
    files: {
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    },
    gates: ["cargo-fmt", "cargo-clippy", "cargo-test"],
    wholeUnit: ["cargo-fmt", "cargo-clippy"],
    manifest: {
      path: "Cargo.toml",
      before: '[package]\nname = "fixture"\nversion = "0.1.0"\n\n[dependencies]\n',
      after: '[package]\nname = "fixture"\nversion = "0.1.0"\n\n[dependencies]\nserde = "1"\n',
      added: "serde",
    },
    property: {
      path: "tests/sum.rs",
      seeded:
        "#[test]\nfn sum_commutes() {\n    let mut x: u64 = 42;\n    for _ in 0..100 {\n        x = x.wrapping_mul(6364136223846793005).wrapping_add(1);\n        let (a, b) = (x % 10, (x >> 8) % 10);\n        assert_eq!(a + b, b + a);\n    }\n}\n",
      library:
        "use proptest::prelude::*;\nproptest! {\n    #[test]\n    fn sum(a in 0u32..10, b in 0u32..10) { prop_assert_eq!(a + b, b + a); }\n}\n",
    },
    mutation: { tool: "cargo-mutants", source: "src/lib.rs", files: {}, on: ["cargo", "cargo-mutants"] },
  },
  maven: {
    files: { "pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>\n" },
    gates: ["maven-verify"],
    wholeUnit: [],
    manifest: {
      path: "pom.xml",
      before: "<project>\n  <dependencies>\n  </dependencies>\n</project>\n",
      after:
        "<project>\n  <dependencies>\n    <dependency>\n      <groupId>com.google.guava</groupId>\n      <artifactId>guava</artifactId>\n      <version>33.0.0-jre</version>\n    </dependency>\n  </dependencies>\n</project>\n",
      added: "com.google.guava:guava",
    },
    property: {
      path: "src/test/java/com/example/SumTest.java",
      seeded:
        "package com.example;\n\nimport java.util.Random;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass SumTest {\n    @Test\n    void commutes() {\n        Random r = new Random(42);\n        for (int i = 0; i < 100; i++) {\n            int a = r.nextInt(9), b = r.nextInt(9);\n            assertEquals(a + b, b + a);\n        }\n    }\n}\n",
      library:
        "package com.example;\n\nimport net.jqwik.api.*;\n\nclass SumProperties {\n    @Property\n    boolean commutes(@ForAll int a, @ForAll int b) { return a + b == b + a; }\n}\n",
    },
    mutation: {
      tool: "pit",
      source: "src/main/java/com/example/Sum.java",
      files: {
        "pom.xml":
          "<project><build><plugins><plugin><groupId>org.pitest</groupId><artifactId>pitest-maven</artifactId></plugin></plugins></build></project>\n",
      },
      on: ["mvn"],
    },
  },
  dotnet: {
    files: {
      "Fixture.csproj":
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n',
    },
    gates: ["dotnet-build", "dotnet-format", "dotnet-test"],
    wholeUnit: [],
    manifest: {
      path: "Fixture.csproj",
      before: '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n  </ItemGroup>\n</Project>\n',
      after:
        '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />\n  </ItemGroup>\n</Project>\n',
      added: "Newtonsoft.Json",
    },
    property: {
      path: "Tests/SumTests.cs",
      seeded:
        "using Xunit;\n\npublic class SumTests\n{\n    [Fact]\n    public void Commutes()\n    {\n        var r = new System.Random(42);\n        for (var i = 0; i < 100; i++)\n        {\n            int a = r.Next(9), b = r.Next(9);\n            Assert.Equal(a + b, b + a);\n        }\n    }\n}\n",
      library:
        "using FsCheck;\nusing FsCheck.Xunit;\n\npublic class SumProperties\n{\n    [Property]\n    public bool Commutes(int a, int b) => a + b == b + a;\n}\n",
    },
    // No mutation adapter for .NET: the gate runs the built-in engine.
    mutation: null,
  },
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-gate-matrix-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

/** A cell: skipped while `KNOWN` names an open issue for it. */
function cell(stack: Stack, name: string, body: () => void | Promise<void>, timeout?: number) {
  const issue = KNOWN[`${stack}:${name}`];
  if (issue) test.skip(`${name} (known: ${issue})`, body);
  else test(name, body, timeout);
}

/** A tool shell over a real directory with a fixed PATH, for detection only. */
function shell(root: string, on: string[]): ToolShell {
  return {
    root,
    scratch: join(root, ".scratch"),
    platform: "linux",
    run: async () => ({ exitCode: 0, output: "", timedOut: false }),
    read: (path) => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    },
    exists: (path) => existsSync(join(root, path)),
    remove: () => {},
    which: (command) => (on.includes(command) ? `/usr/bin/${command}` : null),
    now: () => 0,
  };
}

for (const stack of STACKS) {
  const fixture = FIXTURES[stack];
  describe(`gate matrix: ${stack}`, () => {
    const preselected = () =>
      detectGates(project(fixture.files))
        .filter((s) => s.preselected)
        .map((s) => s.check);

    cell(stack, "detection", () => {
      expect(preselected().map((c) => c.id)).toEqual(fixture.gates);
    });

    // The mutation gate needs a required test check to run the mutants against; without one it is
    // a silent no-op (#844).
    cell(stack, "test-check", () => {
      expect(preselected().some((c) => c.required && isTestCheck(c))).toBe(true);
    });

    // Whole-unit checks fail in a task's worktree until sibling tasks' files exist, so they run at
    // integration; file-local static checks run per task (#799, #842).
    cell(stack, "per-task-or-integration", () => {
      const checks = preselected();
      expect(checks.filter(isWholeUnitCheck).map((c) => c.id)).toEqual(fixture.wholeUnit);
      for (const check of checks.filter((c) => isTestCheck(c))) {
        expect(isStaticCheck(check)).toBe(false);
      }
    });

    // `allowNewDependencies: false` relies on this to see a dependency added to the stack's
    // manifest (#802).
    cell(stack, "dependency-check", () => {
      const { declared } = addedDependencies([
        { path: fixture.manifest.path, before: fixture.manifest.before, content: fixture.manifest.after },
      ]);
      expect(declared.map((d) => d.name)).toContain(fixture.manifest.added);
    });

    // A project that forbids new dependencies can still satisfy the property-test gate with a
    // seeded generator in its own test framework (#796).
    cell(stack, "property-tests", () => {
      expect(propertyTestKind(fixture.property.path, fixture.property.seeded)).toBe("seeded");
      expect(propertyTestKind(fixture.property.path, fixture.property.library)).toBe("library");
    });

    cell(stack, "mutation-tool", () => {
      const mutation = fixture.mutation;
      const source = { path: mutation?.source ?? "src/Sum.cs", content: "x\n", before: null };
      if (!mutation) {
        expect(detectMutationTool([source], shell(project(fixture.files), []))).toBeNull();
        return;
      }
      const installed = project({ ...fixture.files, ...mutation.files });
      expect(detectMutationTool([source], shell(installed, mutation.on))?.tool).toBe(
        mutation.tool as never,
      );
      // Without the tool the built-in engine runs: detection never invents one.
      expect(detectMutationTool([source], shell(project(fixture.files), []))).toBeNull();
    });
  });
}

// --- Toolchain tier --------------------------------------------------------------------------

/** Minimal valid projects whose detected gates should all pass with the real tools. */
const RUNNABLE: Partial<Record<Stack, { files: Record<string, string>; needs: string[][] }>> = {
  bun: {
    files: {
      "package.json": JSON.stringify({ name: "fixture", private: true, scripts: { test: "bun test" } }),
      "bun.lock": '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "": {\n      "name": "fixture",\n    },\n  },\n  "packages": {},\n}\n',
      "sum.ts": "export const sum = (a: number, b: number): number => a + b;\n",
      "sum.test.ts":
        'import { expect, test } from "bun:test";\nimport { sum } from "./sum";\n\ntest("sum", () => {\n  expect(sum(1, 2)).toBe(3);\n});\n',
    },
    needs: [["bun", "--version"]],
  },
  python: {
    files: {
      "pyproject.toml":
        "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      "fixture/__init__.py": "",
      "fixture/sum.py": "def add(a: int, b: int) -> int:\n    return a + b\n",
      "tests/test_sum.py": "from fixture.sum import add\n\n\ndef test_add() -> None:\n    assert add(1, 2) == 3\n",
    },
    needs: [
      ["python3", "-m", "pytest", "--version"],
      ["ruff", "--version"],
    ],
  },
  go: {
    files: {
      "go.mod": "module example.com/fixture\n\ngo 1.22\n",
      "sum.go": "package fixture\n\n// Sum adds two numbers.\nfunc Sum(a, b int) int {\n\treturn a + b\n}\n",
      "sum_test.go":
        'package fixture\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(1, 2) != 3 {\n\t\tt.Fatal("sum")\n\t}\n}\n',
    },
    needs: [["go", "version"]],
  },
  rust: {
    files: {
      "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      "src/lib.rs":
        "pub fn sum(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn adds() {\n        assert_eq!(sum(1, 2), 3);\n    }\n}\n",
    },
    needs: [
      ["cargo", "--version"],
      ["cargo", "fmt", "--version"],
      ["cargo", "clippy", "--version"],
    ],
  },
  maven: {
    files: {
      "pom.xml": `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>0.1.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`,
      "src/main/java/com/example/Sum.java":
        "package com.example;\n\npublic final class Sum {\n    private Sum() {}\n\n    public static int of(int a, int b) {\n        return a + b;\n    }\n}\n",
      "src/test/java/com/example/SumTest.java":
        "package com.example;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass SumTest {\n    @Test\n    void adds() {\n        assertEquals(3, Sum.of(1, 2));\n    }\n}\n",
    },
    needs: [
      ["mvn", "--version"],
      ["java", "-version"],
    ],
  },
  dotnet: {
    files: {
      "Fixture.csproj":
        '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n</Project>\n',
      "Sum.cs":
        "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + b;\n}\n",
    },
    needs: [["dotnet", "--version"]],
  },
};

const toolchains = process.env.BAKED_GATE_MATRIX_TOOLCHAINS === "1";
const available = (needs: string[][]) =>
  needs.every(([command, ...args]) => {
    if (!command) return false;
    const result = spawnSync(command, args, { stdio: "ignore", timeout: 60_000 });
    return result.status === 0;
  });

describe.skipIf(!toolchains)("gate matrix: toolchains", () => {
  for (const [stack, runnable] of Object.entries(RUNNABLE) as [Stack, NonNullable<(typeof RUNNABLE)[Stack]>][]) {
    // In CI every toolchain must be there; locally a missing one skips its row.
    const ready = process.env.CI ? true : available(runnable.needs);
    (ready ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      stack,
      `${stack}: every detected gate passes on a clean project`,
      async () => {
        const root = project(runnable.files);
        const checks = detectGates(root)
          .filter((s) => s.preselected)
          .map((s) => s.check);
        expect(checks.length).toBeGreaterThan(0);
        for (const check of checks) {
          const result = await executeGate(root, check, new AbortController().signal);
          expect({ gate: check.id, status: result.status, output: result.status === "passed" ? "" : result.outputTail }).toEqual({
            gate: check.id,
            status: "passed",
            output: "",
          });
        }
      },
      900_000,
    );
  }
});

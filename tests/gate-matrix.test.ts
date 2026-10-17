import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { syntaxErrors } from "../src/core/intelligence/syntax-check.js";
import { timedOutFailure } from "../src/core/verification/check-runner.js";
import { failureSignature } from "../src/core/verification/output-counts.js";
import { baselineDebt, baselineKeys } from "../src/core/verification/task-end-check.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { isStaticCheck, isWholeUnitCheck } from "../src/core/workflows/check-policy.js";
import { detectGates, executeGate } from "../src/core/workflows/gates.js";
import { type LayoutResult, layoutVerdict } from "../src/core/workflows/layout-check.js";
import { addedDependencies } from "../src/core/workflows/quality/dependencies.js";
import {
  detectMutationTool,
  type ToolShell,
  toolShellFiles,
} from "../src/core/workflows/quality/mutation-tools.js";
import { isTestCheck } from "../src/core/workflows/quality/mutation.js";
import {
  libraryFiles,
  propertyLibraries,
  propertyTestKind,
} from "../src/core/workflows/quality/properties.js";
import {
  checkBuiltinRules,
  ruleClaimKey,
  ruleClaimText,
  ruleFindingKey,
} from "../src/core/workflows/quality/rules.js";
import { staticCorrection } from "../src/core/workflows/scheduler.js";
import type { Check, RunPolicy, RuntimeState } from "../src/core/workflows/schemas.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { Task } from "../src/core/workflows/types.js";
import {
  createTaskWorktree,
  ensureRunWorktree,
  runContentCommit,
} from "../src/core/workflows/worktree.js";

/**
 * The gate matrix (#854): every supported stack against every quality gate's decision, without a
 * model. Bench rounds 12 and 13 lost whole rounds to gates that did not know a toolchain or a
 * project layout (#796, #835, #844, #840, #842); each of those is a cell here.
 *
 * A cell that is known to be wrong names its issue in `KNOWN` and is skipped; the PR that fixes the
 * issue removes the entry, so the cell runs from then on. A fix PR for a gate finding adds its
 * failing cell first.
 *
 * Worktree mode repeats the decisions in the run and task worktrees the loop runs in, created by
 * the scheduler's own worktree helpers with the working copy's `node_modules` linked (#835), and
 * reads them through the scheduler's tool shell and property-library probe.
 *
 * The toolchain tier at the end runs each stack's detected gates on a minimal valid project with
 * the real tools. It needs the toolchains, so it runs only with BAKED_GATE_MATRIX_TOOLCHAINS=1 (the
 * CI job `gate-matrix` sets it); the rest of the file is hermetic.
 */

type Stack = "bun" | "npm" | "python" | "go" | "rust" | "maven" | "dotnet";
const STACKS: Stack[] = ["bun", "npm", "python", "go", "rust", "maven", "dotnet"];

/** The gates a failure of which is corrected only in the files its output names (#1067). */
const STATIC_FIXES: Record<Stack, string[]> = {
  bun: ["typecheck", "lint"],
  npm: ["lint"],
  python: ["ruff"],
  go: ["go-vet"],
  rust: ["cargo-fmt", "cargo-clippy"],
  maven: [],
  dotnet: ["dotnet-format"],
};

/** The task-scope check that runs a test task's own file (#1271; compiled stacks #1396). */
const WRITTEN_TEST_ARGS: Record<Stack, string[] | null> = {
  // The detected JavaScript gates run a package script, whose arguments are up to the script.
  bun: null,
  npm: null,
  python: ["-m", "pytest", "-q", "./tests/test_sum.py"],
  go: ["test", "./."],
  rust: ["test", "--test", "sum"],
  maven: ["-B", "-q", "test", "-Dtest=com.example.SumTest", "-Dsurefire.failIfNoSpecifiedTests=false"],
  dotnet: ["test", "--nologo", "--filter", "FullyQualifiedName~SumTests."],
};

/** A failed test as the stack's test runner prints it, before a hang (#1277, #1424). */
const FAILED_TEST_OUTPUT: Record<Stack, string> = {
  bun: "test/sum.test.ts:\n(fail) sum is commutative [0.31ms]",
  npm: " FAIL  src/sum.test.js > sum\n × sum 2ms",
  python: "FAILED tests/test_sum.py::test_sum_commutes - assert 3 == 4",
  go: "--- FAIL: TestSum (0.00s)",
  rust: "test sum_commutes ... FAILED",
  maven: "[ERROR] com.example.SumTest.commutes -- Time elapsed: 0.012 s <<< FAILURE!",
  dotnet: "  Failed SumTests.Commutes [8 ms]",
};

/** Cells known to be wrong today: `<stack>:<cell>` -> issue. */
const KNOWN: Record<string, string> = {};

interface Fixture {
  /** Files that make the gate detector see the stack, as the bench loop's scaffolds write them. */
  files: Record<string, string>;
  /** The preselected gates detectGates proposes, in order. */
  gates: string[];
  /** The gates that analyze the whole compilation unit and so run at integration, not per task. */
  wholeUnit: string[];
  /** A manifest change that adds one dependency, and the dependency it adds. */
  manifest: { path: string; before: string; after: string; added: string };
  /**
   * A library-free property test (allowed when the project forbids new dependencies), one with the
   * library, and a deterministic one that enumerates a bounded domain (a request without random input, #1064).
   */
  property: { path: string; seeded: string; library: string; exhaustive: string };
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
      exhaustive:
        "import { expect, test } from 'bun:test';\ntest('sum is commutative for every byte pair', () => {\n  for (let a = 0; a < 256; a++) for (let b = 0; b < 16; b++) expect(a + b).toBe(b + a);\n});\n",
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
      exhaustive:
        "import { expect, test } from 'vitest';\ntest('sum', () => {\n  for (let a = 0; a < 256; a++) expect(a + 0).toBe(a);\n});\n",
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
      exhaustive:
        "def test_sum_commutes_for_every_byte():\n    for a in range(256):\n        for b in range(16):\n            assert a + b == b + a\n",
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
      exhaustive:
        "package fixture\n\nimport \"testing\"\n\nfunc TestSumForEveryMask(t *testing.T) {\n\tfor mask := 0; mask < 256; mask++ {\n\t\tif mask+0 != mask {\n\t\t\tt.Fatal(mask)\n\t\t}\n\t}\n}\n",
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
      exhaustive:
        "#[test]\nfn sum_commutes_for_every_byte() {\n    for a in 0..256u32 {\n        assert_eq!(a + 1, 1 + a);\n    }\n}\n",
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
      exhaustive:
        "package com.example;\n\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nclass SumTest {\n    @Test\n    void commutesForEveryByte() {\n        for (int a = 0; a < 256; a++) {\n            assertEquals(a + 1, 1 + a);\n        }\n    }\n}\n",
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
      exhaustive:
        "using Xunit;\n\npublic class SumTests\n{\n    [Fact]\n    public void CommutesForEveryByte()\n    {\n        for (var a = 0; a < 256; a++)\n        {\n            Assert.Equal(a + 1, 1 + a);\n        }\n    }\n}\n",
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

    cell(stack, "timed-out-failure", () => {
      expect(timedOutFailure(`${FAILED_TEST_OUTPUT[stack]}\nstill running`)).toBe(true);
    });

    cell(stack, "written-tests-check", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const written = writtenTestsCheck(root, preselected(), [{ path, action: "create" }]);
      expect(written?.args ?? null).toEqual(WRITTEN_TEST_ARGS[stack]);
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
    // A failed linter, formatter or type checker is corrected in the files its output names,
    // without their tests and without the planned task's whole scope; a test gate is not (#1067).
    cell(stack, "lint-corrective-scope", () => {
      const correction = (check: Check): boolean => {
        const store = {
          findings: () => [{ id: "F1", body_json: JSON.stringify({ claim: `Task T001 required check ${check.id} failed` }) }],
        } as unknown as WorkflowStore;
        const task = { origin: "repair", findingIds: ["F1"] } as Task;
        return staticCorrection(store, "run", { checks: [check] } as RunPolicy, task);
      };
      expect(preselected().filter(correction).map((c) => c.id)).toEqual(STATIC_FIXES[stack]);
    });

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

    // A request that forbids random input still gets a property test: a loop over every value of
    // a bounded domain counts (#1064: cidrfold-update looped over all 256 masks and was refused).
    cell(stack, "property-tests-exhaustive", () => {
      expect(propertyTestKind(fixture.property.path, fixture.property.exhaustive)).toBe("exhaustive");
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

// --- Rule pack -------------------------------------------------------------------------------

/**
 * A placeholder body in each stack's language, and an ordinary error whose message mentions a
 * todo, which a todo app writes on purpose (#845).
 */
const STUBS: Record<Stack, { path: string; placeholder: string; ordinary: string }> = {
  bun: {
    path: "src/sum.ts",
    placeholder: '  throw new Error("not implemented");',
    ordinary: '  throw new Error("Todo with id 3 does not exist");',
  },
  npm: {
    path: "src/sum.js",
    placeholder: '  throw new Error("TODO");',
    ordinary: '  throw new Error("Todo 3 not found");',
  },
  python: {
    path: "fixture/sum.py",
    // A Python stub is only a placeholder as a function's whole body (#937).
    placeholder: "def total(values):\n    raise NotImplementedError",
    ordinary: '    raise KeyError("Todo 3 does not exist")',
  },
  go: {
    path: "sum.go",
    placeholder: '\tpanic("not implemented")',
    ordinary: '\tpanic("todo list is empty")',
  },
  rust: {
    path: "src/lib.rs",
    placeholder: "    todo!()",
    ordinary: '    panic!("todo {} not found: {}", id, reason)',
  },
  maven: {
    path: "src/main/java/fixture/Sum.java",
    placeholder: "        throw new UnsupportedOperationException();",
    ordinary: '        throw new IllegalStateException("Todo 3 does not exist");',
  },
  dotnet: {
    path: "src/Sum.cs",
    placeholder: "        throw new NotImplementedException();",
    ordinary: '        throw new KeyNotFoundException("Todo 3 does not exist");',
  },
};

/**
 * A catch that returns the null or false its function's declared type announces, and one that
 * returns a default the type does not announce, in each stack with brace catches (#1192).
 */
const FALLBACKS: Partial<Record<Stack, { path: string; typed: string; silent: string }>> = {
  bun: {
    path: "src/url.ts",
    typed: "export function parseUrl(raw: string): URL | null {\n  try {\n    return new URL(raw);\n  } catch {\n    return null;\n  }\n}",
    silent: "export function parseUrl(raw: string) {\n  try {\n    return new URL(raw);\n  } catch {\n    return null;\n  }\n}",
  },
  npm: {
    path: "src/url.js",
    typed: "/** @returns {boolean} */\nexport function isUrl(raw) {\n  try { new URL(raw); return true; } catch { return false; }\n}",
    silent: "export function isUrl(raw) {\n  try { new URL(raw); return true; } catch { return false; }\n}",
  },
  maven: {
    path: "src/main/java/fixture/Urls.java",
    typed: "    static boolean isUrl(String raw) {\n        try {\n            new java.net.URI(raw);\n            return true;\n        } catch (Exception e) {\n            return false;\n        }\n    }",
    silent: "    static String host(String raw) {\n        try {\n            return new java.net.URI(raw).getHost();\n        } catch (Exception e) {\n            return \"\";\n        }\n    }",
  },
  dotnet: {
    path: "src/Urls.cs",
    typed: "    static bool IsUrl(string raw) {\n        try {\n            new Uri(raw);\n            return true;\n        } catch (Exception) {\n            return false;\n        }\n    }",
    silent: "    static string Host(string raw) {\n        try {\n            return new Uri(raw).Host;\n        } catch (Exception) {\n            return \"\";\n        }\n    }",
  },
};

for (const stack of STACKS) {
  const stub = STUBS[stack];
  const placeholders = (line: string) =>
    checkBuiltinRules([{ path: stub.path, content: `${line}\n`, before: null }], {}).filter(
      (f) => f.rule === "placeholder-body",
    );
  describe(`gate matrix: ${stack} rule pack`, () => {
    cell(stack, "rule-pack: placeholder-body", () => {
      expect(placeholders(stub.placeholder).map((f) => f.blocking)).toEqual([true]);
      expect(placeholders(stub.ordinary)).toEqual([]);
    });

    const fallback = FALLBACKS[stack];
    if (fallback)
      cell(stack, "rule-pack: catch-return-default", () => {
        const found = (content: string) =>
          checkBuiltinRules([{ path: fallback.path, content: `${content}\n`, before: null }], {})
            .filter((f) => f.rule === "catch-return-default")
            .map((f) => f.blocking);
        // A JSDoc type is not a declared return type: plain JavaScript keeps the finding.
        expect(found(fallback.typed)).toEqual(stack === "npm" ? [true] : []);
        expect(found(fallback.silent)).toEqual([true]);
      });

    // A correction that leaves the same match is kept as a limitation instead of asking again;
    // the earlier round's claim must read back to the same key, wherever the line moved (#845).
    cell(stack, "rule-pack: same match after a correction", () => {
      const [found] = checkBuiltinRules(
        [{ path: stub.path, content: `${stub.ordinary}\n${stub.placeholder}\n`, before: null }],
        {},
      ).filter((f) => f.rule === "placeholder-body");
      const finding = found ?? {
        rule: "placeholder-body",
        message: "The body is a placeholder, not an implementation",
        file: stub.path,
        line: 2,
        text: stub.placeholder.trim(),
      };
      const key = ruleFindingKey(finding);
      expect(ruleClaimKey(ruleClaimText(finding))).toBe(key);
      expect(ruleClaimKey(ruleClaimText({ ...finding, line: finding.line + 7 }))).toBe(key);
    });
  });
}

/**
 * The task-end syntax gate (#977): a source file of each stack that does not parse, with the line
 * the gate must name, and the same file fixed, which must pass.
 */
const SYNTAX: Record<Stack, { path: string; valid: string; broken: string; line: number }> = {
  bun: {
    path: "src/sum.ts",
    valid: "export const sum = <T extends number>(a: T, b: T): number => a + b;\n",
    broken: "export const sum = (a: number, b: number): number => {\n  return a + ;\n};\n",
    line: 2,
  },
  npm: {
    path: "src/sum.js",
    valid: "export const sum = (a, b) => a + b;\n",
    broken: "export const sum = (a, b) => {\n  return [a, b;\n};\n",
    line: 2,
  },
  python: {
    path: "fixture/sum.py",
    valid: "def total(a: int, b: int) -> int:\n    return a + b\n",
    broken: "def total(a: int, b: int) -> int:\n    return (a + b\n\nx = 1\n",
    line: 2,
  },
  go: {
    path: "sum.go",
    valid: "package fixture\n\nfunc Sum(a, b int) int { return a + b }\n",
    broken: "package fixture\n\nfunc Sum(a, b int) int {\n\treturn a + b +\n}\n",
    line: 4,
  },
  rust: {
    path: "src/lib.rs",
    valid: "pub fn sum(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    broken: "pub fn sum(a: i32, b: i32) -> i32 {\n    let s = \u201cx\u201d;\n    a + b\n}\n",
    line: 2,
  },
  maven: {
    path: "src/main/java/fixture/Sum.java",
    valid: "package fixture;\n\npublic class Sum {\n    int sum(int a, int b) { return a + b; }\n}\n",
    broken: "package fixture;\n\npublic class Sum {\n    int sum(int a, int b) { return a + b }\n}\n",
    line: 4,
  },
  dotnet: {
    path: "src/Sum.cs",
    valid: "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + b;\n}\n",
    broken: "namespace Fixture;\n\npublic static class Sum\n{\n    public static int Of(int a, int b) => a + ;\n}\n",
    line: 5,
  },
};

for (const stack of STACKS) {
  const sample = SYNTAX[stack];
  describe(`gate matrix: ${stack} syntax gate`, () => {
    cell(stack, "syntax gate: valid file passes", async () => {
      expect(await syntaxErrors(sample.path, sample.valid)).toEqual([]);
    });
    cell(stack, "syntax gate: broken file is refused at its line", async () => {
      const errors = await syntaxErrors(sample.path, sample.broken);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.line).toBe(sample.line);
    });
  });
}

// --- Layout check (#1262) --------------------------------------------------------------------

/** The layout check's decision on a measured page; it does not depend on the stack serving it. */
const page = (scrollWidth: number, httpStatus: number | null = 200): LayoutResult => ({
  status: "measured",
  width: 1280,
  height: 800,
  pages: [{ path: "/", httpStatus, scrollWidth, clientWidth: 1265, overflowing: [] }],
});

for (const stack of STACKS) {
  describe(`gate matrix: ${stack} layout check`, () => {
    cell(stack, "layout check: page that fits passes", () => {
      expect(layoutVerdict(page(1265)).passed).toBe(true);
    });
    cell(stack, "layout check: page wider than the viewport fails", () => {
      expect(layoutVerdict(page(1266))).toMatchObject({ passed: false });
    });
    cell(stack, "layout check: error page fails", () => {
      expect(layoutVerdict(page(1265, 500)).passed).toBe(false);
    });
    cell(stack, "layout check: no browser is not a pass", () => {
      expect(layoutVerdict({ status: "unavailable", reason: "missing dependency" }).passed).toBe(
        false,
      );
    });
  });
}

// --- Worktree mode ---------------------------------------------------------------------------

/** Dependencies installed in the working copy only, as `bun install` or `npm install` leaves them. */
const INSTALLED: Partial<Record<Stack, Record<string, string>>> = {
  bun: { "node_modules/fast-check/package.json": '{"name":"fast-check"}' },
  npm: { "node_modules/fast-check/package.json": '{"name":"fast-check"}' },
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "", GIT_CONFIG_SYSTEM: "", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

interface Worktrees {
  /** The working copy, where the user installed the dependencies. */
  workspace: string;
  /** The run worktree (mutation and property gates) and a task worktree (per-task checks). */
  roots: { name: "run" | "task"; root: string }[];
}

/**
 * The fixture committed in a repository, its dependencies installed but ignored, then the run
 * worktree and a task worktree created as the scheduler creates them.
 */
async function worktrees(files: Record<string, string>, installed: Record<string, string>): Promise<Worktrees> {
  const workspace = project({ ...files, ...installed, ".gitignore": ".baked/\nnode_modules/\n" });
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.name", "Matrix");
  git(workspace, "config", "user.email", "matrix@example.test");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "Scaffold");
  const runId = "gate-matrix";
  const state = {} as RuntimeState;
  const store = {
    workspace,
    run: () => ({ created_at: 1_700_000_000_000 }),
    state: () => state,
    saveState: (_id: string, next: RuntimeState) => Object.assign(state, next),
    transaction: <T>(action: () => T): T => action(),
    artifact: () => ({}),
  } as unknown as WorkflowStore;
  const run = await ensureRunWorktree(store, runId);
  const base = await runContentCommit(store, runId, run);
  const task = await createTaskWorktree(store, runId, "T001", base);
  return {
    workspace,
    roots: [
      { name: "run", root: join(workspace, run.path) },
      { name: "task", root: join(workspace, task) },
    ],
  };
}

for (const stack of STACKS) {
  const fixture = FIXTURES[stack];
  const installed = { ...INSTALLED[stack] };
  for (const [path, content] of Object.entries(fixture.mutation?.files ?? {}))
    if (path.startsWith("node_modules/")) installed[path] = content;
  const committed = Object.fromEntries(
    Object.entries({ ...fixture.files, ...fixture.mutation?.files }).filter(
      ([path]) => !path.startsWith("node_modules/"),
    ),
  );
  describe(`gate matrix: ${stack} in worktree mode`, () => {
    let setup: Worktrees;
    beforeAll(async () => {
      setup = await worktrees(committed, installed);
    });
    const preselected = (root: string) =>
      detectGates(root)
        .filter((s) => s.preselected)
        .map((s) => s.check);

    cell(stack, "worktree: dependencies linked", () => {
      for (const { root } of setup.roots) {
        expect(existsSync(join(root, ".git"))).toBe(true);
        expect(existsSync(join(root, "node_modules"))).toBe(Object.keys(installed).length > 0);
        if (Object.keys(installed).length)
          expect(lstatSync(join(root, "node_modules")).isSymbolicLink()).toBe(true);
      }
    });

    cell(stack, "worktree: detection", () => {
      const plain = preselected(setup.workspace);
      for (const { root } of setup.roots) {
        const checks = preselected(root);
        expect(checks.map((c) => c.id)).toEqual(fixture.gates);
        expect(checks).toEqual(plain);
      }
    });

    cell(stack, "worktree: test-check and per-task-or-integration", () => {
      for (const { root } of setup.roots) {
        const checks = preselected(root);
        expect(checks.some((c) => c.required && isTestCheck(c))).toBe(true);
        expect(checks.filter(isWholeUnitCheck).map((c) => c.id)).toEqual(fixture.wholeUnit);
        for (const check of checks.filter((c) => isTestCheck(c))) expect(isStaticCheck(check)).toBe(false);
      }
    });

    // The task adds a dependency to the manifest it checked out; the baseline is the scaffold's.
    cell(stack, "worktree: dependency-check", () => {
      const task = setup.roots.find((r) => r.name === "task")?.root ?? "";
      const path = fixture.manifest.path;
      const before = readFileSync(join(task, path), "utf8");
      expect(git(task, "status", "--porcelain", "--", path)).toBe("");
      writeFileSync(join(task, path), fixture.manifest.after);
      const { declared } = addedDependencies([
        { path, before, content: readFileSync(join(task, path), "utf8") },
      ]);
      writeFileSync(join(task, path), before);
      expect(declared.map((d) => d.name)).toContain(fixture.manifest.added);
    });

    // The scheduler's tool shell reads the run root; Stryker sits in the linked node_modules,
    // which used to throw "Path escapes workspace" (#835).
    cell(stack, "worktree: mutation-tool", () => {
      const mutation = fixture.mutation;
      const source = { path: mutation?.source ?? "src/Sum.cs", content: "x\n", before: null };
      for (const { root } of setup.roots) {
        const tools = { ...shell(root, mutation?.on ?? []), ...toolShellFiles(root) };
        const found = detectMutationTool([source], tools)?.tool ?? null;
        expect(found).toBe((mutation?.tool ?? null) as never);
      }
    });

    // The property-library probe reads the same linked node_modules (#796, #835).
    cell(stack, "worktree: property-libraries", () => {
      const probe = (root: string) => propertyLibraries({ ...libraryFiles(root), pythonImports: () => null });
      const plain = probe(setup.workspace);
      expect(plain["JS/TS"]).toBe(Boolean(INSTALLED[stack]));
      for (const { root } of setup.roots) expect(probe(root)).toEqual(plain);
    });

    // The baseline is measured in the run worktree; a later failure may name a task worktree or the
    // working copy behind the linked node_modules, and is still the same failure (#1055).
    cell(stack, "worktree: baseline-signature", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const failure = (root: string) => `Error: boom\n    at ${join(root, "src", "a")}:3:7`;
      const expected = failureSignature(failure(run), run);
      expect(expected).toContain("<root>");
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)])
        expect(failureSignature(failure(root), run)).toBe(expected);
    });

    // Under staticBaseline "relative" a diagnostic from before the run is debt in every worktree,
    // whichever one printed its absolute path; one in a file the run changes never is (#1222).
    cell(stack, "worktree: baseline-debt", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const lint = (root: string) => `${join(root, "lib", "old.py")}:1:1: E501 Line too long\nFound 1 error.`;
      const baseline = baselineKeys(lint(run), run);
      expect(baseline).toEqual(["lib/old.py|E# Line too long"]);
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)]) {
        expect(baselineDebt(lint(root), run, { baseline, changed: [], summary: 1 })).toEqual(baseline);
        expect(baselineDebt(lint(root), run, { baseline, changed: ["lib/old.py"], summary: 1 })).toBeNull();
      }
    });

    // A linter that fails on an unplanned file before the run still fails the same way after a task
    // adds files: its summary count is not part of the failure (dur 741547f0, #1218).
    cell(stack, "worktree: baseline-signature lint summary", () => {
      const run = setup.roots.find((r) => r.name === "run")?.root ?? "";
      const lint = (root: string, files: number) =>
        `${join(root, "biome.json")} format\n  × Formatter would have printed the following content:\nChecked ${files} files in 3ms. No fixes applied.\nFound 1 error.`;
      const expected = failureSignature(lint(run, 1), run);
      for (const root of [setup.workspace, ...setup.roots.map((r) => r.root)])
        expect(failureSignature(lint(root, 4), run)).toBe(expected);
    });
  });
}

// --- Toolchain tier --------------------------------------------------------------------------

/** Minimal valid projects whose detected gates should all pass with the real tools. */
const RUNNABLE: Partial<
  Record<Stack, { files: Record<string, string>; needs: string[][]; written?: string }>
> = {
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
      "tests/sum.rs": "#[test]\nfn sum_adds() {\n    assert_eq!(fixture::sum(1, 2), 3);\n}\n",
    },
    written: "tests/sum.rs",
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
    written: "src/test/java/com/example/SumTest.java",
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
// The test preload points HOME at an empty profile, where rustup finds no default toolchain;
// os.homedir() still names the real home, so the toolchain tier points rustup and cargo there.
if (toolchains) {
  process.env.RUSTUP_HOME ??= join(homedir(), ".rustup");
  process.env.CARGO_HOME ??= join(homedir(), ".cargo");
}
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
    if (runnable.written)
      (ready ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
        stack,
        `${stack}: the written-tests check runs the task's test file`,
        async () => {
          const root = project(runnable.files);
          const checks = detectGates(root)
            .filter((s) => s.preselected)
            .map((s) => s.check);
          const check = writtenTestsCheck(root, checks, [{ path: runnable.written ?? "", action: "create" }]);
          expect(check).not.toBeNull();
          if (!check) return;
          const result = await executeGate(root, check, new AbortController().signal);
          expect({ status: result.status, output: result.status === "passed" ? "" : result.outputTail }).toEqual({
            status: "passed",
            output: "",
          });
        },
        900_000,
      );
  }
});

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
import { reproExecutables } from "../src/core/verification/repro.js";
import { exitStatus, timedOutFailure } from "../src/core/verification/check-runner.js";
import { failureSignature, testCount } from "../src/core/verification/output-counts.js";
import { baselineDebt, baselineKeys } from "../src/core/verification/task-end-check.js";
import { plannedWrittenTests, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { launchedCommand } from "../src/core/workflows/launcher.js";
import { detectProfile } from "../src/core/tools/project.js";
import {
  coveringChecks,
  fixerCommand,
  isStaticCheck,
  isWholeUnitCheck,
  styleClaimShown,
} from "../src/core/workflows/check-policy.js";
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
import { scanTestIntegrity, testChanges } from "../src/core/workflows/test-integrity.js";
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
  go: ["gofmt", "go-vet"],
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

/** The program a README of the stack documents, which run_probe must be able to start (#1529). */
const DOCUMENTED_PROGRAM: Record<Stack, string> = {
  bun: "bun",
  npm: "node",
  python: process.platform === "win32" ? "python" : "python3",
  go: "go",
  rust: "cargo",
  maven: "java",
  dotnet: "dotnet",
};

/**
 * The edit tools' lint and per-file format commands (#1537): the Python profile read ruff only from
 * ruff.toml, so this fixture's `[tool.ruff]` project got flake8 and black while its gates ran ruff.
 */
const EDIT_PROFILE: Record<Stack, { lint: string | null; formatFile: string | null }> = {
  bun: { lint: "bun run lint", formatFile: null },
  npm: { lint: "npm run lint", formatFile: null },
  python: { lint: "ruff check", formatFile: "ruff format" },
  go: { lint: "go vet ./...", formatFile: "gofmt -w" },
  rust: { lint: "cargo clippy", formatFile: "rustfmt" },
  maven: { lint: "mvn checkstyle:check", formatFile: null },
  dotnet: { lint: "dotnet format --verify-no-changes", formatFile: null },
};

/** The launchers a project may start its checks through (#1507). */
const LAUNCHERS: [string, (executable: string, args: string[]) => { executable: string; args: string[] }][] = [
  ["cmd /c", (executable, args) => ({ executable: "cmd", args: ["/c", executable, ...args] })],
  ["cmd.exe /d /s /c", (executable, args) => ({ executable: "cmd.exe", args: ["/d", "/s", "/c", [executable, ...args].join(" ")] })],
  ["sh -c", (executable, args) => ({ executable: "sh", args: ["-c", [executable, ...args].join(" ")] })],
  ["pwsh -Command", (executable, args) => ({ executable: "pwsh", args: ["-NoProfile", "-Command", [executable, ...args].join(" ")] })],
];

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

/**
 * A red baseline as the stack's test runner (and Python's type checker) prints it, with `n` files
 * checked or tests passing. A task that adds a file or a passing test changes `n` but not the
 * failure, which must keep its signature (#1221, #1425).
 */
const RED_BASELINE: Record<Stack, (n: number) => string> = {
  bun: (n) => `test/old.test.ts:\n(fail) old [1.00ms]\n\n ${n} pass\n 1 fail\n ${n + 1} expect() calls\nRan ${n + 1} tests across ${n} files. [12.00ms]`,
  npm: (n) => ` FAIL  src/old.test.js > old\n Test Files  1 failed | ${n} passed (${n + 1})\n      Tests  1 failed | ${n} passed (${n + 1})`,
  python: (n) => `FAILED tests/test_old.py::test_old - assert 1 == 2\n=== 1 failed, ${n} passed in 0.12s ===\nsrc/old.py:3: error: Incompatible return value type\nFound 1 error in 1 file (checked ${n} source files)`,
  go: (n) => `--- FAIL: TestOld (0.00s)\nFAIL\nFAIL\texample.com/fixture\t0.0${n}s`,
  rust: (n) => `running ${n + 1} tests\ntest old ... FAILED\ntest result: FAILED. ${n} passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`,
  maven: (n) => `[ERROR] Tests run: ${n + 1}, Failures: 1, Errors: 0, Skipped: 0\n[ERROR] com.example.OldTest.old -- Time elapsed: 0.01 s <<< FAILURE!`,
  dotnet: (n) => `  Failed OldTests.Old [3 ms]\nFailed!  - Failed:     1, Passed:     ${n}, Skipped:     0, Total:     ${n + 1}`,
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
    gates: ["gofmt", "go-vet", "go-test"],
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

    // caesar 21bc3a53: run_probe refused java next to `mvn verify`, so its README task blocked.
    cell(stack, "README example program runs under run_probe", () => {
      expect(reproExecutables(preselected())).toContain(DOCUMENTED_PROGRAM[stack]);
    });

    cell(stack, "edit-profile", async () => {
      const profile = await detectProfile(project(fixture.files));
      expect({ lint: profile.lint, formatFile: profile.formatFile }).toEqual(EDIT_PROFILE[stack]);
    });

    cell(stack, "timed-out-failure", () => {
      expect(timedOutFailure(`${FAILED_TEST_OUTPUT[stack]}\nstill running`)).toBe(true);
    });

    cell(stack, "baseline-signature test summary", () => {
      expect(failureSignature(RED_BASELINE[stack](4), "/w")).toBe(failureSignature(RED_BASELINE[stack](5), "/w"));
    });

    cell(stack, "written-tests-check", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const written = writtenTestsCheck(root, preselected(), [{ path, action: "create" }]);
      expect(written?.args ?? null).toEqual(WRITTEN_TEST_ARGS[stack]);
    });

    // A planned test task is told the check of its test files before they exist (#1518): bench
    // round 43's bun test tasks listed no suite check and did not know they could run it.
    cell(stack, "planned-written-tests", () => {
      const path = fixture.property.path;
      const root = project({ ...fixture.files, [path]: fixture.property.seeded });
      const writes = [{ path, action: "create" }];
      const written = writtenTestsCheck(root, preselected(), writes);
      expect(plannedWrittenTests(preselected(), writes)?.id ?? null).toBe(written?.id ?? null);
      if (written) expect(plannedWrittenTests(preselected(), writes)?.timeoutMs).toBe(written.timeoutMs);
    });

    // The mutation gate needs a required test check to run the mutants against; without one it is
    // a silent no-op (#844).
    cell(stack, "test-check", () => {
      expect(preselected().some((c) => c.required && isTestCheck(c))).toBe(true);
    });

    // A check started through a launcher routes by the program the launcher runs (#1507): bench
    // round 42 wrote the Maven check as `cmd /c mvn -B -q verify`, and 7 of 7 features got no
    // task-end test check and no mutation gate.
    for (const [launcher, wrap] of LAUNCHERS)
      cell(stack, `written-tests-check and test-check behind ${launcher}`, () => {
        const path = fixture.property.path;
        const root = project({ ...fixture.files, [path]: fixture.property.seeded });
        const checks = preselected().map((c) => ({ ...c, ...wrap(c.executable, c.args) }));
        expect(checks.some((c) => c.required && isTestCheck(c))).toBe(true);
        const written = writtenTestsCheck(root, checks, [{ path, action: "create" }]);
        if (!WRITTEN_TEST_ARGS[stack]) return expect(written).toBeNull();
        expect(written?.executable).toBe(launcher.split(" ")[0]);
        expect(launchedCommand(written?.executable ?? "", written?.args ?? []).args).toEqual(WRITTEN_TEST_ARGS[stack]);
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

// --- Test integrity ----------------------------------------------------------------------

/**
 * A test that checks parts of the output (a prefix, a count, a final row), and the same test
 * strengthened to one comparison with the full expected output: fewer assertions, more expected
 * text. A correction of a test-strength finding writes the second (#1481).
 */
const STRENGTHENED: Record<Stack, { path: string; loose: string; strict: string }> = {
  bun: {
    path: "tests/table.test.ts",
    loose: 'test("table", () => {\n  expect(out).toContain("1 | one");\n  expect(out).toContain("2 | two");\n  expect(out.length).toBe(17);\n});\n',
    strict: 'test("table", () => {\n  expect(out).toBe("1 | one\\n2 | two\\n3 | three\\n");\n});\n',
  },
  npm: {
    path: "test/table.test.js",
    loose: 'test("table", () => {\n  assert.ok(out.startsWith("1 | one"));\n  assert.ok(out.endsWith("3 | three"));\n});\n',
    strict: 'test("table", () => {\n  assert.strictEqual(out, "1 | one\\n2 | two\\n3 | three");\n});\n',
  },
  python: {
    path: "tests/test_table.py",
    loose: 'def test_table():\n    assert out.startswith("1 | one")\n    assert out.count("\\n") == 3\n',
    strict: 'def test_table():\n    assert out == """1 | one\n2 | two\n3 | three\n"""\n',
  },
  go: {
    path: "table_test.go",
    loose: 'func TestTable(t *testing.T) {\n\tif !strings.HasPrefix(out, "1 | one") {\n\t\tt.Errorf("prefix")\n\t}\n\tif strings.Count(out, "\\n") != 3 {\n\t\tt.Errorf("rows")\n\t}\n}\n',
    strict: 'func TestTable(t *testing.T) {\n\twant := `1 | one\n2 | two\n3 | three\n`\n\tif out != want {\n\t\tt.Errorf("got %q", out)\n\t}\n}\n',
  },
  rust: {
    path: "tests/table.rs",
    loose: '#[test]\nfn table() {\n    assert!(out.starts_with("1 | one"));\n    assert_eq!(out.lines().count(), 3);\n}\n',
    strict: '#[test]\nfn table() {\n    assert_eq!(out, "1 | one\\n2 | two\\n3 | three\\n");\n}\n',
  },
  maven: {
    path: "src/test/java/fixture/TableTest.java",
    loose: '    @Test\n    void table() {\n        assertTrue(out.startsWith("1 | one"));\n        assertEquals(3, out.lines().count());\n    }\n',
    strict: '    @Test\n    void table() {\n        assertEquals("1 | one\\n2 | two\\n3 | three\\n", out);\n    }\n',
  },
  dotnet: {
    path: "tests/TableTests.cs",
    loose: '    [Fact]\n    public void Table()\n    {\n        Assert.StartsWith("1 | one", output);\n        Assert.Equal(3, output.Split("\\n").Length);\n    }\n',
    strict: '    [Fact]\n    public void Table()\n    {\n        Assert.Equal("1 | one\\n2 | two\\n3 | three\\n", output);\n    }\n',
  },
};

for (const stack of STACKS) {
  const sample = STRENGTHENED[stack];
  const rules = (strengthens: string[], after = sample.strict) =>
    scanTestIntegrity([{ path: sample.path, before: sample.loose, after }], {
      strengthens: new Set(strengthens),
    }).map((f) => f.rule);
  describe(`gate matrix: ${stack} test integrity`, () => {
    cell(stack, "test integrity: strengthened test of a test-strength finding passes", () => {
      expect(rules([sample.path])).toEqual([]);
    });
    cell(stack, "test integrity: the same edit without that finding is flagged", () => {
      expect(rules([])).toEqual(["assertions"]);
    });
    cell(stack, "test integrity: fewer assertions with less expected text are flagged", () => {
      // The loose test with its last assertion removed: weaker, not stronger.
      const lines = sample.loose.split("\n");
      const last = lines.findLastIndex((line) => /assert|expect\(|Errorf/i.test(line));
      const weaker = lines.filter((_, i) => i !== last).join("\n");
      expect(rules([sample.path], weaker)).toContain("assertions");
    });
  });
}

/**
 * A test file with two tests of one assertion each, by name, the first checking `v`. A correction
 * that swaps the first for a weaker test under another name keeps every total (#1519); one that
 * only retitles it keeps its body (#1532).
 */
const NAMED: Record<Stack, { path: string; file: (names: [string, string], v?: number) => string }> = {
  bun: {
    path: "tests/primes.test.ts",
    file: ([a, b], v = 1) => `test("${a}", () => {\n  expect(run()).toBe(${v});\n});\ntest("${b}", () => {\n  expect(run()).toBe(2);\n});\n`,
  },
  npm: {
    path: "test/primes.test.js",
    file: ([a, b], v = 1) => `it("${a}", () => {\n  assert.strictEqual(run(), ${v});\n});\nit("${b}", () => {\n  assert.strictEqual(run(), 2);\n});\n`,
  },
  python: {
    path: "tests/test_primes.py",
    file: ([a, b], v = 1) => `def test_${a}():\n    assert run() == ${v}\n\n\ndef test_${b}():\n    assert run() == 2\n`,
  },
  go: {
    path: "primes_test.go",
    file: ([a, b], v = 1) => `func Test${a}(t *testing.T) {\n\tif run() != ${v} {\n\t\tt.Errorf("want ${v}")\n\t}\n}\n\nfunc Test${b}(t *testing.T) {\n\tif run() != 2 {\n\t\tt.Errorf("want 2")\n\t}\n}\n`,
  },
  rust: {
    path: "tests/primes.rs",
    file: ([a, b], v = 1) => `#[test]\nfn ${a}() {\n    assert_eq!(run(), ${v});\n}\n\n#[test]\nfn ${b}() {\n    assert_eq!(run(), 2);\n}\n`,
  },
  maven: {
    path: "src/test/java/fixture/PrimesTest.java",
    file: ([a, b], v = 1) => `    @Test\n    void ${a}() {\n        assertEquals(${v}, run());\n    }\n\n    @Test\n    @DisplayName("second")\n    void ${b}() {\n        assertEquals(2, run());\n    }\n`,
  },
  dotnet: {
    path: "tests/PrimesTests.cs",
    file: ([a, b], v = 1) => `    [Fact]\n    public void ${a}()\n    {\n        Assert.Equal(${v}, Run());\n    }\n\n    [Theory]\n    [InlineData(2)]\n    public async Task ${b}(int n)\n    {\n        Assert.Equal(n, await Run());\n    }\n`,
  },
};

for (const stack of STACKS) {
  const sample = NAMED[stack];
  const before = sample.file(["intervalWorkload", "scalarCases"]);
  const swapped = sample.file(["literalCases", "scalarCases"], 3);
  const renamed = sample.file(["serializedLocation", "scalarCases"]);
  const scan = (after: string, options: Parameters<typeof scanTestIntegrity>[1] = {}) =>
    scanTestIntegrity([{ path: sample.path, before, after }], options);
  const name = (base: string) => (stack === "python" ? `test_${base}` : stack === "go" ? `Test${base}` : base);
  const protects = new Map([[sample.path, new Map([[name("intervalWorkload"), "T011 for finding F1"]])]]);
  describe(`gate matrix: ${stack} test identity`, () => {
    cell(stack, "test identity: a test swapped for another under a new name is flagged", () => {
      const found = scan(swapped);
      expect(found.map((f) => f.rule)).toEqual(["test-removed"]);
      expect(found[0]?.detail).toContain(JSON.stringify(name("intervalWorkload")));
    });
    cell(stack, "test identity: an added test and an edited body pass", () => {
      expect(scan(before.replace("1", "3"))).toEqual([]);
      expect(testChanges({ path: sample.path, before, after: swapped })).toEqual({ added: [name("literalCases")], renamed: {} });
    });
    cell(stack, "test identity: a test another finding's correction added stays, whatever the finding asks", () => {
      const found = scan(swapped, { protects, rewrites: new Set([sample.path]) });
      expect(found.map((f) => f.rule)).toEqual(["test-removed"]);
      expect(found[0]?.detail).toContain("which T011 for finding F1 added");
      expect(found[0]?.keep).toEqual([name("intervalWorkload")]);
      expect(scan(swapped, { rewrites: new Set([sample.path]) })).toEqual([]);
    });
    cell(stack, "test identity: a test retitled with its body kept is not removed, protected or not", () => {
      expect(scan(renamed)).toEqual([]);
      expect(scan(renamed, { protects })).toEqual([]);
      expect(testChanges({ path: sample.path, before, after: renamed })).toEqual({ added: [], renamed: { [name("intervalWorkload")]: name("serializedLocation") } });
    });
  });
}

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

/**
 * Formatting that a passing lint gate does not show (bench round 41, fpbits, #1480): `go vet`
 * passes on unformatted code, `gofmt -l` exits 0 whatever it lists, and `ruff check` reports no
 * formatting. Each stack's formatter is a file-local gate of its own, so it covers the files a task
 * writes and its fixer formats them before the task's checks run.
 */
describe("gate matrix: formatting a lint gate does not verify", () => {
  const formatters: [string, Record<string, string>, string, string, { executable: string; args: string[] }][] = [
    ["go", FIXTURES.go.files, "gofmt", "internal/core/format.go", { executable: "gofmt", args: ["-w", "internal/core/format.go"] }],
    [
      "python",
      { "pyproject.toml": "[project]\nname = 'fixture'\n\n[tool.ruff]\n\n[tool.ruff.format]\nquote-style = 'double'\n" },
      "ruff-format",
      "fixture/core.py",
      { executable: "ruff", args: ["format", "fixture/core.py"] },
    ],
    ["rust", FIXTURES.rust.files, "cargo-fmt", "src/core.rs", { executable: "cargo", args: ["fmt", "--", "src/core.rs"] }],
    ["dotnet", FIXTURES.dotnet.files, "dotnet-format", "src/Core.cs", { executable: "dotnet", args: ["format", "--include", "src/Core.cs"] }],
  ];
  for (const [stack, files, id, path, fixer] of formatters)
    test(`${stack}: ${id} is preselected and its fixer formats the file a task wrote`, () => {
      const checks = detectGates(project(files))
        .filter((s) => s.preselected)
        .map((s) => s.check);
      const check = checks.find((c) => c.id === id);
      expect(check?.fix && fixerCommand(check.fix, path)).toEqual(fixer);
      const writes = [{ path, action: "create" as const }];
      // Whole-unit formatters (cargo fmt) run at the checks stage after integration (#842).
      expect(coveringChecks({ checks } as RunPolicy, { writes }).some((c) => c.id === id)).toBe(!isWholeUnitCheck(check as Check));
    });

  test("gofmt -l fails on a file it lists although it exits 0", () => {
    const gofmt = detectGates(project(FIXTURES.go.files)).find((s) => s.check.id === "gofmt")?.check as Check;
    expect(exitStatus(gofmt, 0, "internal/core/format.go\n")).toBe("failed");
    expect(exitStatus(gofmt, 0, "")).toBe("passed");
    expect(exitStatus({ ...gofmt, executable: "C:\\Go\\bin\\gofmt.exe" }, 0, "a.go\n")).toBe("failed");
  });

  // A criterion that claims formatting or lint passes only on a check that shows it.
  const passed = (...commands: string[][]): Check[] =>
    commands.map(([executable = "", ...args]) => ({
      id: [executable, ...args].join("-").replace(/[^A-Za-z0-9_-]/g, ""),
      executable,
      args,
      cwd: ".",
      timeoutMs: 1000,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    }));
  const claims: [string, Check[], boolean | null][] = [
    ["All new Go files are gofmt-formatted; 'go vet ./...' and 'go test ./...' pass", passed(["go", "vet", "./..."], ["go", "test", "./..."]), false],
    ["All new Go files are gofmt-formatted; 'go vet ./...' and 'go test ./...' pass", passed(["gofmt", "-l", "."], ["go", "vet", "./..."]), true],
    ["changed Go files are formatted", passed(["go", "vet", "./..."]), false],
    ["the Python sources are formatted", passed(["ruff", "check", "."]), false],
    ["the Python sources are formatted", passed(["ruff", "format", "--check", "."]), true],
    ["the code is lint-clean", passed(["ruff", "check", "."]), true],
    ["the code is formatted", passed(["bun", "run", "lint"]), true],
    ["cargo fmt --check and clippy report nothing", passed(["cargo", "fmt", "--check"], ["cargo", "clippy"]), true],
    ["the report prints dates in ISO 8601 format", passed(["go", "test", "./..."]), null],
    ["the output is formatted as a table", passed(["go", "test", "./..."]), null],
  ];
  for (const [text, checks, shown] of claims)
    test(`"${text}" with ${checks.map((c) => c.id).join(", ")} passing: ${shown}`, () => {
      expect(styleClaimShown(text, checks)).toBe(shown);
    });
});

/**
 * A project whose toolchain no detector knows (Lua, PHP, C) states its commands in a task runner or
 * its CI (#1488). Without suggestions a shipped SDD preset refuses to start until a person types
 * every gate; with them the gates come from the project's own files, and a runner that prints TAP
 * or a JUnit XML report still gets the fewer-tests baseline.
 */
describe("gate matrix: a toolchain no detector knows", () => {
  const LUA = { "src/sum.lua": "return function(a, b) return a + b end\n", "spec/sum_spec.lua": "describe('sum', function() end)\n" };
  const cases: [string, Record<string, string>, [string, string, string[]][]][] = [
    [
      "Makefile",
      { ...LUA, Makefile: ".PHONY: test lint\nLUA ?= lua\n\nlint:\n\tluacheck src\n\ntest: lint\n\tbusted\n\nfmt-check fmt:\n\tstylua --check src\n" },
      [
        ["lint", "make", ["lint"]],
        ["format", "make", ["fmt-check"]],
        ["tests", "make", ["test"]],
      ],
    ],
    [
      "justfile",
      { ...LUA, justfile: "set shell := [\"bash\", \"-c\"]\nversion := \"1\"\n\n# Run the specs\ntest *args:\n    busted {{args}}\n\ncheck: test\n    luacheck src\n" },
      [
        ["tests", "just", ["test"]],
        ["check", "just", ["check"]],
      ],
    ],
    [
      "Taskfile",
      { ...LUA, "Taskfile.yml": "version: '3'\n\ntasks:\n  lint:\n    cmds:\n      - luacheck src\n  test:\n    deps: [lint]\n    cmds:\n      - busted\n" },
      [
        ["lint", "task", ["lint"]],
        ["tests", "task", ["test"]],
      ],
    ],
    [
      "CI workflow",
      {
        ...LUA,
        ".github/workflows/ci.yml": "on: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: luarocks install busted\n      - run: luacheck src\n      - name: Specs\n        run: |\n          busted --output=TAP\n      - run: busted --coverage && luacov\n",
      },
      [
        ["lint", "luacheck", ["src"]],
        ["tests", "busted", ["--output=TAP"]],
      ],
    ],
  ];
  for (const [name, files, expected] of cases)
    test(`${name}: its targets are suggested and preselected`, () => {
      const found = detectGates(project(files));
      expect(found.map((s) => [s.check.id, s.check.executable, s.check.args])).toEqual(expected);
      expect(found.every((s) => s.preselected && s.check.required && s.check.scope === "feature")).toBe(true);
    });

  test("a detected toolchain keeps its own gates, without the runner's", () => {
    const found = detectGates(project({ ...FIXTURES.go.files, Makefile: "test:\n\tgo test ./...\n" }));
    expect(found.map((s) => s.check.id)).toEqual(FIXTURES.go.gates);
  });

  test("the runner's test gate is a test check for the mutation and written-tests gates", () => {
    const tests = detectGates(project({ ...LUA, Makefile: "test:\n\tbusted\n" })).find((s) => s.check.id === "tests");
    expect(tests && isTestCheck(tests.check)).toBe(true);
  });

  test("TAP and JUnit XML output give the fewer-tests baseline", () => {
    expect(testCount("ok 1 - sum adds\nok 2 - sum commutes\n1..2\n")).toEqual({ tool: "tap", count: 2 });
    expect(testCount('<testsuites tests="5"><testsuite tests="5"/></testsuites>')).toEqual({ tool: "junit", count: 5 });
  });
});

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
  // A misaligned struct passes `go vet` and fails the format gate; the per-file fixer repairs it
  // (bench round 41, fpbits internal/core/format.go, #1480). The same for an unformatted Python file.
  const unformatted: [Stack, string, Record<string, string>, string, string[][]][] = [
    [
      "go",
      "gofmt",
      { ...RUNNABLE.go?.files, "format.go": "package fixture\n\ntype Format struct {\n\tA int\n\tLonger string\n}\n" },
      "format.go",
      [["go", "version"]],
    ],
    [
      "python",
      "ruff-format",
      {
        ...RUNNABLE.python?.files,
        "pyproject.toml": "[project]\nname = 'fixture'\nversion = '0.1.0'\n\n[tool.ruff]\nline-length = 100\n\n[tool.ruff.format]\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
        "fixture/core.py": "def core( a,b ):\n    return {'a':a,'b':b}\n",
      },
      "fixture/core.py",
      [["ruff", "--version"]],
    ],
  ];
  for (const [stack, id, files, path, needs] of unformatted)
    (process.env.CI || available(needs) ? cell : (s: Stack, name: string) => test.skip(`${name} (no toolchain)`, () => {}))(
      stack,
      `${stack}: ${id} fails on an unformatted file that the lint gate passes, and its fixer repairs it`,
      async () => {
        const root = project(files);
        const checks = detectGates(root)
          .filter((s) => s.preselected)
          .map((s) => s.check);
        const format = checks.find((c) => c.id === id);
        const lint = checks.find((c) => c.id === (stack === "go" ? "go-vet" : "ruff"));
        if (!format?.fix || !lint) throw new Error(`${id} or its lint gate is missing`);
        expect((await executeGate(root, lint, new AbortController().signal)).status).toBe("passed");
        const before = await executeGate(root, format, new AbortController().signal);
        expect(before.status).toBe("failed");
        expect(before.outputTail).toContain(path.split("/").at(-1) ?? path);
        const fix = fixerCommand(format.fix, path);
        expect(spawnSync(fix.executable, fix.args, { cwd: root }).status).toBe(0);
        expect((await executeGate(root, format, new AbortController().signal)).status).toBe("passed");
      },
      300_000,
    );

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

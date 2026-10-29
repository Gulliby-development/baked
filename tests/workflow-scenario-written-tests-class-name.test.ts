import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildCheckEnv, CheckRunner, exitStatus, replayUnselectedTests } from "../src/core/verification/check-runner.js";
import { testsRan } from "../src/core/verification/output-counts.js";
import { writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { replayUnselectedTestRuns } from "../src/core/workflows/trace.js";
import type { Check } from "../src/core/workflows/schemas.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 75, maskback head (#2363). The brief overwrote the scaffold's
// `UnitTest1.cs` with the first test class, `FailureExceptionTests`. The tests-written check
// filtered `dotnet test` by the file's name (`FullyQualifiedName~UnitTest1.`), selected no test and
// failed on a correct implementation: T015 kept a nested `UnitTest1` class to satisfy the filter,
// T016 raised a spec conflict, 1.31M tokens and one intervention. Java and Kotlin derived the class
// from the path the same way.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const check = (id: string, executable: string, args: string[]): Check =>
  ({ id, executable, args, cwd: ".", envNames: [], timeoutMs: 300_000, required: true, scope: "feature", writes: [] }) as Check;
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "baked-class-name-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const written = (files: Record<string, string>, run: Check) =>
  writtenTestsCheck(project(files), [run], Object.keys(files).map((path) => ({ path, action: "create" })));

const MASKBACK = `namespace Maskback.Tests;

public class FailureExceptionTests
{
    [Fact]
    public void KeepsTheMessage()
    {
        Assert.Equal("boom", new FailureException("boom").Message);
    }
}
`;

describe("scenario: maskback UnitTest1.cs holds FailureExceptionTests (#2363)", () => {
  const dotnet = check("tests", "dotnet", ["test", "--nologo"]);

  test("C#: the filter names the class the file declares, with its namespace, not the file", () => {
    const gate = written({ "Maskback.Tests/UnitTest1.cs": MASKBACK }, dotnet);
    expect(gate?.args).toEqual(["test", "--nologo", "--filter", "FullyQualifiedName~Maskback.Tests.FailureExceptionTests."]);
    expect(gate?.args.join(" ")).not.toContain("UnitTest1");
    expect(gate?.declaredTests).toEqual(["Maskback.Tests.FailureExceptionTests"]);
  });

  test("C#: two test classes in one file, a block namespace and a partial class in two files", () => {
    const two = `using Xunit;
namespace Maskback.Tests
{
    public class ParserTests
    {
        [Theory]
        [InlineData(1)]
        public void Parses(int value) { }
    }

    internal static class Builders { public static string Name = "[Fact]"; }

    public sealed class RendererTests
    {
        [Xunit.Fact] public void Renders() { }
    }
}
`;
    expect(written({ "Maskback.Tests/UnitTest1.cs": two }, dotnet)?.args.at(-1)).toBe(
      "FullyQualifiedName~Maskback.Tests.ParserTests.|FullyQualifiedName~Maskback.Tests.RendererTests.",
    );
    const partial = (body: string) => `namespace Maskback.Tests;\n\npublic partial class CliTests\n{\n    ${body}\n}\n`;
    expect(
      written(
        { "Maskback.Tests/CliTests.Parse.cs": partial("[Fact] public void Parses() { }"), "Maskback.Tests/CliTests.Run.cs": partial("[Fact] public void Runs() { }") },
        dotnet,
      )?.args.at(-1),
    ).toBe("FullyQualifiedName~Maskback.Tests.CliTests.");
  });

  test("C#: a file whose tests no class reader finds keeps the filter by its name", () => {
    const property = "public class ParserTests\n{\n    [Property]\n    public bool Parses(int n) => n == n;\n}\n";
    expect(written({ "Maskback.Tests/ParserTests.cs": property }, dotnet)?.args.at(-1)).toBe("FullyQualifiedName~ParserTests.");
    // A file that declares no test is a support file: no check runs it (#2439).
    expect(written({ "Maskback.Tests/ParserTests.cs": "public class ParserTests {}\n" }, dotnet)).toBeNull();
  });

  const JAVA = `package com.example;

import org.junit.jupiter.api.Test;

class AdderTest {
    @Test
    void adds() {}
}

final class SubtractorTest {
    @org.junit.jupiter.api.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(ints = {1})
    void subtracts(int value) {}
}

class Fixtures {
    static final String NAME = "@Test";
}
`;

  test("Java: maven and gradle run every test class the file declares", () => {
    expect(written({ "src/test/java/com/example/UnitTest1.java": JAVA }, check("tests", "mvn", ["-B", "test"]))?.args).toEqual([
      "-B",
      "test",
      "-Dtest=com.example.AdderTest,com.example.SubtractorTest",
      "-Dsurefire.failIfNoSpecifiedTests=false",
    ]);
    expect(written({ "src/test/java/com/example/UnitTest1.java": JAVA }, check("tests", "./gradlew", ["test"]))?.args).toEqual([
      "test",
      "--tests",
      "com.example.AdderTest",
      "--tests",
      "com.example.SubtractorTest",
    ]);
  });

  test("Kotlin: a class not named like the file, and top-level test functions in the file's class", () => {
    const kotlin = `package com.example

import kotlin.test.Test

class FailureExceptionTest {
    @Test
    fun keepsMessage() {}
}

class Helper(val name: String)

@Test
fun topLevel() {}
`;
    const gradle = check("tests", "gradle", ["test"]);
    expect(written({ "src/test/kotlin/com/example/UnitTest1.kt": kotlin }, gradle)?.args).toEqual([
      "test",
      "--tests",
      "com.example.FailureExceptionTest",
      "--tests",
      "com.example.UnitTest1Kt",
    ]);
    const named = `@file:JvmName("Checks")\npackage com.example\n\nimport org.junit.jupiter.api.Test\n\n@Test\nfun adds() {}\n`;
    expect(written({ "src/test/kotlin/com/example/checks.kt": named }, gradle)?.args).toEqual(["test", "--tests", "com.example.Checks"]);
  });
});

const POM = `<?xml version="1.0" encoding="UTF-8"?>
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
`;
const works = (command: string[]) =>
  Bun.which(command[0] ?? "") !== null && Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!works(["mvn", "--version"]) || !works(["java", "-version"]))("with maven: UnitTest1.java holds AdderTest (#2363)", () => {
  test("the written-tests check runs the declared class, where the filter by the file's name ran none", () => {
    const path = "src/test/java/com/example/UnitTest1.java";
    const root = project({
      "pom.xml": POM,
      [path]: "package com.example;\n\nimport static org.junit.jupiter.api.Assertions.assertEquals;\n\nimport org.junit.jupiter.api.Test;\n\nclass AdderTest {\n    @Test\n    void adds() {\n        assertEquals(3, 1 + 2);\n    }\n}\n",
    });
    const gate = writtenTestsCheck(root, [check("tests", "mvn", ["-B", "test"])], [{ path, action: "create" }]) as Check;
    const run = (args: string[]) => {
      const out = Bun.spawnSync([gate.executable, ...args], { cwd: root, env: buildCheckEnv(gate), stdout: "pipe", stderr: "pipe" });
      const output = out.stdout.toString() + out.stderr.toString();
      return { output, status: exitStatus(gate, out.exitCode ?? 1, output) };
    };
    const declared = run(gate.args);
    expect(declared.status, declared.output).toBe("passed");
    expect(testsRan(declared.output)?.count).toBe(1);
    // The check R75's rule built: `-Dtest` by the path, which names no class. Surefire runs
    // nothing and prints no count, so the check verified nothing.
    const byName = run(["-B", "test", "-Dtest=com.example.UnitTest1", "-Dsurefire.failIfNoSpecifiedTests=false"]);
    expect(testsRan(byName.output)).toBeNull();
    expect(byName.output).not.toContain("Tests run:");
  }, 600_000);
});

describe("a filter by the declared classes that runs no test is the host's (#2363, shadow)", () => {
  test("the check fails as before, a written_tests_unselected would-stop names the filter, and the replay finds it", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const attempt = store.reserve(run.runId, store.beginStep(run.runId, "fixture"), null, 0, fixture.policy);
    // A stand-in for `dotnet test --filter FullyQualifiedName~Maskback.Tests.FailureExceptionTests.`
    // whose filter matched nothing: dotnet's message, exit 0.
    const unselected: Check = {
      ...check("tests-written", "bun", ["-e", "console.log('No test matches the given testcase filter `FullyQualifiedName~Maskback.Tests.FailureExceptionTests.` in /w/bin/Maskback.Tests.dll')"]),
      scope: "task",
      requireTests: true,
      declaredTests: ["Maskback.Tests.FailureExceptionTests"],
    };
    const runner = new CheckRunner(store, new ProcessScope());
    const result = await runner.run(run.runId, attempt, unselected, new AbortController().signal, fixture.root);
    expect(result.status).toBe("failed");
    const stops = store
      .eventsOfType(run.runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "written_tests_unselected" ? [e.payload] : []));
    expect(stops).toHaveLength(1);
    expect(stops[0]?.mode).toBe("shadow");
    expect(stops[0]?.summary).toContain("Maskback.Tests.FailureExceptionTests");
    expect(replayUnselectedTests(store, run.runId)).toEqual([
      { checkId: "tests-written", command: `bun ${unselected.args.join(" ")}`, declared: ["Maskback.Tests.FailureExceptionTests"] },
    ]);
    // The trace replay counts it as recorded: a run before #2363 would show it as new.
    expect(replayUnselectedTestRuns(store, run.runId).map((b) => [b.checkId, b.recorded])).toEqual([["tests-written", true]]);
    // A check whose classes were not read from the file (the file-name fallback) records nothing.
    const { declaredTests: _, ...byName } = unselected;
    await runner.run(run.runId, attempt, { ...byName, id: "other-written" }, new AbortController().signal, fixture.root);
    expect(replayUnselectedTests(store, run.runId)).toHaveLength(1);
  }, 60_000);
});

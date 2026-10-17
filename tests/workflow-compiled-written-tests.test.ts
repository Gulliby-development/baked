import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { affectedTestCheck, isCompiledTestFile, writtenTestsCheck } from "../src/core/workflows/affected-tests.js";
import type { Check } from "../src/core/workflows/types.js";

// dieodds (C#, xUnit; bench round 39, #1396): the policy's only test check was `dotnet test`, which
// the written-tests check did not know, so no test task had a task check and five correctives
// (1.76M tokens) repaired wrong expectations after the feature gate.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const check = (id: string, executable: string, args: string[]): Check =>
  ({ id, executable, args, cwd: ".", envNames: [], timeoutMs: 300_000, required: true, scope: "feature", writes: [] }) as unknown as Check;

describe("written-tests check of compiled stacks (#1396)", () => {
  test("a dieodds test task gets a dotnet test check filtered to its test class", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-compiled-tests-"));
    dirs.push(root);
    const path = "tests/Dieodds.Tests/ParserTests.cs";
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), "public class ParserTests {}\n");
    const checks = [check("build", "dotnet", ["build"]), check("tests", "dotnet", ["test", "Dieodds.sln", "--nologo"])];
    expect(writtenTestsCheck(root, checks, [{ path, action: "create" }, { path: "src/Dieodds/Parser.cs", action: "modify" }])).toMatchObject({
      id: "tests-written",
      required: true,
      scope: "task",
      args: ["test", "Dieodds.sln", "--nologo", "--filter", "FullyQualifiedName~ParserTests."],
    });
  });

  test("test files of each compiled stack are recognised, sources are not", () => {
    expect(["tests/Dieodds.Tests/Roll.cs", "Tests/SumTests.cs", "src/App/ParserTest.cs", "tests/cli.rs", "crates/core/tests/parse.rs", "src/test/java/a/BTest.java", "app/src/test/kotlin/a/CTest.kt"].filter(isCompiledTestFile)).toHaveLength(7);
    expect(["src/Dieodds/Roll.cs", "tests/Dieodds.Tests/obj/Gen.cs", "src/lib.rs", "tests/common/mod.rs", "src/main/java/a/B.java"].filter(isCompiledTestFile)).toEqual([]);
  });

  test("cargo, maven and gradle run only the written files; a check that already filters is left alone", () => {
    expect(affectedTestCheck([check("t", "cargo", ["test", "--workspace", "--", "--nocapture"])], ["crates/core/tests/parse.rs"])?.args).toEqual(["test", "--workspace", "--test", "parse", "--", "--nocapture"]);
    expect(affectedTestCheck([check("t", "./mvnw", ["-B", "verify"])], ["src/test/java/com/acme/QueryTest.java"])?.args).toEqual(["-B", "test", "-Dtest=com.acme.QueryTest", "-Dsurefire.failIfNoSpecifiedTests=false"]);
    expect(affectedTestCheck([check("t", "gradlew", ["test", "--info"])], ["app/src/test/kotlin/com/acme/QueryTest.kt"])?.args).toEqual(["--info", "test", "--tests", "com.acme.QueryTest"]);
    expect(affectedTestCheck([check("t", "dotnet", ["test", "--filter", "Category=Unit"])], ["Tests/SumTests.cs"])).toBeNull();
    expect(affectedTestCheck([check("t", "dotnet", ["build"])], ["Tests/SumTests.cs"])).toBeNull();
  });
});

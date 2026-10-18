import { describe, expect, test } from "bun:test";
import { listsFailures } from "../src/core/verification/check-runner.js";
import { isCheckCommand } from "../src/core/verification/criteria-cases.js";
import { affectedTestCheck } from "../src/core/workflows/affected-tests.js";
import { fixerCommand, isWholeUnitFixer, wholeUnitFixerCommand } from "../src/core/workflows/check-policy.js";
import { launchedCommand } from "../src/core/workflows/launcher.js";
import { isTestCheck } from "../src/core/workflows/quality/mutation.js";
import type { Check } from "../src/core/workflows/types.js";

// Bench round 42, fecsmith (#1507): the loop's scaffold wrote the Maven check as `cmd /c mvn -B -q
// verify`. Routing read only `cmd`, so 7 of 7 Java features had no task-end test check and every
// mutation gate reported "no required test check in the policy".

const check = (executable: string, args: string[], id = "verify"): Check =>
  ({ id, executable, args, cwd: ".", required: true, timeoutMs: 600_000, scope: "run", writes: [] }) as unknown as Check;

describe("a command behind a launcher", () => {
  test("is the program the launcher runs, through cmd.exe, POSIX shells and PowerShell", () => {
    const cases: [string, string[], string, string[]][] = [
      ["cmd", ["/c", "mvn", "-B", "-q", "verify"], "mvn", ["-B", "-q", "verify"]],
      ["C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", '"mvn.cmd -B verify"'], "mvn", ["-B", "verify"]],
      ["sh", ["-c", "python -m pytest -q"], "python", ["-m", "pytest", "-q"]],
      ["/bin/bash", ["-lc", "go test './...'"], "go", ["test", "./..."]],
      ["pwsh", ["-NoProfile", "-Command", "dotnet test --nologo"], "dotnet", ["test", "--nologo"]],
      ["cmd", ["/c", 'sh -c "bun test"'], "bun", ["test"]],
    ];
    for (const [executable, args, program, inner] of cases)
      expect(launchedCommand(executable, args)).toMatchObject({ program, args: inner });
  });

  test("with shell syntax, or arguments after `sh -c`, stays the launcher", () => {
    for (const [executable, args] of [
      ["cmd", ["/c", "cd app && mvn verify"]],
      ["cmd", ["/c", "mvn", "verify", "&", "echo", "done"]],
      ["sh", ["-c", "pytest | tee log"]],
      ["sh", ["-c", "pytest $ARGS"]],
      ["sh", ["-c", "pytest", "extra"]],
      ["bash", ["-c", "pytest 'unclosed"]],
    ] as [string, string[]][])
      expect(launchedCommand(executable, args).program).toBe(executable);
  });

  test("relaunches new arguments through the same launcher, quoting them for it", () => {
    expect(launchedCommand("cmd", ["/c", "mvn", "verify"]).launch(["test", "-Dtest=a.B,a.C"])).toEqual({
      executable: "cmd",
      args: ["/c", "mvn", "test", "-Dtest=a.B,a.C"],
    });
    expect(launchedCommand("sh", ["-c", "dotnet test"]).launch(["test", "--filter", "A|B"])).toEqual({
      executable: "sh",
      args: ["-c", "dotnet test --filter 'A|B'"],
    });
    // cmd.exe has no quoting that survives being one argument, so such a word is not launched.
    expect(launchedCommand("cmd", ["/c", "dotnet test"]).launch(["test", "--filter", "A|B"])).toBeNull();
  });
});

describe("routing behind a launcher (#1507)", () => {
  test("derives the task-end check of each toolchain and keeps the launcher", () => {
    expect(affectedTestCheck([check("cmd", ["/c", "mvn", "-B", "-q", "verify"])], ["src/test/java/com/x/SumTest.java"])).toMatchObject({
      id: "verify-affected",
      executable: "cmd",
      args: ["/c", "mvn", "-B", "-q", "test", "-Dtest=com.x.SumTest", "-Dsurefire.failIfNoSpecifiedTests=false"],
    });
    expect(affectedTestCheck([check("sh", ["-c", "pytest -q"])], ["tests/test_sum.py"])).toMatchObject({
      executable: "sh",
      args: ["-c", "pytest -q ./tests/test_sum.py"],
    });
    expect(affectedTestCheck([check("cmd", ["/c", "gradlew.bat build"])], ["src/test/kotlin/x/SumTest.kt"])?.args).toEqual([
      "/c",
      "gradlew.bat test --tests x.SumTest",
    ]);
    expect(affectedTestCheck([check("bash", ["-c", "cargo test"])], ["tests/sum.rs"])?.args).toEqual(["-c", "cargo test --test sum"]);
    expect(affectedTestCheck([check("cmd", ["/c", "bun", "test"])], ["src/sum.test.ts"])?.args).toEqual(["/c", "bun", "test", "./src/sum.test.ts"]);
  });

  test("makes a launched build tool a test check, and a launched non-test command not one", () => {
    expect(isTestCheck(check("cmd", ["/c", "mvn", "-B", "-q", "verify"]))).toBe(true);
    expect(isTestCheck(check("sh", ["-c", "./gradlew check"], "gate"))).toBe(true);
    expect(isTestCheck(check("cmd", ["/c", "mvn", "-DskipTests", "verify"]))).toBe(false);
    expect(isTestCheck(check("cmd", ["/c", "echo", "ready"], "gate"))).toBe(false);
  });

  test("gives fixers, listing checks and quoted commands the launched program", () => {
    const fmt = { executable: "sh", args: ["-c", "cargo fmt"] };
    expect(isWholeUnitFixer(fmt)).toBe(true);
    expect(wholeUnitFixerCommand(fmt, ["src/a.rs", "src/b.rs"])).toEqual({ executable: "sh", args: ["-c", "cargo fmt -- src/a.rs src/b.rs"] });
    // A path appended after `sh -c line` would be the line's $0, not the fixer's argument.
    expect(fixerCommand({ executable: "sh", args: ["-c", "ruff format"] }, "src/a.py")).toEqual({ executable: "sh", args: ["-c", "ruff format src/a.py"] });
    expect(fixerCommand({ executable: "cmd", args: ["/c", "go", "fmt"] }, "a.go")).toEqual({ executable: "cmd", args: ["/c", "gofmt", "-w", "a.go"] });
    expect(listsFailures({ executable: "cmd", args: ["/c", "gofmt", "-l", "."] })).toBe(true);
    expect(isCheckCommand("mvn -B verify", [{ executable: "cmd", args: ["/c", "mvn", "-B", "verify"] }])).toBe(true);
    expect(isCheckCommand("make verify", [{ executable: "sh", args: ["-c", "make verify"] }])).toBe(true);
  });
});

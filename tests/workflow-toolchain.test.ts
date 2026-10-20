import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { affectedTestCheck } from "../src/core/workflows/affected-tests.js";
import { fixerCommand } from "../src/core/workflows/check-policy.js";
import type { Check } from "../src/core/workflows/schemas.js";
import { withPerTestTimeout } from "../src/core/workflows/test-timeout.js";
import { toolchainCommand } from "../src/core/workflows/toolchain.js";

// #1655: the helpers that read a check's command knew different toolchains. A `uv run pytest`,
// `poetry run pytest`, `python -m unittest`, `cargo nextest run` or subdirectory check got no
// per-task test check, so a test task's own failures surfaced only at the feature gate, and pytest
// never got a per-test limit even where the project declares pytest-timeout.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const check = (executable: string, args: string[], cwd = "."): Check =>
  ({ id: "tests", executable, args, cwd, envNames: [], timeoutMs: 600_000, required: true, scope: "feature", writes: [] }) as unknown as Check;
const affected = (c: Check, tests: string[]) => {
  const found = affectedTestCheck([c], tests);
  return found && { cwd: found.cwd, command: [found.executable, ...found.args] };
};

describe("toolchain table (#1655)", () => {
  test("unwraps a Python environment runner and rebuilds the command through it", () => {
    const uv = toolchainCommand("uv", ["run", "pytest", "-q"]);
    expect([uv.program, ...uv.args]).toEqual(["pytest", "-q"]);
    expect(uv.launch(["-q", "./tests/test_a.py"])).toEqual({ executable: "uv", args: ["run", "pytest", "-q", "./tests/test_a.py"] });
    const shell = toolchainCommand("sh", ["-c", "poetry run python -m pytest"]);
    expect([shell.program, ...shell.args]).toEqual(["python", "-m", "pytest"]);
    // An option of the runner itself is not unwrapped.
    expect(toolchainCommand("uv", ["run", "--with", "x", "pytest"]).program).toBe("uv");
  });

  test("every reproduced command gets a per-task test check", () => {
    expect(affected(check("uv", ["run", "pytest", "-q"]), ["tests/test_a.py"])).toEqual({ cwd: ".", command: ["uv", "run", "pytest", "-q", "./tests/test_a.py"] });
    expect(affected(check("poetry", ["run", "pytest"]), ["tests/test_a.py"])).toEqual({ cwd: ".", command: ["poetry", "run", "pytest", "./tests/test_a.py"] });
    expect(affected(check("python3", ["-m", "pytest", "-q"], "api"), ["api/tests/test_a.py", "web/a.test.ts"])).toEqual({ cwd: "api", command: ["python3", "-m", "pytest", "-q", "./tests/test_a.py"] });
    expect(affected(check("python", ["-m", "unittest", "discover", "-s", "tests", "-v"]), ["tests/test_a.py"])).toEqual({ cwd: ".", command: ["python", "-m", "unittest", "-v", "./tests/test_a.py"] });
    expect(affected(check("go", ["test", "./..."], "svc"), ["svc/store/store_test.go"])).toEqual({ cwd: "svc", command: ["go", "test", "./store"] });
    expect(affected(check("cargo", ["nextest", "run", "--workspace"]), ["tests/sum.rs"])).toEqual({ cwd: ".", command: ["cargo", "nextest", "run", "--workspace", "--test", "sum"] });
    // A check in a subdirectory runs no test outside it.
    expect(affected(check("go", ["test", "./..."], "svc"), ["cmd/main_test.go"])).toBeNull();
    // tox runs its own environments and passes files only where tox.ini forwards {posargs}.
    expect(affected(check("tox", []), ["tests/test_a.py"])).toBeNull();
  });

  test("pytest gets a per-test limit only where the project declares pytest-timeout", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-toolchain-"));
    dirs.push(root);
    expect(withPerTestTimeout(check("uv", ["run", "pytest", "-q"]), root)).toEqual(["run", "pytest", "-q"]);
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'x'\n\n[dependency-groups]\ndev = ['pytest', 'pytest-timeout']\n");
    expect(withPerTestTimeout(check("uv", ["run", "pytest", "-q"]), root)).toEqual(["run", "pytest", "-q", "--timeout=30"]);
    expect(withPerTestTimeout(check("python3", ["-m", "pytest"]), root)).toEqual(["-m", "pytest", "--timeout=30"]);
    expect(withPerTestTimeout(check("pytest", ["--timeout=5"]), root)).toEqual(["--timeout=5"]);
    writeFileSync(join(root, "pyproject.toml"), "[project]\ndependencies = ['pytest-timeout']\n\n[tool.pytest.ini_options]\ntimeout = 120\n");
    expect(withPerTestTimeout(check("pytest", []), root)).toEqual([]);
    // go test's -timeout is one limit for the whole package binary, not per test; not added.
    expect(withPerTestTimeout(check("go", ["test", "./..."]), root)).toEqual(["test", "./..."]);
  });

  test("a fixer behind an environment runner takes the file like the bare tool", () => {
    expect(fixerCommand({ executable: "uv", args: ["run", "ruff", "check", "--fix"] }, "src/a.py")).toEqual({ executable: "uv", args: ["run", "ruff", "check", "--fix", "src/a.py"] });
  });
});

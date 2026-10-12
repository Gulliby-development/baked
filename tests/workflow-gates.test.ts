import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectChecks } from "../src/components/workflow/format.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  checkFromDraft,
  detectGates,
  draftFromCheck,
  emptyGateDraft,
  executeGate,
  formatCommandLine,
  outputTail,
  pythonExecutable,
  readGates,
  splitCommandLine,
  writeGates,
} from "../src/core/workflows/gates.js";
import type { Check } from "../src/core/workflows/types.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function workspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "baked-gates-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "fixture", scripts });
const ids = (root: string, configured: Check[] = []) =>
  detectGates(root, configured).map((s) => s.check.id);
const gate = (patch: Partial<Check> = {}): Check => ({
  id: "unit",
  executable: "bun",
  args: ["run", "test"],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope: "feature",
  envNames: [],
  writes: [],
  ...patch,
});

describe("gate detection by ecosystem", () => {
  test("package scripts pick the runner from the lock file", () => {
    const scripts = pkg({ typecheck: "tsc", lint: "biome check", test: "vitest", build: "vite build" });
    for (const [lock, runner] of [
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
    ] as const) {
      const found = detectGates(workspace({ "package.json": scripts, [lock]: "" }));
      expect(found.map((s) => s.check.id)).toEqual(["typecheck", "lint", "tests", "build"]);
      expect(found.every((s) => s.check.executable === runner)).toBe(true);
      expect(found[2]?.check.args).toEqual(["run", "test"]);
    }
  });
  test("a build is offered but not preselected, and the npm placeholder test is ignored", () => {
    const root = workspace({
      "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1', build: "tsc" }),
    });
    const found = detectGates(root);
    expect(found.map((s) => s.check.id)).toEqual(["build"]);
    expect(found[0]?.check.required).toBe(false);
    expect(found[0]?.preselected).toBe(false);
    expect(detectChecks(root)).toEqual([]);
  });
  test("alternative typecheck script names are recognized and broken package.json is skipped", () => {
    expect(ids(workspace({ "package.json": pkg({ "type-check": "tsc" }) }))).toEqual(["typecheck"]);
    expect(ids(workspace({ "package.json": "{ not json" }))).toEqual([]);
  });
  test("pytest comes from its config files or a declared dependency", () => {
    for (const files of [
      { "pytest.ini": "[pytest]\n" },
      { "pyproject.toml": "[tool.pytest.ini_options]\n" },
      { "setup.cfg": "[tool:pytest]\n" },
      { "tox.ini": "[pytest]\n" },
      { "tests/conftest.py": "" },
      { "requirements-dev.txt": "requests\npytest>=8\n" },
      { "pyproject.toml": 'dependencies = ["pytest>=8"]\n' },
    ]) {
      const found = detectGates(workspace(files));
      expect(found.map((s) => s.check.id)).toEqual(["pytest"]);
      expect(found[0]?.check.executable).toBe(pythonExecutable());
      expect(found[0]?.check.args).toEqual(["-m", "pytest", "-q"]);
    }
    expect(ids(workspace({ "requirements.txt": "requests\n" }))).toEqual([]);
  });
  test("ruff comes from its config or a declared dependency", () => {
    for (const files of [
      { "ruff.toml": "" },
      { ".ruff.toml": "" },
      { "pyproject.toml": "[tool.ruff]\nline-length = 100\n" },
      { "requirements.txt": "ruff==0.5\n" },
    ]) {
      const found = detectGates(workspace(files));
      expect(found.map((s) => s.check.id)).toEqual(["ruff"]);
      expect(found[0]?.check).toMatchObject({ executable: "ruff", args: ["check", "."] });
    }
  });
  test("go and cargo projects get their format, lint and test gates", () => {
    const go = detectGates(workspace({ "go.mod": "module example.com/x\n" }));
    expect(go.map((s) => s.check)).toMatchObject([
      { id: "go-vet", executable: "go", args: ["vet", "./..."], fix: { executable: "go", args: ["fmt", "./..."] } },
      { id: "go-test", executable: "go", args: ["test", "./..."] },
    ]);
    const cargo = detectGates(workspace({ "Cargo.toml": '[package]\nname = "x"\n' }));
    expect(cargo.map((s) => s.check)).toMatchObject([
      { id: "cargo-fmt", executable: "cargo", args: ["fmt", "--check"], fix: { executable: "cargo", args: ["fmt"] } },
      { id: "cargo-clippy", executable: "cargo", args: ["clippy", "--all-targets", "--", "-D", "warnings"] },
      { id: "cargo-test", executable: "cargo", args: ["test"] },
    ]);
  });
  test(".NET projects get build, format and test gates", () => {
    const found = detectGates(workspace({ "App.slnx": "<Solution />" }));
    expect(found.map((s) => s.check)).toMatchObject([
      { id: "dotnet-build", executable: "dotnet", args: ["build", "--nologo"] },
      {
        id: "dotnet-format",
        executable: "dotnet",
        args: ["format", "--verify-no-changes"],
        fix: { executable: "dotnet", args: ["format"] },
      },
      { id: "dotnet-test", executable: "dotnet", args: ["test", "--nologo"] },
    ]);
    expect(found[0]?.source).toBe("App.slnx");
    expect(ids(workspace({ "App.csproj": "<Project />" }))).toEqual(["dotnet-build", "dotnet-format", "dotnet-test"]);
  });
  test("several .NET files at the root name the solution explicitly", () => {
    const found = detectGates(workspace({ "A.csproj": "", "B.csproj": "", "All.sln": "" }));
    expect(found[0]?.check.args).toEqual(["build", "All.sln", "--nologo"]);
    expect(found[1]?.check.fix?.args).toEqual(["format", "All.sln"]);
  });
  test("a Maven project gets its verify gate", () => {
    expect(detectGates(workspace({ "pom.xml": "<project />" })).map((s) => s.check)).toMatchObject([
      { id: "maven-verify", executable: "mvn", args: ["-B", "-q", "verify"] },
    ]);
  });
  test("a polyglot project lists every ecosystem and an empty one lists nothing", () => {
    const root = workspace({
      "package.json": pkg({ test: "vitest" }),
      "bun.lock": "",
      "go.mod": "module x\n",
      "ruff.toml": "",
    });
    expect(ids(root)).toEqual(["tests", "ruff", "go-vet", "go-test"]);
    expect(ids(workspace())).toEqual([]);
  });
  test("gates that are already configured are not suggested again", () => {
    const root = workspace({ "package.json": pkg({ test: "vitest", lint: "biome" }), "bun.lock": "" });
    expect(ids(root, [gate({ id: "tests" })])).toEqual(["lint"]);
    expect(ids(root, [gate({ id: "my-lint", args: ["run", "lint"] })])).toEqual(["tests"]);
  });
  test("every suggestion satisfies the policy rules a run applies", () => {
    const root = workspace({
      "package.json": pkg({ typecheck: "tsc", lint: "l", test: "t", build: "b" }),
      "bun.lock": "",
      "pytest.ini": "",
      "ruff.toml": "",
      "go.mod": "module x\n",
      "Cargo.toml": "[package]\n",
    });
    const all = detectGates(root).map((s) => s.check);
    expect(all.length).toBe(11);
    expect(writeGates(root, all)).toBeUndefined();
    expect(readGates(root).map((c) => c.id)).toEqual(all.map((c) => c.id));
  });
});

describe("command line text", () => {
  test("splits quotes and keeps Windows backslashes", () => {
    expect(splitCommandLine(`python -m pytest "tests dir" 'a b' C:\\tools\\x.exe ""`)).toEqual([
      "python", "-m", "pytest", "tests dir", "a b", "C:\\tools\\x.exe", "",
    ]);
    expect(() => splitCommandLine('echo "open')).toThrow("Unclosed");
  });
  test("formatting round-trips arguments with spaces and quotes", () => {
    const args = ["-e", 'console.log("a b")', "plain", ""];
    expect(splitCommandLine(formatCommandLine("bun", args))).toEqual(["bun", ...args]);
  });
});

describe("gate drafts", () => {
  test("a valid draft becomes a check and back", () => {
    const root = workspace();
    const draft = { ...emptyGateDraft(), id: "unit", command: "bun run test --silent", timeoutSeconds: "90", envNames: "CI, NODE_ENV", writes: "coverage" };
    const result = checkFromDraft(draft, root, []);
    expect(result).toEqual({ ok: true, check: gate({ args: ["run", "test", "--silent"], timeoutMs: 90000, envNames: ["CI", "NODE_ENV"], writes: ["coverage"] }) });
    if (result.ok) expect(checkFromDraft(draftFromCheck(result.check), root, [])).toEqual(result);
  });
  test("each invalid field is reported in words", () => {
    const root = workspace();
    const base = { ...emptyGateDraft(), id: "unit", command: "bun test" };
    const error = (patch: Partial<typeof base>, others: Check[] = []) => {
      const result = checkFromDraft({ ...base, ...patch }, root, others);
      return result.ok ? null : result.error;
    };
    expect(error({ id: "bad id!" })).toContain("ID");
    expect(error({ command: "  " })).toContain("Enter the command");
    expect(error({ command: 'bun "x' })).toContain("Unclosed");
    expect(error({ timeoutSeconds: "0" })).toContain("Timeout");
    expect(error({ timeoutSeconds: "x" })).toContain("Timeout");
    expect(error({ cwd: "../outside" })).toBeTruthy();
    expect(error({ envNames: "1BAD" })).toContain("Invalid process definition");
    expect(error({ writes: "package.json" })).toContain("overlaps source/configuration");
    expect(error({}, [gate({ id: "unit" })])).toContain("Duplicate check ID unit");
    expect(error({})).toBeNull();
  });
});

describe("saving gates", () => {
  const read = (root: string) => JSON.parse(readFileSync(join(root, ".baked", "config.json"), "utf8"));
  test("keeps every other project setting and the rest of the workflow block", () => {
    const root = workspace({
      ".baked/config.json": JSON.stringify({
        defaultModel: "p/m",
        theme: { name: "x" },
        workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: { ...defaultWorkflowPolicy, maxTotalTokens: 123456, checks: [gate({ id: "old" })] } },
      }),
    });
    writeGates(root, [gate({ id: "a" }), gate({ id: "b", required: false })]);
    const saved = read(root);
    expect(saved.defaultModel).toBe("p/m");
    expect(saved.theme).toEqual({ name: "x" });
    expect(saved.workflows).toMatchObject({ enabled: true, importsEnabled: true });
    expect(saved.workflows.policy.maxTotalTokens).toBe(123456);
    expect(saved.workflows.policy.checks.map((c: Check) => c.id)).toEqual(["a", "b"]);
    expect(readGates(root).map((c) => c.id)).toEqual(["a", "b"]);
  });
  test("a project without a workflow block gets an enabled one", () => {
    const root = workspace({ ".baked/config.json": JSON.stringify({ defaultModel: "p/m" }) });
    writeGates(root, [gate()]);
    expect(read(root).workflows.enabled).toBe(true);
    expect(read(root).defaultModel).toBe("p/m");
  });
  test("a block inherited from the global config is copied, not lost", () => {
    const root = workspace();
    const inherited = { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: { ...defaultWorkflowPolicy, maxAgentCalls: 33 } };
    expect(readGates(root, inherited)).toEqual([]);
    writeGates(root, [gate()], inherited);
    expect(read(root).workflows).toMatchObject({ enabled: true, policy: { maxAgentCalls: 33 } });
  });
  test("an invalid gate is rejected and nothing is written", () => {
    const root = workspace();
    expect(() => writeGates(root, [gate({ id: "x" }), gate({ id: "x" })])).toThrow("Duplicate");
    expect(() => writeGates(root, [gate({ cwd: "../out" })])).toThrow();
    expect(() => readFileSync(join(root, ".baked", "config.json"))).toThrow();
  });
});

describe("running a gate on demand", () => {
  const run = (root: string, check: Check, signal = new AbortController().signal) => executeGate(root, check, signal);
  const script = (code: string, patch: Partial<Check> = {}) => gate({ args: ["-e", code], ...patch });
  test("reports a pass with its duration", async () => {
    const result = await run(workspace(), script("console.log('fine')"));
    expect(result).toMatchObject({ status: "passed", exitCode: 0 });
    expect(result.outputTail).toBe("fine");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
  test("reports a failure with the exit code and only the last lines of output", async () => {
    const result = await run(workspace(), script("for (let i = 1; i <= 100; i++) console.log('line ' + i); process.exit(3)"));
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    const lines = result.outputTail.split("\n");
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe("line 100");
    expect(lines[0]).toBe("line 61");
  });
  test("stops at the timeout", async () => {
    const result = await run(workspace(), script("setInterval(() => {}, 1000)", { timeoutMs: 1000 }));
    expect(result.status).toBe("timeout");
    expect(result.durationMs).toBeLessThan(10000);
  });
  test("can be cancelled", async () => {
    const controller = new AbortController();
    const pending = run(workspace(), script("setInterval(() => {}, 1000)", { timeoutMs: 60000 }), controller.signal);
    setTimeout(() => controller.abort(), 300);
    expect((await pending).status).toBe("cancelled");
  });
  test("a missing command is an error with a plain message, not a crash", async () => {
    const result = await run(workspace(), gate({ executable: "baked-no-such-tool-xyz", args: [] }));
    expect(result.status).toBe("error");
    expect(result.outputTail).toContain("Command not found");
  });
  test("runs in the declared directory and passes only declared environment names", async () => {
    const root = workspace({ "sub/marker.txt": "x" });
    process.env.BAKED_GATE_TEST_VISIBLE = "seen";
    process.env.BAKED_GATE_TEST_HIDDEN_TOKEN = "must-not-leak-12345";
    cleanups.push(() => {
      delete process.env.BAKED_GATE_TEST_VISIBLE;
      delete process.env.BAKED_GATE_TEST_HIDDEN_TOKEN;
    });
    const code = "console.log(require('fs').existsSync('marker.txt'), process.env.BAKED_GATE_TEST_VISIBLE, process.env.BAKED_GATE_TEST_HIDDEN_TOKEN)";
    expect((await run(root, script(code, { cwd: "sub" }))).outputTail).toBe("true seen undefined");
    // A secret-looking name reaches the child only when declared, and its value is masked in the tail.
    process.env.CUSTOM_DECLARED_SECRET = "declared-secret-value";
    cleanups.push(() => delete process.env.CUSTOM_DECLARED_SECRET);
    const print = "console.log(String(process.env.CUSTOM_DECLARED_SECRET))";
    expect((await run(root, script(print))).outputTail).toBe("undefined");
    expect((await run(root, script(print, { envNames: ["CUSTOM_DECLARED_SECRET"] }))).outputTail).toBe("[redacted]");
  });
  test("a definition outside the workspace is refused before anything starts", async () => {
    await expect(run(workspace(), script("1", { cwd: "../x" }))).rejects.toThrow();
  });
  test("output is stripped of terminal colors", () => {
    expect(outputTail("\u001b[31mred\u001b[0m\r\nplain\n")).toBe("red\nplain");
  });
});

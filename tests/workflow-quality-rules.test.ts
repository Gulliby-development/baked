import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  addedLines,
  BUILTIN_RULES,
  checkAstGrepRules,
  checkBuiltinRules,
  type ChangedFile,
  configuredRules,
} from "../src/core/workflows/quality/rules.js";
import { runReport } from "../src/core/workflows/run-report.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

const rulesOf = (files: ChangedFile[], settings = {}) =>
  checkBuiltinRules(files, settings).map((f) => `${f.rule}:${f.line}:${f.blocking ? "block" : "note"}`);
const created = (path: string, content: string): ChangedFile => ({ path, content, before: null });

describe("anti-slop rule pack", () => {
  test("a planted empty catch is a blocking finding with the rule ID", () => {
    const content = "export function load(path: string) {\n  try {\n    return read(path);\n  } catch (error) {\n  }\n}\n";
    expect(rulesOf([created("src/load.ts", content)])).toEqual(["empty-catch:4:block"]);
    expect(rulesOf([created("src/load.ts", "try { go(); } catch {}\n")])).toEqual(["empty-catch:1:block"]);
  });

  test("silent fallbacks in catch blocks, promises and Python are found", () => {
    const ts = "try {\n  return parse(text);\n} catch {\n  return null;\n}\nfetchIt().catch(() => {});\n";
    expect(rulesOf([created("src/a.ts", ts)])).toEqual(["catch-return-default:3:block", "promise-catch-ignore:6:block"]);
    const py = "try:\n    run()\nexcept ValueError:\n    pass\n\ntry:\n    run()\nexcept Exception: return None\n";
    expect(rulesOf([created("app/run.py", py)])).toEqual([
      "python-swallowed-exception:3:block",
      "python-swallowed-exception:8:block",
    ]);
    // An except clause that does more than pass is handling the error.
    const handled = "try:\n    run()\nexcept ValueError:\n    pass\n    log()\n";
    expect(rulesOf([created("app/run.py", handled)])).toEqual([]);
  });

  test("Go, Rust, suppressions and placeholders", () => {
    const go = "func f() {\n\tif err != nil {\n\t}\n\t_ = file.Close()\n}\n";
    expect(rulesOf([created("cmd/f.go", go)])).toEqual(["go-empty-error-check:2:block", "go-ignored-error:4:note"]);
    const rs = "fn main() { let v = parse().unwrap(); }\n#[cfg(test)]\nmod tests { fn t() { x().unwrap(); } }\n";
    expect(rulesOf([created("src/main.rs", rs)])).toEqual(["rust-unwrap:1:note"]);
    const ts = "// @ts-ignore\nconst a = b as any;\n// eslint-disable-next-line no-console\nthrow new Error(\"Not implemented\");\n// TODO: real logic\n";
    expect(rulesOf([created("src/x.ts", ts)])).toEqual([
      "ts-ignore:1:block",
      "explicit-any:2:note",
      "lint-suppression:3:note",
      "placeholder-body:4:block",
      "todo-comment:5:note",
    ]);
    expect(rulesOf([created("src/lib.rs", "fn parse() { todo!() }\n")])).toEqual(["placeholder-body:1:block"]);
  });

  test("a todo app's error messages are not placeholders (#845)", () => {
    const store = "if (!this.todoExists(id)) {\n  throw new Error(`Todo with id ${id} does not exist`);\n}\nthrow new Error('Todo not found');\n";
    expect(rulesOf([created("src/store.ts", store)])).toEqual([]);
    const placeholders = 'throw new Error("TODO");\nthrow new Error("todo: parse the date");\nthrow new Error(`Todo!`);\nthrow new Error("not yet implemented");\n';
    expect(rulesOf([created("src/x.ts", placeholders)])).toEqual([
      "placeholder-body:1:block",
      "placeholder-body:2:block",
      "placeholder-body:3:block",
      "placeholder-body:4:block",
    ]);
    expect(rulesOf([created("main.go", 'panic("todo")\npanic("Todo list is empty")\n')])).toEqual(["placeholder-body:1:block"]);
  });

  test("a Python function whose body only raises NotImplementedError is a placeholder (#937)", () => {
    const stubs: Array<[string, number]> = [
      ["def parse(text):\n    raise NotImplementedError\n", 2],
      ['def parse(text: str) -> int:\n    raise NotImplementedError("todo")\n', 2],
      [
        'class Parser:\n    def parse(self, text):\n        """Parse the text."""\n        raise NotImplementedError()\n\n    def other(self):\n        return 1\n',
        4,
      ],
      [
        'async def load(\n    path: str,\n) -> bytes:\n    """Load the file.\n\n    Reads all of it.\n    """\n    raise NotImplementedError\n',
        8,
      ],
      ["def stub():\n    pass\n    raise NotImplementedError\n", 3],
    ];
    for (const [content, line] of stubs) {
      expect(rulesOf([created("app/parse.py", content)])).toEqual([`placeholder-body:${line}:block`]);
    }
  });

  test("abstract methods and conditional NotImplementedError are not placeholders (#937)", () => {
    const allowed = [
      "from abc import abstractmethod\n\nclass Base:\n    @abstractmethod\n    def parse(self, text):\n        raise NotImplementedError\n",
      "import abc\n\nclass Base:\n    @property\n    @abc.abstractmethod\n    def name(self):\n        raise NotImplementedError()\n",
      'from abc import ABC\n\nclass Base(ABC):\n    def parse(self, text):\n        """Parse it."""\n        raise NotImplementedError\n',
      "import abc\n\nclass Base(abc.ABC):\n    def parse(self, text):\n        raise NotImplementedError\n",
      "from typing import Protocol\n\nclass Reader(Protocol):\n    def read(self) -> bytes:\n        raise NotImplementedError\n",
      "import typing\n\nclass Reader(typing.Protocol):\n    def read(self) -> bytes:\n        raise NotImplementedError\n",
      "from abc import ABCMeta\n\nclass Base(metaclass=ABCMeta):\n    def parse(self, text):\n        raise NotImplementedError\n",
      'def convert(value, kind):\n    if kind == "int":\n        return int(value)\n    if kind == "float":\n        raise NotImplementedError("float")\n    raise NotImplementedError\n',
      "def convert(value):\n    result = int(value)\n    raise NotImplementedError\n",
    ];
    for (const content of allowed) expect(rulesOf([created("app/base.py", content)])).toEqual([]);
  });

  test("only the lines the run added count", () => {
    const before = "try { go(); } catch {}\nexport const a = 1;\n";
    const after = `${before}export const b = 2;\n`;
    expect(rulesOf([{ path: "src/a.ts", content: after, before }])).toEqual([]);
    expect([...addedLines(before, after)]).toEqual([2]);
    // A file whose baseline is unknown is reported, but never blocks.
    expect(rulesOf([{ path: "src/a.ts", content: after, before: undefined }])).toEqual(["empty-catch:1:note"]);
  });

  test("test files skip the error-handling rules but not suppressions", () => {
    const content = "try { boom(); } catch {}\n// @ts-ignore\n";
    expect(rulesOf([created("tests/a.test.ts", content)])).toEqual(["ts-ignore:2:block"]);
  });

  test("a project disables a rule or changes its severity", () => {
    const content = "try { go(); } catch {}\n// TODO later\n";
    const file = created("src/a.ts", content);
    expect(rulesOf([file], { disabled: ["empty-catch"] })).toEqual(["todo-comment:2:note"]);
    expect(rulesOf([file], { severity: { "empty-catch": "warning", "todo-comment": "error" } })).toEqual([
      "empty-catch:1:note",
      "todo-comment:2:block",
    ]);
  });

  test("every built-in rule has an ID, a message and a fix", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of BUILTIN_RULES) expect(rule.message && rule.fix && rule.title).toBeTruthy();
  });

  test("project ast-grep rule files without ast-grep are listed as not run", () => {
    const result = checkAstGrepRules("/tmp", [created("src/a.ts", "x\n")], { files: ["rules/no-eval.yml"] }, null);
    expect(result.findings).toEqual([]);
    expect(result.astGrep).toEqual({ files: ["rules/no-eval.yml"], ran: false, note: "ast-grep is not installed" });
  });
});

describe("anti-slop rules in a run", () => {
  class SloppyExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(private readonly dir: string) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/load.ts", action: "modify" });
        return result;
      }
      if (request.profile.output === "implementation") {
        const first = this.implementations++ === 0;
        // The first attempt swallows the error; the correction lets it propagate.
        const body = first ? "  try {\n    return read(path);\n  } catch (error) {\n  }\n" : "  return read(path);\n";
        writeFileSync(join(this.dir, "src/load.ts"), `${BEFORE}export function load(path: string) {\n${body}}\n`);
      }
      return super.execute(request);
    }
  }
  // A suppression that was there before the run is not the run's.
  const BEFORE = "// eslint-disable-next-line no-console\nexport const read = (p: string) => p;\n";

  test("a planted empty catch blocks with the rule ID until the correction removes it", async () => {
    const fixture = workflowFixture({
      executor: (root) => {
        mkdirSync(join(root, "src"), { recursive: true });
        writeFileSync(join(root, "src/load.ts"), BEFORE);
        return new SloppyExecutor(root);
      },
    });
    try {
      const { service } = fixture;
      const run = await fixture.start();
      await service.drive(run.runId, new AbortController().signal);
      await fixture.approve(run.runId);
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");
      const claims = service.store.findings(run.runId).map((f) => ({ status: f.status, claim: JSON.parse(f.body_json).claim as string }));
      const empty = claims.find((f) => f.claim.startsWith("Rule empty-catch: "));
      expect(empty?.claim).toContain("src/load.ts:6");
      expect(empty?.status).toBe("resolved");
      expect(claims.some((f) => f.claim.includes("lint-suppression"))).toBe(false);
      expect(fixture.executor.implementations).toBe(2);
      expect(runReport(service.store, run.runId)).toContain("Anti-slop rules: 0 blocking, 0 noted");
    } finally {
      await fixture.dispose();
    }
  });

  /** The todo-cli situation of #845: each correction only moves the line the rule matches. */
  class StubbornExecutor extends FixtureExecutor {
    implementations = 0;
    constructor(
      private readonly dir: string,
      private readonly line: string,
    ) {
      super(dir);
    }
    override async execute(request: ExecutionRequest) {
      if (request.profile.output === "plan") {
        const result = await super.execute(request);
        const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/store.ts", action: "create" });
        return result;
      }
      if (request.profile.output === "implementation") {
        const padding = "\n".repeat(this.implementations++);
        mkdirSync(join(this.dir, "src"), { recursive: true });
        writeFileSync(join(this.dir, "src/store.ts"), `${padding}export function remove(id: number) {\n  ${this.line}\n}\n`);
      }
      return super.execute(request);
    }
  }

  const runWith = async (line: string) => {
    const fixture = workflowFixture({ executor: (root) => new StubbornExecutor(root, line) });
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const done = await fixture.service.drive(run.runId, new AbortController().signal);
    return { fixture, run, done };
  };

  test("a todo app's error message never blocks the run (#845)", async () => {
    const { fixture, run, done } = await runWith("throw new Error(`Todo with id ${id} does not exist`);");
    try {
      expect(done.status).toBe("completed");
      expect(fixture.executor.implementations).toBe(1);
      const claims = fixture.service.store.findings(run.runId).map((f) => String(JSON.parse(f.body_json).claim));
      expect(claims.some((c) => c.startsWith("Rule placeholder-body: "))).toBe(false);
    } finally {
      await fixture.dispose();
    }
  });

  test("a rule match the correction leaves in place becomes a known limitation instead of another correction (#845)", async () => {
    const { fixture, run, done } = await runWith('throw new Error("TODO");');
    try {
      expect(done.status).toBe("completed");
      // One correction for the finding, then no more: the second match only moved a line.
      expect(fixture.executor.implementations).toBe(2);
      const claims = fixture.service.store.findings(run.runId).map((f) => String(JSON.parse(f.body_json).claim));
      expect(claims.filter((c) => c.startsWith("Rule placeholder-body: "))).toHaveLength(1);
      const state = fixture.service.store.state(run.runId);
      expect(state.limitations.map((l) => [l.decidedBy, l.claim.split(" (")[0]])).toEqual([
        ["rule", "Rule placeholder-body: The body is a placeholder, not an implementation"],
      ]);
      const report = runReport(fixture.service.store, run.runId);
      expect(report).toContain("error, kept after its correction");
      expect(report).toContain("rule pack (same match after its correction)");
    } finally {
      await fixture.dispose();
    }
  });

  test("the project's rule choices are frozen in the run policy", async () => {
    const fixture = workflowFixture();
    try {
      fixture.config.quality = { disabledRules: ["todo-comment"], ruleSeverity: { "rust-unwrap": "error" } };
      const run = await fixture.start();
      const policy = JSON.parse(fixture.service.store.run(run.runId).policy_json);
      expect(policy.qualityRules).toEqual({ disabled: ["todo-comment"], severity: { "rust-unwrap": "error" } });
      expect(configuredRules({})).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });
});

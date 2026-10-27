import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { exactTextSections } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import { exactTextContext, STRING_LITERALS, stringLiteral } from "../src/core/workflows/supplied-content.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// R67 srtvet-update (#2101): T005 compared the README section "## Cleaning spaces" (1,264
// characters with backticks, two fenced blocks, `<U+0020>` and `<TAB>` notation) exactly in Go,
// where a raw string cannot hold a backtick, and spent 1.64M tokens over four check rounds on the
// string's quoting. With `exactTextLiteral: "on"` the host writes the section once as a string
// literal of the test's language and gives it to the test task.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const SECTION = [
  "## Cleaning spaces",
  "",
  'Run `srtvet clean` to strip spaces; "quotes", \\backslashes\\, $HOME, #{x} and `$(cmd)` stay as written:',
  "",
  "```sh",
  "srtvet clean in.srt > out.srt",
  "```",
  "",
  "Spaces show as `<U+0020>` and tabs as `<TAB>`:\tdone “smart”, café, \u{1F600}\u0001.",
].join("\n");
const request = ["Add this section to `README.md` exactly as written:", "````markdown", SECTION, "````", "Then test that README.md holds the Cleaning spaces section byte for byte."].join("\n");

/** Runs a program and returns its standard output, failing on a non-zero exit. */
const run = (cmd: string[], cwd: string): string => {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
};
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-exact-literal-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

describe("the expected text as a string literal of the test's language (#2101)", () => {
  test("every supported language has a row or says why not", () => {
    for (const [language, row] of Object.entries(STRING_LITERALS))
      expect(typeof row === "object" && row !== null, language).toBe(true);
    expect(stringLiteral("rescript", "x")).toBeNull();
    expect(stringLiteral("markdown", "x")).toBeNull();
  });

  test("the literal escapes each language's quote, escape and interpolation characters", () => {
    expect(stringLiteral("go", 'a"b\\c`d\n\te')).toBe('"a\\"b\\\\c`d\\n\\te"');
    expect(stringLiteral("kotlin", "$x")).toBe('"\\$x"');
    expect(stringLiteral("dart", "$x")).toBe('"\\$x"');
    expect(stringLiteral("php", "$x\u0001")).toBe('"\\$x\\u{1}"');
    expect(stringLiteral("ruby", "#{x}")).toBe('"\\#{x}"');
    expect(stringLiteral("elixir", "#{x}")).toBe('"\\#{x}"');
    expect(stringLiteral("rust", "\u0001")).toBe('"\\u{1}"');
    expect(stringLiteral("java", "\u0001x")).toBe('"\\001x"');
    expect(stringLiteral("objc", "a")).toBe('@"a"');
    expect(stringLiteral("lua", "\u0001")).toBe('"\\001"');
    expect(stringLiteral("bash", "it's\n")).toBe("$'it\\'s\\n'");
    expect(stringLiteral("powershell", 'a"b`c$d\n“q”')).toBe('"a`"b``c`$d`n`“q`”"');
  });

  test("JavaScript reads the literal back as the section, byte for byte", () => {
    expect(new Function(`return ${stringLiteral("typescript", SECTION)};`)()).toBe(SECTION);
  });

  test("Python reads the literal back as the section", () => {
    const dir = scratch();
    writeFileSync(join(dir, "probe.py"), `import sys\nsys.stdout.buffer.write((${stringLiteral("python", SECTION)}).encode("utf-8"))\n`);
    expect(run(["python3", "probe.py"], dir)).toBe(SECTION);
  });

  // Bun.spawnSync throws when the executable is missing (macOS runners have no Go).
  test.skipIf(Bun.which("go") === null)("Go compiles the literal and prints the section", () => {
    const dir = scratch();
    writeFileSync(join(dir, "main.go"), `package main\n\nimport "fmt"\n\nfunc main() { fmt.Print(${stringLiteral("go", SECTION)}) }\n`);
    expect(run(["go", "run", "main.go"], dir)).toBe(SECTION);
  }, 120_000);

  test.skipIf(Bun.which("rustc") === null)("Rust compiles the literal and prints the section", () => {
    const dir = scratch();
    writeFileSync(join(dir, "main.rs"), `fn main() { print!("{}", ${stringLiteral("rust", SECTION)}); }\n`);
    run(["rustc", "-o", join(dir, "probe"), "main.rs"], dir);
    expect(run([join(dir, "probe")], dir)).toBe(SECTION);
  }, 120_000);

  test("bash reads the ANSI-C literal back as the section", () => {
    if (process.platform === "win32" || Bun.which("bash") === null) return;
    const dir = scratch();
    // Without the control character: a shell variable cannot hold every byte.
    const text = SECTION.replace("\u0001", "");
    writeFileSync(join(dir, "probe.sh"), `printf '%s' ${stringLiteral("bash", text)}\n`);
    expect(run(["bash", "probe.sh"], dir)).toBe(text);
  });
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Docs", problem: "No section", outcome: "A section", inScope: ["README"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "README documents cleaning", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "README.md", when: "the docs test reads it", then: "its Cleaning spaces section matches the request exactly", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nDocs.\n## Decisions\nDEC-001: FR-001 in README.\n## Components\nREADME.md, docs_test.go\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const planned = (id: string, title: string, path: string): Task => ({ id, title, description: title, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: id === "T002" ? ["T001"] : [], profileId: "implementer", writes: [{ path, action: "create" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "Write the README section", "README.md"), planned("T002", "Test the README section exactly", "docs_test.go")];
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };

class ScriptedExecutor implements AgentExecutor {
  /** The implementer's `extra.exactText`, by task. */
  exactText = new Map<string, unknown>();
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[]; exactText?: unknown } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["."] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const id = request.task?.id ?? "";
        this.exactText.set(id, data.extra.exactText);
        const path = id === "T001" ? "README.md" : "docs_test.go";
        writeFileSync(join(request.root ?? this.root, path), id === "T001" ? `# srtvet\n\n${SECTION}\n` : "package main\n");
        output = { schemaVersion: 1, taskId: id, outcome: "implemented", summary: `Wrote ${path}`, evidenceIds: [], unresolved: [] };
        break;
      }
      case "review":
      case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: evidence, explanation: "The checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

const scenario = async (exactTextLiteral: "on" | undefined) => {
  const root = scratch();
  const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [tests], ...(exactTextLiteral ? { exactTextLiteral } : {}) };
  const executor = new ScriptedExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy });
  await service.drive(started.runId, new AbortController().signal);
  const waiting = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
  await service.decide(started.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  expect(done.status).toBe("completed");
  return executor;
};

describe("scenario: srtvet-update's exact README section test in Go (#2101)", () => {
  test("the section the criterion compares exactly is the request's section", () => {
    expect(exactTextSections(request, spec, tasks[1]!)).toEqual([{ title: "cleaning spaces", text: SECTION }]);
    // A task that writes no test file gets nothing.
    expect(exactTextContext(request, spec, tasks[0]!)).toEqual({});
  });

  test("with the setting on, the test task gets the section as a Go literal; the README task and an off run get nothing", async () => {
    const on = await scenario("on");
    expect(on.exactText.get("T001")).toBeUndefined();
    expect(on.exactText.get("T002")).toEqual({
      sections: [{ title: "cleaning spaces", characters: [...SECTION].length, literal: stringLiteral("go", SECTION) }],
      note: expect.stringContaining("as a go string literal"),
    });
    const off = await scenario(undefined);
    expect(off.exactText.get("T002")).toBeUndefined();
  }, 120_000);
});

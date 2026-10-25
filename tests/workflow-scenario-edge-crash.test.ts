import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { CRASH_FRAMES, caseCrash, EDGE_DIR, type EdgeRecord, edgeCrashDecision, OUTPUT_TAIL_CHARS } from "../src/core/verification/edge-inputs.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 68 url-shortener 67c90258 (#2136). The edge probe of T001 ran two cases
// for its storage criterion; both imported ./src/storage.ts and crashed inside it
// (`error: Missing parameter "code"` at createLink, src/storage.ts:70), so both were inconclusive
// and passed: the record kept only the status and a reason, and the run blocked later at 1.19M
// tokens with the defect still in T001's file. Here T001's storage module throws on every call.
// The probe's record keeps each case's output tail, and the crash inside T001's own file is
// decided a finding of T001 in shadow (`edge_crash_finding` would-stop, the stack's first error
// line as actual). The prober's own mistakes, a module that does not exist and a command with a
// syntax error, stay inconclusive and record nothing. Shadow: the run's tasks are as before.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Links", problem: "No storage", outcome: "A storage", inScope: ["Storage"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "A link is stored and read back", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-007", requirementIds: ["FR-001"], given: "a link of any code", when: "it is stored and read", then: "the same link is printed", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nOne storage.\n## Decisions\nDEC-001: FR-001 in src/storage.ts.\n## Components\nsrc/storage.ts\n## Data\nSQLite\n## Verification\nTests\n## Risks\nNone for fixture";
const check: Check = { id: "tests", executable: "bun", args: ["-e", "const t = await Bun.file('src/storage.ts').text(); if (!t.includes('createLink')) process.exit(1)"], cwd: ".", timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [] };
const basePolicy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 3, maxConvergenceRounds: 3, checks: [check] };
const source: Task = { id: "T001", title: "Write the link storage", description: "Write src/storage.ts", requirementIds: ["FR-001"], criterionIds: ["AC-007"], dependsOn: [], profileId: "implementer", writes: [{ path: "src/storage.ts", action: "create" }], readHints: [], checkIds: ["tests"], origin: "planned", findingIds: [], rationale: "Required behavior" };
const tests: Task = { ...source, id: "T002", title: "Test the link storage", description: "Write tests/storage.test.ts", dependsOn: ["T001"], writes: [{ path: "tests/storage.test.ts", action: "create" }] };
// As R68's T001: every call throws inside the module (bun:sqlite strict mode's missing binding).
const storage = [
  "export function createLink(code: string, url: string) {",
  "  if (code !== undefined) throw new Error('Missing parameter \"code\"');",
  "  return { code, url };",
  "}",
  "",
].join("\n");
const store = (code: string) => ({ executable: "bun", args: ["-e", `import { createLink } from './src/storage.ts'; console.log(createLink(${JSON.stringify(code)}, 'https://e.x').code)`], expected: code, criterionId: "AC-007" });

class CrashExecutor implements AgentExecutor {
  calls: { output: string; taskId?: string; origin?: string }[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const task = request.task;
    this.calls.push({ output: request.profile.output, ...(task ? { taskId: task.id, origin: task.origin } : {}) });
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: Record<string, unknown> & { evidence?: { id: string }[] } };
    const evidenceIds = data.extra.evidence?.map((e) => e.id) ?? [];
    const pass = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-007", verdict: "pass", evidenceIds, explanation: "Checks pass" }], findings: [] };
    const root = request.root ?? this.root;
    const write = (path: string, text: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/storage.ts"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [source, tests] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        if (task?.id === "T001") write("src/storage.ts", storage);
        else write("tests/storage.test.ts", "// storage tests\n");
        output = { schemaVersion: 1, taskId: task?.id, outcome: "implemented", summary: "Wrote the code", evidenceIds: [], unresolved: [] };
        break;
      }
      case "edge-cases":
        output = {
          schemaVersion: 1,
          cases: [
            // Two cases that crash inside T001's own file, as R68's two AC-007 cases did.
            store("ünï-côdé"),
            store("x".repeat(64)),
            // The prober's own mistakes: a module that does not exist, a command that does not parse.
            { executable: "bun", args: ["-e", "import { createLink } from './src/nope.ts'; console.log(createLink('a', 'b'))"], expected: "a", criterionId: "AC-007" },
            { executable: "bun", args: ["-e", "console.log((("], expected: "a", criterionId: "AC-007" },
          ],
          rationale: "Codes past ASCII and long codes",
        };
        break;
      case "review":
      case "convergence": output = pass; break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

async function drive() {
  const root = mkdtempSync(join(tmpdir(), "baked-edge-crash-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executor = new CrashExecutor(root);
  const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", quality: { edgeProbe: "on" as const }, workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: basePolicy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Store links", ownerLabel: "test", policy: basePolicy });
  await service.drive(started.runId, new AbortController().signal);
  const snapshot = await service.get(started.runId);
  const approval = service.store.requests(started.runId).find((r) => r.kind === "approval" && r.status === "pending");
  if (!approval) throw new Error("No approval request");
  await service.decide(started.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
  const done = await service.drive(started.runId, new AbortController().signal);
  const records = service.store
    .artifacts(started.runId)
    .filter((a) => a.logical_path.startsWith(EDGE_DIR))
    .map((a) => JSON.parse(service.store.readArtifact(started.runId, a.id)) as EdgeRecord);
  return { root, runId: started.runId, done, executor, service, records };
}

describe("scenario: R68 url-shortener, an edge case that crashes in the probed task's own file (#2136)", () => {
  test("the crash is recorded with its output and decided a finding of T001 in shadow; the prober's mistakes are not", async () => {
    const { root, runId, done, executor, service, records } = await drive();
    expect(done.status).toBe("completed");
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.files).toEqual(["src/storage.ts"]);
    // Every case is inconclusive and passes under edgeDecision, as in R68.
    expect(record.cases.map((c) => [c.status, c.decision])).toEqual(Array(4).fill(["inconclusive", "pass"]));
    // The record keeps each case's output tail, so the decision can be audited and replayed.
    for (const c of record.cases) {
      expect(c.outputTail).toBeString();
      expect(c.outputTail!.length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    }
    expect(record.cases[0]?.outputTail).toContain("src/storage.ts");
    expect(record.cases[2]?.outputTail).toContain("nope");
    // The two crashes inside T001's file are findings of T001; the two mistakes stay passes.
    expect(record.cases.map((c) => c.crash)).toEqual(["finding", "finding", "pass", "pass"]);
    const stops = service.store
      .eventsOfType(runId, "decision.would_stop")
      .flatMap((e) => (e.type === "decision.would_stop" && e.payload.reason === "edge_crash_finding" ? [e.payload] : []));
    expect(stops.map((s) => [s.mode, s.key])).toEqual([
      ["shadow", `${EDGE_DIR}T001.json#1`],
      ["shadow", `${EDGE_DIR}T001.json#2`],
    ]);
    // The finding it would be: T001's, with the stack's first error line as actual.
    expect(stops[0]?.inputs).toMatchObject({ taskId: "T001", actual: 'error: Missing parameter "code"' });
    // Shadow: no finding, no corrective; the run's tasks are as before.
    expect(service.store.findings(runId)).toEqual([]);
    expect(executor.calls.filter((c) => c.output === "implementation").map((c) => c.taskId)).toEqual(["T001", "T002"]);

    // The crash decisions replay from the bench trace, the output tail kept by its scrub.
    const dir = mkdtempSync(join(tmpdir(), "edge-crash-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === runId);
    expect(replayed?.edgeProbes.map((b) => [b.crashRecorded, b.crashReplayed])).toEqual([["finding", "finding"], ["finding", "finding"], ["pass", "pass"], ["pass", "pass"]]);
    expect(replayed?.newEdgeDecisions).toBe(0);
    const never = replayTrace(out, { edgeCrashRule: () => ({ decision: "pass", actual: null }) }).runs.find((r) => r.runId === runId);
    expect(never?.newEdgeDecisions).toBe(2);
  }, 120_000);
});

// One crash per runtime spelling in CRASH_FRAMES: a new spelling joins the table with its case here.
const SPELLINGS: Record<string, { file: string; output: string; actual: string }> = {
  "bun, node, deno": { file: "src/storage.ts", output: '70 |   stmt.run(link);\n         ^\nerror: Missing parameter "code"\n      at createLink (C:\\Users\\b\\url-shortener\\src\\storage.ts:70:10)\n      at C:\\Users\\b\\url-shortener\\[eval]:1:40\n', actual: 'error: Missing parameter "code"' },
  python: { file: "src/expenses/store.py", output: 'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n  File "/w/src/expenses/store.py", line 12, in add\n    raise ValueError("bad amount")\nValueError: bad amount\n', actual: "ValueError: bad amount" },
  go: { file: "internal/store/store.go", output: "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nexample.com/x/internal/store.Add(...)\n\t/w/internal/store/store.go:42 +0x1d\nmain.main()\n\t/w/cmd/x/main.go:9 +0x25\nexit status 2\n", actual: "panic: runtime error: index out of range [3] with length 3" },
  jvm: { file: "src/main/java/com/acme/Store.java", output: 'Exception in thread "main" java.lang.IllegalStateException: closed\n\tat com.acme.Store.add(Store.java:57)\n\tat com.acme.Main.main(Main.java:9)\n', actual: 'Exception in thread "main" java.lang.IllegalStateException: closed' },
  ".net": { file: "src/Acme/Store.cs", output: "Unhandled exception. System.InvalidOperationException: closed\n   at Acme.Store.Add(String code) in /w/src/Acme/Store.cs:line 12\n   at Program.Main() in /w/src/Acme/Program.cs:line 5\n", actual: "Unhandled exception. System.InvalidOperationException: closed" },
  rust: { file: "src/store.rs", output: "thread 'main' panicked at src/store.rs:5:9:\nattempt to add with overflow\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n", actual: "thread 'main' panicked at src/store.rs:5:9:" },
  ruby: { file: "lib/store.rb", output: "/w/lib/store.rb:12:in 'add': closed (RuntimeError)\n\tfrom -e:1:in '<main>'\n", actual: "/w/lib/store.rb:12:in 'add': closed (RuntimeError)" },
  php: { file: "src/Store.php", output: "PHP Fatal error:  Uncaught Exception: closed in /w/src/Store.php:12\nStack trace:\n#0 Command line code(1): add()\n", actual: "PHP Fatal error:  Uncaught Exception: closed in /w/src/Store.php:12" },
  "php trace": { file: "src/Store.php", output: "Stack trace:\n#0 /w/src/Store.php(12): Store->add()\n#1 {main}\n", actual: "#0 /w/src/Store.php(12): Store->add()" },
  elixir: { file: "lib/store.ex", output: "** (ArithmeticError) bad argument in arithmetic expression\n    (acme 0.1.0) lib/store.ex:12: Acme.Store.add/1\n", actual: "** (ArithmeticError) bad argument in arithmetic expression" },
  dart: { file: "lib/store.dart", output: "Unhandled exception:\nRangeError (index): Invalid value: Not in inclusive range 0..2: 3\n#0      add (file:///w/lib/store.dart:12:5)\n", actual: "Unhandled exception:" },
  swift: { file: "Sources/Store/Store.swift", output: "Fatal error: Index out of range: file Sources/Store/Store.swift, line 12\n", actual: "Fatal error: Index out of range: file Sources/Store/Store.swift, line 12" },
  "c, c++ (sanitizers)": { file: "src/store.c", output: "==1==ERROR: AddressSanitizer: heap-buffer-overflow\n    #0 0x55d1 in add /w/src/store.c:12:5\n    #1 0x55d2 in main /w/src/main.c:3:1\n", actual: "#0 0x55d1 in add /w/src/store.c:12:5" },
  lua: { file: "src/store.lua", output: "lua: src/store.lua:12: closed\nstack traceback:\n\tsrc/store.lua:12: in function 'add'\n", actual: "lua: src/store.lua:12: closed" },
  bash: { file: "store.sh", output: "./store.sh: line 12: jq: command not found\n", actual: "./store.sh: line 12: jq: command not found" },
};

describe("the crash frame table (#2136)", () => {
  test("every runtime spelling has its case here", () => {
    expect(CRASH_FRAMES.map((f) => f.runtime).sort()).toEqual(Object.keys(SPELLINGS).sort());
  });

  for (const [runtime, { file, output, actual }] of Object.entries(SPELLINGS))
    test(`${runtime}: a crash in the task's file is a finding with its first error line; elsewhere it is not`, () => {
      expect(edgeCrashDecision("inconclusive", output, [file])).toEqual({ decision: "finding", actual });
      expect(edgeCrashDecision("inconclusive", output, ["src/other.txt"])).toEqual({ decision: "pass", actual: null });
      // Only an inconclusive case: a refuted or reproduced one is decided by its printed value.
      expect(edgeCrashDecision("refuted", output, [file]).decision).toBe("pass");
    });

  test("the prober's own mistakes stay inconclusive: a missing module, a command syntax error, a non-workspace frame", () => {
    const files = ["src/storage.ts"];
    expect(edgeCrashDecision("inconclusive", "error: Cannot find module './src/nope.ts' from '/w/[eval]'\n", files).decision).toBe("pass");
    expect(edgeCrashDecision("inconclusive", '  File "<string>", line 1\n    print((\nSyntaxError: unexpected EOF while parsing\n', ["src/store.py"]).decision).toBe("pass");
    expect(edgeCrashDecision("inconclusive", "TypeError: x is not a function\n    at /w/node_modules/lib/index.js:3:9\n    at /w/[eval]:1:1\n", files).decision).toBe("pass");
    // A file whose name only ends like the task's is not the task's.
    expect(edgeCrashDecision("inconclusive", "Error: boom\n    at f (/w/src/mystorage.ts:1:1)\n", files).decision).toBe("pass");
  });

  test("chain batteries and sibling probes record the same decision against the chain's file", () => {
    const output = SPELLINGS.python!.output;
    expect(caseCrash({ status: "inconclusive", output }, ["src/expenses/store.py"])).toMatchObject({ crash: "finding", actual: "ValueError: bad amount" });
    expect(caseCrash({ status: "inconclusive", output }, [null])).toMatchObject({ crash: "pass", actual: null });
    // The decision reads only the recorded tail.
    expect(caseCrash({ status: "inconclusive", output: `${"x".repeat(1000)}\n${output}` }, ["src/expenses/store.py"]).outputTail.length).toBe(OUTPUT_TAIL_CHARS);
  });
});

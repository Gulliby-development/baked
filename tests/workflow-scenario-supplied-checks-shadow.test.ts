import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { isStaticCheck } from "../src/core/workflows/check-policy.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import {
  diagnosticRule,
  type SuppliedCheckRunner,
  suppliedCheckRecord,
  suppliedCheckRecords,
  suppliedCheckText,
} from "../src/core/workflows/supplied-checks.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 72 namesound-update (#2275): the request gave a block for group_command.rb and
// required a clean rubocop, and the block failed Style/IfUnlessModifier. T001 met the conflict by
// running rubocop itself and spent 858k tokens over 7 attempts, plus a 103k review corrective.
// The host now runs the project's static checks on the supplied content in a scratch copy before
// the first implementer session, and records each diagnostic on a supplied line (shadow).

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A fake RuboCop: a block `unless` is an offense, printed in RuboCop's own format. */
const LINTER = [
  'import { readdirSync, readFileSync } from "node:fs";',
  "let bad = 0;",
  'for (const f of readdirSync("lib")) {',
  '  readFileSync(`lib/${f}`, "utf8").split("\\n").forEach((line, i) => {',
  "    if (/^\\s*unless\\b/.test(line)) {",
  "      console.log(`lib/${f}:${i + 1}:5: C: [Correctable] Style/IfUnlessModifier: Favor modifier unless usage when having a single-line body.`);",
  "      bad++;",
  "    }",
  "  });",
  "}",
  'console.log(`1 file inspected, ${bad || "no"} offenses detected`);',
  "process.exit(bad ? 1 : 0);",
].join("\n");
const lint: Check = { id: "rubocop", executable: "bun", args: ["rubocop.ts"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };

const BASE = ["def run(args)", "  parse(args)", "end", ""].join("\n");
/** The request's diff: a block `unless` on line 3 of the new file, the namesound shape. */
const diffBrief = (body: string[]) =>
  [
    "Apply exactly this diff, and keep `bundle exec rubocop` clean:",
    "```diff",
    "--- a/lib/group.rb",
    "+++ b/lib/group.rb",
    "@@ -1,3 +1,6 @@",
    " def run(args)",
    ...body.map((l) => `+${l}`),
    "   parse(args)",
    " end",
    "```",
  ].join("\n");
const UNLESS = ["  unless args.empty?", "    warn 'grouping'", "  end"];
const MODIFIER = ["  warn 'grouping' unless args.empty?", "  # grouped", "  # done"];

const workspace = (prefix: string, files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "lib"));
  writeFileSync(join(root, "rubocop.ts"), LINTER);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
};

/** Runs checks with Bun in the copy, counting the runs. */
const runner = () => {
  const runs: string[] = [];
  const run: SuppliedCheckRunner = async (check, root) => {
    runs.push(check.id);
    const proc = Bun.spawnSync([process.execPath, ...check.args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return { status: proc.exitCode === 0 ? "passed" : "failed", output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
  };
  return { runs, run };
};
const modify = { writes: [{ path: "lib/group.rb", action: "modify" as const }] };

describe("the project's static checks on the request's verbatim content (#2275)", () => {
  test("the fake linter is a static check", () => {
    expect(isStaticCheck(lint)).toBe(true);
    expect(diagnosticRule("C: [Correctable] Style/IfUnlessModifier: Favor modifier")).toBe("Style/IfUnlessModifier");
    expect(diagnosticRule("lint/style/useConst FIXABLE")).toBe("lint/style/useConst");
    expect(diagnosticRule("F401 [*] `os` imported but unused")).toBe("F401");
  });

  test("a supplied diff that fails the linter records the check, the rule and the line, and leaves the workspace alone", async () => {
    const root = workspace("baked-supplied-checks-", { "lib/group.rb": BASE });
    const { runs, run } = runner();
    const record = await suppliedCheckRecord("T001", modify, root, diffBrief(UNLESS), [lint, tests], run);
    expect(record).toEqual({
      taskId: "T001",
      mode: "shadow",
      files: [{ path: "lib/group.rb", kind: "diff", lines: [[2, 4]] }],
      skipped: null,
      checks: [{ checkId: "rubocop", status: "failed", offenses: [{ path: "lib/group.rb", line: 2, rule: "Style/IfUnlessModifier" }] }],
      conflict: true,
    });
    // One run of the static check; the test suite is not a static check.
    expect(runs).toEqual(["rubocop"]);
    expect(readFileSync(join(root, "lib/group.rb"), "utf8")).toBe(BASE);
    expect(record && suppliedCheckText(record)).toStartWith(
      "Supplied content fails the project's checks: rubocop at lib/group.rb:2 (Style/IfUnlessModifier). The request gives this content verbatim",
    );
  });

  test("Git for Windows' core.autocrlf neither moves the request's lines nor counts the base's debt (#2275)", async () => {
    const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.autocrlf", GIT_CONFIG_VALUE_0: "true" });
    cleanups.push(() => {
      for (const [name, value] of [["GIT_CONFIG_COUNT", saved.count], ["GIT_CONFIG_KEY_0", saved.key], ["GIT_CONFIG_VALUE_0", saved.value]] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
    const root = workspace("baked-supplied-checks-crlf-", { "lib/group.rb": `${BASE}unless legacy\n  x\nend\n` });
    const record = await suppliedCheckRecord("T001", modify, root, diffBrief(MODIFIER), [lint], runner().run);
    expect(record?.files).toEqual([{ path: "lib/group.rb", kind: "diff", lines: [[2, 4]] }]);
    expect(record?.conflict).toBe(false);
    // A base with CRLF ends: the LF diff applies as host apply's CRLF form, and only its lines count.
    const crlf = workspace("baked-supplied-checks-crlf-base-", { "lib/group.rb": `${BASE}unless legacy\n  x\nend\n`.replace(/\n/g, "\r\n") });
    const whole = await suppliedCheckRecord("T001", modify, crlf, diffBrief(MODIFIER), [lint], runner().run);
    expect(whole?.skipped).toBeNull();
    expect(whole?.files).toEqual([{ path: "lib/group.rb", kind: "diff", lines: [[2, 4]] }]);
    expect(whole?.checks).toEqual([{ checkId: "rubocop", status: "failed", offenses: [] }]);
  });

  test("a clean block records no conflict after one run, and an offense the base already had on another line is not the request's", async () => {
    const debt = `${BASE}unless legacy\n  x\nend\n`;
    const root = workspace("baked-supplied-checks-clean-", { "lib/group.rb": debt });
    const { runs, run } = runner();
    const record = await suppliedCheckRecord("T001", modify, root, diffBrief(MODIFIER), [lint], run);
    // The linter fails on the base's line 7, which the request does not set.
    expect(record?.checks).toEqual([{ checkId: "rubocop", status: "failed", offenses: [] }]);
    expect(record?.conflict).toBe(false);
    expect(record && suppliedCheckText(record)).toBeNull();
    expect(runs).toEqual(["rubocop"]);
  });

  test("a whole new file counts every line; no supplied code, no static check, or a diff that does not apply runs nothing", async () => {
    const root = workspace("baked-supplied-checks-file-", { "lib/group.rb": BASE });
    const { runs, run } = runner();
    const created = await suppliedCheckRecord(
      "T002",
      { writes: [{ path: "lib/new.rb", action: "create" }] },
      root,
      ["Create `lib/new.rb` with exactly this content:", "```ruby", "unless ready", "  wait", "end", "```"].join("\n"),
      [lint],
      run,
    );
    expect(created?.checks[0]?.offenses).toEqual([{ path: "lib/new.rb", line: 1, rule: "Style/IfUnlessModifier" }]);
    expect(created?.files).toEqual([{ path: "lib/new.rb", kind: "file", lines: [[1, 3]] }]);
    expect(runs).toEqual(["rubocop"]);

    expect(await suppliedCheckRecord("T003", modify, root, "Make the group command warn.", [lint], run)).toBeNull();
    expect(await suppliedCheckRecord("T003", modify, root, diffBrief(UNLESS), [tests], run)).toMatchObject({ skipped: "no required static check covers the task's files", checks: [], conflict: false });
    const stale = diffBrief(UNLESS).replace(" def run(args)", " def other(args)");
    expect(await suppliedCheckRecord("T003", modify, root, stale, [lint], run)).toMatchObject({ skipped: "the diff for lib/group.rb does not apply", conflict: false });
    // A whole-unit tool fails on files later tasks write: it is named, not run.
    const types: Check = { ...lint, id: "tsc", executable: "tsc", args: ["--noEmit"] };
    const record = await suppliedCheckRecord("T003", modify, root, diffBrief(UNLESS), [types, lint], run);
    expect(record?.checks.map((c) => [c.checkId, c.status])).toEqual([
      ["tsc", "skipped"],
      ["rubocop", "failed"],
    ]);
    expect(runs).toEqual(["rubocop", "rubocop"]);
  });
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Grouping", problem: "No warning", outcome: "A warning", inScope: ["Grouping"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The command warns", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "args", when: "run", then: "it warns", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nApply the brief.\n## Decisions\nDEC-001: FR-001 in lib.\n## Components\nlib/group.rb\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const task: Task = { id: "T001", title: "update lib/group.rb", description: "update lib/group.rb", requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: "lib/group.rb", action: "modify" }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [tests, lint] };

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  constructor(private root: string) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["lib"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [task] } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const id = request.task?.id ?? "";
        this.attempts.push(id);
        // The implementer keeps rubocop clean, which the supplied diff does not.
        writeFileSync(join(request.root ?? this.root, "lib/group.rb"), ["def run(args)", ...MODIFIER, "  parse(args)", "end", ""].join("\n"));
        output = { schemaVersion: 1, taskId: id, outcome: "implemented", summary: "Updated lib/group.rb", evidenceIds: [], unresolved: [] };
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

describe("scenario: an update brief whose supplied diff fails the project's linter, in shadow (#2275)", () => {
  test("the conflict is recorded before the first implementer session, which still runs", async () => {
    const root = workspace("baked-supplied-checks-run-", { "lib/group.rb": BASE });
    const brief = diffBrief(UNLESS);
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(executor.attempts).toEqual(["T001"]);
    const [record] = suppliedCheckRecords(service.store, run.runId);
    expect(record).toMatchObject({ taskId: "T001", mode: "shadow", conflict: true, skipped: null });
    expect(record?.checks.find((c) => c.checkId === "rubocop")?.offenses).toEqual([{ path: "lib/group.rb", line: 2, rule: "Style/IfUnlessModifier" }]);
  }, 120000);
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { diffSections } from "../src/core/intelligence/call-context.js";
import { runRootPath } from "../src/core/workflows/effects.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  applyArgs,
  applyRegion,
  crlfPatch,
  type HostApplyRecord,
  type HostApplyWrite,
  hostAppliableTasks,
  hostApplyContents,
  hostApplyDecision,
  hostApplyInputs,
  hostApplyPaths,
  hostApplyText,
  hostApplyRecords,
  regionSections,
  zeroContextHunks,
} from "../src/core/workflows/host-apply.js";
import type { Check, RunPolicy, Spec, Task, TaskGraph } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { headerPath, suppliedBlocks, suppliedLines } from "../src/core/workflows/sizing.js";
import { newId } from "../src/core/workflows/store.js";
import { suppliedTestFiles } from "../src/core/workflows/supplied-content.js";
import { comparableWrite, suppliedDrifts } from "../src/core/workflows/supplied-drift.js";
import { exportTrace, replayTrace } from "../src/core/workflows/trace.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Bench round 65 (#2023): eolscope-update, seqmill-update and aclvet-update carried briefs with
// exact diffs and whole files, and spent 400k, 228k and 170k plus a replan on tasks that only
// applied them. The host now decides, in shadow, whether it would apply a planned task's content
// itself: every write has a verbatim block, and every diff passes `git apply --check` against the
// task's base. It records the decision with its inputs; the implementer still runs.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A brief with a prefix-less diff that applies, a whole new file, a diff that does not apply, and a prose-only change. */
const brief = [
  "Apply exactly this change:",
  "```diff",
  "--- src/a.ts",
  "+++ src/a.ts",
  "@@ -1,2 +1,2 @@",
  " export const A = 1;",
  "-export const B = 2;",
  "+export const B = 3;",
  "```",
  "Create `src/b.ts` with exactly this content:",
  "```ts",
  "export const NEW = true;",
  "```",
  "Then this one:",
  "```diff",
  "--- a/src/c.ts",
  "+++ b/src/c.ts",
  "@@ -1 +1 @@",
  '-export const C = "old";',
  '+export const C = "new";',
  "```",
  "Also make src/d.ts export D = 2.",
].join("\n");
const A_BEFORE = "export const A = 1;\nexport const B = 2;\n";

const write = (over: Partial<HostApplyWrite>): HostApplyWrite => ({ path: "src/x.ts", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true, ...over });

describe("the verbatim reader and the apply decision (#2023)", () => {
  test("diff sections get a/ and b/ headers, whatever the brief wrote", () => {
    const sections = diffSections(["--- src/a.ts\t2026-01-01", "+++ src/a.ts", "@@ -1 +1 @@", "-x", "+y", "", "diff --git a/n b/n", "--- /dev/null", "+++ b/src/n.ts", "@@ -0,0 +1 @@", "+n", ""].join("\n"));
    expect(sections).toEqual([
      { path: "src/a.ts", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n", deletes: false },
      { path: "src/n.ts", patch: "--- /dev/null\n+++ b/src/n.ts\n@@ -0,0 +1 @@\n+n\n", deletes: false },
    ]);
  });

  test("one reader serves pricing and the apply decision", () => {
    const paths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    const blocks = suppliedBlocks(brief, paths);
    expect([...blocks.keys()]).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(blocks.get("src/b.ts")).toEqual([{ kind: "file", lines: 1, content: "export const NEW = true;\n", whole: true }]);
    expect(blocks.get("src/a.ts")?.[0]).toMatchObject({ kind: "diff", lines: 2 });
    expect(Object.fromEntries(suppliedLines(brief, paths))).toEqual({ "src/a.ts": 2, "src/b.ts": 1, "src/c.ts": 2 });
  });

  test("the decision keeps the implementer for every write it cannot apply", () => {
    expect(hostApplyDecision([write({})])).toEqual({ wouldApply: true, reason: null });
    expect(hostApplyDecision([write({ files: 1, diffs: 0, applies: null, whole: true })]).wouldApply).toBe(true);
    expect(hostApplyDecision([write({ action: "create", files: 1, diffs: 0, applies: null, exists: false })]).wouldApply).toBe(true);
    expect(hostApplyDecision([write({ files: 1, diffs: 0, applies: null })]).reason).toContain("may be an excerpt");
    expect(hostApplyDecision([write({ files: 1, diffs: 1, applies: null })]).reason).toContain("both a fenced file and a diff");
    expect(hostApplyDecision([write({ files: 2, diffs: 0, applies: null, whole: true })]).reason).toContain("2 fenced blocks");
    expect(hostApplyDecision([write({ applies: false, refusal: "error: patch failed: src/x.ts:1" })]).reason).toBe("the diff for src/x.ts does not apply to the task's base: error: patch failed: src/x.ts:1");
    expect(hostApplyDecision([write({}), write({ path: "src/y.ts", diffs: 0, applies: null })]).reason).toBe("the request gives no verbatim block for src/y.ts");
    expect(hostApplyDecision([write({ action: "delete" })]).reason).toBe("the task deletes src/x.ts");
    // A new-file diff whose content the base already holds is done, not refused (#2594).
    expect(hostApplyDecision([write({ applies: false, present: true, refusal: "error: src/x.ts: already exists in working directory" })])).toEqual({ wouldApply: true, reason: null });
  });

  test("the apply check changes no file, and a task without a supplied write has nothing to decide", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), A_BEFORE);
    const inputs = await hostApplyInputs(root, brief, { writes: [{ path: "src/a.ts", action: "modify" }] });
    expect(inputs).toEqual([{ path: "src/a.ts", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true }]);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe(A_BEFORE);
    expect(await hostApplyInputs(root, brief, { writes: [{ path: "src/d.ts", action: "modify" }] })).toBeNull();
  }, 60000);

  test("an LF diff applies to a CRLF checkout of the same content, and the record says so (#2158)", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-crlf-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    const crlf = A_BEFORE.replaceAll("\n", "\r\n");
    writeFileSync(join(root, "src/a.ts"), crlf);
    writeFileSync(join(root, "src/c.ts"), 'export const C = "different";\r\n');
    // Staged as CRLF, which git does not convert: Git for Windows' system `core.autocrlf=true`
    // would otherwise normalize the files, there and in a directory outside any repository.
    git(root, "init", "-q");
    git(root, "config", "core.autocrlf", "false");
    git(root, "add", ".");
    const inputs = await hostApplyInputs(root, brief, { writes: [{ path: "src/a.ts", action: "modify" }, { path: "src/c.ts", action: "modify" }] });
    expect(inputs?.[0]).toEqual({ path: "src/a.ts", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true, eol: "crlf" });
    // A diff whose context differs still does not apply, in either line end.
    expect(inputs?.[1]).toMatchObject({ path: "src/c.ts", applies: false });
    expect(inputs?.[1]?.eol).toBeUndefined();
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe(crlf);
    expect(crlfPatch("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n \n")).toBe("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\r\n+b\r\n \r\n");
  }, 60000);
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Constants", problem: "Old constants", outcome: "New constants", inScope: ["Constants"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "The constants are current", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "the module", when: "it is read", then: "the constants are current", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nApply the brief.\n## Decisions\nDEC-001: FR-001 in src.\n## Components\nsrc/a.ts, src/b.ts, src/c.ts, src/d.ts\n## Data\nNone\n## Verification\nTests\n## Risks\nNone for fixture";
const planned = (id: string, path: string, action: "create" | "modify"): Task => ({ id, title: `update ${path}`, description: `update ${path}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path, action }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" });
const tasks = [planned("T001", "src/a.ts", "modify"), planned("T002", "src/b.ts", "create"), planned("T003", "src/c.ts", "modify"), planned("T004", "src/d.ts", "modify")];
const content: Record<string, [string, string]> = {
  T001: ["src/a.ts", "export const A = 1;\nexport const B = 3;\n"],
  T002: ["src/b.ts", "export const NEW = true;\n"],
  T003: ["src/c.ts", 'export const C = "new";\n'],
  T004: ["src/d.ts", "export const D = 2;\n"],
};
const tests: Check = { id: "tests", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".", timeoutMs: 60000, required: true, scope: "feature", envNames: [], writes: [] };
const policy: RunPolicy = { ...defaultWorkflowPolicy, clarification: "assume", checks: [tests] };

class ScriptedExecutor implements AgentExecutor {
  attempts: string[] = [];
  /** src/a.ts as T001's implementer found it: the host's check left it alone. */
  aBefore = "";
  constructor(
    private root: string,
    private graph: Task[] = tasks,
    private files: Record<string, [string, string]> = content,
  ) {}
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    const evidence = data.extra.evidence?.map((e) => e.id) ?? [];
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src"] }; break;
      case "spec": output = spec; break;
      case "plan": output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: this.graph } }; break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const id = request.task?.id ?? "";
        // A batch worker edits its own task worktree.
        const root = request.root ?? this.root;
        this.attempts.push(id);
        if (id === "T001" && this.files === content) this.aBefore = readFileSync(join(root, "src/a.ts"), "utf8");
        const [path, text] = this.files[id] ?? ["", ""];
        writeFileSync(join(root, path), text);
        output = { schemaVersion: 1, taskId: id, outcome: "implemented", summary: `Updated ${path}`, evidenceIds: [], unresolved: [] };
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

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

// Bench round 68 (#2138): with `--writers 3` every task ran in the batch worker, which skipped the
// pre-session shadow hooks; cfgquill-update recorded no decision for two tasks whose diffs applied
// (one of them 55 percent of the run's tokens). The same scenario runs on both paths.
// With `core.autocrlf=true`, as Git for Windows sets it, the task worktrees are CRLF; git apply
// converts them to the repository's LF before it compares, so the brief's LF diffs still apply
// (#2158). A CRLF base git does not convert is the CRLF case above.
for (const [writers, autocrlf] of [[1, false], [2, false], [2, true]] as const)
describe(`scenario: an update brief with exact diffs and a whole file, in shadow, ${String(writers)} writer(s)${autocrlf ? ", autocrlf" : ""} (#2023, #2138, #2158)`, () => {
  test("would_apply is recorded per planned task with its inputs, the implementer still runs, and the decision replays", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-shadow-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), A_BEFORE);
    writeFileSync(join(root, "src/c.ts"), 'export const C = "different";\n');
    writeFileSync(join(root, "src/d.ts"), "export const D = 1;\n");
    if (writers > 1) {
      // A worktree run: the batch path needs a repository to cut task worktrees from.
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "Test User");
      git(root, "config", "user.email", "test@example.test");
      git(root, "config", "commit.gpgsign", "false");
      git(root, "config", "core.autocrlf", String(autocrlf));
      writeFileSync(join(root, ".gitignore"), ".baked/\n");
      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "Initial");
    }
    expect(hostAppliableTasks(brief, { tasks })).toEqual(["T001", "T002", "T003"]);

    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy, ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    // The plan approval names the host-appliable tasks.
    expect((JSON.parse(approval.body_json) as { hostApply?: string }).hostApply).toBe(
      "Host-appliable from the request's verbatim content: T001, T002, T003 (shadow: the host records whether each would apply, and an implementer still runs)",
    );
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");

    // Shadow: every task still got its implementer, and the apply check changed no file.
    expect([...executor.attempts].sort()).toEqual(["T001", "T002", "T003", "T004"]);
    expect(executor.aBefore).toBe(autocrlf ? A_BEFORE.replaceAll("\n", "\r\n") : A_BEFORE);

    const records = hostApplyRecords(service.store, run.runId);
    expect(records.map((r) => [r.taskId, r.wouldApply])).toEqual([
      ["T001", true],
      ["T002", true],
      ["T003", false],
    ]);
    const byTask = new Map<string, HostApplyRecord>(records.map((r) => [r.taskId, r]));
    expect(byTask.get("T001")).toEqual({ taskId: "T001", mode: "shadow", writes: [{ path: "src/a.ts", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true }], wouldApply: true, reason: null });
    expect(byTask.get("T002")?.writes).toEqual([{ path: "src/b.ts", action: "create", files: 1, diffs: 0, whole: true, exists: false, applies: null }]);
    expect(byTask.get("T003")?.writes[0]).toMatchObject({ path: "src/c.ts", applies: false });
    expect(byTask.get("T003")?.reason).toStartWith("the diff for src/c.ts does not apply to the task's base");
    // A task whose write the request does not supply records nothing.
    expect(byTask.has("T004")).toBe(false);

    // The replay hook decides each record again from the bench trace (#1649).
    const dir = mkdtempSync(join(tmpdir(), "host-apply-trace-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "run.sqlite.gz");
    exportTrace(root, out);
    const replayed = replayTrace(out).runs.find((r) => r.runId === run.runId);
    expect(replayed?.hostApply.map((b) => [b.taskId, b.recorded, b.replayed])).toEqual([
      ["T001", true, true],
      ["T002", true, true],
      ["T003", false, false],
    ]);
    expect(replayed?.newApplyDecisions).toBe(0);
    // A rule that skipped the apply check would apply T003's stale diff: a new decision.
    const unchecked = replayTrace(out, {
      hostApplyRule: (writes) => (writes.every((w) => w.files + w.diffs > 0) ? { wouldApply: true, reason: null } : { wouldApply: false, reason: "unsupplied" }),
    }).runs.find((r) => r.runId === run.runId);
    expect(unchecked?.newApplyDecisions).toBe(1);
  }, 120000);
});

describe("every pre-session shadow hook runs on both implementer paths (#2138)", () => {
  test("the single-writer and batch paths call beforeSession, and the hooks are called nowhere else", () => {
    const source = readFileSync(join(import.meta.dir, "../src/core/workflows/scheduler.ts"), "utf8");
    const body = (name: string): string => {
      const start = source.search(new RegExp(`\\n  private (?:async )?${name}\\(`));
      const end = source.indexOf("\n  private ", start + 1);
      return source.slice(start, end);
    };
    expect(body("runTaskStep").includes("await this.beforeSession(")).toBe(true);
    expect(body("runTaskWorker").includes("await this.beforeSession(")).toBe(true);
    // The hooks beforeSession runs: a direct call on one path would skip the other.
    const hooks = [...body("beforeSession").matchAll(/this\.(record\w+)\(/g)].map((m) => m[1]);
    expect(hooks).toEqual(["recordHostApply", "recordSuppliedChecks"]);
    expect(source.match(/this\.recordHostApply\(/g)).toHaveLength(1);
    // A task that runs no session gets the supplied-content check before the host writes (#2456).
    expect(source.match(/this\.recordSuppliedChecks\(/g)).toHaveLength(2);
    expect(body("runTaskStep").includes("await this.recordSuppliedChecks(")).toBe(true);
    // A corrective's `start` scope record is unownedFile's (#2133): runTaskStep calls it, and
    // heldCorrectives before a batch.
    expect(body("runTaskStep").includes('this.unownedFile(runId, state, policy, task, root, "start")')).toBe(true);
    expect(body("heldCorrectives").includes('this.unownedFile(runId, state, policy, task, root, "start")')).toBe(true);
  });
});

// Bench round 67 srtvet-update (#2101): the brief gave the README section "## Cleaning spaces"
// verbatim (1,264 characters, two fenced blocks) and the README task cost an implementer 123k
// tokens: a fenced block for a file that exists is an excerpt, which the host could not place.
// A Markdown block that opens with a heading is now the section of that heading: the host would
// write it in place of the file's one section of that heading, or append it.
const SECTION = ["## Cleaning spaces", "", "Run `srtvet clean` to strip spaces:", "", "```sh", "srtvet clean in.srt > out.srt", "```", "", "Spaces show as `<U+0020>` and tabs as `<TAB>`:", "", "```text", "1<TAB>00:00:01", "```"].join("\n");
const regionBrief = (prose: string) => [prose, "````markdown", SECTION, "````"].join("\n");
const README = ["# srtvet", "", "Checks subtitle files.", "", "## Usage", "", "```sh", "## Cleaning spaces (a shell comment, not a heading)", "srtvet check in.srt", "```", "", "## License", "", "MIT", ""].join("\n");

describe("a verbatim Markdown section the host writes into its file (#2101)", () => {
  test("the reader marks a heading-led Markdown block as a region, unless the prose says it is the whole file", () => {
    const [block] = suppliedBlocks(regionBrief("Add this section to `README.md` exactly as written:"), ["README.md"]).get("README.md") ?? [];
    expect(block).toMatchObject({ kind: "file", whole: true, region: { title: "Cleaning spaces", level: 2 } });
    for (const prose of ["Replace `README.md` with:", "The full contents of `README.md`:", "Overwrite README.md with this:"])
      expect(suppliedBlocks(regionBrief(prose), ["README.md"]).get("README.md")?.[0]).not.toHaveProperty("region");
    // A block that does not open with a heading, or a file that is not Markdown, is no region.
    expect(suppliedBlocks("Add to `README.md`:\n```markdown\nSome text.\n```", ["README.md"]).get("README.md")?.[0]).not.toHaveProperty("region");
    expect(suppliedBlocks("Add to `notes.txt`:\n```\n## Heading\n```", ["notes.txt"]).get("notes.txt")?.[0]).not.toHaveProperty("region");
  });

  test("the host would append a new section, replace the one existing section, and refuse a heading the file repeats", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-region-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const task = { writes: [{ path: "README.md", action: "modify" as const }] };
    const request = regionBrief("Add this section to `README.md` exactly as written:");
    const decide = async (readme: string) => {
      writeFileSync(join(root, "README.md"), readme);
      const writes = (await hostApplyInputs(root, request, task)) ?? [];
      return { writes, verdict: hostApplyDecision(writes) };
    };
    // The heading inside the fenced shell block is no section.
    const absent = await decide(README);
    expect(absent.writes[0]?.region).toEqual({ level: 2, matches: 0 });
    expect(absent.verdict).toEqual({ wouldApply: true, reason: null });
    const once = await decide(README.replace("## License", "## Cleaning spaces\n\nOld text.\n\n## License"));
    expect(once.writes[0]?.region).toEqual({ level: 2, matches: 1 });
    expect(once.verdict.wouldApply).toBe(true);
    const twice = await decide(`${README}\n## Cleaning spaces\n\nA.\n\n## Cleaning spaces\n\nB.\n`);
    expect(twice.verdict).toEqual({ wouldApply: false, reason: "the section the request gives for README.md has a heading that 2 sections of the file share" });
    // Without the region rule the same block was an excerpt the host could not place.
    expect(hostApplyDecision([{ ...absent.writes[0]!, region: undefined, whole: false }]).wouldApply).toBe(false);
  });

  test("applyRegion writes the section in place or at the end, and leaves the rest of the file as it was", () => {
    const region = { title: "Cleaning spaces", level: 2 };
    expect(applyRegion(README, SECTION, region)).toBe(`${README.trimEnd()}\n\n${SECTION}\n`);
    const old = README.replace("## License", "## Cleaning spaces\n\nOld text.\n\n### Detail\n\nMore.\n\n## License");
    expect(applyRegion(old, SECTION, region)).toBe(README.replace("## License", `${SECTION}\n\n## License`));
    // The written file holds the section byte for byte: an exact-text test of it passes.
    expect(applyRegion(old, SECTION, region)).toContain(SECTION);
    expect(applyRegion(`${README}\n## Cleaning spaces\n\nA.\n\n## Cleaning spaces\n`, SECTION, region)).toBeNull();
    expect(regionSections(README, region)).toEqual([]);
  });
});

// #2333: R73 and R74 recorded 12 `wouldApply` decisions that matched the reference trees byte for
// byte and one correct refusal; the sessions they would have skipped cost 29 to 74 percent of
// idpeek-update's, ewvet-update's and xmlvet-update's tokens. Under `hostApply: "on"` the host
// writes those tasks itself.
describe("the host writes the request's verbatim content (#2333)", () => {
  test("hostApplyContents gives each write's final text: a diff applied, a whole file, a section written in, a CRLF base", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-contents-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), A_BEFORE);
    expect(await hostApplyContents(root, brief, { writes: [{ path: "src/a.ts", action: "modify" }, { path: "src/b.ts", action: "create" }] })).toEqual([
      { path: "src/a.ts", content: "export const A = 1;\nexport const B = 3;\n" },
      { path: "src/b.ts", content: "export const NEW = true;\n" },
    ]);
    // The base is left alone, and a diff that does not apply throws with its path.
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe(A_BEFORE);
    writeFileSync(join(root, "src/c.ts"), 'export const C = "different";\n');
    await expect(hostApplyContents(root, brief, { writes: [{ path: "src/c.ts", action: "modify" }] })).rejects.toThrow("the diff for src/c.ts does not apply");
    // A CRLF base takes the LF diff as CRLF hunk lines and keeps its line ends.
    writeFileSync(join(root, "src/a.ts"), A_BEFORE.replaceAll("\n", "\r\n"));
    expect((await hostApplyContents(root, brief, { writes: [{ path: "src/a.ts", action: "modify" }] }))[0]?.content).toBe("export const A = 1;\r\nexport const B = 3;\r\n");
    // A Markdown section replaces the one section of its heading.
    writeFileSync(join(root, "README.md"), "# Tool\n\n## Usage\n\nold\n\n## License\n\nMIT\n");
    const section = ["Add this section to `README.md`:", "```markdown", "## Usage", "", "new", "```"].join("\n");
    expect((await hostApplyContents(root, section, { writes: [{ path: "README.md", action: "modify" }] }))[0]?.content).toBe("# Tool\n\n## Usage\n\nnew\n\n## License\n\nMIT\n");
  }, 60000);

  // Git for Windows sets `core.autocrlf=true`, so the run worktree's files are CRLF there; the host's
  // write keeps the base's line ends, as an implementer's edit would.
  for (const [writers, autocrlf] of [[1, false], [2, false], [2, true]] as const)
    test(`${String(writers)} writer(s)${autocrlf ? ", autocrlf" : ""}: the applicable tasks run no implementer, the others do, and the records say applied`, async () => {
      const root = mkdtempSync(join(tmpdir(), "baked-host-apply-on-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/a.ts"), A_BEFORE);
      writeFileSync(join(root, "src/c.ts"), 'export const C = "different";\n');
      writeFileSync(join(root, "src/d.ts"), "export const D = 1;\n");
      if (writers > 1) {
        git(root, "init", "-q", "-b", "main");
        git(root, "config", "user.name", "Test User");
        git(root, "config", "user.email", "test@example.test");
        git(root, "config", "commit.gpgsign", "false");
        git(root, "config", "core.autocrlf", String(autocrlf));
        writeFileSync(join(root, ".gitignore"), ".baked/\n");
        git(root, "add", ".");
        git(root, "commit", "-q", "-m", "Initial");
      }
      const on: RunPolicy = { ...policy, hostApply: "on" };
      const executor = new ScriptedExecutor(root);
      const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: on } };
      const service = new NativeWorkflowService(root, config, executor);
      cleanups.push(() => service.close());
      const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: brief, ownerLabel: "test", policy: on, ...(writers > 1 ? { executionMode: "worktree" as const, maxConcurrentWriters: writers } : {}) });
      await service.drive(run.runId, new AbortController().signal);
      const waiting = await service.get(run.runId);
      const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
      if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
      expect((JSON.parse(approval.body_json) as { hostApply?: string }).hostApply).toBe(hostApplyText(["T001", "T002", "T003"], "on"));
      await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
      const done = await service.drive(run.runId, new AbortController().signal);
      expect(done.status).toBe("completed");

      // T001's diff and T002's whole file are the host's; T003's stale diff and T004's prose are not.
      expect([...executor.attempts].sort()).toEqual(["T003", "T004"]);
      // The run's own tree: the workspace, or the run worktree with several writers.
      const tree = join(root, runRootPath(service.store, run.runId));
      const a = content.T001?.[1] ?? "";
      expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe(autocrlf ? a.replaceAll("\n", "\r\n") : a);
      expect(readFileSync(join(tree, "src/b.ts"), "utf8")).toBe(content.T002?.[1] ?? "");
      const records = hostApplyRecords(service.store, run.runId);
      expect(records.map((r) => [r.taskId, r.mode, r.wouldApply, r.applied])).toEqual([
        ["T001", "on", true, true],
        ["T002", "on", true, true],
        ["T003", "on", false, false],
      ]);
      expect(service.store.tasks(run.runId).filter((t) => ["T001", "T002"].includes(t.id)).map((t) => t.status)).toEqual(["verified", "verified"]);
    }, 120000);
});

// Bench round 75 (#2366): evalpin-update's brief gave a diff for tests/cli.rs and quoted the one
// changed test's old and new line in two `text` fences, after a prose line that named the path and
// said "Exactly". The quote was read as the whole file next to the diff, so the host declined T002
// ("both a fenced file and a diff") and an implementer spent 49.7k tokens on a one-line edit.
const CLI_BEFORE = ["#[test]", "fn help_and_command_diagnostics_use_one_exact_io_call() {", "    assert_eq!(calls, 2);", "}", ""].join("\n");
const cliDiff = ["```diff", "--- a/tests/cli.rs", "+++ b/tests/cli.rs", "@@ -1,4 +1,4 @@", " #[test]", " fn help_and_command_diagnostics_use_one_exact_io_call() {", "-    assert_eq!(calls, 2);", "+    assert_eq!(calls, 1);", " }", "```"];
const evalpin = (quotes: string[]) => ["Apply this diff to `tests/cli.rs`:", ...cliDiff, ...quotes].join("\n");
const quotedLines = [
  "Exactly one existing test changes: `help_and_command_diagnostics_use_one_exact_io_call` in `tests/cli.rs` (line 3, its call count). Old line:",
  "```text",
  "    assert_eq!(calls, 2);",
  "```",
  "New line:",
  "```text",
  "    assert_eq!(calls, 1);",
  "```",
];

describe("a quoted old or new line next to a diff of the same file (#2366)", () => {
  test("quoted lines are context: the diff alone supplies the file, for pricing and the apply decision", () => {
    const request = evalpin(quotedLines);
    expect(suppliedBlocks(request, ["tests/cli.rs"]).get("tests/cli.rs")?.map((b) => b.kind)).toEqual(["diff"]);
    // Pricing counts the diff's two changed lines, not the quoted line as a file.
    expect(Object.fromEntries(suppliedLines(request, ["tests/cli.rs"]))).toEqual({ "tests/cli.rs": 2 });
    // A quote whose lines are all in the diff is context whatever the prose says.
    const plain = evalpin(["The changed line of `tests/cli.rs` must read exactly:", "```text", "    assert_eq!(calls, 1);", "```"]);
    expect(suppliedLines(plain, ["tests/cli.rs"]).get("tests/cli.rs")).toBe(2);
    // Without a diff for the path the same block is still a supplied file.
    expect(suppliedBlocks(quotedLines.join("\n"), ["tests/cli.rs"]).get("tests/cli.rs")?.map((b) => b.kind)).toEqual(["file"]);
  });

  test("the host would apply the diff, and a true whole file next to the diff still declines", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-quoted-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "tests"));
    writeFileSync(join(root, "tests/cli.rs"), CLI_BEFORE);
    const task = { writes: [{ path: "tests/cli.rs", action: "modify" as const }] };
    const quoted = (await hostApplyInputs(root, evalpin(quotedLines), task)) ?? [];
    expect(quoted).toEqual([{ path: "tests/cli.rs", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true }]);
    expect(hostApplyDecision(quoted)).toEqual({ wouldApply: true, reason: null });
    expect((await hostApplyContents(root, evalpin(quotedLines), task))[0]?.content).toBe(CLI_BEFORE.replace("calls, 2", "calls, 1"));
    // A whole file that is not a quote of the diff still conflicts with it.
    const whole = ["Replace `tests/cli.rs` with:", "```rust", "#[test]", "fn other() {}", "```"];
    const both = (await hostApplyInputs(root, evalpin(whole), task)) ?? [];
    expect(both[0]).toMatchObject({ files: 1, diffs: 1, whole: true });
    expect(hostApplyDecision(both).reason).toBe("the request gives both a fenced file and a diff for tests/cli.rs");
    expect(suppliedLines(evalpin(whole), ["tests/cli.rs"]).get("tests/cli.rs")).toBe(4);
  }, 60000);
});

// Bench round 76 (#2412): update briefs gave README diffs as `git diff -U0` output, so no context
// line carried a non-ASCII character. Without `--unidiff-zero` git pins a hunk with neither leading
// nor trailing context to both ends of the file: flatelens-update's two pure additions were appended
// after the README's footer and reported as applied (a 96k corrective), and callmend-update's
// replacing hunk was refused, so an implementer spent 86k tokens on a change the brief gave exactly.
const README_BEFORE = ["# Tool", "", "Intro.", "", "## Usage", "", "run it", "", "Built with BAKED", ""].join("\n");
const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
/** A `git diff -U0` block for `path`, with its `diff --git` and `index` header. */
const zeroDiff = (path: string, before: string, hunks: string[], index = blob(before).slice(0, 7)) =>
  ["```diff", `diff --git a/${path} b/${path}`, `index ${index}..1234567 100644`, `--- a/${path}`, `+++ b/${path}`, ...hunks, "```"].join("\n");
/** flatelens: two pure additions, in the middle of the file. */
const ADDS = ["@@ -3,0 +4,2 @@", "+", "+More intro.", "@@ -7,0 +10 @@", "+run it twice"];
const README_ADDED = ["# Tool", "", "Intro.", "", "More intro.", "", "## Usage", "", "run it", "run it twice", "", "Built with BAKED", ""].join("\n");
/** callmend: a hunk that replaces a line. */
const REPLACES = ["@@ -7 +7 @@", "-run it", "+run it now"];
const README_REPLACED = README_BEFORE.replace("run it", "run it now");
const readmeTask = { writes: [{ path: "README.md", action: "modify" as const }] };
const brief0 = (diff: string) => `The README.md diff has no context lines (-U0): add the lines at the positions in its @@ headers.\n${diff}`;

describe("a zero-context (-U0) diff applies at its @@ positions (#2412)", () => {
  test("one helper builds git apply's arguments: --unidiff-zero only for a patch with a zero-context hunk", () => {
    const normal = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n";
    expect(applyArgs(normal, true)).toEqual(["apply", "--check", "--recount", "-p1"]);
    expect(applyArgs(normal)).toEqual(["apply", "--recount", "-p1"]);
    expect(applyArgs("index 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -2,0 +3 @@\n+X\n")).toEqual(["apply", "--recount", "-p1", "--unidiff-zero"]);
    // A context line anywhere in the hunk is context; a new or deleted file's hunk is never zero-context.
    expect(zeroContextHunks("--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+b\n+c\n")).toBe(false);
    expect(zeroContextHunks("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x\n")).toBe(false);
    expect(zeroContextHunks("--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n")).toBe(false);
    // One zero-context hunk among context hunks is enough.
    expect(zeroContextHunks("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -9 +9 @@\n-y\n+z\n")).toBe(true);
    // The diff's own index line is kept for the base check; git skips it before the headers.
    expect(diffSections(zeroDiff("README.md", README_BEFORE, REPLACES).replace(/```(diff)?/g, ""))[0]?.patch).toBe(`index ${blob(README_BEFORE).slice(0, 7)}..1234567\n--- a/README.md\n+++ b/README.md\n@@ -7 +7 @@\n-run it\n+run it now\n`);
  });

  test("a pure addition lands at its header's line, a replacement applies, and the base is left alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-u0-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "README.md"), README_BEFORE);
    const added = brief0(zeroDiff("README.md", README_BEFORE, ADDS));
    expect(await hostApplyInputs(root, added, readmeTask)).toEqual([{ path: "README.md", action: "modify", files: 0, diffs: 1, whole: false, exists: true, applies: true }]);
    // Not after the footer.
    expect((await hostApplyContents(root, added, readmeTask))[0]?.content).toBe(README_ADDED);
    const replaced = brief0(zeroDiff("README.md", README_BEFORE, REPLACES));
    expect((await hostApplyInputs(root, replaced, readmeTask))?.[0]?.applies).toBe(true);
    expect((await hostApplyContents(root, replaced, readmeTask))[0]?.content).toBe(README_REPLACED);
    // Both in one diff, and a CRLF checkout of the same blob.
    const both = brief0(zeroDiff("README.md", README_BEFORE, [...ADDS.slice(0, 3), ...REPLACES, ...ADDS.slice(3)]));
    expect((await hostApplyContents(root, both, readmeTask))[0]?.content).toBe(README_ADDED.replace("run it\n", "run it now\n"));
    writeFileSync(join(root, "README.md"), README_BEFORE.replaceAll("\n", "\r\n"));
    expect((await hostApplyInputs(root, added, readmeTask))?.[0]).toMatchObject({ applies: true, eol: "crlf" });
    expect((await hostApplyContents(root, added, readmeTask))[0]?.content).toBe(README_ADDED.replaceAll("\n", "\r\n"));
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(README_BEFORE.replaceAll("\n", "\r\n"));
  }, 60000);

  test("a zero-context diff whose index pre-image is not the base declines with the hash; a context diff is not hash-checked", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-u0-drift-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // An earlier change moved the Usage section down two lines: the diff's line numbers are stale.
    const drifted = README_BEFORE.replace("Intro.\n", "Intro.\n\nSee also.\n");
    writeFileSync(join(root, "README.md"), drifted);
    const stale = brief0(zeroDiff("README.md", README_BEFORE, ADDS));
    const inputs = (await hostApplyInputs(root, stale, readmeTask)) ?? [];
    expect(inputs[0]).toMatchObject({ applies: false });
    const old = blob(README_BEFORE).slice(0, 7);
    expect(inputs[0]?.refusal).toBe(`the zero-context diff for README.md names pre-image ${old}, and the base file is ${blob(drifted).slice(0, 7)}: its hunks are placed by line number only, so they apply only to that pre-image`);
    expect(hostApplyDecision(inputs).reason).toStartWith(`the diff for README.md does not apply to the task's base: the zero-context diff for README.md names pre-image ${old}`);
    // Without an index line there is no pre-image to check: the line numbers decide.
    const bare = stale.replace(/^index .*\n/m, "");
    expect((await hostApplyInputs(root, bare, readmeTask))?.[0]?.applies).toBe(true);
    // A normal-context diff with a stale index line applies as before, by its context.
    const context = brief0(["```diff", "diff --git a/README.md b/README.md", "index 0123456..1234567 100644", "--- a/README.md", "+++ b/README.md", "@@ -7,5 +7,5 @@", " ## Usage", " ", "-run it", "+run it now", " ", " Built with BAKED", "```"].join("\n"));
    expect((await hostApplyInputs(root, context, readmeTask))?.[0]?.applies).toBe(true);
    expect((await hostApplyContents(root, context, readmeTask))[0]?.content).toBe(drifted.replace("run it", "run it now"));
  }, 60000);

  // The two R76 shapes through a run with `hostApply: "on"`: flatelens' pure additions in the
  // README (T001) and callmend's replacing hunk (T002), plus a diff with context (T003).
  test("scenario: under hostApply on, both -U0 shapes are host-applied at their positions, and a context diff is unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-apply-u0-run-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), README_BEFORE);
    const LIB = ["def run(args)", "  parse(args)", "end", ""].join("\n");
    writeFileSync(join(root, "src/lib.rb"), LIB);
    writeFileSync(join(root, "src/a.ts"), A_BEFORE);
    const request = [
      brief0(zeroDiff("README.md", README_BEFORE, ADDS)),
      "Change `src/lib.rb` (-U0):",
      zeroDiff("src/lib.rb", LIB, ["@@ -2 +2 @@", "-  parse(args)", "+  parse(args, strict: true)"]),
      "Then this one:",
      ["```diff", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,2 +1,2 @@", " export const A = 1;", "-export const B = 2;", "+export const B = 3;", "```"].join("\n"),
    ].join("\n");
    const files: Record<string, [string, string]> = {
      T001: ["README.md", README_ADDED],
      T002: ["src/lib.rb", LIB.replace("parse(args)", "parse(args, strict: true)")],
      T003: ["src/a.ts", "export const A = 1;\nexport const B = 3;\n"],
    };
    const graph = [planned("T001", "README.md", "modify"), planned("T002", "src/lib.rb", "modify"), planned("T003", "src/a.ts", "modify")];
    const on: RunPolicy = { ...policy, hostApply: "on" };
    const executor = new ScriptedExecutor(root, graph, files);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy: on } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy: on });
    await service.drive(run.runId, new AbortController().signal);
    const waiting = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error(`No approval request: ${waiting.status} ${waiting.reason}`);
    await service.decide(run.runId, { commandId: newId(), expectedRevision: waiting.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    expect((await service.drive(run.runId, new AbortController().signal)).status).toBe("completed");
    const records = hostApplyRecords(service.store, run.runId);
    expect(records.map((r) => [r.taskId, r.wouldApply, r.applied, r.reason])).toEqual([
      ["T001", true, true, null],
      ["T002", true, true, null],
      ["T003", true, true, null],
    ]);
    expect(executor.attempts).toEqual([]);
    for (const [path, text] of Object.values(files)) expect(readFileSync(join(root, runRootPath(service.store, run.runId), path), "utf8")).toBe(text);
  }, 120000);
});

// Bench round 77 (#2438): trailspin's brief listed each Go file's exported signatures in a fenced
// block whose first line was a path comment (`// internal/cli/cli.go`), after the prose "Files
// (names and shapes are fixed; tests call them)". The host took the listing as the whole new file,
// wrote six stubs that did not compile, and the run spent a corrective round replacing them.
const LISTING = ["```go", "// internal/cli/cli.go", "func Run(args []string, stdout, stderr io.Writer) int", "func Usage() string", "```"];
const trailspin = (prose: string) => [prose, ...LISTING].join("\n");
const cliTask = { writes: [{ path: "internal/cli/cli.go", action: "create" as const }] };

describe("a path-comment signature listing is not a new file (#2438)", () => {
  test("only a header comment names the path, the prose does not say whole: a listing the host declines", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-listing-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const request = trailspin("Files (names and shapes are fixed; tests call them):");
    expect(suppliedBlocks(request, ["internal/cli/cli.go"]).get("internal/cli/cli.go")).toMatchObject([{ kind: "file", listing: true }]);
    const writes = (await hostApplyInputs(root, request, cliTask)) ?? [];
    expect(writes).toEqual([{ path: "internal/cli/cli.go", action: "create", files: 1, diffs: 0, whole: false, exists: false, applies: null, listing: true }]);
    expect(hostApplyDecision(writes).wouldApply).toBe(false);
    expect(hostApplyDecision(writes).reason).toContain("may be a listing");
    // The decision unit: the same create without the flag applies.
    expect(hostApplyDecision([write({ path: "internal/cli/cli.go", action: "create", files: 1, diffs: 0, applies: null, exists: false, listing: true })]).wouldApply).toBe(false);
    expect(hostApplyDecision([write({ path: "internal/cli/cli.go", action: "create", files: 1, diffs: 0, applies: null, exists: false })]).wouldApply).toBe(true);
  }, 60000);

  test("a header block whose prose says it is the whole file, or whose prose names the path, still applies", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-listing-whole-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const prose of ["Write this file verbatim:", "Create `internal/cli/cli.go` with:", "The complete contents:"]) {
      const request = trailspin(prose);
      expect(suppliedBlocks(request, ["internal/cli/cli.go"]).get("internal/cli/cli.go")?.[0]).not.toHaveProperty("listing");
      expect(hostApplyDecision((await hostApplyInputs(root, request, cliTask)) ?? []).wouldApply).toBe(true);
    }
  }, 60000);

  test("every header comment form marks a listing", () => {
    for (const [path, lead] of [["tools/run.py", "#"], ["src/lib.rs", "//"], ["db/schema.sql", "--"], ["src/core.lisp", ";"]] as const) {
      const request = ["Shapes:", "```", `${lead} ${path}`, "signature one", "```"].join("\n");
      expect(suppliedBlocks(request, [path]).get(path)).toMatchObject([{ kind: "file", listing: true }]);
    }
  });

  test("supplied drift and the supplied test files leave a listing out", () => {
    const request = trailspin("Files (names and shapes are fixed; tests call them):");
    const listing = write({ path: "internal/cli/cli.go", action: "create", files: 1, diffs: 0, applies: null, exists: false, listing: true });
    expect(comparableWrite(listing)).toBe(false);
    const graph = { tasks: [{ id: "T001", origin: "planned", writes: cliTask.writes }] } as unknown as Pick<TaskGraph, "tasks">;
    // An older record without the flag still finds the block marked and records no drift.
    const { listing: _drop, ...unflagged } = listing;
    expect(suppliedDrifts(request, [{ taskId: "T001", mode: "shadow", writes: [unflagged], wouldApply: true, reason: null }], graph, () => "package cli\n")).toEqual([]);
    const testPath = "internal/cli/cli_test.go";
    const testRequest = ["Tests:", "```go", `// ${testPath}`, "func TestRun(t *testing.T)", "```"].join("\n");
    const testGraph = { tasks: [{ id: "T002", origin: "planned", writes: [{ path: testPath, action: "create" }] }] } as unknown as Pick<TaskGraph, "tasks">;
    expect(suppliedTestFiles(testRequest, testGraph).size).toBe(0);
  });
});

// Bench round 78 (#2453): deltaglue's brief listed `src/cli.ts`'s shape (`// src/cli.ts`) after a
// line whose prose named `src/frames.ts`, `src/chunks.ts` and `src/assemble.ts` and "the whole
// stream". For a task that wrote `src/frames.ts` the reader took the cli.ts listing as the whole
// of frames.ts, and under `hostApply: on` the host wrote it; the real frames listing, headed with
// trailing words, was attributed to nothing. The block's own header comment now decides its path.
const deltaglue = [
  "## Shapes",
  "",
  "Tests import `src/frames.ts`, `src/chunks.ts` and `src/assemble.ts` and check the whole stream:",
  "```ts",
  "// src/cli.ts",
  "export function run(argv: string[], out: (line: string) => void): number;",
  "```",
  "The frame codec:",
  "```ts",
  "// src/frames.ts   (names and shapes are fixed; tests call them)",
  "export interface Frame { kind: number; body: Uint8Array }",
  "export function encode(frame: Frame): Uint8Array;",
  "```",
].join("\n");
const DELTAGLUE_PATHS = ["src/frames.ts", "src/chunks.ts", "src/assemble.ts", "src/cli.ts"];
const deltaglueGraph = {
  tasks: DELTAGLUE_PATHS.map((path, i) => ({ id: `T00${i + 1}`, origin: "planned", writes: [{ path, action: "create" }] })),
} as unknown as Pick<TaskGraph, "tasks">;

describe("a block's header comment names its file, whatever the prose names (#2453)", () => {
  test("scenario: deltaglue's listings go to the files their headers name, as listings, for one path or all", async () => {
    for (const asked of [...DELTAGLUE_PATHS.map((p) => [p]), DELTAGLUE_PATHS]) {
      const supplied = suppliedBlocks(deltaglue, asked);
      expect(supplied.has("src/chunks.ts")).toBe(false);
      expect(supplied.has("src/assemble.ts")).toBe(false);
      if (asked.includes("src/frames.ts")) {
        expect(supplied.get("src/frames.ts")).toMatchObject([{ kind: "file", whole: false, listing: true }]);
        expect(supplied.get("src/frames.ts")?.[0]).toMatchObject({ content: expect.stringContaining("export interface Frame") });
      }
      // "the whole stream" is a clause about other files: the cli.ts block is a listing too.
      if (asked.includes("src/cli.ts")) expect(supplied.get("src/cli.ts")).toMatchObject([{ kind: "file", whole: false, listing: true }]);
    }
    const root = mkdtempSync(join(tmpdir(), "baked-host-deltaglue-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const task of deltaglueGraph.tasks) {
      const writes = await hostApplyInputs(root, deltaglue, task, deltaglueGraph);
      expect(writes === null || !hostApplyDecision(writes).wouldApply).toBe(true);
    }
    expect(hostAppliableTasks(deltaglue, deltaglueGraph)).toEqual([]);
    // The record R78 left for frames T001 (whole, unflagged) finds the frames listing: no drift.
    const old = write({ path: "src/frames.ts", action: "create", files: 1, diffs: 0, whole: true, applies: null, exists: false });
    const frames = { tasks: [{ id: "T001", origin: "planned", writes: [{ path: "src/frames.ts", action: "create" }] }] } as unknown as Pick<TaskGraph, "tasks">;
    expect(suppliedDrifts(deltaglue, [{ taskId: "T001", mode: "on", writes: [old], wouldApply: true, reason: null }], frames, () => "export interface Frame {\n")).toEqual([]);
  }, 60000);

  test("one case per comment marker: Python and Ruby #, Go, Rust and TypeScript //, Lua --", () => {
    for (const [lead, a, b] of [
      ["#", "pkg/a.py", "pkg/b.py"],
      ["#", "lib/a.rb", "lib/b.rb"],
      ["//", "internal/a.go", "internal/b.go"],
      ["//", "src/a.rs", "src/b.rs"],
      ["//", "src/a.ts", "src/b.ts"],
      ["--", "lua/a.lua", "lua/b.lua"],
    ] as const) {
      const request = [
        `Tests import \`${b}\` and check the whole output:`,
        "```",
        `${lead} ${a}`,
        "signature of a",
        "```",
        "Shapes of b:",
        "```",
        `${lead} ${b}   (names and shapes are fixed)`,
        "signature of b",
        "```",
      ].join("\n");
      for (const asked of [[b], [a], [a, b]]) {
        const supplied = suppliedBlocks(request, asked);
        if (asked.includes(b)) expect(supplied.get(b)).toMatchObject([{ kind: "file", listing: true, content: `${lead} ${b}   (names and shapes are fixed)\nsignature of b\n` }]);
        if (asked.includes(a)) expect(supplied.get(a)).toMatchObject([{ kind: "file", listing: true, content: `${lead} ${a}\nsignature of a\n` }]);
        expect([...supplied.keys()].every((path) => asked.includes(path))).toBe(true);
      }
    }
  });

  test("a header is a path-like first token; trailing words need a directory or punctuation", () => {
    expect(headerPath("// src/frames.ts   (names and shapes are fixed)")).toBe("src/frames.ts");
    expect(headerPath("# setup.py (entry point)")).toBe("setup.py");
    expect(headerPath("-- ./db/schema.sql")).toBe("db/schema.sql");
    expect(headerPath("; src/core.lisp")).toBe("src/core.lisp");
    expect(headerPath("// Node.js helper for the stream")).toBeNull();
    expect(headerPath("# Shapes of the API")).toBeNull();
    expect(headerPath("#!/usr/bin/env python3")).toBeNull();
    expect(headerPath("export const A = 1;")).toBeNull();
    // A bare file name in the header lets the prose give the directory; a whole file still applies.
    const request = ["Replace `src/config.py` with:", "```python", "# config.py", "DEBUG = False", "```"].join("\n");
    expect(suppliedBlocks(request, ["src/config.py"]).get("src/config.py")).toMatchObject([{ kind: "file", whole: true }]);
    expect(suppliedBlocks(request, ["src/config.py"]).get("src/config.py")?.[0]).not.toHaveProperty("listing");
  });

  test("the record and the plan approval read the blocks with one set of paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-host-one-set-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // The prose names two planned files: the block is neither's, whoever asks.
    const request = ["Create `src/x.ts` and `src/y.ts`; both get exactly this content:", "```ts", "export {};", "```"].join("\n");
    const graph = {
      tasks: ["src/x.ts", "src/y.ts"].map((path, i) => ({ id: `T00${i + 1}`, origin: "planned", writes: [{ path, action: "create" }] })),
    } as unknown as Pick<TaskGraph, "tasks">;
    expect(hostAppliableTasks(request, graph)).toEqual([]);
    for (const task of graph.tasks) expect(await hostApplyInputs(root, request, task, graph)).toBeNull();
    expect(hostApplyPaths(graph.tasks[0] as Task, graph)).toEqual(["src/x.ts", "src/y.ts"]);
  }, 60000);
});

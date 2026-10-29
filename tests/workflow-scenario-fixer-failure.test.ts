import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { fixerCommand, isWholeUnitFixer, wholeUnitFixerCommand } from "../src/core/workflows/check-policy.js";
import { FAILED_FIXERS_PATH, FIXER_DIR, FIXER_OUTPUT_LIMIT, failedFixersDiagnostic, fixerOutput, fixerProbeDecision, fixerProbePath } from "../src/core/workflows/fixer-run.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Bench round 77, pairwick (#2436): the configured fixer `sbt.bat --server -batch scalafmtAll` got
// the file appended to its last command, and sbt refused `scalafmtAll <file>` before formatting
// anything (`[error] Expected whitespace character`, exit 1). `apply_fix` returned only
// `"<file>: exit 1"`, the host fixer pass read nothing, and the models hand-indented Scala against
// scalafmt's layout: 17.13M of the initiative's 21.09M tokens. A fixer's exit and output now reach
// the model, the run's records and the task's next attempt.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const SBT_ERROR = "[error] Expected whitespace character\n[error] Expected '/'\n[error] scalafmtAll src/a.ts";
/** A fixer that cannot run as configured: it prints sbt's refusal and leaves the file. */
const brokenFix = { executable: "bun", args: ["-e", `console.error(${JSON.stringify(SBT_ERROR)}); process.exit(1)`] };
/** A required format check that fails while value.txt has trailing whitespace. */
const fmt = {
  id: "fmt",
  executable: "bun",
  args: ["-e", "const t = await Bun.file('value.txt').text(); if (t !== t.trim()) { console.log('value.txt is not formatted properly!'); process.exit(1) }"],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "task" as const,
  envNames: [],
  writes: [],
  fix: brokenFix,
};

const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } },
  warnings: [],
});

/** Scripts the planning stages; the implementation runs the real tools. */
class ScriptedExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") {
      if (!this.native) throw new Error("native executor missing");
      return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
    }
    const out = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
      (plan.taskGraph.tasks[0] as Record<string, unknown>).checkIds = ["fmt"];
    }
    return out;
  }
}

describe("a fixer that cannot run says why (#2436)", () => {
  test("apply_fix returns the fixer's exit code and output, not only `exit 1`", async () => {
    const policy: RunPolicy = { ...fixturePolicy, checks: [{ ...fmt, scope: "feature" }, ...fixturePolicy.checks] };
    const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root) });
    cleanups.push(fixture.dispose);
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => native.dispose());
    fixture.executor.native = native;
    const results: string[] = [];
    const steps = [
      () => call("edit_file", { path: "value.txt", oldString: "", newString: "ready" }),
      () => call("apply_fix", { checkId: "fmt" }),
      () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote the value", evidenceIds: [], unresolved: [] }),
    ];
    let index = 0;
    provider.createModel = () =>
      new MockLanguageModelV3({
        doGenerate: async (options) => {
          const last = options.prompt.at(-1);
          if (last?.role === "tool") results.push(JSON.stringify(last.content));
          const step = steps[index++];
          if (!step) throw new Error("fixer script exhausted");
          return step();
        },
      }) as LanguageModelV3;
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());
    const fix = results
      .flatMap((r) => JSON.parse(r) as { toolName: string; output: { value: { fixed: unknown[] } } }[])
      .find((part) => part.toolName === "apply_fix");
    expect(fix?.output.value.fixed).toEqual([{ target: "value.txt", exitCode: 1, output: SBT_ERROR }]);
  }, 60000);

  test("the host fixer pass records each run, and the task's next attempt gets the failure", async () => {
    const policy: RunPolicy = { ...fixturePolicy, checks: [fmt, ...fixturePolicy.checks] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { executor, service, root } = fixture;
    const sent: { attemptId: string; failedFixers: unknown }[] = [];
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
        (plan.taskGraph.tasks[0] as Record<string, unknown>).checkIds = ["fmt"];
      }
      if (request.profile.output === "implementation") {
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { failedFixers?: unknown } };
        if (data.extra.failedFixers) sent.push({ attemptId: request.attemptId, failedFixers: data.extra.failedFixers });
        writeFileSync(join(root, "value.txt"), "ready  \n");
      }
      return out;
    };
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    for (let i = 0; i < 3 && (await service.get(run.runId)).status !== "completed"; i++) {
      await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    const artifacts = service.store.artifacts(run.runId);
    const read = (path: string) => {
      const row = [...artifacts].reverse().find((a) => a.logical_path === path || a.logical_path.startsWith(path));
      return row ? (JSON.parse(service.store.readArtifact(run.runId, row.id)) as Record<string, unknown>) : null;
    };
    // The pass's record: the command as run, its exit, its output, and that nothing changed.
    const pass = read(`${FIXER_DIR}fmt/`) as { runs: { command: string[]; exitCode: number; changed: boolean; output: string }[] } | null;
    expect(pass?.runs[0]).toMatchObject({ exitCode: 1, changed: false });
    expect(pass?.runs[0]?.output).toContain("Expected whitespace character");
    expect((read(FAILED_FIXERS_PATH) as { failed: { targets: string[] }[] } | null)?.failed.map((r) => r.targets)).toEqual([["value.txt"]]);
    // The next attempt on the file (here the correction of T001's value.txt) received the
    // fixer's output, and its saved context says so.
    const contexts = artifacts
      .filter((a) => a.kind === "attempt-context")
      .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { failedFixers?: { failed: { checkId: string; output: string }[] } });
    const told = contexts.find((c) => c.failedFixers);
    expect(told?.failedFixers?.failed[0]?.checkId).toBe("fmt");
    expect(told?.failedFixers?.failed[0]?.output).toContain("Expected whitespace character");
    // The block's diagnostic names the fixer and its output (#2442).
    const diagnostics = artifacts.filter((a) => a.logical_path.startsWith("errors/")).map((a) => service.store.readArtifact(run.runId, a.id));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.at(-1)).toContain("Automatic fixers that failed without changing their files");
    expect(diagnostics.at(-1)).toContain("Expected whitespace character");
    // What the attempt was sent is what its saved context records.
    expect(sent.length).toBeGreaterThan(0);
    for (const one of sent) {
      const row = service.store.latestArtifact(run.runId, `attempts/${one.attemptId}/context.json`);
      expect(row && (JSON.parse(service.store.readArtifact(run.runId, row.id)) as { failedFixers?: unknown }).failedFixers).toEqual(one.failedFixers);
    }
  }, 60000);

  test("an sbt fixer whose last command takes no file runs once, as configured", () => {
    for (const executable of ["sbt", "sbt.bat"]) {
      const fix = { executable, args: ["--server", "-batch", "scalafmtAll"] };
      expect(fixerCommand(fix, "src/main/scala/pairwick/Rules.scala")).toEqual(fix);
      expect(isWholeUnitFixer(fix)).toBe(true);
      expect(wholeUnitFixerCommand(fix, ["src/main/scala/pairwick/Rules.scala"])).toEqual(fix);
    }
    // `scalafmtOnly` takes the file as its own argument, as the detector configures it.
    const only = { executable: "sbt", args: ["-batch", "scalafmtOnly"] };
    expect(fixerCommand(only, "src/A.scala")).toEqual({ executable: "sbt", args: ["-batch", "scalafmtOnly src/A.scala"] });
    expect(isWholeUnitFixer(only)).toBe(false);
  });

  test("a fixer's output keeps its tail, without color codes", () => {
    expect(fixerOutput("\u001b[31m[error]\u001b[0m Expected '/'\n")).toBe("[error] Expected '/'");
    const long = `${"x".repeat(FIXER_OUTPUT_LIMIT)}\nlast line`;
    expect(fixerOutput(long).endsWith("last line")).toBe(true);
    expect(fixerOutput(long)).toContain("characters left out");
  });

  test("every fixer run goes through runFixer", () => {
    // A fixer command (`fixerCommand`, `wholeUnitFixerCommand`) is passed straight to a local
    // runner whose body calls `runFixer`; a runner of its own drops the result (#2436).
    const dir = join(import.meta.dir, "../src");
    const sites: string[] = [];
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || file.endsWith("check-policy.ts")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(/(\w+)\(\s*(?:fixerCommand|wholeUnitFixerCommand)\(/g)) {
        const runner = match[1] ?? "";
        const declared = text.indexOf(`const ${runner} = async (`);
        // The runner's first lines: where it starts the process.
        const body = declared < 0 ? "" : text.slice(declared, declared + 1500);
        sites.push(`${file}: ${runner} ${/\brunFixer\(/.test(body) ? "runFixer" : "own runner"}`);
      }
    }
    expect(sites.length).toBeGreaterThanOrEqual(4);
    expect(sites.filter((site) => !site.endsWith("runFixer"))).toEqual([]);
  });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

// #2442: the fixer of a required check is run once before the first task, on a tracked file of the
// plan's code kinds in a copy of the run. A fixer that fails and changes nothing there, while its
// check passed before any change, cannot run as configured: the `fixer_unusable` would-stop.
describe("a fixer that cannot run is found before the first task (#2442)", () => {
  async function probe(fix: { executable: string; args: string[] }) {
    const check = { ...fmt, scope: "feature" as const, args: ["-e", "process.exit(0)"], fix };
    const policy: RunPolicy = { ...fixturePolicy, checks: [check, ...fixturePolicy.checks] };
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { executor, service, root } = fixture;
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test User");
    git(root, "config", "user.email", "test@example.test");
    git(root, "config", "commit.gpgsign", "false");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, ".gitignore"), ".baked/\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "Initial");
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        plan.taskGraph.tasks[0]?.writes.push({ path: "src/a.ts", action: "modify" });
      }
      return out;
    };
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await service.drive(run.runId, signal());
    const row = service.store.latestArtifact(run.runId, fixerProbePath("fmt"));
    const record = row ? (JSON.parse(service.store.readArtifact(run.runId, row.id)) as { decision: string; file: string; exitCode: number; output: string }) : null;
    const stops = service.store.eventsOfType(run.runId, "decision.would_stop").filter((e) => e.payload.reason === "fixer_unusable");
    // The probe ran in a copy: the workspace file is as committed.
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    return { record, stops };
  }

  test("a fixer that exits 1 and changes nothing records the would-stop, with its output", async () => {
    const { record, stops } = await probe(brokenFix);
    expect(record).toMatchObject({ decision: "unusable", file: "src/a.ts", exitCode: 1 });
    expect(record?.output).toContain("Expected whitespace character");
    expect(stops).toHaveLength(1);
    expect(String(stops[0]?.payload.summary)).toContain("Expected whitespace character");
  }, 60000);

  test("a fixer that runs records usable and no would-stop", async () => {
    const { record, stops } = await probe({ executable: "bun", args: ["-e", "0"] });
    expect(record).toMatchObject({ decision: "usable", file: "src/a.ts", exitCode: 0 });
    expect(stops).toHaveLength(0);
  }, 60000);

  test("the decision: failed and unchanged is unusable; a change or exit 0 is usable", () => {
    expect(fixerProbeDecision({ exitCode: 1, timedOut: false, changed: false })).toBe("unusable");
    expect(fixerProbeDecision({ exitCode: null, timedOut: true, changed: false })).toBe("unusable");
    expect(fixerProbeDecision({ exitCode: 1, timedOut: false, changed: true })).toBe("usable");
    expect(fixerProbeDecision({ exitCode: 0, timedOut: false, changed: false })).toBe("usable");
  });

  test("a block's diagnostic names the fixer runs that failed, with their last output line", () => {
    const run = { checkId: "scalafmt", targets: ["src/A.scala"], command: ["sbt", "scalafmtAll"], exitCode: 1, timedOut: false, changed: false, output: "[error] Expected '/'" };
    expect(failedFixersDiagnostic([run])).toContain("- scalafmt: sbt scalafmtAll on src/A.scala: exit 1: [error] Expected '/'");
    expect(failedFixersDiagnostic([])).toBe("");
  });
});

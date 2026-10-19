import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../../src/core/llm/providers/index.js";
import { hashBytes } from "../../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../../src/core/workflows/agent-executor.js";
import { WorkflowFault } from "../../src/core/workflows/errors.js";
import type { RunPolicy } from "../../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./workflow-fixture.js";

export const directoryFixers = [
  { name: "biome", args: ["biome", "check", "--write", "."], extension: "ts" },
  { name: "ruff", args: ["ruff", "check", "--fix", "."], extension: "py" },
  { name: "prettier", args: ["prettier", "--write", "."], extension: "ts" },
  { name: "eslint", args: ["eslint", "--fix", "src"], extension: "ts" },
  { name: "black", args: ["black", "."], extension: "py" },
] as const;
type Fixer = (typeof directoryFixers)[number];

const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage: {
    inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  },
  warnings: [],
});

/** Script the planning stages, but run the implementation's real tools and journal. */
class ScriptedExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  constructor(root: string, private readonly paths: string[]) { super(root); }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "implementation") {
      if (!this.native) throw new Error("native executor missing");
      return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
    }
    const result = await super.execute(request);
    if (request.profile.output === "plan") {
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]?.writes.push(...this.paths.map((path) => ({ path, action: "modify" })));
    }
    return result;
  }
}

/**
 * #1593: a directory-wide fixer rewrites two task files on its first invocation. The agent
 * then edits the second file, stops at its budget, and resumes without accepting outside changes.
 * A Bun stub models the directory rewrite on every OS without installing or downloading tools.
 */
export async function directoryFixerScenario(fixer: Fixer, unsafe = false) {
  const paths = [`src/a.${fixer.extension}`, `src/b.${fixer.extension}`];
  const initial = fixer.extension === "py" ? "# initial\n" : "// initial\n";
  const bad = fixer.extension === "py" ? "value = 1 # bad\n" : "export const value = 1; // bad\n";
  const formatted = bad.replace("bad", unsafe ? "unsafe" : "formatted");
  const fixed = bad.replace("bad", "formatted");
  const script = `for (const path of ${JSON.stringify([...paths, "outside.txt"])}) {
    const text = await Bun.file(path).text();
    await Bun.write(path, text.replaceAll('bad', 'formatted'));
  }
  await Bun.write('stray.txt', 'remove me');`;
  const policy: RunPolicy = {
    ...fixturePolicy,
    checks: [...fixturePolicy.checks, {
      id: "lint", executable: "bun", args: ["-e", "process.exit(0)"], cwd: ".",
      timeoutMs: 10000, required: true, scope: "feature", envNames: [], writes: [],
      // Keep the actual tool's argv, including its directory, after the Bun stand-in.
      fix: { executable: "bun", args: ["-e", script, "--", ...fixer.args] },
      ...(unsafe ? { fixUnsafe: { executable: "bun", args: ["-e", script.replaceAll("'bad', 'formatted'", "'formatted', 'unsafe'"), "--", ...fixer.args, "--unsafe"] } } : {}),
    }],
  };
  const fixture = workflowFixture({ policy, executor: (root) => new ScriptedExecutor(root, paths) });
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  fixture.executor.native = native;
  try {
    mkdirSync(join(fixture.root, "src"));
    for (const path of paths) writeFileSync(join(fixture.root, path), initial);
    writeFileSync(join(fixture.root, "outside.txt"), "bad outside\n");
    const results: string[] = [];
    const steps = [
      () => call("edit_file", { path: "value.txt", oldString: "", newString: "ready" }),
      ...paths.map((path) => () => call("edit_file", { path, oldString: initial, newString: bad })),
      () => call("apply_fix", { checkId: "lint" }),
      () => call("edit_file", { path: paths[1], oldString: formatted, newString: `${formatted.trimEnd()} // final\n` }),
      () => { throw new WorkflowFault("BUDGET_EXHAUSTED", "Scripted budget stop after the fixer and edit"); },
      () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote ready value and formatted code", evidenceIds: [], unresolved: [] }),
    ];
    let index = 0;
    provider.createModel = () => new MockLanguageModelV3({ doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") results.push(JSON.stringify(last.content));
      const step = steps[index++];
      if (!step) throw new Error("directory fixer script exhausted");
      return step();
    } }) as LanguageModelV3;
    const run = await fixture.start();
    const signal = () => new AbortController().signal;
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    const stopped = await fixture.service.drive(run.runId, signal());
    const effects = fixture.service.store.effects(run.runId).filter((effect) =>
      effect.kind === "file_patch" && paths.includes(JSON.parse(effect.intent_json).path) && effect.before_hash === hashBytes(bad),
    );
    // A plain resume must recognize every file the fixer rewrote, even after an interrupted task.
    await fixture.resume(run.runId);
    const resumed = await fixture.service.drive(run.runId, signal());
    expect(stopped.reason).toBe("budget_exhausted");
    expect(resumed.reason).not.toBe("input_changed");
    expect(resumed.status).toBe("completed");
    expect(results.join("\n")).not.toContain("File changed outside this attempt");
    expect(results.join("\n")).toContain('"fixed":');
    expect(effects).toHaveLength(2);
    for (const effect of effects) {
      expect(effect.status).toBe("applied");
      expect(effect.after_hash).toBe(hashBytes(fixed));
    }
    for (const [i, path] of paths.entries())
      expect(readFileSync(join(fixture.root, path), "utf8")).toBe(i === 1 ? `${formatted.trimEnd()} // final\n` : formatted);
    expect(readFileSync(join(fixture.root, "outside.txt"), "utf8")).toBe("bad outside\n");
    expect(existsSync(join(fixture.root, "stray.txt"))).toBe(false);
  } finally {
    provider.createModel = original;
    native.dispose();
    await fixture.dispose();
  }
}

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult, LanguageModelV3Prompt } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor, unchangedRereads } from "../src/core/workflows/agent-executor.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, workflowFixture } from "./helpers/workflow-fixture.js";

// Sibling-bug audit (#1409, sibling of #1360): from the fourth read before an edit, a re-read of
// an unchanged file was answered "its content is in your context above", even when history
// compaction had replaced that output with a stub telling the model to read again with
// fresh: true. The model then edited blind or read in a loop.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});
type Step = (prompt: LanguageModelV3Prompt) => LanguageModelV3GenerateResult;

function scriptModel(script: Step[]): string[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const results: string[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") results.push(JSON.stringify(last.content));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next(options.prompt);
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return results;
}

class NativeImplementer extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

const marker = "NOTES-LINE-0042";
const notes = Array.from({ length: 80 }, (_, i) => `NOTES-LINE-${String(i).padStart(4, "0")}: the value file must hold the word ready`).join("\n");

describe("scenario: a re-read after history compaction (#1409)", () => {
  test("a fresh re-read after compaction returns the file, not the unchanged stub", async () => {
    const fixture = workflowFixture({ executor: (root) => new NativeImplementer(root) });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "notes.md"), notes);
    for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(fixture.root, name), `${name}\n`);
    const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => native.dispose());
    fixture.executor.native = native;
    const results = scriptModel([
      () => call("read", { files: [{ path: "notes.md" }] }),
      () => call("read", { files: [{ path: "a.txt" }] }),
      () => call("read", { files: [{ path: "b.txt" }] }),
      () => call("read", { files: [{ path: "c.txt" }] }),
      // The first output is compacted now; its stub says to read again with fresh: true.
      (prompt) => {
        expect(JSON.stringify(prompt)).toContain("with fresh: true");
        return call("read", { files: [{ path: "notes.md" }], fresh: true });
      },
      () => call("edit_file", { path: "value.txt", oldString: "", newString: "ready" }),
      () => call("submit_result", { schemaVersion: 1, taskId: "T001", outcome: "implemented", summary: "Wrote value.txt", evidenceIds: [], unresolved: [] }),
    ]);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, new AbortController().signal);
    await fixture.approve(run.runId);
    const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
    const fresh = results.filter((r) => r.includes('"toolName":"read"')).at(-1) ?? "";
    expect(fresh).not.toContain("is unchanged since your read");
    expect(fresh).toContain(marker);
    expect(outcome.status).toBe("completed");
  }, 60000);
});

describe("unchangedRereads guards (#1409)", () => {
  function file() {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const path = join(fixture.root, "notes.md");
    writeFileSync(path, notes);
    return path;
  }
  const reads = (path: string, options: Parameters<typeof unchangedRereads>[4] = {}) => {
    const earlier = new Map<string, { hash: string | null; read: number; call?: number }>();
    for (let read = 1; read <= 3; read++) unchangedRereads([{ path }], earlier, read, false, { ...options, call: read });
    return earlier;
  };

  test("a role without edit tools always gets the file", () => {
    const path = file();
    const earlier = reads(path, { mayEdit: false });
    expect(unchangedRereads([{ path }], earlier, 4, false, { mayEdit: false, call: 4 }).unchanged).toEqual([]);
  });

  test("a read older than the compaction window gets the file, a recent one the stub", () => {
    const path = file();
    const earlier = reads(path);
    expect(unchangedRereads([{ path }], earlier, 4, false, { call: 6 }).unchanged).toHaveLength(1);
    expect(unchangedRereads([{ path }], reads(path), 4, false, { call: 7 }).unchanged).toEqual([]);
  });

  test("a fresh read always gets the file", () => {
    const path = file();
    const earlier = reads(path);
    expect(unchangedRereads([{ path }], earlier, 4, false, { fresh: true, call: 4 }).unchanged).toEqual([]);
  });
});

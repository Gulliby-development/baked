import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectWarnings } from "../src/core/llm/providers/codex/runner.js";

const root = join(import.meta.dir, "..");

/** Runs a model step with a provider warning in a fresh process and returns its stderr. */
function stderrOfStep(prelude: string): string {
  const script = `
${prelude}
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
const model = new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: "text", text: "ok" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [{ type: "unsupported", feature: "topK", details: "ignored" }],
  }),
});
await generateText({ model, prompt: "hi" });
`;
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  return result.stderr.toString();
}

describe("AI SDK warnings", () => {
  test("a provider warning is printed when nothing turns the SDK's logging off", () => {
    expect(stderrOfStep("")).toContain("AI SDK Warning");
  });

  test("the warnings module keeps a step's provider warning off stderr", () => {
    expect(stderrOfStep('import "./src/core/sdk-warnings.ts";')).toBe("");
  });

  test("the TUI entry point and the workflow worker load it before anything else", () => {
    for (const file of ["src/boot.tsx", "src/core/workers/workflow.worker.ts"]) {
      const firstImport = readFileSync(join(root, file), "utf8")
        .split("\n")
        .find((line) => line.startsWith("import "));
      expect(firstImport).toMatch(/sdk-warnings\.js";$/);
    }
  });

  test("Codex does not warn about the output limit every agent sets", () => {
    expect(collectWarnings({ prompt: [], maxOutputTokens: 4096 })).toEqual([]);
    expect(collectWarnings({ prompt: [], topK: 3 })).toHaveLength(1);
  });
});

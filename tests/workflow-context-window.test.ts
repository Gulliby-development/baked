import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { getModelContextWindowSync, knownModelContextWindow } from "../src/core/llm/models.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #1244: the workflow context check used a fixed 128,000-token window for every model, so a
// model nothing in BAKED names (codex gpt-6.1-sol) stopped a run at its second review with
// budget_exhausted before any call, while the model itself had room.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [] };
// About 120k tokens at the check's three bytes per token: above 80 percent of 128k.
const LARGE_REQUEST = `Add greet.\n${"Context line for the request.\n".repeat(12_000)}`;

// Research under the 256 KiB result limit and a long request: together about 110k tokens, more
// than the spec author's context may hold in 128k; without the research about 35k.
const LARGE_FACTS = Array.from({ length: 25 }, (_, i) => ({ statement: `Fact ${i}: ${"detail ".repeat(1_250)}`, paths: [] }));
const LONG_REQUEST = `Add greet.\n${"Context line for the request.\n".repeat(3_500)}`;

class ResearchOnly implements AgentExecutor {
  prompts: string[] = [];
  models: string[] = [];
  outputs: string[] = [];
  readonly stop = new AbortController();
  constructor(private facts: { statement: string; paths: string[] }[] = []) {}
  async execute(request: ExecutionRequest) {
    this.prompts.push(request.prompt);
    this.models.push(request.profile.model);
    this.outputs.push(request.profile.output);
    if (request.profile.output !== "research") {
      this.stop.abort();
      throw new Error("stop after research");
    }
    return {
      output: { schemaVersion: 1, summary: "A module", facts: this.facts, unknowns: [], constraints: [], suggestedScope: ["src/greet.ts"] },
      inputTokens: 20,
      outputTokens: 30,
    };
  }
}

async function research(model: string, modelFallback: Record<string, string[]> = {}, request = LARGE_REQUEST, facts: { statement: string; paths: string[] }[] = []) {
  const root = mkdtempSync(join(tmpdir(), "baked-window-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/greet.ts"), "export const greet = () => \"\";\n");
  const executor = new ResearchOnly(facts);
  const config = { ...DEFAULT_CONFIG, defaultModel: model, modelFallback, workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: request, ownerLabel: "test", policy });
  await service.drive(run.runId, executor.stop.signal);
  const snapshot = JSON.stringify(await service.get(run.runId));
  return { executor, service, runId: run.runId, snapshot };
}

describe("workflow context window (#1244)", () => {
  test("a model with no known window is not stopped on the 128k guess", async () => {
    expect(knownModelContextWindow("fixture/unnamed-model")).toBeNull();
    expect(getModelContextWindowSync("fixture/unnamed-model")).toBe(128_000);
    const { executor, snapshot } = await research("fixture/unnamed-model");
    expect(executor.prompts.length).toBeGreaterThan(0);
    expect(snapshot).not.toContain("exceeds");
  }, 60000);

  test("a model whose window is known and too small stops for the window, before any call", async () => {
    expect(knownModelContextWindow("openai/gpt-4o")).toBe(128_000);
    const { executor, service, runId, snapshot } = await research("openai/gpt-4o");
    expect(executor.prompts.length).toBe(0);
    expect(snapshot).toContain('"reason":"budget_exhausted"');
    const diagnostic = service.store.artifacts(runId).filter((a) => a.kind === "diagnostic").at(-1);
    if (!diagnostic) throw new Error("No diagnostic");
    const text = String(service.store.readArtifact(runId, diagnostic.id));
    expect(text).toContain("128000-token window of openai/gpt-4o even shortened");
    expect(text).toContain("its largest part is the request");
  }, 60000);

  test("a context that fits only shortened runs without the research instead of stopping", async () => {
    const { executor } = await research("openai/gpt-4o", {}, LONG_REQUEST, LARGE_FACTS);
    expect(executor.outputs).toEqual(["research", "spec"]);
    expect(executor.prompts[1]).not.toContain("Fact 0:");
  }, 60000);

  test("a context too large for the routed model goes to the next model of the route", async () => {
    const { executor } = await research("openai/gpt-4o", { "openai/gpt-4o": ["fixture/unnamed-model"] });
    expect(executor.models[0]).toBe("fixture/unnamed-model");
  }, 60000);
});

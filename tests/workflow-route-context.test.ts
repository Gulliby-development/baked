import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { largerContextModel } from "../src/core/llm/context-sizes.js";
import type { ModelRouting } from "../src/core/llm/model-routing.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import {
  applyRoutingChange,
  describeRoute,
  draftOf,
  parseRouteContext,
  routeOf,
} from "../src/core/workflows/routing-edit.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// #1256: a workflow route picks the context window of a model that offers several (Claude Code
// `[1m]`): `max` always, `auto` only for a step whose context does not fit the model as named.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [] };
// About 180k tokens at the check's three bytes per token: above 80 percent of 200k, well
// within 1M.
const LARGE_REQUEST = `Add greet.\n${"Context line for the request.\n".repeat(18_000)}`;

class ResearchOnly implements AgentExecutor {
  models: string[] = [];
  readonly stop = new AbortController();
  /** Models whose calls the provider refuses for their size, as an HTTP 413. */
  constructor(private readonly tooLarge: string[] = []) {}
  async execute(request: ExecutionRequest) {
    this.models.push(request.profile.model);
    if (this.tooLarge.includes(request.profile.model))
      throw Object.assign(new Error("Request too large"), { statusCode: 413 });
    if (request.profile.output !== "research") {
      this.stop.abort();
      throw new Error("stop after research");
    }
    return {
      output: {
        schemaVersion: 1,
        summary: "A module",
        facts: [],
        unknowns: [],
        constraints: [],
        suggestedScope: ["src/greet.ts"],
      },
      inputTokens: 20,
      outputTokens: 30,
    };
  }
}

async function research(prompt: string, modelRouting?: ModelRouting, tooLarge: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "baked-route-context-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/greet.ts"), 'export const greet = () => "";\n');
  const executor = new ResearchOnly(tooLarge);
  const config = {
    ...DEFAULT_CONFIG,
    defaultModel: "claude-code/sonnet",
    ...(modelRouting ? { modelRouting } : {}),
    workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy },
  };
  const service = new NativeWorkflowService(root, config, executor);
  cleanups.push(() => service.close());
  const run = await service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt,
    ownerLabel: "test",
    policy,
  });
  await service.drive(run.runId, executor.stop.signal);
  const routing = service.store.latestArtifact(run.runId, "routing.json");
  return {
    executor,
    snapshot: JSON.stringify(await service.get(run.runId)),
    routing: routing ? String(service.store.readArtifact(run.runId, routing.id)) : "",
  };
}

describe("route context window (#1256)", () => {
  test("a context too large for 200k stops the run without a context setting", async () => {
    const { executor, snapshot } = await research(LARGE_REQUEST);
    expect(executor.models).toEqual([]);
    expect(snapshot).toContain('"reason":"budget_exhausted"');
  }, 60000);

  test("auto moves only the step that does not fit to the largest window", async () => {
    const { executor, routing } = await research(LARGE_REQUEST, { context: "auto" });
    expect(executor.models[0]).toBe("claude-code/sonnet[1m]");
    expect(routing).toContain('"context":"auto"');
    expect(routing).not.toContain("sonnet[1m]");
  }, 60000);

  test("auto moves a step the provider refuses for its size to the largest window", async () => {
    const { executor } = await research("Add greet.", { context: "auto" }, ["claude-code/sonnet"]);
    expect(executor.models.slice(0, 2)).toEqual(["claude-code/sonnet", "claude-code/sonnet[1m]"]);
  }, 60000);

  test("auto keeps the model as named while the context fits", async () => {
    const { executor } = await research("Add greet.", { context: "auto" });
    expect(executor.models[0]).toBe("claude-code/sonnet");
  }, 60000);

  test("max freezes the largest window into the run's routing, fallback models too", async () => {
    const { executor, routing } = await research("Add greet.", {
      roles: {
        researcher: { model: "claude-code/opus", context: "max", fallback: ["claude-code/sonnet"] },
      },
    });
    expect(executor.models[0]).toBe("claude-code/opus[1m]");
    expect(routing).toContain('"model":"claude-code/opus[1m]"');
    expect(routing).toContain('"fallback":["claude-code/sonnet[1m]"]');
  }, 60000);

  test("a window in tokens picks that window", async () => {
    const { executor } = await research("Add greet.", {
      context: 1_000_000,
      roles: { researcher: { model: "claude-code/opus", context: 200_000 } },
    });
    expect(executor.models[0]).toBe("claude-code/opus");
  }, 60000);
});

describe("route context editing (#1256)", () => {
  test("a route keeps its context through the edit form", () => {
    const route = { model: "claude-code/opus", context: "max" as const };
    expect(draftOf(route).context).toBe("max");
    expect(routeOf(draftOf(route))).toEqual(route);
    expect(routeOf({ model: "claude-code/opus", effort: null, fallback: [] })).toBe(
      "claude-code/opus",
    );
    expect(describeRoute({ model: "claude-code/opus", context: 1_000_000 })).toBe(
      "claude-code/opus · context 1m",
    );
  });

  test("parses keywords and sizes", () => {
    expect(parseRouteContext("auto")).toBe("auto");
    expect(parseRouteContext("MAX")).toBe("max");
    expect(parseRouteContext("1m")).toBe(1_000_000);
    expect(parseRouteContext("200k")).toBe(200_000);
    expect(parseRouteContext("huge")).toBeNull();
  });

  test("the routing-wide context is set, kept by other edits and cleared", () => {
    const layers = { global: undefined, project: undefined };
    const set = applyRoutingChange(layers, "project", { context: "auto" });
    expect(set).toEqual({ routing: { context: "auto" }, problems: [] });
    const other = applyRoutingChange({ global: undefined, project: set.routing }, "project", {
      critic: "advise",
    });
    expect(other.routing).toEqual({ context: "auto", critic: "advise" });
    const cleared = applyRoutingChange({ global: undefined, project: other.routing }, "project", {
      context: null,
    });
    expect(cleared.routing).toEqual({ critic: "advise" });
  });

  test("only models with a larger window have one to move to", () => {
    expect(largerContextModel("claude-code/opus")).toBe("claude-code/opus[1m]");
    expect(largerContextModel("claude-code/opus[1m]")).toBeNull();
    expect(largerContextModel("claude-code/haiku")).toBeNull();
    expect(largerContextModel("codex/gpt-5.5")).toBeNull();
  });
});

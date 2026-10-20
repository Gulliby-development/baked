import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { ProfileRegistry } from "../src/core/agents/profiles/registry.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { disposeMCPManager, getMCPManager } from "../src/core/mcp/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import {
  grantedMcpServers,
  toolListAllows,
  unmatchedMcpGrants,
} from "../src/core/workflows/mcp-grants.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import { WorkflowToolPolicy } from "../src/core/workflows/tool-policy.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { useMCPStore } from "../src/stores/mcp.js";
import type { MCPServerConfig } from "../src/types/index.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const stub: MCPServerConfig = {
  name: "stub",
  command: process.execPath,
  args: [join(import.meta.dir, "fixtures", "mcp-stub-server.ts")],
};

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("MCP grants", () => {
  test("a tool is granted by its exact name or its server's wildcard, never by default", () => {
    expect(toolListAllows(["mcp__stub__echo"], "mcp__stub__echo")).toBe(true);
    expect(toolListAllows(["mcp__stub__*"], "mcp__stub__stamp")).toBe(true);
    expect(toolListAllows(["mcp__stub__echo"], "mcp__stub__stamp")).toBe(false);
    expect(toolListAllows(["mcp__other__*"], "mcp__stub__echo")).toBe(false);
    expect(toolListAllows(fixturePolicy.allowedTools, "mcp__stub__echo")).toBe(false);
    // A wildcard is not a prefix match on built-in names.
    expect(toolListAllows(["read"], "read")).toBe(true);
    expect(toolListAllows(["mcp__stub__*"], "read")).toBe(false);
  });

  test("only servers both lists name are connected, and disabled ones never", () => {
    const servers: MCPServerConfig[] = [
      stub,
      { name: "other", command: "x" },
      { name: "off", command: "x", disabled: true },
    ];
    const granted = grantedMcpServers(
      servers,
      ["read", "mcp__stub__echo", "mcp__other__*", "mcp__off__*"],
      ["mcp__stub__*", "mcp__off__*"],
    );
    expect(granted.map((s) => s.name)).toEqual(["stub"]);
  });

  test("the doctor names grants no configured server provides", () => {
    expect(
      unmatchedMcpGrants([stub], [
        { id: "a", allowedTools: ["read", "mcp__stub__echo", "mcp__gone__*"] },
      ]),
    ).toEqual([{ profileId: "a", grant: "mcp__gone__*" }]);
  });
});

describe("profiles with MCP grants", () => {
  const profile = (id: string, role: string, output: string, allowedTools: string[]) => ({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    description: "Test profile",
    role,
    model: "$active",
    context: role === "reviewer" ? "review" : "research",
    instructions: "Test",
    skills: [],
    allowedTools,
    output,
    maxSteps: 4,
    maxOutputTokens: 1024,
  });
  function registryWith(file: unknown) {
    const workspace = mkdtempSync(join(tmpdir(), "baked-mcp-profiles-"));
    cleanups.push(() => removeTempDir(workspace));
    const agents = join(workspace, "baked", "agents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "custom.json"), JSON.stringify(file));
    return () => new ProfileRegistry(workspace, { active: "openai/x" }, join(workspace, "none"));
  }

  test("an agent profile may grant MCP tools", () => {
    const load = registryWith(
      profile("docs-reviewer", "reviewer", "review", ["read", "mcp__stub__echo", "submit_review"]),
    );
    expect(load().get("docs-reviewer").allowedTools).toContain("mcp__stub__echo");
  });

  test("a malformed grant is refused", () => {
    const load = registryWith(profile("bad", "researcher", "research", ["read", "mcp__stub"]));
    expect(load).toThrow("Unsupported tool");
  });

  test("acceptance roles run on host tools only", () => {
    const load = registryWith(
      profile("walker", "acceptance-walker", "acceptance", ["mcp__stub__*"]),
    );
    expect(load).toThrow("Unsupported tool");
  });
});

function step(call: { name: string; input: unknown }): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: call.name, input: JSON.stringify(call.input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 100, text: 100, reasoning: 0 },
    },
    warnings: [],
  };
}

/** Scripts the model; returns the tool names it was offered and the tool results it saw. */
function scriptModel(script: Array<LanguageModelV3GenerateResult | (() => never)>) {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const offered: string[][] = [];
  const seen: unknown[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      offered.push((options.tools ?? []).map((t) => t.name));
      const last = options.prompt.at(-1);
      if (last?.role === "tool") seen.push(...last.content);
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return typeof next === "function" ? next() : next;
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return { offered, seen };
}

async function attempt(options: { profileTools: string[]; policyTools: string[] }) {
  const policy: RunPolicy = {
    ...fixturePolicy,
    allowedTools: [...fixturePolicy.allowedTools, ...options.policyTools],
  };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { store } = fixture.service;
  const run = await fixture.start();
  store.transaction(() => store.transition(run.runId, "running"));
  const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
  const implementer = profiles.find((p) => p.role === "implementer");
  if (!implementer) throw new Error("implementer profile missing");
  const profile: AgentProfile = {
    ...implementer,
    model: "openai/fixture-model",
    allowedTools: [...implementer.allowedTools, ...options.profileTools],
  };
  const task: Task = {
    id: "T001", title: "Use MCP", description: "Use MCP", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
    dependsOn: [], profileId: profile.id, writes: [{ path: "value.txt", action: "create" }], readHints: [],
    checkIds: [], origin: "planned", findingIds: [], rationale: "MCP",
  };
  const stepId = store.beginStep(run.runId, "fixture");
  const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
  const leases = new WorkspaceLeases(store);
  leases.acquire("mutation", run.runId);
  cleanups.push(() => leases.release());
  cleanups.push(async () => {
    await disposeMCPManager();
    useMCPStore.setState({ servers: {} });
  });
  const executor = new NativeAgentExecutor(store, leases, {
    ...fixture.config,
    repoMap: false,
    mcpServers: [stub],
  });
  cleanups.push(() => executor.dispose());
  const request: ExecutionRequest = {
    runId: run.runId, attemptId, profile, task, prompt: "Use the MCP tool", signal: new AbortController().signal, maxSteps: 10,
  };
  return { executor, request, store, runId: run.runId, attemptId, profile, policy, task, leases };
}

describe("MCP tools in a workflow attempt", () => {
  test("a tool granted by profile and policy runs through the guard and is recorded as evidence", async () => {
    const { executor, request, store, runId, attemptId } = await attempt({
      profileTools: ["mcp__stub__echo"],
      policyTools: ["mcp__stub__*"],
    });
    const { offered, seen } = scriptModel([
      step({ name: "mcp__stub__echo", input: { text: "hello" } }),
      () => {
        throw new Error("stop after the call");
      },
    ]);
    await expect(executor.execute(request)).rejects.toThrow("stop after the call");
    expect(offered[0]).toContain("mcp__stub__echo");
    // The policy grants the whole server, the profile only `echo`.
    expect(offered[0]).not.toContain("mcp__stub__stamp");
    expect(JSON.stringify(seen)).toContain("echo: hello");
    const evidence = store.artifacts(runId).filter((a) => a.kind === "read" && a.logical_path.startsWith(`reads/${attemptId}/`));
    expect(evidence[0]?.inline_content).toContain("mcp__stub__echo");
    expect(evidence).toHaveLength(1);
  }, 30000);

  test("a tool the policy does not grant is not offered and its server is not started", async () => {
    const { executor, request } = await attempt({
      profileTools: ["mcp__stub__echo"],
      policyTools: [],
    });
    const { offered } = scriptModel([
      () => {
        throw new Error("stop");
      },
    ]);
    await expect(executor.execute(request)).rejects.toThrow("stop");
    expect(offered[0]?.some((name) => name.startsWith("mcp__"))).toBe(false);
    expect(getMCPManager().isConnected("stub")).toBe(false);
  });

  test("the guard refuses an MCP call outside the grants", async () => {
    const { store, runId, attemptId, profile, policy, task, leases } = await attempt({
      profileTools: ["mcp__stub__echo"],
      policyTools: ["mcp__stub__echo"],
    });
    const guard = new WorkflowToolPolicy(store, leases, runId, attemptId, profile, policy, task);
    expect(guard.validate("mcp__stub__echo", { path: "/outside/the/workspace" })).toBeNull();
    expect(() => guard.validate("mcp__stub__stamp", {})).toThrow("not allowed");
  });
});

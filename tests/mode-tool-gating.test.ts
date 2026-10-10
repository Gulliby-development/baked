/**
 * Mode tool gating — cache-stability + execution-time deny.
 *
 * Restricted modes (architect/plan) and plan-execution must
 * send the FULL tool schema (byte-identical across modes) so the prompt-cache
 * prefix (tools → system → messages) survives mode switches (discussion #85).
 * Restriction is enforced at execution: a disallowed tool returns a deny result
 * (error: mode_restricted) instead of running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// No repo map needed — the gate is pure logic over the tool set. Disabling it
// keeps the background AST-summary worker from spinning up on the tmp dir
// (which logs disk-I/O noise on teardown). Must be set before ContextManager.
process.env.BAKED_NO_REPOMAP = "1";

import { createForgeAgent } from "../src/core/agents/forge.js";
import { ContextManager } from "../src/core/context/manager.js";

let TMP: string;
const contexts: ContextManager[] = [];
function context(): ContextManager { const cm = new ContextManager(TMP); contexts.push(cm); return cm; }

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "mode-gate-"));
});

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((cm) => cm.dispose()));
  rmSync(TMP, { recursive: true, force: true });
});

// biome-ignore lint/suspicious/noExplicitAny: minimal model stub for agent construction
const mockModel = (id: string) => ({ modelId: id, doGenerate: async () => ({}) }) as any;

type Agent = { tools: Record<string, { execute?: (...a: unknown[]) => unknown }> };

function makeAgent(forgeMode: "default" | "architect", planExecution = false): Agent {
  return createForgeAgent({
    model: mockModel("anthropic/claude-sonnet-4-6"),
    contextManager: context(),
    forgeMode,
    planExecution,
  }) as unknown as Agent;
}

function toolNames(agent: Agent): string[] {
  return Object.keys(agent.tools).sort();
}

describe("mode tool gating", () => {
  // The first agent built in a process loads every tool module, which takes seconds on a busy CI runner.
  test("architect mode sends the SAME tool schema as default mode", () => {
    expect(toolNames(makeAgent("architect"))).toEqual(toolNames(makeAgent("default")));
  }, 30000);

  test("plan-execution sends the SAME tool schema as default mode", () => {
    expect(toolNames(makeAgent("default", true))).toEqual(toolNames(makeAgent("default")));
  });

  test("disallowed tool (edit_file) denies at execution in architect mode", async () => {
    const editTool = makeAgent("architect").tools.edit_file;
    expect(editTool?.execute).toBeDefined();
    const result = (await editTool!.execute!(
      { path: "x.ts", oldString: "a", newString: "b" },
      {},
    )) as { success: boolean; error?: string; output: string };
    expect(result.success).toBe(false);
    expect(result.error).toBe("mode_restricted");
    expect(result.output).toContain("architect");
  });

  test("allowed tool (read) is NOT deny-stubbed in architect mode", () => {
    const archRead = makeAgent("architect").tools.read;
    expect(typeof archRead?.execute).toBe("function");
  });

  test("default mode does not deny-stub edit_file (distinct execute from architect's stub)", () => {
    // The architect edit_file execute is the deny stub; the default one is the
    // real tool. They must be different function references — proves default
    // mode left edit_file untouched. Avoids running a real edit (which would hit
    // the live repo-map worker) so the assertion stays a pure structural check.
    const defaultEdit = makeAgent("default").tools.edit_file;
    const architectEdit = makeAgent("architect").tools.edit_file;
    expect(typeof defaultEdit?.execute).toBe("function");
    expect(typeof architectEdit?.execute).toBe("function");
    expect(defaultEdit?.execute).not.toBe(architectEdit?.execute);
  });
});

describe("buildModeMessage — cache-stable mode injection", () => {
  test("default mode returns null (absence of banner = default)", () => {
    const cm = context();
    cm.setForgeMode("default");
    expect(cm.buildModeMessage()).toBeNull();
  });

  test("architect mode returns banner + instructions", () => {
    const cm = context();
    cm.setForgeMode("architect");
    const msg = cm.buildModeMessage();
    expect(msg).toContain("Active mode: ARCHITECT.");
    expect(msg).toContain("ARCHITECT MODE");
  });

  test("plan mode returns banner + plan instructions", () => {
    const cm = context();
    cm.setForgeMode("plan");
    const msg = cm.buildModeMessage();
    expect(msg).toContain("Active mode: PLAN.");
    expect(msg).toContain("PLAN MODE");
  });

  test("message is byte-stable for an unchanged mode", () => {
    const cm = context();
    cm.setForgeMode("architect");
    expect(cm.buildModeMessage()).toBe(cm.buildModeMessage());
  });

  test("override wins over live state (frozen turn-mode, no mid-turn drift)", () => {
    // The deny gate enforces the mode frozen at agent build. The banner must
    // reflect that same frozen mode even if live state changed mid-turn.
    const cm = context();
    cm.setForgeMode("default"); // live state = default
    const msg = cm.buildModeMessage("architect"); // frozen = architect
    expect(msg).toContain("Active mode: ARCHITECT.");
  });

  test("override default returns null even when live state is restricted", () => {
    const cm = context();
    cm.setForgeMode("architect");
    expect(cm.buildModeMessage("default")).toBeNull();
  });
});

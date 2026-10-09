import assert from "node:assert/strict";
import { spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/config/index.js";
import type { CommandContext, CommandHandler } from "../../src/core/commands/types.js";
import { register } from "../../src/core/commands/workflow.js";
import { defaultWorkflowPolicy } from "../../src/core/workflows/defaults.js";
import { parseWorkflowArgs } from "../../src/headless/workflow-parse.js";
import { stopWorkflowSessions, workflowSession } from "../../src/hooks/useWorkflow.js";

const workspace = process.env.BAKED_WORKFLOW_FIXTURE_ROOT!;
const config = { ...DEFAULT_CONFIG, defaultModel: "none", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy } };
mkdirSync(join(workspace, ".baked"), { recursive: true });
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify(config));
const client = workflowSession(workspace);
const commands: string[][] = [];
const command = spyOn(client, "command").mockImplementation(async (argv) => {
  commands.push([...argv]);
  return {};
});
const handlers = new Map<string, CommandHandler>();
register(handlers);
const handle = handlers.get("/workflow")!;
const context = (model: string, tabId: string) => ({
  cwd: workspace,
  chat: { activeModel: model, setMessages: () => {} },
  tabMgr: { activeTabId: tabId },
}) as unknown as CommandContext;
try {
  await handle('/workflow run sdd --feature first --prompt "Explain --model"', context("fixture/first", "tab-1"));
  await handle('/workflow run sdd --feature second --prompt "Next"', context("fixture/second", "tab-2"));
  await handle('/workflow run sdd --feature explicit --prompt "Next" --model fixture/explicit', context("fixture/second", "tab-2"));
  await handle('/workflow status saved-run', context("fixture/second", "tab-2"));
  assert.equal(workflowSession(workspace), client, "Switching tabs must reuse the live worker");
  const parsed = commands.map(parseWorkflowArgs);
  assert.equal(parsed[0].flags.model, "fixture/first");
  assert.equal(parsed[0].flags.prompt, "Explain --model");
  assert.equal(parsed[1].flags.model, "fixture/second");
  assert.equal(parsed[2].flags.model, "fixture/explicit");
  assert.equal(parsed[3].flags.model, undefined);
  assert.equal(config.defaultModel, "none");
  console.log(JSON.stringify({ modelSelection: "passed", commands: commands.length, modelCalls: 0 }));
} finally {
  command.mockRestore();
  await stopWorkflowSessions();
}
process.exit(0);

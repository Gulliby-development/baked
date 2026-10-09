import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { ProfileSchema, WorkflowSchema } from "../src/core/workflows/schemas.js";

// Host storage benchmark only: no model, shell checks, global config writes or network.
const workspace = mkdtempSync(join(tmpdir(), "baked-workflow-benchmark-"));
const service = new NativeWorkflowService(workspace, {
  ...DEFAULT_CONFIG, defaultModel: "benchmark/no-provider",
  workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy },
});
try {
  const seed = await service.start({ commandId: "benchmark-seed", featureId: "benchmark", workflowId: "sdd", prompt: "Storage benchmark", ownerLabel: "benchmark", policy: defaultWorkflowPolicy });
  const row = service.store.run(seed.runId);
  const state = service.store.state(seed.runId);
  const definition = WorkflowSchema.parse(JSON.parse(row.definition_json));
  const profiles = ProfileSchema.array().parse(JSON.parse(row.profiles_json));
  const ids = [seed.runId];
  service.store.transaction(() => {
    for (let i = 1; i < 1000; i++) {
      const id = `benchmark-${i}`;
      service.store.create(id, "benchmark", definition, profiles, defaultWorkflowPolicy, state);
      ids.push(id);
    }
    for (const id of ids) for (let j = 0; j < 99; j++) service.store.emit(id, { type: "budget.updated", payload: { usedTokens: 0, reservedTokens: 0, activeMs: 0, estimatedCostUsd: null } });
  });
  const p95 = (fn: () => unknown): number => {
    const values = Array.from({ length: 100 }, () => { const before = performance.now(); fn(); return performance.now() - before; }).sort((a, b) => a - b);
    return Number((values[94] ?? 0).toFixed(3));
  };
  console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, runs: ids.length, events: ids.reduce((n, id) => n + service.store.run(id).event_seq, 0), statusP95Ms: p95(() => service.store.snapshot(seed.runId)), listP95Ms: p95(() => service.store.list(20)), replayP95Ms: p95(() => service.store.events(seed.runId)), modelCalls: 0 }, null, 2));
} finally { service.close(); rmSync(workspace, { recursive: true, force: true }); }

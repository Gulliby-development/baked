import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { WorkflowPanel } from "../src/components/workflow/WorkflowPanel.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { stopWorkflowSessions } from "../src/hooks/useWorkflow.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { useWorkflowStore } from "../src/stores/workflow.js";

// Real SQLite -> polling hook -> OpenTUI frame. No model calls or UI mocks.
const workspace = mkdtempSync(join(tmpdir(), "baked-workflow-ui-benchmark-"));
mkdirSync(join(workspace, ".baked"));
writeFileSync(join(workspace, ".baked", "config.json"), JSON.stringify({
  defaultModel: "benchmark/no-provider",
  workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy },
}));
let view: Awaited<ReturnType<typeof testRender>> | undefined;
let service: NativeWorkflowService | undefined;
try {
  service = new NativeWorkflowService(workspace, { ...DEFAULT_CONFIG, defaultModel: "benchmark/no-provider", workflows: { enabled: true, importsEnabled: false, defaultWorkflow: "sdd", policy: defaultWorkflowPolicy } });
  const run = await service.start({ commandId: "benchmark-ui", featureId: "latency", workflowId: "sdd", prompt: "Measure rendering", ownerLabel: "benchmark", policy: defaultWorkflowPolicy });
  useWorkflowStore.getState().select(run.runId);
  await act(async () => { view = await testRender(<WorkflowPanel visible workspace={workspace} onClose={() => {}} />, { width: 120, height: 40 }); });
  const renderer = view!;
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    await act(async () => { await Bun.sleep(31 + (i * 17) % 73); });
    const status = i % 2 === 0 ? "paused" : "created";
    const store = service.store;
    store.transaction(() => store.transition(run.runId, status));
    const committed = performance.now();
    let visible = false;
    while (performance.now() - committed < 2000) {
      await act(async () => { await Bun.sleep(10); });
      await act(async () => { await renderer.renderOnce(); });
      if (renderer.captureCharFrame().includes(`latency · ${status}`)) { visible = true; break; }
    }
    assert(visible, "durable status did not reach the terminal frame");
    samples.push(performance.now() - committed);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, samples: samples.length, width: 120, height: 40, eventToFrameP95Ms: Number(samples[28]!.toFixed(3)), maxMs: Number(samples[29]!.toFixed(3)), modelCalls: 0 }, null, 2));
} finally {
  if (view) await act(async () => view!.renderer.destroy());
  await stopWorkflowSessions();
  service?.close();
  // Report the isolated path if native workers retain Windows handles.
  try { rmSync(workspace, { recursive: true, force: true }); }
  catch { console.error(`Benchmark fixture cleanup pending: ${workspace}`); }
}
process.exit(0);

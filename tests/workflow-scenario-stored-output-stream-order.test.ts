import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { CheckRunner, storedSignatureOutput } from "../src/core/verification/check-runner.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import { failureHash, repeatCheck } from "../src/core/workflows/repeated-failure.js";
import type { Check, RunPolicy } from "../src/core/workflows/schemas.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor } from "../src/core/workflows/types.js";

// #2861, the sibling of #2859: a stored check artifact's `output` keeps the order its stdout and
// stderr chunks arrived in. The repeated-failure hash of an unfinished task and the corrective
// repeat chain compare the stored outputs of two runs, so the same failure whose pipes arrived the
// other way looked like a new one. The artifact now keeps the stream-ordered tail when the order
// differs, and those comparisons read it (`storedSignatureOutput`).

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Biome's diagnostic on stderr and summary on stdout: stdout first on the first run only. */
const biomeScript = (marker: string) =>
  `const fs = require('node:fs'); const first = !fs.existsSync(${JSON.stringify(marker)}); fs.writeFileSync(${JSON.stringify(marker)}, ''); const err = () => console.error('src/duration.ts format ━━━━━━━━━━\\n\\n  × Formatter would have printed the following content:'); const out = () => { console.log('Checked 2 files in 3ms. No fixes applied.'); console.log('Found 1 error.'); }; if (first) { out(); setTimeout(() => { err(); process.exit(1); }, 150); } else { err(); setTimeout(() => { out(); process.exit(1); }, 150); }`;

describe("a stored check's output compares alike whatever order its pipes arrived in (#2861)", () => {
  test("two stored runs of one failure give the same repeated-failure hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-stored-order-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "biome.json"), "{}\n");
    const markers = mkdtempSync(join(tmpdir(), "baked-stored-order-marker-"));
    cleanups.push(() => rmSync(markers, { recursive: true, force: true }));
    const check: Check = {
      id: "biome",
      executable: "bun",
      args: ["-e", biomeScript(join(markers, "ran"))],
      cwd: ".",
      timeoutMs: 10000,
      required: true,
      scope: "feature",
      envNames: [],
      writes: [],
    };
    const policy: RunPolicy = { ...defaultWorkflowPolicy, checks: [check] };
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, {} as AgentExecutor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Format", ownerLabel: "test", policy });
    const step = service.store.beginStep(run.runId, "fixture");
    const attempt = service.store.reserve(run.runId, step, null, 0, policy);
    const scope = new ProcessScope();
    cleanups.push(() => scope.stop());
    const runner = new CheckRunner(service.store, scope);
    const first = await runner.run(run.runId, attempt, check, new AbortController().signal, root);
    const second = await runner.run(run.runId, attempt, check, new AbortController().signal, root);
    expect([first.status, second.status]).toEqual(["failed", "failed"]);

    const bodies = service.store
      .artifacts(run.runId)
      .filter((row) => row.kind === "check" && row.logical_path.startsWith("checks/biome/"))
      .map((row) => JSON.parse(service.store.readArtifact(run.runId, row.id)) as { output: string; orderedTail?: string });
    expect(bodies).toHaveLength(2);
    // The stored outputs keep the arrival order, which differs between the runs.
    const [a, b] = bodies as [{ output: string; orderedTail?: string }, { output: string; orderedTail?: string }];
    expect(a.output.indexOf("Checked")).toBeLessThan(a.output.indexOf("src/duration.ts format"));
    expect(b.output.indexOf("src/duration.ts format")).toBeLessThan(b.output.indexOf("Checked"));
    const hash = (output: string) => failureHash([repeatCheck("biome", output, ["src/duration.ts"])]);
    expect(hash(a.output)).not.toBe(hash(b.output));
    // Only the run whose pipes arrived out of stream order keeps a second, ordered tail.
    expect(typeof a.orderedTail).toBe("string");
    expect(b.orderedTail).toBeUndefined();
    expect(hash(storedSignatureOutput(a))).toBe(hash(storedSignatureOutput(b)));
  });
});

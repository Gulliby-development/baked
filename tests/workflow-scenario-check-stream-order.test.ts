import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckRunner } from "../src/core/verification/check-runner.js";
import { CHECK_BASELINE_PATH, commandKey, failureSignature, shapedFailureSignature } from "../src/core/verification/output-counts.js";
import { ProcessScope } from "../src/core/workflows/process-scope.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// #2859: a check's output is built from its stdout and stderr chunks in the order they arrive,
// which two pipes do not fix. The CI merge queue ejected #2805 on the #1218 scenario when the
// Biome stand-in's stdout arrived before its stderr (1 time in 200): the baseline and the
// task-end signatures differed and a correction opened for an unchanged failure.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

/**
 * A Biome stand-in that writes its diagnostic to stderr and its summary to stdout, in the order
 * `marker` decides: stdout first on the run that finds no marker (and writes it), stderr first on
 * every later run. The pause between the two writes fixes their arrival order.
 */
const biomeScript = (marker: string) =>
  `const fs = require('node:fs'); const first = !fs.existsSync(${JSON.stringify(marker)}); fs.writeFileSync(${JSON.stringify(marker)}, ''); const n = fs.readdirSync('.').filter((f) => !f.startsWith('.')).length; const err = () => console.error('biome.json format ━━━━━━━━━━\\n\\n  × Formatter would have printed the following content:'); const out = () => { console.log(\`Checked \${n} file\${n === 1 ? '' : 's'} in 3ms. No fixes applied.\`); console.log('Found 1 error.'); }; if (first) { out(); setTimeout(() => { err(); process.exit(1); }, 150); } else { err(); setTimeout(() => { out(); process.exit(1); }, 150); }`;

const biomeCheck = (marker: string) => ({
  id: "biome",
  executable: "bun",
  args: ["-e", biomeScript(marker)],
  cwd: ".",
  timeoutMs: 10000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
});

const markerPath = () => {
  const dir = mkdtempSync(join(tmpdir(), "baked-stream-order-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "ran");
};

describe("a check's signature does not depend on the order its pipes arrived in (#2859)", () => {
  test("two runs whose stdout and stderr arrive in opposite orders sign alike", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-stream-order-root-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "biome.json"), "{}\n");
    const runner = new CheckRunner(undefined as unknown as WorkflowStore, new ProcessScope());
    const check = biomeCheck(markerPath());
    const first = await runner.measure(check, signal(), root, null);
    const second = await runner.measure(check, signal(), root, null);
    expect([first.status, second.status]).toEqual(["failed", "failed"]);
    // The recorded output keeps the arrival order, which differs.
    expect(first.output.indexOf("Checked")).toBeLessThan(first.output.indexOf("biome.json format"));
    expect(second.output.indexOf("biome.json format")).toBeLessThan(second.output.indexOf("Checked"));
    expect(failureSignature(first.output, root)).not.toBe(failureSignature(second.output, root));
    // The signatures read the streams in a fixed order.
    expect(failureSignature(first.signatureOutput, root)).toBe(failureSignature(second.signatureOutput, root));
    expect(shapedFailureSignature(first.signatureOutput, root)).toBe(shapedFailureSignature(second.signatureOutput, root));
  });

  test("the #1218 scenario opens no correction when the baseline's pipes arrived the other way", async () => {
    const biome = biomeCheck(markerPath());
    class ScriptedExecutor extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output === "implementation") {
          mkdirSync(join(fixture.root, "src"), { recursive: true });
          writeFileSync(join(fixture.root, "src", "duration.ts"), "export const ms = 1;\n");
        }
        if (request.profile.output !== "plan") return result;
        const output = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
        for (const task of output.taskGraph.tasks) task.writes.push({ path: "src/duration.ts", action: "create" });
        return result;
      }
    }
    const fixture = workflowFixture({
      policy: { ...fixturePolicy, checks: [...fixturePolicy.checks, biome] },
      executor: (root) => new ScriptedExecutor(root),
    });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "biome.json"), '{ "formatter": { "enabled": true } }');
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    await fixture.service.drive(run.runId, signal());

    const artifact = fixture.service.store.latestArtifact(run.runId, CHECK_BASELINE_PATH);
    const baseline = artifact ? JSON.parse(fixture.service.store.readArtifact(run.runId, artifact.id)) : null;
    expect(baseline?.failures[commandKey(biome)]).toContain("Checked <n> file in");
    const tasks = fixture.service.store.tasks(run.runId).map((t) => JSON.parse(t.definition_json) as { origin: string });
    expect(tasks.every((t) => t.origin === "planned")).toBe(true);
    expect((await fixture.service.get(run.runId)).status).toBe("blocked");
  });
});

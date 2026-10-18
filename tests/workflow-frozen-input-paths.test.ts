import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes } from "../src/core/specs/hash.js";
import { assertFrozenInputs } from "../src/core/workflows/context.js";
import { EffectJournal, effectFile } from "../src/core/workflows/effects.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { FixtureExecutor, fixturePolicy } from "./helpers/workflow-fixture.js";

const base = mkdtempSync(join(tmpdir(), "baked-frozen-paths-"));
const target = join(base, "workspace");
const root = join(base, "linked-workspace");
mkdirSync(target);
let symlinkDenied = false;
try {
  symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  // Windows can require Developer Mode or elevated privileges for directory symlinks.
  if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) throw error;
  symlinkDenied = true;
}
afterAll(() => removeTempDir(base));

for (const status of ["applied", "reconciled"] as const) {
  test.skipIf(symlinkDenied)(`${status} manifest effects match frozen inputs through a symlinked workspace root`, async () => {
    const inputs = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "tsconfig.json", "biome.json"];
    const initial = "{}\n";
    const changed = '{"updated":true}\n';
    for (const path of [...inputs, "AGENTS.md"]) writeFileSync(join(root, path), initial);
    const service = new NativeWorkflowService(root, { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true } }, new FixtureExecutor(root));
    try {
      const { runId } = await service.start({ commandId: newId(), featureId: status, workflowId: "sdd", prompt: "Update manifests", ownerLabel: "test", policy: fixturePolicy });
      const { store } = service;
      const state = store.state(runId);
      const assert = () => assertFrozenInputs(state, store, runId);
      const attemptId = store.beginExternalAttempt(runId, "publication").attemptId;
      service.leases.acquire("mutation", runId);
      const journal = new EffectJournal(store, service.leases);
      expect(assert).not.toThrow();
      for (const path of inputs) {
        const frozenPath = join(root, path);
        expect(state.frozenFiles[frozenPath]).toBe(hashBytes(initial));
        expect(effectFile(root, JSON.stringify({ path }))).not.toBe(frozenPath);
        const id = journal.publish(runId, attemptId, path, changed, hashBytes(initial), "file_patch");
        if (status === "reconciled") {
          store.effectStatus(runId, id, "unknown");
          expect(journal.reconcile(runId)).toEqual([]);
          expect(store.effects(runId).find((effect) => effect.id === id)?.status).toBe(status);
        }
        expect(assert).not.toThrow();
        expect(state.frozenFiles[frozenPath]).toBe(hashBytes(initial));
      }
      const manifest = join(root, "package.json");
      writeFileSync(manifest, "outside edit");
      expect(assert).toThrow("Accepted input changed");
      rmSync(manifest);
      expect(assert).toThrow("Accepted input changed");
      writeFileSync(manifest, changed);
      journal.publish(runId, attemptId, "AGENTS.md", changed, hashBytes(initial), "file_patch");
      expect(assert).toThrow("Accepted input changed");
    } finally {
      await service.shutdown();
      service.close();
    }
  });
}

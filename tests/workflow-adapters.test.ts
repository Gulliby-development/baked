import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "baked-workflow-adapter-"));
  const profile = join(root, ".baked", "test-profile");
  mkdirSync(profile, { recursive: true });
  const child = Bun.spawn([process.execPath, resolve("tests/fixtures", name)], { stdout: "pipe", stderr: "pipe", timeout: 30000, env: { ...process.env, HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile, BAKED_WORKFLOW_FIXTURE_ROOT: root } });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  rmSync(root, { recursive: true, force: true });
  if (code !== 0) throw new Error(`${name}: ${err}\n${out}`);
  expect(code).toBe(0);
  return out;
}
test("native executor edits and deletes through guarded tools and bounds output correction", async () => {
  expect(await fixture("workflow-native.ts")).toContain('"formatRetries":1');
}, 35000);
test("workflow panel renders list, form and run sections at three terminal sizes", async () => {
  expect(await fixture("workflow-ui.tsx")).toContain('"frames":51');
}, 35000);
test("workflow worker preserves command state while SQLite contention leaves the UI thread responsive", async () => {
  expect(await fixture("workflow-worker.ts")).toContain('"worker":"passed"');
}, 35000);

test("workflow slash command uses the current tab model with an already cached worker", async () => {
  expect(await fixture("workflow-model-selection.ts")).toContain('"modelSelection":"passed"');
}, 35000);

test("CLI and worker complete a feature through native provider transport with repair and independent review models", async () => {
  expect(await fixture("workflow-provider.ts")).toContain('"providerTransport":"passed"');
}, 35000);

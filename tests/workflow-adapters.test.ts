import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { withTempDir } from "./helpers/temp-dir.js";

async function fixture(name: string, timeout = 30000): Promise<string> {
  return withTempDir("baked-workflow-adapter-", async (root) => {
    const profile = join(root, ".baked", "test-profile");
    mkdirSync(profile, { recursive: true });
    const child = Bun.spawn([process.execPath, resolve("tests/fixtures", name)], { stdout: "pipe", stderr: "pipe", timeout, env: { ...process.env, HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile, BAKED_WORKFLOW_FIXTURE_ROOT: root } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`${name}: ${err}\n${out}`);
    expect(code).toBe(0);
    return out;
  });
}
test("native executor edits and deletes through guarded tools and bounds output correction", async () => {
  expect(await fixture("workflow-native.ts")).toContain('"formatRetries":1');
}, 35000);
test("workflow panel renders list, form and run sections at three terminal sizes", async () => {
  expect(await fixture("workflow-ui.tsx")).toContain('"frames":78');
}, 35000);
test("the terminal UI stops a workflow worker whose thread stopped and the next worker takes its run over (#1541)", async () => {
  expect(await fixture("workflow-worker-stall.ts")).toContain('"stall":"passed"');
}, 35000);
test("workflow worker preserves command state while SQLite contention leaves the UI thread responsive", async () => {
  expect(await fixture("workflow-worker.ts")).toContain('"worker":"passed"');
}, 35000);

test("gate runs, saves and policy updates go through the worker without touching started runs", async () => {
  // About 6 s alone; the full Windows suite has pushed it past 30 s.
  expect(await fixture("workflow-gates-worker.ts", 90000)).toContain('"gatesWorker":"passed"');
}, 95000);

test("initiative commands and new-run execution options go through the worker to the core", async () => {
  // About 6 s alone; the full Windows suite has pushed it past 30 s.
  expect(await fixture("workflow-initiatives-worker.ts", 90000)).toContain('"initiativesWorker":"passed"');
}, 95000);

test("a soft checkpoint stops a read-heavy agent loop between two steps", async () => {
  expect(await fixture("workflow-checkpoint-loop.ts")).toContain('"checkpointLoop":"passed"');
}, 60000);

test("workflow slash command uses the current tab model with an already cached worker", async () => {
  expect(await fixture("workflow-model-selection.ts")).toContain('"modelSelection":"passed"');
}, 35000);

test("CLI and worker complete a feature through native provider transport with repair and independent review models", async () => {
  // 18.7 s alone; the full Windows suite has pushed it past 60 s (#725).
  expect(await fixture("workflow-provider.ts", 120000)).toContain('"providerTransport":"passed"');
}, 125000);

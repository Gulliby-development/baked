import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { headline } from "../src/components/workflow/format.js";
import { frozenInputAdvice } from "../src/core/workflows/context.js";
import { reasonText } from "../src/core/workflows/reasons.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import { newId } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

// Broad review of rounds 39 to 50 (#1654): a person's edit to an instruction or manifest file the
// run froze blocked it with "Accepted input changed: PATH" and no stated action, and
// `resume --accept-workspace` could not clear it, because accepting touched only the workspace
// baseline and never the frozen files.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function blockedOnEdit(file: string) {
  const fixture = workflowFixture();
  cleanups.push(fixture.dispose);
  const { service, root } = fixture;
  mkdirSync(join(root, "baked"), { recursive: true });
  writeFileSync(join(root, file), "Keep functions small.\n");
  const started = await fixture.start();
  await service.drive(started.runId, new AbortController().signal);
  await fixture.approve(started.runId);
  writeFileSync(join(root, file), "Keep functions small. Prefer pure functions.\n");
  await service.drive(started.runId, new AbortController().signal);
  return { ...fixture, runId: started.runId };
}

for (const file of ["baked/constitution.md", "package.json"]) {
  test(`an edit to the frozen ${file} names its way out, and accepting it continues the run`, async () => {
    const { service, runId } = await blockedOnEdit(file);
    let run = await service.get(runId);
    expect([run.status, run.reason]).toEqual(["blocked", "input_changed"]);
    expect(reasonText("input_changed")).toContain("accept the change");
    expect(headline(run, [], false).next).toContain("Press A to keep the changes");
    const advice = stopRecovery(service.store, runId);
    expect(advice?.message).toContain(`Accepted input changed: ${join(service.store.workspace, file)}`);
    expect(advice?.message).toContain(`baked workflow resume ${runId} --accept-workspace`);
    expect(advice?.remedies.map((r) => r.action)).toEqual(["accept-workspace", "revise", "cancel"]);
    // The terminal panel lists the file before it asks to keep the changes.
    expect((await service.outsideChanges(runId)).map((c) => c.path)).toContain(file);
    await service.resume(runId, { commandId: newId(), expectedRevision: run.revision }, { acceptWorkspace: true });
    await service.drive(runId, new AbortController().signal);
    run = await service.get(runId);
    expect(run.status).toBe("completed");
    const record = service.store.artifacts(runId).find((a) => a.logical_path.startsWith("operator/accepted-workspace-"));
    const accepted = JSON.parse(service.store.readArtifact(runId, record?.id ?? "")) as { frozen?: { path: string }[] };
    expect(accepted.frozen?.map((f) => f.path)).toContain(join(service.store.workspace, file));
    if (file.endsWith(".md")) expect(service.store.state(runId).instructionText).toContain("Prefer pure functions");
  });
}

test("a frozen skill, agent, workflow or gate file points to a definition revision instead", () => {
  const advice = frozenInputAdvice("run1", "/repo/baked/skills/style/SKILL.md");
  expect(advice.message).toContain("baked workflow candidate run1 --workflow FILE");
  expect(advice.remedies.map((r) => r.action)).not.toContain("accept-workspace");
});

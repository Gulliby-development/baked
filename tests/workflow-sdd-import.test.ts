import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashJson } from "../src/core/specs/hash.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { IMPORTED_EVENT, InitiativeService } from "../src/core/workflows/initiatives/service.js";
import { InitiativeStore } from "../src/core/workflows/initiatives/store.js";
import { formatWorkflowResult } from "../src/core/commands/workflow.js";
import { describeSddImport } from "../src/core/workflows/sdd-export/describe.js";
import { type ImportedPackage, readSddPackage } from "../src/core/workflows/sdd-export/import.js";
import { buildSddPackage, SDD_EXPORT_FORMAT_VERSION, writeSddPackage } from "../src/core/workflows/sdd-export/package.js";
import { IMPORT_SEED_ARTIFACT } from "../src/core/workflows/sdd-export/seed.js";
import { newId } from "../src/core/workflows/store.js";
import { executeWorkflowCommand } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const fixtures: ReturnType<typeof workflowFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
const signal = () => new AbortController().signal;
const fixture = () => {
  const made = workflowFixture();
  fixtures.push(made);
  return made;
};

/** A run of the fixture feature, approved and driven to its end, in its own workspace. */
async function acceptedRun() {
  const source = fixture();
  const run = await source.start();
  await source.service.drive(run.runId, signal());
  await source.approve(run.runId);
  await source.service.drive(run.runId, signal());
  return { ...source, runId: run.runId };
}

const plan: InitiativePlan = {
  schemaVersion: 1,
  title: "Value and front",
  goals: ["Ship the value"],
  completionCriteria: ["Value is ready"],
  features: [
    { id: "fixture", title: "Value", boundary: { scope: "Writes the value", paths: ["value.txt"] }, contract: "value.txt holds ready", dependsOn: [], mandatory: true, size: "small" },
    { id: "front", title: "Front", boundary: { scope: "Shows the value", paths: ["front.txt"] }, contract: "Reads value.txt", dependsOn: ["fixture"], mandatory: true },
    { id: "docs", title: "Docs", boundary: { scope: "Describes the value", paths: ["docs.txt"] }, contract: "Names value.txt", dependsOn: ["front"], mandatory: true, size: "small" },
  ],
};

/** An initiative whose split is approved and whose `fixture` feature run is accepted. */
async function exportedInitiative() {
  const source = await acceptedRun();
  const initiatives = new InitiativeStore(source.service.store);
  initiatives.create({
    id: "value-init",
    title: "Value and front",
    prompt: "Make a value and show it",
    status: "active",
    settings: { workflowId: "sdd", basePolicy: fixturePolicy, budget: null, featureAutoApproval: null, model: null, ownerLabel: "test" } as never,
    decomposeRunId: null,
  });
  const revision = initiatives.addRevision("value-init", plan, { maxTotalTokens: 4000000, maxAgentCalls: 400, maxActiveMs: 6000000 }, hashJson(plan), "decomposer", null);
  initiatives.approve("value-init", revision, hashJson(plan));
  initiatives.link("value-init", "fixture", source.runId, revision, hashJson(plan.features[0]), "start");
  return { ...source, path: writeSddPackage(buildSddPackage(source.service.store, "value-init"), join(source.root, "value.zip"), true).path };
}

const importArgs = (path: string, ...more: string[]) =>
  parseWorkflowArgs(["import", "--source", "baked-export", "--path", path, ...more]);

describe("SDD package import (#2208)", () => {
  test("a run package imports as a run that starts at analysis and completes without specifying or planning again", async () => {
    const source = await acceptedRun();
    const path = writeSddPackage(buildSddPackage(source.service.store, source.runId), join(source.root, "pkg"), false).path;
    const sourceState = source.service.store.state(source.runId);

    const target = fixture();
    const imported = (await executeWorkflowCommand(target.service, importArgs(path), signal())) as ImportedPackage;
    expect(imported).toMatchObject({ kind: "run", id: "fixture", seeded: ["fixture"], unseeded: [] });
    const runId = imported.run!.runId;
    const state = target.service.store.state(runId);
    expect(state.spec).toEqual(sourceState.spec);
    expect(state.plan).toBe(sourceState.plan);
    expect(state.graph).toEqual(sourceState.graph);
    expect(state.approvalRoot).toBeNull();
    const record = target.service.store.latestArtifact(runId, IMPORT_SEED_ARTIFACT);
    expect(JSON.parse(target.service.store.readArtifact(runId, record!.id))).toMatchObject({ source: { kind: "run", id: source.runId } });
    // Nothing ran on import; the first drive analyzes and waits for a person.
    expect(target.executor.calls).toEqual([]);
    // The printed next step is the command that continues it; the terminal app shows the same line.
    const line = describeSddImport(imported);
    expect(formatWorkflowResult(imported)).toBe(line);
    const resume = line.slice(line.indexOf("baked workflow ") + "baked workflow ".length).split(" ");
    await executeWorkflowCommand(target.service, parseWorkflowArgs(resume), signal());
    expect(target.executor.calls).toEqual(["analysis"]);
    await target.approve(runId);
    await target.service.drive(runId, signal());
    expect(target.service.store.run(runId).status).toBe("completed");
    expect(target.executor.calls).not.toContain("spec");
    expect(target.executor.calls).not.toContain("plan");
    expect(readFileSync(join(target.root, "value.txt"), "utf8")).toBe("ready");
  });

  test("an initiative package imports awaiting the approval of its split; the accepted feature starts at analysis", async () => {
    const { path } = await exportedInitiative();
    const target = fixture();
    const imported = (await executeWorkflowCommand(target.service, importArgs(path, "--id", "again"), signal())) as ImportedPackage;
    expect(imported).toMatchObject({ kind: "initiative", id: "again", seeded: ["fixture"], unseeded: ["front", "docs"] });
    const initiatives = new InitiativeService(target.service);
    const view = initiatives.view("again");
    expect(view.status).toBe("awaiting_approval");
    const store = new InitiativeStore(target.service.store);
    expect(store.revision("again", 1).source).toBe("user");
    expect(store.plan(store.revision("again", 1)).features.map((f) => f.id)).toEqual(["fixture", "front", "docs"]);
    expect(Object.keys((store.eventsOfType("again", IMPORTED_EVENT)[0] as { features: object }).features)).toEqual(["fixture"]);
    expect(target.executor.calls).toEqual([]);

    const request = store.requests("again").find((r) => r.status === "pending")!;
    await initiatives.approve("again", { commandId: newId(), expectedRevision: store.get("again").revision }, { requestId: request.id, digest: request.digest });
    await initiatives.drive("again", signal());
    const runId = store.current("again", "fixture")!.run_id;
    const state = target.service.store.state(runId);
    expect(state.spec?.featureId).toBe("again_fixture");
    expect(state.graph?.featureId).toBe("again_fixture");
    expect(state.graph?.specHash).toBe(hashJson(state.spec));
    // The seeded feature analyzed its imported plan and waits for its approval; front waits for it.
    expect(target.executor.calls).toEqual(["analysis"]);
    expect(store.current("again", "front")).toBeNull();
  });

  test("a package changed after export, of another format version or not a package is refused", async () => {
    const source = await acceptedRun();
    const path = writeSddPackage(buildSddPackage(source.service.store, source.runId), join(source.root, "pkg"), false).path;
    expect(readSddPackage(path).manifest.formatVersion).toBe(SDD_EXPORT_FORMAT_VERSION);

    writeFileSync(join(path, "specs/fixture/spec.md"), "# Edited\n");
    expect(() => readSddPackage(path)).toThrow("specs/fixture/spec.md (missing or edited)");

    const manifestPath = join(path, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, formatVersion: 99 }));
    expect(() => readSddPackage(path)).toThrow("format version 99");

    writeFileSync(join(source.root, "not.zip"), "plain text");
    expect(() => readSddPackage(join(source.root, "not.zip"))).toThrow("not a readable package");
    expect(() => readSddPackage(join(source.root, "missing"))).toThrow("No package");
  });
});

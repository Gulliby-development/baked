import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { runWithCwd } from "../src/core/cwd.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { importSpecKit } from "../src/core/specs/importers/spec-kit.js";
import { specPublication } from "../src/core/specs/render.js";
import type { InitiativePlan } from "../src/core/workflows/initiatives/plan.js";
import { InitiativeStore } from "../src/core/workflows/initiatives/store.js";
import {
  buildSddPackage,
  SDD_EXPORT_FORMAT_VERSION,
  writeSddPackage,
} from "../src/core/workflows/sdd-export/package.js";
import { unzipFiles } from "../src/core/workflows/sdd-export/zip.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { executeWorkflowCommand, runWorkflowCli } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { FixtureExecutor, fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const fixtures: ReturnType<typeof workflowFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
const signal = () => new AbortController().signal;

/** A run of the fixture feature, approved and driven to its end. */
async function acceptedRun(executor?: (root: string) => FixtureExecutor) {
  const fixture = workflowFixture(executor ? { executor } : {});
  fixtures.push(fixture);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, signal());
  await fixture.approve(run.runId);
  await fixture.service.drive(run.runId, signal());
  return { ...fixture, runId: run.runId };
}

function tree(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else out.push(relative(root, path).replaceAll("\\", "/"));
    }
  };
  visit(root);
  return out.sort();
}

const SPEC_FILES = ["plan.md", "spec.json", "spec.md", "tasks.json", "tasks.md"];

describe("SDD export package (#2206)", () => {
  test("a single accepted run exports the spec-kit tree with a manifest of hashes and a one-feature graph", async () => {
    const { service, root, runId } = await acceptedRun();
    const state = service.store.state(runId);
    // Golden guard: a document `specPublication` adds must reach the package.
    expect(Object.keys(specPublication(state.spec!, state.plan!, state.graph!)).sort()).toEqual(SPEC_FILES);
    const written = writeSddPackage(buildSddPackage(service.store, runId), join(root, "out"), false);
    expect(tree(written.path)).toEqual(
      ["AGENTS.md", "graph.json", "graph.md", "manifest.json", ...SPEC_FILES.map((f) => `specs/fixture/${f}`)].sort(),
    );
    const manifest = JSON.parse(readFileSync(join(written.path, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      formatVersion: SDD_EXPORT_FORMAT_VERSION,
      kind: "run",
      id: runId,
      title: "Fixture",
      features: [{ id: "fixture", accepted: true, runId, dir: "specs/fixture", dependsOn: [] }],
    });
    expect(Object.keys(manifest.files)).not.toContain("manifest.json");
    for (const [path, hash] of Object.entries(manifest.files))
      expect(hashBytes(readFileSync(join(written.path, path), "utf8"))).toBe(hash as string);
    for (const [name, content] of Object.entries(specPublication(state.spec!, state.plan!, state.graph!)))
      expect(readFileSync(join(written.path, "specs/fixture", name), "utf8")).toBe(content);
    const graph = JSON.parse(readFileSync(join(written.path, "graph.json"), "utf8"));
    expect(graph.features).toEqual([
      expect.objectContaining({ id: "fixture", tasks: [expect.objectContaining({ id: "T001", dependsOn: [], writes: ["value.txt"] })] }),
    ]);
    expect(readFileSync(join(written.path, "graph.md"), "utf8")).toContain('f_fixture_T001["T001 Create value"]');
    const agents = readFileSync(join(written.path, "AGENTS.md"), "utf8");
    expect(agents).toContain("`specs/fixture/`");
    expect(agents).not.toContain("BAKED_");
  });

  test("an initiative exports its accepted plan, both features in dependency order and only the accepted documents", async () => {
    const { service, root, runId } = await acceptedRun();
    const initiatives = new InitiativeStore(service.store);
    const plan: InitiativePlan = {
      schemaVersion: 1,
      title: "Value and front",
      goals: ["Ship the value"],
      completionCriteria: ["Value is ready"],
      features: [
        { id: "front", title: "Front", boundary: { scope: "Shows the value", paths: ["front.txt"] }, contract: "Reads value.txt", dependsOn: ["fixture"], mandatory: true },
        { id: "fixture", title: "Value", boundary: { scope: "Writes the value", paths: ["value.txt"] }, contract: "value.txt holds ready", dependsOn: [], mandatory: true, size: "small" },
      ],
    };
    initiatives.create({
      id: "value-init",
      title: "Value and front",
      prompt: "Make a value and show it",
      status: "active",
      settings: { workflowId: "sdd", basePolicy: fixturePolicy, budget: null, featureAutoApproval: null, model: null, ownerLabel: "test" } as never,
      decomposeRunId: null,
    });
    const revision = initiatives.addRevision("value-init", plan, { maxTotalTokens: 100000, maxAgentCalls: 50, maxActiveMs: 600000 }, hashJson(plan), "decomposer", null);
    initiatives.approve("value-init", revision, hashJson(plan));
    initiatives.link("value-init", "fixture", runId, revision, hashJson(plan.features[1]), "start");

    const pkg = buildSddPackage(service.store, "value-init");
    expect(Object.keys(pkg.files).sort()).toEqual(
      ["AGENTS.md", "graph.json", "graph.md", "initiative.json", "initiative.md", "manifest.json", ...SPEC_FILES.map((f) => `specs/fixture/${f}`)].sort(),
    );
    expect(pkg.manifest).toMatchObject({ kind: "initiative", planRevision: revision, planDigest: hashJson(plan), status: "active" });
    expect(pkg.manifest.features.map((f) => [f.id, f.accepted, f.dir, f.status])).toEqual([
      ["fixture", true, "specs/fixture", "completed"],
      ["front", false, null, "not_started"],
    ]);
    expect(JSON.parse(pkg.files["initiative.json"]!).plan).toEqual(plan);
    expect(pkg.files["initiative.md"]).toContain("Make a value and show it");
    expect(pkg.files["initiative.md"]).toContain("- Depends on: fixture");
    expect(pkg.files["graph.md"]).toContain("f_fixture ==> f_front");
    expect(pkg.files["AGENTS.md"]).toContain("| front: Front | not_started | fixture | none |");

    // Zip and folder hold the same files with the same bytes.
    const folder = writeSddPackage(pkg, join(root, "pkg"), false);
    const zipped = writeSddPackage(pkg, join(root, "pkg.zip"), true);
    expect(zipped.files).toEqual(folder.files);
    const unpacked = unzipFiles(readFileSync(zipped.path), { maxFiles: 100, maxBytes: 1 << 24 });
    expect(Object.keys(unpacked).sort()).toEqual(tree(folder.path));
    for (const path of tree(folder.path)) expect(unpacked[path]).toBe(readFileSync(join(folder.path, path), "utf8"));
    // The same store gives the same archive bytes.
    expect(hashBytes(readFileSync(zipped.path))).toBe(
      hashBytes(readFileSync(writeSddPackage(buildSddPackage(service.store, "value-init"), join(root, "again.zip"), true).path)),
    );
  });

  test("an exported feature folder imports back as a spec-kit candidate", async () => {
    const { service, root, runId } = await acceptedRun();
    const written = writeSddPackage(buildSddPackage(service.store, runId), join(root, "out"), false);
    const imported = importSpecKit(join(written.path, "specs", "fixture"));
    expect(imported.spec).toEqual(service.store.state(runId).spec);
    expect(imported.graph).toEqual(service.store.state(runId).graph);
    expect(imported.warnings).toEqual([]);
  });

  test("a secret in the plan refuses the export and names the file and line, not the value", async () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    class SecretPlan extends FixtureExecutor {
      override async execute(request: ExecutionRequest) {
        const result = await super.execute(request);
        if (request.profile.output !== "plan") return result;
        const output = result.output as { markdown: string; taskGraph: { planHash: string } };
        output.markdown += `\n## Notes\ntoken ${token}`;
        output.taskGraph.planHash = hashBytes(output.markdown);
        return result;
      }
    }
    const { service, runId } = await acceptedRun((root) => new SecretPlan(root));
    let message = "";
    try {
      buildSddPackage(service.store, runId);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("specs/fixture/plan.md line");
    expect(message).toContain("GitHub token");
    expect(message).not.toContain(token);
  });

  test("a run without approval, an unknown id and an existing destination are refused", async () => {
    const fixture = workflowFixture();
    fixtures.push(fixture);
    const run = await fixture.start();
    await fixture.service.drive(run.runId, signal());
    expect(() => buildSddPackage(fixture.service.store, run.runId)).toThrow("no accepted spec");
    expect(() => buildSddPackage(fixture.service.store, "missing-run")).toThrow("Unknown run");
    expect(() => buildSddPackage(fixture.service.store, "../escape")).toThrow("Unknown run or initiative");
    mkdirSync(join(fixture.root, "taken"));
    await fixture.approve(run.runId);
    expect(() => writeSddPackage(buildSddPackage(fixture.service.store, run.runId), join(fixture.root, "taken"), false)).toThrow("already exists");
  });

  test("the workflow command writes the default folder and the CLI exits 2 for an unknown id", async () => {
    const { service, root, runId } = await acceptedRun();
    const result = (await executeWorkflowCommand(service, parseWorkflowArgs(["export-package", runId, "--zip"]), signal())) as { path: string; zip: boolean };
    expect(result.zip).toBe(true);
    expect(relative(root, result.path).replaceAll("\\", "/")).toBe(`.baked/exports/${runId}-export.zip`);
    const code = await runWithCwd(root, () => runWorkflowCli(["export-package", "no-such-id", "--json"]));
    expect(code).toBe(2);
    const refused = await runWithCwd(root, () => runWorkflowCli(["export-package", runId, "--zip", "--json"]));
    expect(refused).toBe(1);
  });
});


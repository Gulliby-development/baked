import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decidedChecks } from "../src/core/verification/host-passed.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 87 slk (Vue and TypeScript, #2641): the run published its documents
// under `specs/<feature>/` unformatted, the project's whole-tree format check (`bun run
// format:check` = `prettier --check .`) reported those five files and nothing else, no task may
// write `specs/` and the fixer runs only on a task's files, so T005 ended unfinished twice with the
// same output and the run blocked. Here a stand-in Prettier reports every Markdown or JSON file
// under `specs/` and any other file holding `UNFORMATTED`, in Prettier's own words.

const FORMATTER = `
const { readdirSync, readFileSync, statSync } = require("node:fs");
const { join, relative } = require("node:path");
const bad = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".baked" || name === ".git" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const file = relative(process.cwd(), path).replaceAll("\\\\", "/");
    const doc = /^specs\\//.test(file) && /\\.(?:md|json)$/.test(file);
    if (doc || readFileSync(path, "utf8").includes("UNFORM" + "ATTED")) bad.push(file);
  }
};
walk(process.cwd());
console.log("Checking formatting...");
if (!bad.length) { console.log("All matched files use Prettier code style!"); process.exit(0); }
for (const file of bad) console.log("[warn] " + file);
console.log("[warn] Code style issues " + (bad.length === 1 ? "in the above file" : "found in " + bad.length + " files") + ". Run Prettier with --write to fix.");
process.exit(1);
`;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

const format = {
  id: "format",
  executable: "bun",
  args: ["format-check.cjs"],
  cwd: ".",
  timeoutMs: 20000,
  required: true,
  scope: "feature" as const,
  envNames: [],
  writes: [],
  fix: { executable: "bun", args: ["-e", "process.exit(0)"] },
};

async function finished(workflowId: "sdd" | "standard" | "quick", written: string) {
  const policy: RunPolicy = { ...fixturePolicy, checks: [format, ...fixturePolicy.checks] };
  const fixture = workflowFixture({ policy });
  cleanups.push(fixture.dispose);
  const { executor, service, root } = fixture;
  writeFileSync(join(root, "format-check.cjs"), FORMATTER);
  // A quick run publishes nothing; an earlier run's documents are in the tree it checks.
  if (workflowId === "quick") {
    mkdirSync(join(root, "specs/earlier"), { recursive: true });
    for (const name of ["spec.json", "spec.md", "plan.md", "tasks.json", "tasks.md"])
      writeFileSync(join(root, "specs/earlier", name), name.endsWith(".json") ? '{"a":[1,2]}' : "# Earlier\n");
  }
  const original = executor.execute.bind(executor);
  executor.execute = async (request: ExecutionRequest) => {
    const out = await original(request);
    if (request.profile.output === "plan") {
      const plan = out.output as { taskGraph: { tasks: { checkIds: string[] }[] } };
      for (const task of plan.taskGraph.tasks) task.checkIds = [...task.checkIds, "format"];
    }
    if (request.profile.output === "implementation") writeFileSync(join(request.root ?? root, "value.txt"), written);
    return out;
  };
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId, prompt: "Create ready value", ownerLabel: "test", policy });
  let current = await service.drive(run.runId, signal());
  for (let i = 0; i < 5 && current.status === "waiting"; i++) {
    await fixture.approve(run.runId);
    current = await service.drive(run.runId, signal());
  }
  const checks = service.store.checks(run.runId).filter((c) => c.check_id === "format");
  const evidence = new Map(service.store.evidence(run.runId).map((e) => [e.id, e.artifact_id]));
  const outputs = checks.map((c) => service.store.readArtifact(run.runId, evidence.get(c.evidence_id) ?? ""));
  const decided = decidedChecks(service.store, run.runId, checks);
  const debt = service.store.artifacts(run.runId).filter((a) => a.logical_path.startsWith("checks/host-published/"));
  return { current, checks, decided, debt, outputs, root };
}

describe("scenario: R87 slk, the published specs/ documents fail the whole-tree format check (#2641)", () => {
  // sdd is a schema-1 run, standard and quick schema-2 runs; quick publishes nothing of its own.
  for (const workflowId of ["sdd", "standard", "quick"] as const)
    test(`${workflowId}: the run completes; the format check's failure on the documents is the host's`, async () => {
      const { current, checks, decided, debt, outputs, root } = await finished(workflowId, "ready");
      expect(current.status).toBe("completed");
      const document = workflowId === "quick" ? "specs/earlier/spec.json" : "specs/fixture/spec.json";
      expect(readFileSync(join(root, document), "utf8").length).toBeGreaterThan(0);
      // The check really failed on the documents, and the run decided it as the host's.
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.some((c) => c.status === "failed")).toBe(true);
      expect(decided.every((c) => c.status === "passed")).toBe(true);
      expect(debt.length).toBeGreaterThan(0);
      expect(outputs.some((o) => o.includes(`[warn] ${document}`) && o.includes("documents the host publishes"))).toBe(true);
    }, 60000);

  test("sdd: a file the task wrote unformatted still fails the check", async () => {
    const { current, decided, debt } = await finished("sdd", "UNFORMATTED");
    expect(current.status).not.toBe("completed");
    expect(decided.some((c) => c.status === "failed")).toBe(true);
    expect(debt).toEqual([]);
  }, 120000);
});

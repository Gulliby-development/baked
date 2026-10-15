import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import type { Check, RunPolicy, Spec, Task } from "../src/core/workflows/schemas.js";
import { importedFiles } from "../src/core/workflows/invalidation.js";
import { NativeWorkflowService } from "../src/core/workflows/service.js";
import { newId } from "../src/core/workflows/store.js";
import type { AgentExecutor, ExecutionRequest } from "../src/core/workflows/types.js";

// Scenario of bench round 30, md-site 337d16db (#1285). A property test task failed its test check
// on a defect in one source. Its corrective could write every file of the related planned tasks,
// nearly the whole project (8 or 9 paths), and rewrote modules the failure never reached. The
// corrective of a failed task test check now starts from the failing test files and the planned
// sources they import on its first attempt; a failed attempt still widens to the full set.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const spec: Spec = { schemaVersion: 1, featureId: "fixture", revision: 1, title: "Site", problem: "Pages are wrong", outcome: "Pages render", inScope: ["Render pages"], outOfScope: [], assumptions: [], openQuestions: [], requirements: [{ id: "FR-001", text: "Pages render", priority: "must", verification: "automated", sourceRefs: [] }], criteria: [{ id: "AC-001", requirementIds: ["FR-001"], given: "a page", when: "it is built", then: "it renders", method: "automated" }], dependencies: [] };
const markdown = "# Plan\n## Context\nTwo modules and a property test of one.\n## Decisions\nDEC-001: FR-001 in both modules.\n## Components\nsrc/render.ts, src/links.ts, src/slug.ts\n## Data\nText\n## Verification\nProperty tests\n## Risks\nNone for fixture";
const script = "const fs = require('node:fs'); if (fs.existsSync('tests/render.test.ts') && fs.readFileSync('src/slug.ts', 'utf8').includes('bug')) { console.log('(fail) tests/render.test.ts > render slugs headings'); process.exit(1) }";
const check = (id: string, scope: "task" | "feature"): Check => ({ id, executable: "bun", args: ["-e", script], cwd: ".", timeoutMs: 10000, required: true, scope, envNames: [], writes: [] });
const policy: RunPolicy = { ...defaultWorkflowPolicy, maxRepairRounds: 2, checks: [check("tests-written", "task"), check("tests", "feature")] };
const planned = (id: string, paths: string[], checkIds: string[], dependsOn: string[] = []): Task => ({ id, title: `Write ${paths.join(", ")}`, description: `Write ${paths.join(", ")}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn, profileId: "implementer", writes: paths.map((path) => ({ path, action: "create" as const })), readHints: [], checkIds, origin: "planned", findingIds: [], rationale: "Required behavior" });

class ScriptedExecutor implements AgentExecutor {
  corrections: string[][] = [];
  constructor(private root: string) {}
  private write(path: string, text: string) {
    mkdirSync(join(this.root, path, ".."), { recursive: true });
    writeFileSync(join(this.root, path), text);
  }
  async execute(request: ExecutionRequest) {
    const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string; snapshotHash: string; extra: { evidence?: { id: string }[] } };
    let output: unknown;
    switch (request.profile.output) {
      case "research": output = { schemaVersion: 1, summary: "A fixture workspace", facts: [], unknowns: [], constraints: [], suggestedScope: ["src/render.ts"] }; break;
      case "spec": output = spec; break;
      case "plan":
        output = { schemaVersion: 1, markdown, taskGraph: { schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(spec), planHash: hashBytes(markdown), tasks: [planned("T001", ["src/render.ts", "src/slug.ts", "src/links.ts"], []), planned("T002", ["tests/render.test.ts"], ["tests-written"], ["T001"])] } };
        break;
      case "analysis": output = { schemaVersion: 1, inputHash: data.inputHash, verdict: "pass", findings: [] }; break;
      case "implementation": {
        const task = request.task as Task;
        if (task.id === "T001") {
          // The test reaches slug.ts through render.ts; links.ts is a module it never imports.
          this.write("src/render.ts", 'import { slug } from "./slug";\nexport const render = (h: string) => slug(h);\n');
          this.write("src/slug.ts", "export const slug = (h: string) => h; // bug\n");
          this.write("src/links.ts", "export const links = (s: string) => s;\n");
        } else if (task.origin === "planned")
          this.write("tests/render.test.ts", 'import { render } from "../src/render";\nrender("A");\n');
        else {
          this.corrections.push(task.writes.map((w) => w.path).sort());
          this.write("src/slug.ts", "export const slug = (h: string) => h.toLowerCase();\n");
        }
        output = { schemaVersion: 1, taskId: task.id, outcome: "implemented", summary: "Done", evidenceIds: [], unresolved: [] };
        break;
      }
      case "review": case "convergence":
        output = { schemaVersion: 1, snapshotHash: data.snapshotHash, verdict: "pass", coverage: [{ criterionId: "AC-001", verdict: "pass", evidenceIds: data.extra.evidence?.map((e) => e.id) ?? [], explanation: "Checks pass" }], findings: [] };
        break;
      default: throw new Error(`Unexpected profile ${request.profile.output}`);
    }
    return { output, inputTokens: 20, outputTokens: 30 };
  }
}

describe("scenario: md-site 337d16db, corrective of a failed property test (#1285)", () => {
  test("the first attempt writes the failing test and the sources it imports, not every related file", async () => {
    const root = mkdtempSync(join(tmpdir(), "baked-mdsite-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const executor = new ScriptedExecutor(root);
    const config = { ...DEFAULT_CONFIG, defaultModel: "fixture/model", workflows: { enabled: true, importsEnabled: true, defaultWorkflow: "sdd", policy } };
    const service = new NativeWorkflowService(root, config, executor);
    cleanups.push(() => service.close());
    const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Render the pages", ownerLabel: "test", policy });
    await service.drive(run.runId, new AbortController().signal);
    const snapshot = await service.get(run.runId);
    const approval = service.store.requests(run.runId).find((r) => r.kind === "approval" && r.status === "pending");
    if (!approval) throw new Error("No approval request");
    await service.decide(run.runId, { commandId: newId(), expectedRevision: snapshot.revision }, { kind: "approve", requestId: approval.id, digest: approval.digest });
    const done = await service.drive(run.runId, new AbortController().signal);
    expect(done.status).toBe("completed");
    expect(readFileSync(join(root, "src/slug.ts"), "utf8")).toContain("toLowerCase");
    expect(executor.corrections).toEqual([["src/render.ts", "src/slug.ts", "tests/render.test.ts"]]);
  }, 60000);
});

describe("importedFiles", () => {
  test("follows imports from the files through the candidates, up to the depth", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-imports-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "tests/a.test.ts"), 'import { a } from "../src/a";\n');
    writeFileSync(join(root, "src/a.ts"), 'import { b } from "./b";\nexport const a = b;\n');
    writeFileSync(join(root, "src/b.ts"), 'import { c } from "./c";\nexport const b = c;\n');
    writeFileSync(join(root, "src/c.ts"), "export const c = 1;\n");
    writeFileSync(join(root, "src/other.ts"), "export const other = 1;\n");
    const candidates = ["src/a.ts", "src/b.ts", "src/c.ts", "src/other.ts"];
    expect(importedFiles(root, ["tests/a.test.ts"], candidates)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(importedFiles(root, ["tests/a.test.ts"], candidates, 3)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

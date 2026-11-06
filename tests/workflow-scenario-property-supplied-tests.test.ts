import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkPropertyTests } from "../src/core/workflows/quality/properties.js";
import { stopRecovery } from "../src/core/workflows/stop-detail.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 95, youngkit-update 6f23a7b6 (#2886). The brief was an exact-diff update
// whose test files it supplied verbatim; the spec author marked criteria `property`, and the host
// property gate (#637) found no property test in those files and raised a high `missing` finding
// per criterion. No correction may depart from a supplied test file, so the corrective had no
// writable test target and the run blocked `input_changed` with no remedy.

const SUPPLIED_TEST = 'import { expect, test } from "bun:test";\n\ntest("value", () => expect(1).toBe(1));\n';
const SUPPLIED_SOURCE = "export const largest = (values: number[]): number => Math.max(...values);\n";
// An exact patch, as R95's seven-file brief: every file the plan writes is supplied.
const PROMPT = `Create ready value. Apply exactly this patch.\n\nReplace the whole \`value.txt\` with:\n\n\`\`\`text\nready\n\`\`\`\n\nReplace the whole \`src/largest.ts\` with:\n\n\`\`\`ts\n${SUPPLIED_SOURCE}\`\`\`\n`;

class SuppliedExecutor extends FixtureExecutor {
  constructor(private readonly dir: string) {
    super(dir);
  }
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "spec") {
      const result = await super.execute(request);
      // The spec author marks the criterion, as R95's did for AC-001 and AC-004.
      return { ...result, output: { ...fixtureSpec, criteria: fixtureSpec.criteria.map((c) => ({ ...c, property: "numbers" })) } };
    }
    if (request.profile.output === "plan") {
      const result = await super.execute(request);
      // The covering task writes source only (R95 T001 and T002); no test file is planned.
      const plan = result.output as { taskGraph: { tasks: { writes: { path: string; action: string }[] }[] } };
      plan.taskGraph.tasks[0]?.writes.push({ path: "src/largest.ts", action: "create" });
      return result;
    }
    if (request.profile.output === "implementation") {
      mkdirSync(join(this.dir, "src"), { recursive: true });
      writeFileSync(join(this.dir, "src/largest.ts"), SUPPLIED_SOURCE);
    }
    return super.execute(request);
  }
}

describe("scenario: youngkit-update 6f23a7b6, the property gate on supplied test files (#2886)", () => {
  test("an exact patch raises no property finding, and the run completes instead of blocking", async () => {
    const fixture = workflowFixture({
      executor: (root) => {
        // A property library is available, so the gate is on (no test of the repository declines it).
        mkdirSync(join(root, "node_modules/fast-check"), { recursive: true });
        writeFileSync(join(root, "node_modules/fast-check/package.json"), '{ "name": "fast-check" }');
        return new SuppliedExecutor(root);
      },
    });
    const { service } = fixture;
    try {
      const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: PROMPT, ownerLabel: "test", policy: fixture.policy });
      await service.drive(started.runId, new AbortController().signal);
      await fixture.approve(started.runId);
      const done = await service.drive(started.runId, new AbortController().signal);
      const claims = service.store.findings(started.runId).map((f) => String(JSON.parse(f.body_json).claim));
      expect(claims.some((c) => c.startsWith("Property test missing"))).toBe(false);
      expect(service.store.run(started.runId).corrective_tasks).toBe(0);
      expect(done.status).toBe("completed");
      const kept = service.store.latestArtifact(started.runId, "quality/properties.json");
      const result = kept ? (JSON.parse(service.store.readArtifact(started.runId, kept.id)) as { criteria: { status: string; note?: string }[] }) : null;
      expect(result?.criteria.length).toBeGreaterThan(0);
      for (const criterion of result?.criteria ?? []) {
        expect(criterion.status).toBe("waived");
        expect(criterion.note).toContain("supplies every file the plan writes verbatim");
      }
    } finally {
      await fixture.dispose();
    }
  }, 60000);

  test("a property finding no approved task can write blocks with a way out, not an empty remedy list", async () => {
    // Nothing supplied: the gate holds, and the plan has no test file to put the property test in.
    const fixture = workflowFixture({
      executor: (root) => {
        mkdirSync(join(root, "node_modules/fast-check"), { recursive: true });
        writeFileSync(join(root, "node_modules/fast-check/package.json"), '{ "name": "fast-check" }');
        return new SuppliedExecutor(root);
      },
    });
    const { service } = fixture;
    try {
      const started = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value.", ownerLabel: "test", policy: fixture.policy });
      await service.drive(started.runId, new AbortController().signal);
      await fixture.approve(started.runId);
      const done = await service.drive(started.runId, new AbortController().signal);
      expect([done.status, done.reason]).toEqual(["blocked", "input_changed"]);
      const recovery = stopRecovery(service.store, started.runId);
      expect(recovery?.message).toContain("writable test");
      expect(recovery?.remedies.map((r) => r.action)).toEqual(["replan", "revise", "fork"]);
    } finally {
      await fixture.dispose();
    }
  }, 60000);

  test("supplied test files waive their criterion; a file the run writes itself still needs one", () => {
    const criteria = [{ id: "AC-001", property: "numbers" }];
    const tasks = [
      { criterionIds: ["AC-001"], writes: [{ path: "tests/value.test.ts", action: "create" }] },
      { criterionIds: ["AC-002"], writes: [{ path: "src/value.ts", action: "modify" }] },
    ];
    const read = () => SUPPLIED_TEST;
    const status = (supplied: string[]) => checkPropertyTests("on", criteria, tasks, read, { "JS/TS": true }, new Set(supplied)).criteria[0]?.status;
    expect(status([])).toBe("missing");
    expect(status(["src/value.ts"])).toBe("missing");
    expect(status(["tests/value.test.ts"])).toBe("waived");
    expect(status(["tests/value.test.ts", "src/value.ts"])).toBe("waived");
  });
});

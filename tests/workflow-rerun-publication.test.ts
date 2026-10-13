import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fixture whose planner can be switched to a revised plan, as a rerun with a new model would produce. */
function fixture() {
  const f = workflowFixture();
  cleanups.push(f.dispose);
  const base = f.executor.execute.bind(f.executor);
  const control = { revised: false };
  f.executor.execute = async (request: ExecutionRequest) => {
    const result = await base(request);
    if (control.revised && request.profile.output === "plan") {
      const output = result.output as { markdown: string; taskGraph: { planHash: string } };
      output.markdown = output.markdown.replace("None for fixture", "Revised: none for fixture");
      output.taskGraph.planHash = hashBytes(output.markdown);
    }
    return result;
  };
  return { ...f, control };
}

async function untilApproval(f: ReturnType<typeof fixture>, runId: string) {
  for (let i = 0; i < 8; i++) {
    const run = await f.service.get(runId);
    if (run.pendingRequestIds.length || run.status === "blocked" || run.status === "completed") return run;
    if (run.status === "paused" || run.status === "created") await f.resume(runId);
    await f.service.drive(runId, new AbortController().signal);
  }
  return f.service.get(runId);
}

async function cancel(f: ReturnType<typeof fixture>, runId: string) {
  const run = await f.service.get(runId);
  await f.service.cancel(runId, { commandId: newId(), expectedRevision: run.revision });
}

const planPath = (root: string) => join(root, "specs", "fixture", "plan.md");

test("a rerun replaces spec files a finished run published and nobody edited", async () => {
  const f = fixture();
  const first = await f.start();
  expect(await untilApproval(f, first.runId)).toMatchObject({ status: "waiting", reason: "approval" });
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("None for fixture");
  await cancel(f, first.runId);

  f.control.revised = true;
  const second = await f.start();
  expect(await untilApproval(f, second.runId)).toMatchObject({ status: "waiting", reason: "approval" });
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("Revised: none for fixture");
});

test("a rerun is refused at start when the user edited a published spec file", async () => {
  const f = fixture();
  const first = await f.start();
  await untilApproval(f, first.runId);
  await cancel(f, first.runId);
  writeFileSync(planPath(f.root), `${readFileSync(planPath(f.root), "utf-8")}\nMy own note\n`);

  f.control.revised = true;
  await expect(f.start()).rejects.toThrow(
    "specs/fixture/ already holds specs/fixture/plan.md, which no finished run published",
  );
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("My own note");
});

test("a rerun is refused at start while another run owns the spec files", async () => {
  const f = fixture();
  const first = await f.start();
  await untilApproval(f, first.runId);

  f.control.revised = true;
  await expect(f.start()).rejects.toThrow(`specs/fixture/ belongs to open run ${first.runId}`);
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("None for fixture");
});

test("a feature id whose specs folder already exists is refused before any model call", async () => {
  const f = fixture();
  mkdirSync(join(f.root, "specs", "fixture"), { recursive: true });
  writeFileSync(join(f.root, "specs", "fixture", "spec.json"), "{}\n");
  let calls = 0;
  const execute = f.executor.execute.bind(f.executor);
  f.executor.execute = async (request: ExecutionRequest) => {
    calls++;
    return execute(request);
  };
  await expect(f.start()).rejects.toMatchObject({
    code: "INPUT_CHANGED",
    details: { reason: "feature_id_taken", files: ["specs/fixture/spec.json"] },
  });
  expect(calls).toBe(0);
});

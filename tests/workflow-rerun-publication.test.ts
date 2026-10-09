import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import { newId } from "../src/core/workflows/store.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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

test("a rerun still stops when the user edited a published spec file", async () => {
  const f = fixture();
  const first = await f.start();
  await untilApproval(f, first.runId);
  await cancel(f, first.runId);
  writeFileSync(planPath(f.root), `${readFileSync(planPath(f.root), "utf-8")}\nMy own note\n`);

  f.control.revised = true;
  const second = await f.start();
  expect(await untilApproval(f, second.runId)).toMatchObject({ status: "blocked", reason: "input_changed" });
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("My own note");
  const diagnostics = f.service.store
    .artifacts(second.runId)
    .filter((a) => a.kind === "diagnostic")
    .map((a) => f.service.store.readArtifact(second.runId, a.id));
  expect(diagnostics.join("\n")).toContain("File changed before publication: specs/fixture/plan.md");
});

test("a rerun does not take spec files from a run that is still open", async () => {
  const f = fixture();
  const first = await f.start();
  await untilApproval(f, first.runId);

  f.control.revised = true;
  const second = await f.start();
  const blocked = await untilApproval(f, second.runId);
  expect(blocked).toMatchObject({ status: "blocked", reason: "input_changed" });
  const diagnostics = f.service.store
    .artifacts(second.runId)
    .filter((a) => a.kind === "diagnostic")
    .map((a) => f.service.store.readArtifact(second.runId, a.id));
  expect(diagnostics.join("\n")).toContain(`belongs to open run ${first.runId}`);
  expect(readFileSync(planPath(f.root), "utf-8")).toContain("None for fixture");
});

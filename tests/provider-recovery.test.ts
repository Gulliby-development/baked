import { expect, test } from "bun:test";
import { ProviderUnreachableError } from "../src/core/llm/provider-health.js";
import { recordProviderOutcome } from "../src/core/workflows/retry.js";
import { WorkflowStore } from "../src/core/workflows/store.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

test("empty-provider counters survive a reopened store and isolate stages, profiles, tasks and models", async () => {
  const fixture = workflowFixture();
  try {
    const run = await fixture.start();
    const fail = (store: WorkflowStore, stage = "specify", profile = "specifier", task?: string, model = "fixture/model", tokens: number | null = 0, error: unknown = new ProviderUnreachableError(model)) => {
      const step = store.beginStep(run.runId, stage);
      const attempt = store.reserve(run.runId, step, model, 1, fixture.policy);
      store.finishAttempt(run.runId, attempt, error === undefined ? "completed" : "failed", tokens, false, error);
      return recordProviderOutcome(store, run.runId, attempt, profile, task, error).failures;
    };
    expect(fail(fixture.service.store)).toBe(1);
    expect(fail(fixture.service.store)).toBe(2);
    const reopened = new WorkflowStore(fixture.root);
    try {
      expect(fail(reopened)).toBe(3);
      expect(fail(reopened, "plan")).toBe(1);
      expect(fail(reopened, "specify", "other-profile")).toBe(1);
      expect(fail(reopened, "specify", "specifier", "T001")).toBe(1);
      expect(fail(reopened, "specify", "specifier", undefined, "fixture/other")).toBe(1);
      expect(fail(reopened)).toBe(4);
      expect(fail(reopened, "specify", "specifier", undefined, "fixture/model", 10)).toBe(0);
      expect(fail(reopened)).toBe(1);
      expect(fail(reopened, "specify", "specifier", undefined, "fixture/model", null)).toBe(0);
      expect(fail(reopened)).toBe(1);
      expect(fail(reopened, "specify", "specifier", undefined, "fixture/model", 0, new Error("Invalid output"))).toBe(0);
      expect(fail(reopened)).toBe(1);
      const step = reopened.beginStep(run.runId, "specify");
      const attempt = reopened.reserve(run.runId, step, "fixture/model", 1, fixture.policy);
      reopened.finishAttempt(run.runId, attempt, "completed", 0);
      expect(recordProviderOutcome(reopened, run.runId, attempt, "specifier", undefined).failures).toBe(0);
      expect(fail(reopened)).toBe(1);
    } finally { reopened.close(); }
  } finally { await fixture.dispose(); }
});

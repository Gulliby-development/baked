import { afterEach, describe, expect, test } from "bun:test";
import { restrictsRequest } from "../src/core/workflows/analysis-notes.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// cfgtrace a657dc4d, bench round 24: the two blocking scope findings of the third analysis.
const LIMIT = "The spec applies a 1 MiB and 8-segment limit to schemas; the request gives none";
const EXCLUSION =
  "The assumptions exclude inputs outside 'stated test domains', which drops required rejection cases the request states: E101 over 1,048,576 bytes, E107 over 8 levels, at most 64 layers";

describe("a scope finding whose dropped cases come from the spec's own exclusion (#1159)", () => {
  const base = { id: "F-002", kind: "scope", blocking: true };
  test("is a restriction the request settles; a clause the spec leaves out still asks", () => {
    expect(restrictsRequest({ ...base, description: LIMIT })).toBe(true);
    expect(restrictsRequest({ ...base, description: EXCLUSION })).toBe(true);
    expect(restrictsRequest({ ...base, description: "FR-003 limits inputs to UTF-8 and thereby omits the Latin-1 files the request names" })).toBe(true);
    expect(restrictsRequest({ ...base, description: "The spec omits the --json flag the request asks for" })).toBe(false);
    expect(restrictsRequest({ ...base, description: "The spec excludes nothing but drops the E107 rejection the request states" })).toBe(false);
  });

  test("is settled under assume without asking a person", async () => {
    const fixture = workflowFixture({ policy: { ...fixturePolicy, clarification: "assume" } });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      if (request.profile.output === "analysis") {
        const data = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { inputHash: string };
        // The findings survive every return, as in the run.
        return {
          output: {
            schemaVersion: 1,
            inputHash: data.inputHash,
            verdict: "needs_revision",
            findings: [
              { id: "F-001", kind: "scope", refs: ["spec.json"], description: LIMIT, blocking: true },
              { id: "F-002", kind: "scope", refs: ["spec.json"], description: EXCLUSION, blocking: true },
            ],
          },
          inputTokens: 25,
          outputTokens: 25,
        };
      }
      return original(request);
    };
    const run = await fixture.start();
    const snapshot = await service.drive(run.runId, new AbortController().signal);
    expect(snapshot).toMatchObject({ status: "waiting", reason: "approval" });
    expect(service.store.requests(run.runId).filter((r) => r.kind === "clarification")).toEqual([]);
    expect(service.store.latestArtifact(run.runId, "assumptions/analysis.json")).not.toBeNull();
  });
});

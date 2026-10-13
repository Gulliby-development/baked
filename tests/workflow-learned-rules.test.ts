import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { hashBytes } from "../src/core/specs/hash.js";
import {
  editProjectMemory,
  LEARNED_RULES_ARTIFACT,
  projectMemoryView,
  ruleApplies,
  ruleScope,
  rulesFor,
} from "../src/core/workflows/project-memory.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { newId } from "../src/core/workflows/store.js";
import { formatProjectMemory } from "../src/headless/workflow.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;
type Extra = { learnedRules?: { rules: { text: string; scope: string }[] }; task?: unknown };
const extraOf = (prompt: string): Extra =>
  (JSON.parse(prompt.split("\n").at(-1) ?? "{}") as { extra: Extra }).extra;

function fixture(policy: RunPolicy = fixturePolicy) {
  const fx = workflowFixture({ policy });
  cleanups.push(() => fx.dispose());
  return fx;
}

async function completed(fx: ReturnType<typeof fixture>, policy: RunPolicy = fixturePolicy) {
  // The fixture task creates value.txt; a later run in the same workspace needs it gone.
  rmSync(join(fx.root, "value.txt"), { force: true });
  const run = await fx.service.start({
    commandId: newId(),
    featureId: "fixture",
    workflowId: "sdd",
    prompt: "Create ready value",
    ownerLabel: "test",
    policy,
  });
  await fx.service.drive(run.runId, signal());
  await fx.approve(run.runId);
  const done = await fx.service.drive(run.runId, signal());
  expect(done.status).toBe("completed");
  return run.runId;
}

/** Records a review finding in a finished run, as a review round would. */
function finding(
  fx: ReturnType<typeof fixture>,
  runId: string,
  fields: Record<string, unknown>,
  status?: "refuted",
) {
  const body = {
    id: "F1",
    kind: "correctness",
    severity: "high",
    requirementIds: ["FR-001"],
    criterionIds: ["AC-001"],
    file: "src/api/locale.ts",
    symbol: null,
    evidenceIds: ["E1"],
    claim: "Unknown locales crash the formatter",
    impact: "A 500 for a bad request",
    suggestedFix: "Validate the locale argument before formatting",
    ...fields,
  };
  fx.service.store.transaction(() => {
    const id = fx.service.store.addFinding(runId, body, hashBytes(newId()), "artifact");
    if (status) fx.service.store.findingStatus(runId, id, status);
  });
}

describe("rule scope", () => {
  test("is the finding's directory and below, or every path", () => {
    expect(ruleScope("src/api/locale.ts")).toBe("src/api/**");
    expect(ruleScope("value.txt")).toBe("**");
    expect(ruleScope(null)).toBe("**");
    expect(ruleApplies("src/api/**", "src/api/v1/routes.ts")).toBe(true);
    expect(ruleApplies("src/api/**", "src/apix/routes.ts")).toBe(false);
    expect(ruleApplies("**", "anything.md")).toBe(true);
    const rules = [{ id: "r-1", text: "Validate input", scope: "src/api/**" }];
    expect(rulesFor(rules, ["docs/readme.md"])).toBeNull();
    expect(rulesFor(rules, ["src/api/a.ts"])?.rules).toEqual([{ text: "Validate input", scope: "src/api/**" }]);
    expect(rulesFor(rules, null)?.rules).toHaveLength(1);
  });
});

describe("learned rules", () => {
  test("a finding repeated in two runs is proposed, accepted by a person and given to the implementer", async () => {
    const fx = fixture();
    const first = await completed(fx);
    const second = await completed(fx);
    finding(fx, first, {});
    finding(fx, second, { claim: "Locale is not checked", suggestedFix: "Validate the locale argument and return 400" });
    // A refuted finding and a failed check do not count.
    finding(fx, first, { id: "F9", kind: "security" }, "refuted");
    finding(fx, second, { id: "F7", kind: "security" });
    finding(fx, second, { id: "F8", kind: "missing", file: "value.txt", claim: "Required check check failed" });

    let view = projectMemoryView(fx.service.store, fixturePolicy);
    const rule = view.entries.find((e) => e.kind === "rule");
    expect(rule).toMatchObject({
      status: "proposed",
      scope: "src/api/**",
      runs: 2,
      text: "Validate the locale argument and return 400",
      sent: false,
    });
    expect(rule?.findings).toHaveLength(2);
    expect(view.entries.filter((e) => e.kind === "rule")).toHaveLength(1);
    expect(formatProjectMemory(view)).toContain("[not sent: proposed; accept it to activate]");

    editProjectMemory(fx.service.store, { action: "accept", id: rule?.id ?? "" });
    view = projectMemoryView(fx.service.store, fixturePolicy);
    expect(view.entries.find((e) => e.kind === "rule")).toMatchObject({ status: "active", sent: true });
    expect(view.rendered).toContain("Validate the locale argument and return 400 (applies to src/api/**)");

    // A rule scoped to every path reaches the fixture task, which writes value.txt.
    const scoped = view.entries.find((e) => e.kind === "rule");
    editProjectMemory(fx.service.store, { action: "edit", id: scoped?.id ?? "", text: "Keep values trimmed" });
    finding(fx, first, { id: "F3", file: "value.txt", suggestedFix: "Write the value without a newline" });
    finding(fx, second, { id: "F4", file: "value.txt", suggestedFix: "Write the value without a newline" });
    const root = projectMemoryView(fx.service.store, fixturePolicy).entries.find((e) => e.scope === "**");
    editProjectMemory(fx.service.store, { action: "accept", id: root?.id ?? "" });

    const before = fx.executor.prompts.implementation?.length ?? 0;
    const third = await completed(fx);
    expect(fx.service.store.latestArtifact(third, LEARNED_RULES_ARTIFACT)).not.toBeNull();
    const prompt = fx.executor.prompts.implementation?.[before] ?? "";
    expect(extraOf(prompt).learnedRules?.rules).toEqual([{ text: "Write the value without a newline", scope: "**" }]);
    const review = fx.executor.prompts.review?.at(-1) ?? "";
    expect(extraOf(review).learnedRules?.rules.map((r) => r.scope).sort()).toEqual(["**", "src/api/**"]);
  }, 120000);

  test("forgetting retires a rule, and learnedRules: false keeps rules out of new runs", async () => {
    const off: RunPolicy = { ...fixturePolicy, learnedRules: false };
    const fx = fixture(off);
    const first = await completed(fx, off);
    const second = await completed(fx, off);
    finding(fx, first, { file: "value.txt" });
    finding(fx, second, { file: "value.txt" });
    const id = projectMemoryView(fx.service.store, off).entries.find((e) => e.kind === "rule")?.id ?? "";
    editProjectMemory(fx.service.store, { action: "accept", id });
    expect(projectMemoryView(fx.service.store, off).entries.find((e) => e.id === id)?.sent).toBe(false);
    const third = await completed(fx, off);
    expect(fx.service.store.latestArtifact(third, LEARNED_RULES_ARTIFACT)).toBeNull();
    editProjectMemory(fx.service.store, { action: "forget", id });
    expect(projectMemoryView(fx.service.store, off).hidden.map((e) => e.id)).toContain(id);
    expect(() => editProjectMemory(fx.service.store, { action: "accept", id: "a-0000000000" })).toThrow();
  }, 120000);
});

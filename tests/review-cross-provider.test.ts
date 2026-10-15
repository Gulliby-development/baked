import { afterEach, describe, expect, test } from "bun:test";
import { modelVendor } from "../src/core/llm/model-vendor.js";
import { findingBlocks } from "../src/core/verification/findings.js";
import { applyRoutingChange } from "../src/core/workflows/routing-edit.js";
import { explainRoute, independentReviewMode } from "../src/core/workflows/routing.js";
import type { Review } from "../src/core/workflows/schemas.js";
import { prepareStart } from "../src/core/workflows/start.js";
import { workflowFixture } from "./helpers/workflow-fixture.js";

const fixtures: ReturnType<typeof workflowFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function routed(modelRouting: Record<string, unknown> | undefined, defaultModel = "codex/gpt-5.5") {
  const fixture = workflowFixture();
  fixtures.push(fixture);
  return { fixture, config: { ...fixture.config, defaultModel, ...(modelRouting ? { modelRouting } : {}) } };
}

const finding = (fields: Partial<Review["findings"][number]>): Review["findings"][number] => ({
  id: "F1",
  kind: "correctness",
  severity: "high",
  requirementIds: ["FR-001"],
  criterionIds: ["AC-001"],
  file: null,
  symbol: null,
  evidenceIds: ["E1"],
  claim: "The parser rejects empty input",
  impact: "A user cannot submit",
  suggestedFix: "Accept it",
  ...fields,
});

describe("model vendors", () => {
  test("providers of one family share a vendor; multi-family providers use the model name", () => {
    expect(modelVendor("claude-code/opus")).toBe("anthropic");
    expect(modelVendor("anthropic/claude-opus-4-8")).toBe("anthropic");
    expect(modelVendor("codex/gpt-5.5")).toBe("openai");
    expect(modelVendor("openai/gpt-5.4-mini")).toBe("openai");
    expect(modelVendor("copilot/claude-sonnet-4.6")).toBe("anthropic");
    expect(modelVendor("github-models/openai/gpt-5")).toBe("openai");
    expect(modelVendor("ollama/qwen3")).toBe("ollama:qwen3");
  });
});

describe("independent review mode", () => {
  test("defaults to provider only when the configuration names two known vendors", () => {
    expect(independentReviewMode(routed(undefined).config)).toBe("off");
    expect(independentReviewMode(routed({ classes: { fast: "codex/gpt-5.4" } }).config)).toBe("warn");
    expect(independentReviewMode(routed({ classes: { review: "claude-code/opus" } }).config)).toBe("provider");
    expect(
      independentReviewMode(routed({ classes: { review: "claude-code/opus" }, independentReview: "warn" }).config),
    ).toBe("warn");
  });
});

describe("cross-provider review", () => {
  test("provider moves same-vendor reviewers to a model of another vendor", () => {
    const { fixture, config } = routed({ independentReview: "provider" });
    const explained = explainRoute(fixture.root, config, {
      workflowId: "sdd",
      availableModels: ["codex/gpt-5.4", "claude-code/opus"],
    });
    expect(explained.profiles.reviewer).toMatchObject({ model: "claude-code/opus", source: "independentReview: provider" });
    expect(explained.profiles["spec-auditor"]?.model).toBe("claude-code/opus");
    expect(explained.profiles.implementer?.model).toBe("codex/gpt-5.5");
    expect(explained.warnings.some((w) => w.startsWith("Cross-provider review: profile reviewer"))).toBe(true);
  });

  test("a configured model of another vendor wins over available providers", () => {
    const { fixture, config } = routed({ independentReview: "provider", classes: { spare: "anthropic/claude-opus-4-8" } });
    const explained = explainRoute(fixture.root, config, { workflowId: "sdd", availableModels: ["claude-code/opus"] });
    expect(explained.profiles.reviewer?.model).toBe("anthropic/claude-opus-4-8");
  });

  test("an already cross-provider review is left as it is", () => {
    const { fixture, config } = routed({ classes: { review: "claude-code/sonnet" } });
    const explained = explainRoute(fixture.root, config, { workflowId: "sdd", availableModels: ["claude-code/opus"] });
    expect(explained.profiles.reviewer).toMatchObject({ model: "claude-code/sonnet", source: "modelRouting.classes.review" });
    expect(explained.warnings).toEqual([]);
  });

  test("with one provider a start warns instead of refusing, and freezes the confidence threshold", async () => {
    const { fixture, config } = routed({ independentReview: "provider", reviewMinConfidence: 0.7 });
    const prepared = await prepareStart(
      fixture.root,
      config,
      { workflowId: "sdd", policy: fixture.policy },
      { availableModels: async () => [] },
    );
    expect(prepared.routing.profiles.reviewer?.model).toBe("codex/gpt-5.5");
    expect(prepared.routing.warnings?.some((w) => w.includes("no model of another vendor"))).toBe(true);
    expect(prepared.policy.reviewMinConfidence).toBe(0.7);
  });

  test("a start without a threshold keeps the policy unchanged", async () => {
    const { fixture, config } = routed(undefined);
    const prepared = await prepareStart(fixture.root, config, { workflowId: "sdd", policy: fixture.policy });
    expect("reviewMinConfidence" in prepared.policy).toBe(false);
    expect("codeWebSearch" in prepared.policy).toBe(false);
  });

  test("a start freezes code web search into the policy only when a layer turns it on (#1239)", async () => {
    const on = routed({ codeWebSearch: true });
    expect((await prepareStart(on.fixture.root, on.config, { workflowId: "sdd", policy: on.fixture.policy })).policy.codeWebSearch).toBe(true);
    const off = routed({ codeWebSearch: false });
    expect("codeWebSearch" in (await prepareStart(off.fixture.root, off.config, { workflowId: "sdd", policy: off.fixture.policy })).policy).toBe(false);
  });
});

describe("review confidence", () => {
  test("a finding below the threshold is a note; a finding without a confidence counts as sure", () => {
    expect(findingBlocks(finding({ confidence: 0.5 }))).toBe(false);
    expect(findingBlocks(finding({ confidence: 0.8 }))).toBe(true);
    expect(findingBlocks(finding({}))).toBe(true);
    expect(findingBlocks(finding({ confidence: 0.5 }), 0.4)).toBe(true);
    expect(findingBlocks(finding({ confidence: 0.5, kind: "security", severity: "critical" }))).toBe(false);
  });

  test("the routing editor sets and clears the threshold and refuses values outside 0 to 1", () => {
    const set = applyRoutingChange({ global: undefined, project: undefined }, "project", { reviewMinConfidence: 0.6 });
    expect(set).toEqual({ routing: { reviewMinConfidence: 0.6 }, problems: [] });
    const cleared = applyRoutingChange({ global: undefined, project: set.routing }, "project", { reviewMinConfidence: null });
    expect(cleared.routing).toBeUndefined();
    const refused = applyRoutingChange({ global: undefined, project: undefined }, "project", { reviewMinConfidence: 2 });
    expect(refused.problems).toEqual(["reviewMinConfidence must be between 0 and 1"]);
  });
});

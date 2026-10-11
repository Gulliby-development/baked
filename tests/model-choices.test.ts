import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config/index.js";
import { type ModelCatalog, modelChoiceGroups } from "../src/core/llm/model-choices.js";
import { formatWorkflowModels, workflowModels } from "../src/headless/workflow-models.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";

const catalog: ModelCatalog = {
  providers: [
    { id: "off", name: "Off", configured: false, models: [] },
    {
      id: "alpha",
      name: "Alpha",
      configured: true,
      models: [
        { id: "alpha/big", name: "Big", contextWindow: 1_000_000 },
        { id: "alpha/small", name: "Small", contextWindow: 200_000 },
      ],
    },
    { id: "broken", name: "Broken", configured: true, models: [], error: "API error: 401" },
  ],
};

test("model choices: classes first, usable providers next, providers without models last", () => {
  const groups = modelChoiceGroups(catalog, {
    classes: ["active", "fast"],
    classDetails: { active: "alpha/big" },
  });
  expect(groups.map((g) => [g.id, g.available, g.note])).toEqual([
    ["classes", true, undefined],
    ["alpha", true, undefined],
    ["off", false, "no key or login"],
    ["broken", false, "API error: 401"],
  ]);
  expect(groups[0]?.choices).toEqual([
    { id: "$active", label: "$active", detail: "alpha/big" },
    { id: "$fast", label: "$fast" },
  ]);
  expect(groups[1]?.choices.map((c) => [c.id, c.detail])).toEqual([
    ["alpha/big", "1M"],
    ["alpha/small", "200k"],
  ]);
});

test("model choices: a query keeps matching models and the providers it names", () => {
  expect(modelChoiceGroups(catalog, { classes: ["active"], query: "SMALL" })).toEqual([
    {
      id: "alpha",
      title: "Alpha",
      available: true,
      choices: [{ id: "alpha/small", label: "Small", detail: "200k" }],
    },
  ]);
  expect(modelChoiceGroups(catalog, { query: "off" }).map((g) => g.id)).toEqual(["off"]);
  expect(modelChoiceGroups(catalog, { query: "nothing" })).toEqual([]);
});

test("baked workflow models lists model names with what they resolve to, then each provider", () => {
  expect(parseWorkflowArgs(["models", "--provider", "alpha", "--json"]).flags).toEqual({
    provider: "alpha",
    json: true,
  });
  expect(() => parseWorkflowArgs(["models", "extra"])).toThrow(/positional/);
  const config = {
    ...DEFAULT_CONFIG,
    modelRouting: { classes: { deep: "alpha/big" } },
  };
  const view = workflowModels(config, catalog, "alpha/small");
  expect(view.classes.map((c) => [c.ref, c.model])).toEqual([
    ["$active", "alpha/small"],
    ["$fast", "alpha/small"],
    ["$coding", "alpha/small"],
    ["$review", "alpha/small"],
    ["$deep", "alpha/big"],
  ]);
  const text = formatWorkflowModels(view);
  expect(text).toContain("$deep    alpha/big");
  expect(text).toContain("Alpha (alpha)\n  alpha/big    Big  1M\n  alpha/small  Small  200k");
  expect(text).toContain("Off (off): no key or login");
  expect(formatWorkflowModels(workflowModels(config, catalog, null))).toContain(
    "$active  needs a run model (--model ID)",
  );
});

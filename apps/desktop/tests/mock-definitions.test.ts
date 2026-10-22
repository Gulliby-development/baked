import { describe, expect, test } from "bun:test";
import type { MockRequest } from "../src/renderer/client/mock-response.ts";
import { MOCK_ROUTES } from "../src/renderer/client/mock-routes.ts";
import type { DefinitionSummary } from "../src/renderer/client/start.ts";

async function definitions(key: string): Promise<DefinitionSummary[]> {
  const request: MockRequest = {
    key,
    method: "GET",
    path: "/v1/workflow/definitions",
    query: new URLSearchParams(),
    body: undefined,
  };
  for (const route of MOCK_ROUTES) {
    const answer = await route(request);
    if (answer) return answer.body as DefinitionSummary[];
  }
  throw new Error(`no mock route answered for ${key}`);
}

describe("mock workflow definitions", () => {
  // The New run form reads `problems` and `execution`; a partial answer left it blank (#268).
  test.each(["baked", "docs", "site", "client"])("%s answers full summaries", async (key) => {
    const found = await definitions(key);
    expect(found.length).toBeGreaterThan(0);
    for (const definition of found) {
      expect(Array.isArray(definition.problems)).toBe(true);
      expect(definition.stages.length).toBeGreaterThan(0);
      expect(definition.source).toBeDefined();
    }
  });
});

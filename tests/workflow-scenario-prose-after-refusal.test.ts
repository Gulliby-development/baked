import { describe, test } from "bun:test";
import { proseAfterRefusalScenario, refusalKinds } from "./helpers/prose-after-refusal-scenario.js";

describe("scenario: prose after a refused submit_result (#1615, R48 md-site T011)", () => {
  test.each(refusalKinds)("%s returns its refusal to the same worker with repair tools", async (kind) => {
    await proseAfterRefusalScenario(kind);
  }, 60000);

  test("an empty format correction continues the task on its earlier edits", async () => {
    await proseAfterRefusalScenario("taskEndCheck", true);
  }, 60000);
});

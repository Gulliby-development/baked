import { describe, test } from "bun:test";
import { directoryFixers, directoryFixerScenario } from "./helpers/directory-fixer-scenario.js";

describe("scenario: directory-wide apply_fix journals sibling task files (#1593)", () => {
  for (const fixer of directoryFixers.slice(0, 3))
    test(`${fixer.name}: editing after a fixer and a plain resume preserve all task files`, async () => {
      await directoryFixerScenario(fixer);
    }, 60000);

  test("the unsafe tier also journals every sibling before the next edit and resume", async () => {
    await directoryFixerScenario(directoryFixers[0], true);
  }, 60000);
});

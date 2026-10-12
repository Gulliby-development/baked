import { describe, expect, test } from "bun:test";
import type { GateDraft } from "../src/renderer/client/setup.js";
import {
  draftLines,
  firstOpenPlace,
  GATE_KINDS,
  kindInfo,
} from "../src/renderer/screens/setup/gate-setup-model.js";

const walk: GateDraft = {
  gate: {
    id: "cli-walk",
    type: "ai-acceptance",
    description: "The CLI handles bad input.",
    required: false,
    acceptance: {
      scenario: { title: "t", steps: ["Start it.", "Type nonsense."], expectations: ["A clear error."] },
      start: { executable: "bun", args: ["cli.ts"], cwd: "." },
      commands: [{ executable: "bun", args: ["cli.ts", "--help"] }],
    },
  },
  script: null,
  summary: "s",
  capabilities: ["Starts bun cli.ts in . and drives its terminal"],
  problems: [],
  path: "baked/gates/cli-walk.json",
};

describe("gate setup", () => {
  test("offers the four kinds in plain words; only two need a model", () => {
    expect(GATE_KINDS.map((k) => k.title)).toEqual([
      "Run a command",
      "AI check of the running app",
      "AI review",
      "Ask a person",
    ]);
    expect(GATE_KINDS.filter((k) => k.usesModel).map((k) => k.kind)).toEqual(["command", "ai-acceptance"]);
    expect(kindInfo("human")?.title).toBe("Ask a person");
  });

  test("a draft reads as labelled lines, not JSON", () => {
    expect(draftLines(walk)).toEqual([
      { label: "What it checks", lines: ["The CLI handles bad input."] },
      { label: "Steps", lines: ["1. Start it.", "2. Type nonsense."] },
      { label: "Expectations", lines: ["E1. A clear error."] },
      { label: "Program", lines: ["bun cli.ts", "then bun cli.ts --help"] },
      { label: "It may", lines: ["Starts bun cli.ts in . and drives its terminal"] },
    ]);
  });

  test("the place step starts on the first place the gate can go", () => {
    expect(
      firstOpenPlace({
        workflowId: "sdd",
        copyTo: "sdd-custom",
        places: [
          { key: "stage:checks", label: "a", bound: false, disabled: "command gates only" },
          { key: "transition:x", label: "b", bound: true, disabled: null },
          { key: "transition:y", label: "c", bound: false, disabled: null },
        ],
      }),
    ).toBe("transition:y");
    expect(firstOpenPlace(null)).toBeNull();
  });
});

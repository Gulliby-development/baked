import { describe, expect, test } from "bun:test";
import {
  parseWorkflowArgs,
  validateWorkflowArgs,
  workflowFlagTables,
} from "../src/headless/workflow-parse.js";

describe("workflow argv parser", () => {
  test.each([
    ["run", ["--feature", "x", "--prompt", "hi"]],
    ["quick", ["--feature", "x", "--prompt-file", "p.md"]],
    ["doctor", ["--workflow", "sdd"]],
    ["estimate", ["--workflow", "sdd"]],
  ])("%s accepts --model with --model-strict", (command, rest) => {
    const args = validateWorkflowArgs(
      parseWorkflowArgs([command, ...rest, "--model", "claude-code/sonnet", "--model-strict"]),
    );
    expect(args.flags["model-strict"]).toBe(true);
    expect(args.flags.model).toBe("claude-code/sonnet");
  });

  test("a duplicate --model-strict is still rejected", () => {
    expect(() =>
      parseWorkflowArgs(["run", "--model-strict", "--model", "m", "--model-strict"]),
    ).toThrow("Unknown or duplicate option --model-strict");
  });

  test("every flag a command accepts is known to the global flag set", () => {
    const { flags, booleanFlags, commandFlags } = workflowFlagTables;
    const missing: string[] = [];
    for (const name of booleanFlags) if (!flags.has(name)) missing.push(`boolean:${name}`);
    for (const [command, names] of Object.entries(commandFlags))
      for (const name of names) if (!flags.has(name)) missing.push(`${command}:${name}`);
    expect(missing).toEqual([]);
  });
});

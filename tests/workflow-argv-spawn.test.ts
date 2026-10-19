import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workflowFlagTables } from "../src/headless/workflow-parse.js";

/**
 * Starts the real CLI with every option a command accepts. A flag that the parser tables miss
 * passes unit tests and fails only at the first real start (#375), so this goes through
 * `boot.tsx`. Each command is given a value that a later validation refuses, or an unknown run,
 * so nothing starts.
 */
const boot = join(import.meta.dir, "..", "src", "boot.tsx");
const home = mkdtempSync(join(tmpdir(), "baked-argv-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const values: Record<string, string> = {
  budget: "huge",
  writers: "0",
  route: "plan=fixture/model",
  feature: "argv",
  prompt: "argv check",
  issue: "1",
  clarification: "assume",
  "rows-as-data": "on",
};
const commands: [string, string[]][] = [
  ["run", []],
  ["quick", []],
  ["doctor", []],
  ["estimate", []],
  ...["deliver", "approve", "repair", "extend", "reroute", "revise", "recover", "undo", "resume"].map(
    (command): [string, string[]] => [command, ["no-such-run"]],
  ),
];

function argv(command: string): string[] {
  const { booleanFlags, commandFlags } = workflowFlagTables;
  const names = commandFlags[command as keyof typeof commandFlags];
  return names.flatMap((name) =>
    booleanFlags.has(name) ? [`--${name}`] : [`--${name}`, values[name] ?? "1"],
  );
}

describe("workflow argv through the CLI", () => {
  test.each(commands)("%s accepts every option it lists", (command, positional) => {
    const env = { ...process.env, HOME: home, USERPROFILE: home, BAKED_NO_SYSTEM_NOTIFICATIONS: "1" };
    for (const key of Object.keys(env))
      if (/^(ANTHROPIC|OPENAI|GITHUB_TOKEN|GH_TOKEN)/.test(key)) delete env[key];
    const result = Bun.spawnSync(
      [process.execPath, boot, "workflow", command, ...positional, ...argv(command)],
      { cwd: home, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output).not.toContain("Unknown or duplicate option");
    expect(output).toContain('"code"');
  }, 40_000);
});

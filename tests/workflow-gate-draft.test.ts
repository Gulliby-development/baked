import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { PolicySchema } from "../src/core/workflows/schemas.js";
import { GateSchema, validateGate } from "../src/core/workflows/v2/definition.js";
import { type DraftModel, draftGate, saveGateDraft } from "../src/core/workflows/v2/gate-draft.js";
import { loadGateLibrary, unconfirmedGates } from "../src/core/workflows/v2/library.js";
import { executeGateCommand } from "../src/headless/workflow-gate.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import { DEFAULT_CONFIG } from "../src/config/index.js";

const policy = PolicySchema.parse(defaultWorkflowPolicy);
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-gate-draft-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { start: "bun cli.ts" } }));
  writeFileSync(join(root, "cli.ts"), "console.log(56);\n");
  return root;
}

/** A model that answers with a fixed reply and keeps the prompts it was given. */
function fake(reply: unknown): DraftModel & { prompts: { system: string; user: string }[] } {
  const prompts: { system: string; user: string }[] = [];
  const model = async (prompt: { system: string; user: string }) => {
    prompts.push(prompt);
    return `Here is the gate:\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``;
  };
  return Object.assign(model, { prompts });
}

const commandReply = {
  kind: "command",
  id: "prints-56",
  description: "The CLI prints 56.",
  script: {
    path: "tests/gates/prints-56.ts",
    content:
      'const out = await new Response(Bun.spawn(["bun", "cli.ts"]).stdout).text();\nif (out.trim() !== "56") { console.log(`expected 56, got ${out}`); process.exit(1); }\n',
  },
};

const walkReply = {
  kind: "ai-acceptance",
  id: "friendly-cli",
  description: "The CLI answers questions politely.",
  acceptance: {
    title: "Asking the CLI",
    steps: ["Start the CLI.", "Run the help command."],
    expectations: ["The help text is clear."],
    start: { executable: "bun", args: ["cli.ts"], readyLog: "ready" },
    commands: [{ executable: "bun", args: ["cli.ts", "--help"] }],
  },
};

describe("gates drafted from a sentence", () => {
  test("an exact check becomes a required command gate that runs its test script with bun", async () => {
    const root = workspace();
    const model = fake(commandReply);
    const draft = await draftGate(root, { text: "the CLI prints 56" }, model);
    expect(model.prompts[0]?.user).toContain("the CLI prints 56");
    expect(model.prompts[0]?.user).toContain('"start":"bun cli.ts"');
    expect(draft.problems).toEqual([]);
    expect(draft.gate).toMatchObject({
      id: "prints-56",
      type: "command",
      required: true,
      command: { executable: "bun", args: ["tests/gates/prints-56.ts"], cwd: "." },
    });
    expect(draft.capabilities[0]).toContain("without a shell");
    expect(draft.path).toBe("baked/gates/prints-56.json");
    // Nothing is written until the draft is saved.
    expect(existsSync(join(root, "baked"))).toBe(false);
    expect(existsSync(join(root, "tests/gates/prints-56.ts"))).toBe(false);

    const saved = saveGateDraft(root, draft, () => loadGateLibrary(root, policy));
    expect(saved).toEqual({ id: "prints-56", path: "baked/gates/prints-56.json", script: "tests/gates/prints-56.ts" });
    const gate = GateSchema.parse(JSON.parse(readFileSync(join(root, saved.path), "utf8")));
    expect(validateGate(gate)).toEqual([]);
    expect(readFileSync(join(root, "tests/gates/prints-56.ts"), "utf8")).toContain("expected 56");
    // The person read the draft, so saving confirms it.
    expect(unconfirmedGates(root, loadGateLibrary(root, policy), ["prints-56"])).toEqual([]);
    // A second save of the same ID overwrites nothing.
    expect(() => saveGateDraft(root, draft, () => loadGateLibrary(root, policy))).toThrow("already exists");
  });

  test("a judged check becomes an advisory terminal walk-through with commands and no grants beyond the app", async () => {
    const root = workspace();
    const draft = await draftGate(root, { text: "the help is friendly" }, fake(walkReply));
    expect(draft.problems).toEqual([]);
    if (draft.gate.type !== "ai-acceptance") throw new Error("not a walk-through");
    expect(draft.gate.required).toBe(false);
    expect(draft.gate.acceptance).toMatchObject({
      driver: "terminal",
      start: { executable: "bun", args: ["cli.ts"], cwd: ".", readyWhen: { logIncludes: "ready" } },
      commands: [{ executable: "bun", args: ["cli.ts", "--help"] }],
      capabilities: { spawnApp: true, listenPorts: [], outboundHosts: [], writePaths: [] },
      promote: { commandGateId: "friendly-cli-test", testPath: "tests/acceptance/friendly-cli.ts", framework: "cli-script" },
    });
    expect(draft.capabilities).toContain("Runs command 1: bun cli.ts --help");
    expect(draft.summary).toContain("then bun cli.ts --help");
  });

  test("shells, unsafe script paths, taken IDs and the wrong kind are refused", async () => {
    const root = workspace();
    const shell = await draftGate(
      root,
      { text: "x" },
      fake({ ...commandReply, script: undefined, command: { executable: "bash", args: ["-c", "bun cli.ts | grep 56"] } }),
    );
    expect(shell.problems).toContain("bash: a gate runs programs directly, not through a shell");
    const outside = await draftGate(root, { text: "x" }, fake({ ...commandReply, script: { path: "src/x.ts", content: "1" } }));
    expect(outside.problems).toContain("src/x.ts: the test script goes under tests/gates/");
    mkdirSync(join(root, "baked", "gates"), { recursive: true });
    writeFileSync(join(root, "baked", "gates", "prints-56.json"), "{}");
    const taken = await draftGate(root, { text: "x" }, fake(commandReply));
    expect(taken.problems).toContain("baked/gates/prints-56.json already exists; choose another ID");
    expect(() => saveGateDraft(root, taken, () => loadGateLibrary(root, policy))).toThrow("already exists");
    await expect(draftGate(root, { text: "x", kind: "ai-acceptance" }, fake(commandReply))).rejects.toThrow(
      "instead of ai-acceptance",
    );
    await expect(draftGate(root, { text: "  " }, fake(commandReply))).rejects.toThrow("Describe the check");
    await expect(draftGate(root, { text: "x" }, async () => "no json here")).rejects.toThrow("did not return");
  });

  test("the requested ID wins over the model's", async () => {
    const root = workspace();
    const draft = await draftGate(root, { text: "x", id: "answer-check" }, fake(commandReply));
    expect(draft.gate.id).toBe("answer-check");
  });
});

describe("baked workflow gate", () => {
  test("new prints the draft, --save writes it, list and show describe it", async () => {
    const root = workspace();
    const run = (argv: string[]) =>
      executeGateCommand(parseWorkflowArgs(["gate", ...argv]), root, DEFAULT_CONFIG, policy, fake(commandReply));
    const printed = await run(["new", "the", "CLI", "prints", "56"]);
    expect(printed.exitCode).toBe(0);
    expect(printed.text).toContain("Draft gate prints-56 (command, required)");
    expect(printed.text).toContain("--save");
    expect(existsSync(join(root, "baked/gates/prints-56.json"))).toBe(false);

    const draftFile = join(root, "draft.json");
    writeFileSync(draftFile, JSON.stringify(printed.result));
    const fromFile = await run(["save", "--file", "draft.json"]);
    expect(fromFile.result).toEqual({ saved: { id: "prints-56", path: "baked/gates/prints-56.json", script: "tests/gates/prints-56.ts" } });

    const list = await run(["list"]);
    expect(list.text).toContain("prints-56  command  required  project");
    const show = await run(["show", "prints-56"]);
    expect(show.result).toMatchObject({ id: "prints-56", confirmed: true });
    await expect(run(["show", "missing"])).rejects.toThrow("No gate missing");

    const again = await run(["new", "--text", "the CLI prints 56", "--save"]);
    expect(again.exitCode).toBe(1);
    expect(again.text).toContain("Cannot be saved");
  });
});

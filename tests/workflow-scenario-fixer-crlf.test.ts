import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureEndings,
  detectNewFileLineEnding,
  restoreEndings,
} from "../src/core/tools/line-endings.js";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getProvider } from "../src/core/llm/providers/index.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import { WorkspaceLeases } from "../src/core/workflows/leases.js";
import { type AgentProfile, ProfileSchema, type RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest, Task } from "../src/core/workflows/types.js";
import { MockLanguageModelV3 } from "./helpers/workflow-model.js";
import { removeTempDir } from "./helpers/temp-dir.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";

// namesound (R70, Ruby on Windows, #2214). The repository is `* text=auto eol=lf`. `rubocop -a`
// writes a file it corrects with CRLF (Ruby opens it in text mode), and edit_file gave every new
// file of that directory the CRLF of its siblings. Cops that match a line's end are blind on CRLF,
// so the checks passed on the working tree while the committed LF tree failed: the commands
// feature was accepted with 3 offenses and the docs feature blocked on them.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const signal = () => new AbortController().signal;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => removeTempDir(dir));
  return dir;
}

const git = (cwd: string, ...args: string[]) => {
  const proc = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
  return proc.stdout;
};

function repo(attributes?: string): string {
  const root = tempDir("baked-eol-");
  git(root, "init", "-q");
  git(root, "config", "core.autocrlf", "false");
  if (attributes) writeFileSync(join(root, ".gitattributes"), attributes);
  return root;
}

// The fixer of a lint check that writes like Ruby on Windows: it corrects `bad` and writes CRLF.
const CRLF_FIXER = {
  executable: "bun",
  args: [
    "-e",
    "const f = process.argv.at(-1); const t = await Bun.file(f).text(); await Bun.write(f, t.replace('bad', 'good').replace(/\\r?\\n/g, '\\r\\n'))",
  ],
};

const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [
    {
      id: "lint",
      executable: "bun",
      args: ["-e", "if ((await Bun.file('value.txt').text()).includes('bad')) process.exit(1)"],
      cwd: ".",
      timeoutMs: 60000,
      required: true,
      scope: "task",
      envNames: [],
      writes: [],
      fix: CRLF_FIXER,
    },
    ...fixturePolicy.checks,
  ],
};

describe("scenario: namesound, a fixer that writes CRLF into a LF repository (#2214)", () => {
  test("the host fixer pass keeps the file's LF ending", async () => {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    const { service, executor, root } = fixture;
    const original = executor.execute.bind(executor);
    executor.execute = async (request: ExecutionRequest) => {
      const out = await original(request);
      if (request.profile.output === "plan") {
        const plan = out.output as { taskGraph: { tasks: Record<string, unknown>[] } };
        (plan.taskGraph.tasks[0] as Record<string, unknown>).checkIds = ["lint"];
      }
      if (request.profile.output === "implementation")
        writeFileSync(join(root, "value.txt"), "bad\nnext line\n");
      return out;
    };
    const run = await fixture.start();
    await service.drive(run.runId, signal());
    await fixture.approve(run.runId);
    for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
      await fixture.resume(run.runId);
      await service.drive(run.runId, signal());
    }
    const fixes = service.store
      .effects(run.runId)
      .filter((e) => e.kind === "file_patch" && JSON.parse(e.intent_json).tool === "apply_fix");
    expect(fixes.map((e) => JSON.parse(e.intent_json).path)).toContain("value.txt");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("good\nnext line\n");
  }, 60_000);

  test("the apply_fix tool keeps the file's LF ending", async () => {
    const fixture = workflowFixture({ policy });
    cleanups.push(fixture.dispose);
    writeFileSync(join(fixture.root, "value.txt"), "bad\nnext line\n");
    const { store } = fixture.service;
    const run = await fixture.start();
    store.transaction(() => store.transition(run.runId, "running"));
    const profiles = ProfileSchema.array().parse(JSON.parse(store.run(run.runId).profiles_json));
    const implementer = profiles.find((p) => p.role === "implementer");
    if (!implementer) throw new Error("implementer profile missing");
    const profile: AgentProfile = { ...implementer, model: "openai/fixture-model" };
    const task: Task = {
      id: "T007", title: "Commands", description: "Commands", requirementIds: ["FR-001"], criterionIds: ["AC-001"],
      dependsOn: [], profileId: profile.id, writes: [{ path: "value.txt", action: "modify" }], readHints: [],
      checkIds: ["lint"], origin: "planned", findingIds: [], rationale: "Lint",
    };
    const provider = getProvider("openai");
    if (!provider) throw new Error("openai provider missing");
    const original = provider.createModel;
    let calls = 0;
    const call: LanguageModelV3GenerateResult = {
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "apply_fix", input: JSON.stringify({ checkId: "lint" }) }],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage: {
        inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
      warnings: [],
    };
    provider.createModel = () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          if (calls++ === 0) return call;
          throw new Error("stop after the fix");
        },
      }) as LanguageModelV3;
    cleanups.push(() => {
      provider.createModel = original;
    });
    const stepId = store.beginStep(run.runId, "fixture");
    const attemptId = store.reserve(run.runId, stepId, profile.model, 2000, policy);
    const leases = new WorkspaceLeases(store);
    leases.acquire("mutation", run.runId);
    cleanups.push(() => leases.release());
    const executor = new NativeAgentExecutor(store, leases, { ...fixture.config, repoMap: false });
    cleanups.push(() => executor.dispose());
    await expect(
      executor.execute({ runId: run.runId, attemptId, profile, task, prompt: "Fix lint", signal: signal(), maxSteps: 10 }),
    ).rejects.toThrow("stop after the fix");
    expect(readFileSync(join(fixture.root, "value.txt"), "utf8")).toBe("good\nnext line\n");
  }, 60_000);

  test("a new file beside a CRLF sibling takes the repository's eol=lf, not the sibling's", () => {
    const root = repo("* text=auto eol=lf\n");
    mkdirSync(join(root, "spec", "cmd"), { recursive: true });
    // commands_spec.rb after the fixer: CRLF in the working tree, not yet committed.
    writeFileSync(join(root, "spec", "cmd", "commands_spec.rb"), "a\r\nb\r\n");
    writeFileSync(join(root, "spec", "cmd", "helper_spec.rb"), "c\r\nd\r\n");
    expect(detectNewFileLineEnding(join(root, "spec", "cmd"), join(root, "spec", "cmd", "cli_spec.rb"))).toBe("lf");
  });
});

describe("the new-file ending rule, branch by branch (#2214)", () => {
  test("an eol attribute wins over everything", () => {
    const root = repo("*.bat text eol=crlf\n");
    writeFileSync(join(root, ".editorconfig"), "root = true\n[*]\nend_of_line = lf\n");
    writeFileSync(join(root, "a.txt"), "x\n");
    expect(detectNewFileLineEnding(root, join(root, "run.bat"))).toBe("crlf");
  });

  test("without an attribute, the index ending of the tracked siblings", () => {
    const root = repo();
    writeFileSync(join(root, "a.rb"), "x\ny\n");
    writeFileSync(join(root, "b.rb"), "x\ny\n");
    git(root, "add", "a.rb", "b.rb");
    // The working copies turned CRLF after they were staged.
    writeFileSync(join(root, "a.rb"), "x\r\ny\r\n");
    writeFileSync(join(root, "b.rb"), "x\r\ny\r\n");
    expect(detectNewFileLineEnding(root, join(root, "c.rb"))).toBe("lf");
  });

  test("with core.autocrlf true the index is not the working ending, so the siblings decide", () => {
    const root = repo();
    git(root, "config", "core.autocrlf", "true");
    writeFileSync(join(root, "a.rb"), "x\r\ny\r\n");
    git(root, "add", "a.rb");
    expect(detectNewFileLineEnding(root, join(root, "c.rb"))).toBe("crlf");
  });

  test("without git, .editorconfig and then the siblings, as before", () => {
    const dir = tempDir("baked-eol-plain-");
    writeFileSync(join(dir, "a.txt"), "x\r\ny\r\n");
    expect(detectNewFileLineEnding(dir, join(dir, "b.txt"))).toBe("crlf");
    writeFileSync(join(dir, ".editorconfig"), "root = true\n[*]\nend_of_line = lf\n");
    expect(detectNewFileLineEnding(dir, join(dir, "b.txt"))).toBe("lf");
  });
});

describe("restoreEndings (#2214)", () => {
  test("puts LF back on a LF file a fixer wrote CRLF, and leaves a fixer's LF alone", () => {
    const dir = tempDir("baked-eol-restore-");
    const lf = join(dir, "lf.rb");
    const crlf = join(dir, "crlf.go");
    const mixed = join(dir, "mixed.txt");
    writeFileSync(lf, "a\nb\n");
    writeFileSync(crlf, "a\r\nb\r\n");
    writeFileSync(mixed, "a\r\nb\n");
    const before = captureEndings([lf, crlf, mixed, join(dir, "absent.rb")]);
    writeFileSync(lf, "A\r\nb\r\n");
    writeFileSync(crlf, "A\nb\n");
    writeFileSync(mixed, "A\r\nb\r\n");
    expect(restoreEndings(before)).toEqual([lf]);
    expect(readFileSync(lf, "utf8")).toBe("A\nb\n");
    expect(readFileSync(crlf, "utf8")).toBe("A\nb\n");
    expect(readFileSync(mixed, "utf8")).toBe("A\r\nb\r\n");
  });
});

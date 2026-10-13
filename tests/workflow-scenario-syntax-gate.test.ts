import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModelV3, LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { syntaxErrors } from "../src/core/intelligence/syntax-check.js";
import { getProvider } from "../src/core/llm/providers/index.js";
import { hashBytes, hashJson } from "../src/core/specs/hash.js";
import { NativeAgentExecutor } from "../src/core/workflows/agent-executor.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// Scenario of bench round 16, mdrefs d2b6bfb4 (#977). T004 wrote src/md/scan.rs with test string
// literals rustc cannot tokenize ("unknown start of token") and finished: whole-crate checks do not
// run per task, so the file was first parsed during defect routing after another task and became
// corrective tasks T014 and T015. The syntax gate refuses the submission in the attempt that broke it.

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const scan = "src/md/scan.rs";
// Curly quotes around a string literal, as a model writes them in prose.
const broken = [
  "pub fn scan(text: &str) -> Vec<&str> {",
  '    text.lines().filter(|l| l.contains("](")).collect()',
  "}",
  "",
  "#[cfg(test)]",
  "mod tests {",
  "    use super::*;",
  "",
  "    #[test]",
  "    fn finds_links() {",
  "        let doc = “see [a](b.md)”;",
  "        assert_eq!(scan(doc).len(), 1);",
  "    }",
  "}",
  "",
].join("\n");
const badLine = "        let doc = “see [a](b.md)”;";
const goodLine = '        let doc = "see [a](b.md)";';

const policy: RunPolicy = {
  ...fixturePolicy,
  checks: [{ ...fixturePolicy.checks[0]!, id: "check", args: ["-e", `if (!(await Bun.file(${JSON.stringify(scan)}).text()).includes("fn scan")) process.exit(1)`] }],
};
const usage = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 100, text: 100, reasoning: 0 },
};
const call = (name: string, input: unknown): LanguageModelV3GenerateResult => ({
  content: [{ type: "tool-call", toolCallId: crypto.randomUUID(), toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls", raw: undefined },
  usage,
  warnings: [],
});

/** Route `openai/*` to a scripted model; returns the tool results it was sent, in order. */
function scriptModel(script: (() => LanguageModelV3GenerateResult)[]): string[] {
  const provider = getProvider("openai");
  if (!provider) throw new Error("openai provider missing");
  const original = provider.createModel;
  const results: string[] = [];
  let index = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const last = options.prompt.at(-1);
      if (last?.role === "tool") results.push(JSON.stringify(last.content));
      const next = script[index++];
      if (!next) throw new Error("script exhausted");
      return next();
    },
  });
  provider.createModel = () => model as LanguageModelV3;
  cleanups.push(() => {
    provider.createModel = original;
  });
  return results;
}

/** Plans one Rust task that creates scan.rs and runs its implementer through the real executor. */
class RustTaskExecutor extends FixtureExecutor {
  native: NativeAgentExecutor | null = null;
  action: "create" | "modify" = "create";
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "plan") {
      const markdown = "# Plan\n## Context\nScan links.\n## Decisions\nDEC-001: FR-001 adds the scanner.\n## Components\nsrc/md\n## Data\nText\n## Verification\nCheck the scanner\n## Risks\nNone for fixture";
      const output = {
        schemaVersion: 1,
        markdown,
        taskGraph: {
          schemaVersion: 1, featureId: "fixture", revision: 1, specHash: hashJson(fixtureSpec), planHash: hashBytes(markdown),
          tasks: [{ id: "T004", title: "Add the link scanner", description: `Write ${scan}`, requirementIds: ["FR-001"], criterionIds: ["AC-001"], dependsOn: [], profileId: "implementer", writes: [{ path: scan, action: this.action }], readHints: [], checkIds: [], origin: "planned", findingIds: [], rationale: "Required behavior" }],
        },
      };
      return { output, inputTokens: 25, outputTokens: 25 };
    }
    if (request.profile.output !== "implementation") return super.execute(request);
    if (!this.native) throw new Error("native executor missing");
    return this.native.execute({ ...request, profile: { ...request.profile, model: "openai/fixture-model" } });
  }
}

async function runScenario(script: (() => LanguageModelV3GenerateResult)[], existing?: string) {
  const fixture = workflowFixture({ policy, executor: (root) => new RustTaskExecutor(root) });
  cleanups.push(fixture.dispose);
  if (existing !== undefined) {
    mkdirSync(join(fixture.root, "src/md"), { recursive: true });
    writeFileSync(join(fixture.root, scan), existing);
    fixture.executor.action = "modify";
  }
  const native = new NativeAgentExecutor(fixture.service.store, fixture.service.leases, { ...fixture.config, repoMap: false });
  cleanups.push(() => native.dispose());
  fixture.executor.native = native;
  const results = scriptModel(script);
  const run = await fixture.start();
  await fixture.service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const outcome = await fixture.service.drive(run.runId, new AbortController().signal);
  return { fixture, outcome, results, runId: run.runId };
}

const submit = () =>
  call("submit_result", { schemaVersion: 1, taskId: "T004", outcome: "implemented", summary: `Wrote ${scan}`, evidenceIds: [], unresolved: [] });

describe("scenario: mdrefs d2b6bfb4, a task that writes a Rust file that does not parse (#977)", () => {
  test("submit_result is refused with file and line; the fixed file is accepted", async () => {
    const { fixture, outcome, results } = await runScenario([
      () => call("edit_file", { path: scan, oldString: "", newString: broken }),
      submit,
      () => call("edit_file", { path: scan, oldString: badLine, newString: goodLine }),
      submit,
    ]);
    // The edit itself already reports the error.
    expect(results[0]).toContain(`${scan}:11:`);
    expect(results[1]).toContain(`Syntax error: ${scan}:11:`);
    expect(results[1]).toContain('"accepted":false');
    expect(results[2]).not.toContain("Syntax check");
    expect(outcome.status).toBe("completed");
    const content = readFileSync(join(fixture.root, scan), "utf8");
    expect(content).toContain(goodLine);
    expect(await syntaxErrors(scan, content)).toEqual([]);
  }, 60000);

  test("the same errors submitted again are accepted and recorded, not refused forever", async () => {
    const { fixture, outcome, results, runId } = await runScenario([
      () => call("edit_file", { path: scan, oldString: "", newString: broken }),
      submit,
      submit,
    ]);
    expect(results[1]).toContain(`Syntax error: ${scan}:11:`);
    expect(outcome.status).not.toBe("running");
    expect(results).toHaveLength(2);
    const recorded = fixture.service.store
      .artifacts(runId)
      .filter((a) => a.logical_path.includes("/syntax-"))
      .map((a) => JSON.parse(fixture.service.store.readArtifact(runId, a.id)) as { accepted: boolean });
    expect(recorded.map((r) => r.accepted)).toEqual([false, true]);
  }, 60000);

  test("errors the file had before the attempt do not refuse it", async () => {
    // Valid Rust (a generic associated type) that the grammar predates.
    const existing = "pub trait Lines {\n    type Iter<'a>: Iterator<Item = &'a str> where Self: 'a;\n}\n";
    expect((await syntaxErrors(scan, existing)).length).toBeGreaterThan(0);
    const { outcome, results } = await runScenario(
      [() => call("edit_file", { path: scan, oldString: "pub trait Lines {", newString: "pub fn scan() -> usize {\n    0\n}\n\npub trait Lines {" }), submit],
      existing,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).not.toContain("Syntax check");
    expect(outcome.status).toBe("completed");
  }, 60000);
});

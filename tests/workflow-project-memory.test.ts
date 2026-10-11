import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { newId } from "../src/core/workflows/store.js";
import {
  answeredQuestion,
  collectProjectMemory,
  editProjectMemory,
  PROJECT_MEMORY_ARTIFACT,
  projectMemoryView,
  renderProjectMemory,
} from "../src/core/workflows/project-memory.js";
import { executeWorkflowCommand, formatProjectMemory } from "../src/headless/workflow.js";
import { parseWorkflowArgs } from "../src/headless/workflow-parse.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import type { RunPolicy } from "../src/core/workflows/schemas.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => new AbortController().signal;
type Extra = { projectMemory?: string };
const extraOf = (prompt: string): Extra => (JSON.parse(prompt.split("\n").at(-1) ?? "{}") as { extra: Extra }).extra;

const QUESTION = "Which output format should the value use?";
const ASSUMPTION = "What does an empty value show? Assumed: an empty file, because nothing was written.";

/** The first research asks one question; every spec carries one recorded assumption. */
class AskingExecutor extends FixtureExecutor {
  asked = false;
  override async execute(request: ExecutionRequest) {
    if (request.profile.output === "research" && !this.asked) {
      this.asked = true;
      (this.prompts.research ??= []).push(request.prompt);
      return { output: { schemaVersion: 1, summary: "Fixture", facts: [], unknowns: [{ question: QUESTION, blocking: true }], constraints: [], suggestedScope: ["value.txt"] }, inputTokens: 10, outputTokens: 10 };
    }
    if (request.profile.output === "spec") {
      await super.execute(request);
      return { output: { ...fixtureSpec, assumptions: [ASSUMPTION] }, inputTokens: 10, outputTokens: 10 };
    }
    return super.execute(request);
  }
}

async function completeRun(fixture: ReturnType<typeof workflowFixture>, policy: RunPolicy, answer?: string) {
  const { service } = fixture;
  const run = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy });
  let snapshot = await service.drive(run.runId, signal());
  if (snapshot.reason === "clarification") {
    const request = service.store.requests(run.runId).find((r) => r.kind === "clarification" && r.status === "pending");
    if (!request || !answer) throw new Error("Unexpected clarification");
    const current = await service.get(run.runId);
    // The terminal app's key: the question ID and its text.
    await service.decide(run.runId, { commandId: newId(), expectedRevision: current.revision }, { kind: "answer", requestId: request.id, answers: { [`Q1: ${QUESTION}`]: answer } });
    snapshot = await service.drive(run.runId, signal());
  }
  expect(snapshot.reason).toBe("approval");
  await fixture.approve(run.runId);
  for (let i = 0; i < 4 && (await service.get(run.runId)).status !== "completed"; i++) {
    await fixture.resume(run.runId);
    await service.drive(run.runId, signal());
  }
  expect((await service.get(run.runId)).status).toBe("completed");
  return run.runId;
}

describe("answer keys", () => {
  const questions = [{ id: "Q-1", question: "First?" }, { question: "Second?" }];
  test("resolve to the question by ID, position or the terminal app's ID-and-text key", () => {
    expect(answeredQuestion("Q-1", questions)).toBe("First?");
    expect(answeredQuestion("Q2", questions)).toBe("Second?");
    expect(answeredQuestion("Q-1: First? (cut)", questions)).toBe("First?");
    expect(answeredQuestion("F9: Some finding text", questions)).toBe("Some finding text");
    expect(answeredQuestion("A free-form key", questions)).toBe("A free-form key");
  });
});

describe("rendering", () => {
  test("is empty without anything learned and leaves out the new run's own checks", () => {
    expect(renderProjectMemory({ answers: [], assumptions: [], checks: [] }, fixturePolicy)).toBeNull();
    const own = ["bun", ...(fixturePolicy.checks[0]?.args ?? [])].join(" ");
    expect(renderProjectMemory({ answers: [], assumptions: [], checks: [{ command: own, runs: 2 }] }, fixturePolicy)).toBeNull();
    const text = renderProjectMemory({ answers: [{ question: "Q?", answer: "A.", runId: "abcdef123456" }], assumptions: [], checks: [{ command: "bun test", runs: 2 }] }, fixturePolicy) ?? "";
    expect(text).toContain("- Q: Q?\n  A: A. (run abcdef12)");
    expect(text).toContain("- `bun test` (2 runs)");
  });
});

describe("project memory across runs", () => {
  test("a later run's research, spec and plan read earlier answers, approved assumptions and passing checks", async () => {
    const fixture = workflowFixture({ executor: (root) => new AskingExecutor(root) });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    const first = await completeRun(fixture, fixturePolicy, "Plain text, no newline");
    // Nothing earlier to remember.
    expect(service.store.state(first).projectMemory).toBeNull();
    expect(extraOf(executor.prompts.research?.[0] ?? "{}").projectMemory).toBeUndefined();

    const memory = collectProjectMemory(service.store);
    expect(memory.answers).toEqual([{ question: QUESTION, answer: "Plain text, no newline", runId: first }]);
    expect(memory.assumptions.map((a) => a.text)).toEqual([ASSUMPTION]);
    expect(memory.checks).toHaveLength(1);

    // Another check, so the first run's command is not already in the new run's contract.
    const other: RunPolicy = { ...fixturePolicy, checks: [{ ...(fixturePolicy.checks[0] as RunPolicy["checks"][number]), id: "other", args: ["-e", "process.exit(0)"] }] };
    executor.prompts = {};
    rmSync(join(fixture.root, "value.txt"));
    const second = await completeRun(fixture, other);
    const state = service.store.state(second);
    expect(state.projectMemory).not.toBeNull();
    expect(service.store.artifacts(second).some((a) => a.logical_path === PROJECT_MEMORY_ARTIFACT)).toBe(true);
    expect(state.manifest.instructionHashes.some((h) => h.source === PROJECT_MEMORY_ARTIFACT)).toBe(true);
    for (const kind of ["research", "spec", "plan"]) {
      const text = extraOf(executor.prompts[kind]?.[0] ?? "{}").projectMemory ?? "";
      expect(text).toContain(`Q: ${QUESTION}`);
      expect(text).toContain("A: Plain text, no newline");
      expect(text).toContain(ASSUMPTION);
      expect(text).toContain("Check commands that passed in completed runs:");
    }
    for (const kind of ["implementation", "review"])
      expect(extraOf(executor.prompts[kind]?.[0] ?? "{}").projectMemory).toBeUndefined();
  });

  test("policy projectMemory: false leaves it out", async () => {
    const fixture = workflowFixture({ executor: (root) => new AskingExecutor(root) });
    cleanups.push(fixture.dispose);
    await completeRun(fixture, fixturePolicy, "Plain text");
    const off = await fixture.service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: { ...fixturePolicy, projectMemory: false } });
    expect(fixture.service.store.state(off.runId).projectMemory).toBeNull();
  });
});

describe("editing project memory", () => {
  test("notes, rewording, forgetting and restoring change what new runs read", async () => {
    const fixture = workflowFixture({ executor: (root) => new AskingExecutor(root) });
    cleanups.push(fixture.dispose);
    const { service, executor } = fixture;
    await completeRun(fixture, fixturePolicy, "Plain text, no newline");
    const { store } = service;
    let view = projectMemoryView(store, fixturePolicy);
    expect(view.enabled).toBe(true);
    const answer = view.entries.find((e) => e.kind === "answer");
    const assumption = view.entries.find((e) => e.kind === "assumption");
    const check = view.entries.find((e) => e.kind === "check");
    if (!answer || !assumption || !check) throw new Error("Expected recorded entries");
    // The policy's own check is listed but not sent.
    expect(check.sent).toBe(false);
    expect(answer.id).toMatch(/^a-[0-9a-f]{10}$/);

    const note = editProjectMemory(store, { action: "add", text: "  Keep   values ASCII.  " });
    editProjectMemory(store, { action: "edit", id: answer.id, text: "JSON with a trailing newline" });
    editProjectMemory(store, { action: "forget", id: assumption.id });
    expect(() => editProjectMemory(store, { action: "edit", id: check.id, text: "x" })).toThrow("cannot be reworded");
    expect(() => editProjectMemory(store, { action: "forget", id: "a-0000000000" })).toThrow("No project memory entry");
    expect(() => editProjectMemory(store, { action: "add", text: "   " })).toThrow("must not be empty");

    view = projectMemoryView(store, fixturePolicy);
    expect(view.entries[0]).toMatchObject({ id: note, kind: "note", text: "Keep values ASCII." });
    expect(view.entries.find((e) => e.id === answer.id)).toMatchObject({ text: "JSON with a trailing newline", recorded: "Plain text, no newline" });
    expect(view.hidden.map((e) => e.id)).toEqual([assumption.id]);
    expect(view.rendered).toContain("Notes people keep for this project:\n- Keep values ASCII.");
    expect(view.rendered).toContain("A: JSON with a trailing newline");
    expect(view.rendered).not.toContain(ASSUMPTION);

    // A new run captures the edited memory.
    executor.prompts = {};
    rmSync(join(fixture.root, "value.txt"));
    const next = await service.start({ commandId: newId(), featureId: "fixture", workflowId: "sdd", prompt: "Create ready value", ownerLabel: "test", policy: fixturePolicy });
    const captured = store.readArtifact(next.runId, store.state(next.runId).projectMemory?.artifactId ?? "");
    expect(captured).toContain("Keep values ASCII.");
    expect(captured).not.toContain(ASSUMPTION);

    editProjectMemory(store, { action: "restore", id: assumption.id });
    editProjectMemory(store, { action: "restore", id: answer.id });
    editProjectMemory(store, { action: "forget", id: note });
    view = projectMemoryView(store, fixturePolicy);
    expect(view.hidden).toEqual([]);
    expect(view.entries.some((e) => e.kind === "note")).toBe(false);
    expect(view.entries.find((e) => e.id === answer.id)?.text).toBe("Plain text, no newline");
    expect(collectProjectMemory(store).assumptions.map((a) => a.text)).toEqual([ASSUMPTION]);
    expect(projectMemoryView(store, { ...fixturePolicy, projectMemory: false }).enabled).toBe(false);
  });

  test("baked workflow memory lists and edits from the command line", async () => {
    const fixture = workflowFixture();
    cleanups.push(fixture.dispose);
    const run = (argv: string[]) => executeWorkflowCommand(fixture.service, parseWorkflowArgs(["memory", ...argv]), signal());
    const empty = (await run([])) as ReturnType<typeof projectMemoryView>;
    expect(formatProjectMemory(empty)).toContain("Project memory is empty");
    const added = (await run(["add", "--text", "Use tabs"])) as ReturnType<typeof projectMemoryView> & { id: string };
    expect(added.entries.map((e) => e.text)).toEqual(["Use tabs"]);
    expect(formatProjectMemory(added)).toContain(`${added.id}  note    Use tabs`);
    await run(["edit", added.id, "--text", "Use spaces"]);
    expect(((await run(["list"])) as ReturnType<typeof projectMemoryView>).entries[0]?.text).toBe("Use spaces");
    await run(["forget", added.id]);
    expect(((await run([])) as ReturnType<typeof projectMemoryView>).entries).toEqual([]);
    expect(() => parseWorkflowArgs(["memory", "add"])).toThrow("requires --text");
    expect(() => parseWorkflowArgs(["memory", "forget"])).toThrow("expects an entry ID");
    expect(() => parseWorkflowArgs(["memory", "forget", "n-1", "--text", "x"])).toThrow("--text is not valid");
    expect(() => parseWorkflowArgs(["memory", "drop", "n-1"])).toThrow("memory accepts");
  });
});

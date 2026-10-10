/**
 * Contracts and pure rules of the AI acceptance gate (workflow v2 design, section 9). The walk,
 * the draft and the verification run in `acceptance-gate.ts`; nothing here starts a process or
 * calls a model.
 */
import { z } from "zod";
import { RelativePath, SafeId } from "../schemas.js";
import type { RequestRow } from "../store.js";
import { CommandGate, type CommandGateDefinition, type Gate, validateGate } from "./definition.js";

export type AcceptanceGateDefinition = Extract<Gate, { type: "ai-acceptance" }>;

/** The n-th expectation of a scenario is `E<n>`, counted from 1. */
export const ExpectationId = z.string().regex(/^E[1-9][0-9]?$/);
export const AssertionId = z.string().regex(/^A[1-9][0-9]?$/);
export const expectationIds = (gate: AcceptanceGateDefinition): string[] =>
  gate.acceptance.scenario.expectations.map((_, index) => `E${index + 1}`);

/** What the walk-through model returns: a verdict per expectation and the steps that show it. */
export const AcceptanceWalkSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectations: z
      .array(
        z
          .object({
            expectationId: ExpectationId,
            verdict: z.enum(["pass", "fail", "inconclusive"]),
            stepIds: z.array(SafeId).max(30),
            explanation: z.string().min(1).max(2000),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type AcceptanceWalk = z.infer<typeof AcceptanceWalkSchema>;

/** What the test writer returns: the file it wrote and the assertion that checks each expectation. */
export const AcceptanceDraftSchema = z
  .object({
    schemaVersion: z.literal(1),
    testPath: RelativePath,
    assertions: z
      .array(
        z
          .object({
            assertionId: AssertionId,
            expectationId: ExpectationId,
            description: z.string().min(1).max(500),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();
export type AcceptanceDraft = z.infer<typeof AcceptanceDraftSchema>;

/** A recorded step: an action, what was observed and the expectations it concerns. */
export const StepInputSchema = z
  .object({
    action: z.string().min(1).max(2000),
    observation: z.string().min(1).max(4000),
    expectationIds: z.array(ExpectationId).max(30),
  })
  .strict();

/**
 * Problems of a walk result: every expectation answered once, and every cited step one this
 * attempt recorded. A pass or fail without a step is not evidence.
 */
export function walkProblems(
  gate: AcceptanceGateDefinition,
  walk: AcceptanceWalk,
  recordedSteps: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const wanted = expectationIds(gate);
  const answered = walk.expectations.map((e) => e.expectationId);
  for (const id of wanted)
    if (!answered.includes(id)) problems.push(`Expectation ${id} has no verdict`);
  for (const id of answered) {
    if (!wanted.includes(id)) problems.push(`Expectation ${id} is not part of the scenario`);
    if (answered.filter((other) => other === id).length > 1)
      problems.push(`Expectation ${id} has more than one verdict`);
  }
  for (const item of walk.expectations) {
    if (item.verdict !== "inconclusive" && item.stepIds.length === 0)
      problems.push(`Expectation ${item.expectationId} cites no recorded step`);
    for (const step of item.stepIds)
      if (!recordedSteps.has(step))
        problems.push(
          `Expectation ${item.expectationId} cites step ${step}, which this attempt did not record`,
        );
  }
  return [...new Set(problems)];
}

/** The verdict of a walk the host accepted: failed when any expectation failed. */
export function walkVerdict(walk: AcceptanceWalk): "passed" | "failed" | "inconclusive" {
  if (walk.expectations.some((e) => e.verdict === "fail")) return "failed";
  if (walk.expectations.some((e) => e.verdict === "inconclusive")) return "inconclusive";
  return "passed";
}

/** Problems of a draft: the declared path, and an assertion for every expectation. */
export function draftProblems(gate: AcceptanceGateDefinition, draft: AcceptanceDraft): string[] {
  const problems: string[] = [];
  if (draft.testPath !== gate.acceptance.promote.testPath)
    problems.push(`The test must be written at ${gate.acceptance.promote.testPath}`);
  const ids = draft.assertions.map((a) => a.assertionId);
  if (new Set(ids).size !== ids.length) problems.push("Assertion IDs must be unique");
  const wanted = expectationIds(gate);
  for (const id of wanted)
    if (!draft.assertions.some((a) => a.expectationId === id))
      problems.push(`Expectation ${id} has no assertion`);
  for (const assertion of draft.assertions)
    if (!wanted.includes(assertion.expectationId))
      problems.push(`Assertion ${assertion.assertionId} maps to an unknown expectation`);
  return problems;
}

/** The marker a generated test prints for each failing assertion. */
export const ASSERTION_MARKER = "ASSERTION FAILED:";
export function failedAssertions(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf(ASSERTION_MARKER);
    if (at < 0) continue;
    const id = line
      .slice(at + ASSERTION_MARKER.length)
      .trim()
      .split(/\s/)[0];
    if (id && AssertionId.safeParse(id).success) found.add(id);
  }
  return [...found].sort();
}

/**
 * The command that runs a generated test, without a shell. A file named like a Bun test
 * (`*.test.ts`, `*.spec.js`, ...) runs under `bun test`; any other file runs as a script.
 */
export function testCommand(testPath: string): { executable: string; args: string[] } {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(testPath)
    ? { executable: "bun", args: ["test", testPath] }
    : { executable: "bun", args: [testPath] };
}

/**
 * Obvious constructs a generated test must not contain: references to the run store, the
 * repository metadata, the gate and workflow definitions, or its own file. This is a static
 * refusal of the plain cases; a person still reviews the test before it is promoted.
 */
export function forbiddenConstructs(content: string, testPath: string): string[] {
  const problems: string[] = [];
  const name = testPath.split("/").at(-1) ?? testPath;
  const rules: [RegExp, string][] = [
    [/\.baked\b/, "it refers to .baked (the run store and configuration)"],
    [/(^|[^A-Za-z0-9_.])\.git[/'"`]/, "it refers to .git"],
    [/baked\/(gates|workflows|agents)\b/, "it refers to the workflow, gate or profile definitions"],
    [/\bchild_process\b.*\bshell\s*:\s*true/s, "it starts a shell"],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(content)) problems.push(reason);
  if (content.includes(name) && /writeFile|appendFile|unlink|rmSync|Bun\.write/.test(content))
    problems.push("it may change its own file");
  return problems;
}

/** Stable means: every run passed for a passed walk, every run failed on a mapped assertion for a failed one. */
export function stabilityProblems(
  walk: "passed" | "failed",
  runs: { exitCode: number | null; timedOut: boolean; failed: string[]; violations: string[] }[],
  mapped: readonly string[],
): string[] {
  const problems: string[] = [];
  runs.forEach((run, index) => {
    const label = `Run ${index + 1}`;
    if (run.violations.length) problems.push(`${label}: ${run.violations.join("; ")}`);
    if (run.timedOut) problems.push(`${label} timed out`);
    else if (walk === "passed" && run.exitCode !== 0)
      problems.push(
        `${label} failed (exit ${String(run.exitCode)}${run.failed.length ? `, ${run.failed.join(", ")}` : ""}) although the walk-through passed`,
      );
    else if (walk === "failed") {
      if (run.exitCode === 0)
        problems.push(`${label} passed although the walk-through found a failure`);
      else if (!run.failed.some((id) => mapped.includes(id)))
        problems.push(
          `${label} did not report a failure of ${mapped.join(" or ")} (reported: ${run.failed.join(", ") || "none"})`,
        );
    }
  });
  return problems;
}

/** The command gate a promotion writes into the project gate library. */
export function promotedGate(
  source: AcceptanceGateDefinition,
  testHash: string,
  approvedAt: string,
): CommandGateDefinition {
  const command = testCommand(source.acceptance.promote.testPath);
  const gate = CommandGate.parse({
    schemaVersion: 1,
    id: source.acceptance.promote.commandGateId,
    description: `Deterministic test promoted from the AI walk-through ${source.id}: ${source.acceptance.scenario.title}`,
    required: true,
    scope: "feature",
    timeoutMs: source.timeoutMs,
    retries: { max: 0, retryOn: [] },
    evidence: { kind: "exit", keepOutputLines: 40, artifactPaths: [] },
    type: "command",
    command: {
      ...command,
      cwd: ".",
      envNames: source.acceptance.start.envNames,
      writes: source.acceptance.capabilities.writePaths,
    },
    provenance: {
      generatedFrom: source.id,
      testPath: source.acceptance.promote.testPath,
      testHash,
      approvedBy: "human",
      approvedAt,
    },
  });
  const errors = validateGate(gate);
  if (errors.length) throw new Error(errors.join("; "));
  return gate;
}

/** Paths that changed outside the granted write directories. */
export function writesOutside(changed: readonly string[], writePaths: readonly string[]): string[] {
  return changed.filter((path) => !writePaths.some((w) => path === w || path.startsWith(`${w}/`)));
}

/** Whether a request is the human decision on a verified acceptance test. */
export function isAcceptanceRequest(request: { kind: string; body_json: string }): boolean {
  if (request.kind !== "approval") return false;
  const body = JSON.parse(request.body_json) as { acceptance?: unknown };
  return typeof body.acceptance === "object" && body.acceptance !== null;
}
/**
 * A pending request the run waits for. The decision on an acceptance test is not one: the
 * walk-through is advisory, so the run goes on and the person decides whenever they like.
 */
export const blocksRun = (request: RequestRow): boolean =>
  request.status === "pending" && !isAcceptanceRequest(request);

/** The AI walk-throughs that are granted any capability, as an approval shows them. */
export function acceptanceGrants(gates: readonly Gate[]): {
  gateId: string;
  driver: AcceptanceGateDefinition["acceptance"]["driver"];
  command: string[];
  capabilities: AcceptanceGateDefinition["acceptance"]["capabilities"];
}[] {
  return gates
    .filter((g): g is AcceptanceGateDefinition => g.type === "ai-acceptance")
    .filter(
      ({ acceptance: { capabilities: c } }) =>
        c.spawnApp || c.listenPorts.length || c.outboundHosts.length || c.writePaths.length,
    )
    .map((g) => ({
      gateId: g.id,
      driver: g.acceptance.driver,
      command: [g.acceptance.start.executable, ...g.acceptance.start.args],
      capabilities: g.acceptance.capabilities,
    }));
}

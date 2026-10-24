import { afterEach, describe, expect, test } from "bun:test";
import { canonical } from "../src/core/specs/hash.js";
import { requestSettles, restrictsRequest } from "../src/core/workflows/analysis-notes.js";
import { type EvidenceInput, evidenceDecision, platformEvidence, reportRequestEvidence } from "../src/core/workflows/evidence-decisions.js";
import { type Review, ReviewSchema, type RunPolicy, type Spec } from "../src/core/workflows/schemas.js";
import { specAmendmentOf } from "../src/core/workflows/spec-amendment.js";
import type { WorkflowStore } from "../src/core/workflows/store.js";
import { replayEvidenceDecisions } from "../src/core/workflows/trace.js";
import type { ExecutionRequest } from "../src/core/workflows/types.js";
import { FixtureExecutor, fixturePolicy, fixtureSpec, workflowFixture } from "./helpers/workflow-fixture.js";

// #2032, follow-up of #2016. Host decisions that settle for the request or the platform read the
// wording of a model's text with a regex, so one changed word flipped them, as "the detailed
// contract defines" against "the request defines" flipped R65 uritpl cli T003 (1.42M tokens, 19.7
// minutes, one question to a person). Each site now settles on evidence the host checks: a request
// quote it finds in the request, or a line of a failing check's or a probe's recorded output. Each
// site below states the same thing in two phrasings, one the old regex matches and one it does
// not, and both decide the same; a quote the host cannot find settles nothing.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const REQUEST = "Build envguard. Tests may read and write any file under tests/ and the fixtures they need. Print each problem on its own line.";
const QUOTE = "Tests may read and write any file under tests/";
const spec: Spec = {
  ...fixtureSpec,
  criteria: [
    ...fixtureSpec.criteria,
    { id: "AC-005", requirementIds: ["FR-001"], given: "a test", when: "it runs", then: "it writes no file outside src/", method: "automated" },
  ],
};

describe("analysis-request: a blocking inconsistency the request settles (#2032)", () => {
  const finding = (description: string, quote?: string) => ({ id: "F-001", kind: "inconsistency", blocking: true, refs: ["AC-005"], description, ...(quote === undefined ? {} : { quote }) });
  // The first phrasing matches the wording rule, the second does not.
  const PHRASINGS = [
    "AC-005 forbids test writes under tests/, but the request allows them.",
    "AC-005 bans what the brief text grants: test writes under tests/.",
  ];

  test("two phrasings with the same request quote both settle", () => {
    for (const description of PHRASINGS) expect(requestSettles(finding(description, QUOTE), spec, REQUEST)).toBe(true);
    // Before #2032 the second phrasing settled nothing.
    expect(requestSettles(finding(PHRASINGS[1] ?? ""), spec)).toBe(false);
  });

  test("a span the description quotes is the evidence when the finding has no quote field", () => {
    for (const description of PHRASINGS) expect(requestSettles(finding(`${description} It says "${QUOTE}".`), spec, REQUEST)).toBe(true);
  });

  test("a quote the request does not hold settles nothing, whatever the words", () => {
    for (const description of PHRASINGS) {
      expect(requestSettles(finding(description, "Tests may delete any file in the repository"), spec, REQUEST)).toBe(false);
      expect(restrictsRequest(finding(description, "Tests may delete any file in the repository"), spec, REQUEST)).toBe(false);
    }
  });

  test("a quote that is the criterion's own words does not show the request side", () => {
    expect(requestSettles(finding(PHRASINGS[0] ?? "", "it writes no file outside src/"), { ...spec }, `${REQUEST} it writes no file outside src/`)).toBe(false);
  });

  test("a finding that quotes nothing falls back to the wording", () => {
    expect(requestSettles(finding(PHRASINGS[0] ?? ""), spec, REQUEST)).toBe(true);
    expect(requestSettles(finding(PHRASINGS[1] ?? ""), spec, REQUEST)).toBe(false);
  });
});

describe("review-request: a review finding that amends the spec for the request (#2032)", () => {
  const finding = (claim: string, quote?: string): Review["findings"][number] =>
    ReviewSchema.shape.findings.element.parse({
      id: "F-007",
      kind: "contradicts",
      severity: "high",
      requirementIds: [],
      criterionIds: ["AC-005"],
      file: "tests/env.test.ts",
      symbol: null,
      evidenceIds: ["e1"],
      claim,
      impact: "The tests cannot use their fixtures",
      suggestedFix: "Remove the no-write clause from AC-005",
      ...(quote === undefined ? {} : { quote }),
    });
  const PHRASINGS = [
    "AC-005 contradicts the request, which lets tests write under tests/.",
    "AC-005 contradicts what the task text grants: tests write under tests/.",
  ];

  test("two phrasings with the same request quote both record an amendment", () => {
    for (const claim of PHRASINGS) expect(specAmendmentOf(finding(claim, QUOTE), spec, REQUEST)).toMatchObject({ findingId: "F-007", criterionIds: ["AC-005"], paths: ["tests/env.test.ts"] });
    expect(specAmendmentOf(finding(PHRASINGS[1] ?? ""), spec)).toBeNull();
  });

  test("a quote the request does not hold records none, whatever the words", () => {
    for (const claim of PHRASINGS) expect(specAmendmentOf(finding(claim, "Tests may delete any file in the repository"), spec, REQUEST)).toBeNull();
  });

  test("a finding whose fix does not change the spec is not a spec amendment, quote or not", () => {
    const code = { ...finding(PHRASINGS[0] ?? "", QUOTE), suggestedFix: "Write the fixture under tests/" };
    expect(specAmendmentOf(code, spec, REQUEST)).toBeNull();
  });
});

describe("the evidence rule", () => {
  const input = (patch: Partial<EvidenceInput>): EvidenceInput => ({ site: "platform-limit", eligible: true, evidence: "absent", wording: false, fallback: true, ...patch });
  test("verified evidence settles on every report, offered evidence the host cannot find never does", () => {
    expect(evidenceDecision(input({ evidence: "verified", fallback: false }))).toBe(true);
    expect(evidenceDecision(input({ evidence: "unverified", wording: true }))).toBe(false);
    expect(evidenceDecision(input({ wording: true }))).toBe(true);
    expect(evidenceDecision(input({ wording: true, fallback: false }))).toBe(false);
    expect(evidenceDecision(input({ evidence: "verified", eligible: false }))).toBe(false);
  });

  test("a platform side is checked against the failing checks and probes of the task", () => {
    const failing = { check: "error: Header 'location' has invalid value: not a ByteString\n" };
    expect(platformEvidence([{ kind: "platform", ref: "check", quote: "Header 'location' has invalid value" }], failing, [])).toBe("verified");
    expect(platformEvidence([{ kind: "platform", ref: "lint", quote: "Header 'location' has invalid value" }], failing, [])).toBe("unverified");
    expect(platformEvidence([{ kind: "platform", ref: "probe", quote: "Header 'location' has invalid value" }], {}, [failing.check])).toBe("verified");
    // Too short to show anything.
    expect(platformEvidence([{ kind: "platform", ref: "check", quote: "error" }], failing, [])).toBe("unverified");
    expect(platformEvidence([{ kind: "criterion", ref: "AC-005", quote: "x" }], failing, [])).toBe("absent");
  });

  test("a docs task's worked example is checked against the request", () => {
    const request = "Document the tool. The README shows `envguard check .env` printing `MISSING DATABASE_URL (line 3)`.";
    expect(reportRequestEvidence(request, 'The rule for examples forbids writing "MISSING DATABASE_URL (line 3)" without running it.', undefined)).toBe("verified");
    expect(reportRequestEvidence(request, "The README example cannot be produced without its files.", [{ kind: "request", quote: "MISSING DATABASE_URL (line 9)" }])).toBe("unverified");
  });
});

// Scenario of bench round 38, url-shortener 0cf3a1af T009 (#1384), with the report reworded: the
// correction met a value the platform cannot carry. It now names the probe it ran and the output
// line that shows the limit, and the host finds that line in the probe's journal.
const policy: RunPolicy = {
  ...fixturePolicy,
  clarification: "assume",
  checks: [{ ...fixturePolicy.checks[0]!, args: ["-e", "const v = await Bun.file('value.txt').text(); if (v !== 'ready') process.exit(1)"] }],
};
const repro = { executable: "bun", args: ["-e", "console.log(await Bun.file('value.txt').text())"], expected: "literal", actual: "ready" };
const PROBE_LINE = "TypeError: Header 'location' has invalid value: 'https://bücher.example/'";
const REPORTS = {
  // The wording rule matches this one.
  worded: "AC-005 demands the exact stored Unicode Location, but HTTP headers cannot carry non-ASCII bytes (platform limit). Nearest feasible behavior: send the punycode host.",
  // And not this one.
  plain: "AC-005 demands the exact stored Unicode Location; Bun throws on it, see the probe. Nearest feasible behavior: send the punycode host.",
};

class PlatformConflict extends FixtureExecutor {
  corrections: string[] = [];
  reviews = 0;
  store: WorkflowStore | null = null;
  constructor(root: string, private report: string, private quote: string) {
    super(root);
  }
  override async execute(request: ExecutionRequest) {
    const context = JSON.parse(request.prompt.split("\n").at(-1) ?? "{}") as { extra: { evidence?: { id: string }[]; finding?: { id: string } } };
    if (request.profile.output === "refutation")
      return { output: { schemaVersion: 1, findingId: context.extra.finding?.id, decision: "confirmed", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], explanation: "The repro prints ready" }, inputTokens: 25, outputTokens: 25 };
    if (request.profile.output === "implementation" && request.task?.origin !== "planned") {
      this.calls.push("implementation");
      this.corrections.push(request.prompt);
      const base = { schemaVersion: 1, taskId: request.task?.id, evidenceIds: [], unresolved: [] as string[] };
      if (this.corrections.length === 1) {
        // What run_probe journals for the attempt.
        this.store?.transaction(() =>
          this.store?.artifact(request.runId, "probe", `attempts/${request.attemptId}/probe-1.json`, canonical({ taskId: request.task?.id ?? null, executable: "bun", args: ["-e", "new Headers({ location: 'https://bücher.example/' })"], durationMs: 5, status: "ran", exitCode: 1, output: `${PROBE_LINE}\n` })),
        );
        return { output: { ...base, outcome: "spec_conflict", summary: this.report, unresolved: ["Allow the serialized form?"], conflictSides: [{ kind: "platform", ref: "probe", quote: this.quote }] }, inputTokens: 25, outputTokens: 25 };
      }
      return { output: { ...base, outcome: "already_satisfied", summary: "The serialized form is what the platform can send", evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [] }, inputTokens: 25, outputTokens: 25 };
    }
    const result = await super.execute(request);
    if (request.profile.output === "review" && this.reviews++ === 0)
      result.output = {
        ...ReviewSchema.parse(result.output),
        verdict: "changes_requested",
        findings: [{ id: "literal", kind: "correctness", severity: "high", requirementIds: ["FR-001"], criterionIds: ["AC-001"], file: "value.txt", symbol: null, evidenceIds: context.extra.evidence?.map((e) => e.id) ?? [], claim: "The Location is not the exact stored Unicode URL", impact: "Wrong header", suggestedFix: "Send the literal value", repro }],
      };
    return result;
  }
}

async function platformRun(report: string, quote: string) {
  let executor: PlatformConflict | null = null;
  const fixture = workflowFixture({
    policy,
    executor: (root) => {
      executor = new PlatformConflict(root, report, quote);
      return executor;
    },
  });
  cleanups.push(fixture.dispose);
  const { service } = fixture;
  const conflict = executor as unknown as PlatformConflict;
  conflict.store = service.store;
  const run = await fixture.start();
  await service.drive(run.runId, new AbortController().signal);
  await fixture.approve(run.runId);
  const done = await service.drive(run.runId, new AbortController().signal);
  const records = service.store
    .artifacts(run.runId)
    .filter((a) => a.logical_path.startsWith("conflicts/evidence/platform-limit-"))
    .map((a) => JSON.parse(service.store.readArtifact(run.runId, a.id)) as { evidence: string; decision: boolean; wording: boolean });
  return {
    status: done.status,
    asked: service.store.requests(run.runId).filter((r) => r.kind === "clarification"),
    corrections: conflict.corrections,
    records,
    replay: (rule?: Parameters<typeof replayEvidenceDecisions>[2]) => replayEvidenceDecisions(service.store, run.runId, rule),
  };
}

describe("scenario: url-shortener 0cf3a1af reworded, a platform limit shown by a probe (#2032)", () => {
  for (const [name, report] of Object.entries(REPORTS))
    test(`the probe's output line settles the limit (${name} phrasing)`, async () => {
      const result = await platformRun(report, "Header 'location' has invalid value");
      expect(result.asked).toHaveLength(0);
      expect(result.status).toBe("completed");
      expect(result.corrections).toHaveLength(2);
      expect(result.corrections[1]).toContain("platform cannot do what a criterion");
      expect(result.records).toEqual([expect.objectContaining({ evidence: "verified", decision: true, wording: name === "worded" })]);
      expect(result.replay()).toEqual([expect.objectContaining({ site: "platform-limit", recorded: true, replayed: true })]);
      // The rule before #2032 decided on the wording alone: the hook shows the difference.
      expect(result.replay((i) => i.wording && i.fallback)[0]?.replayed).toBe(name === "worded");
    }, 90_000);

  test("a quoted line the probe never printed settles nothing, even with the wording", async () => {
    const result = await platformRun(REPORTS.worded, "Header 'location' must be ASCII only");
    expect(result.records).toEqual([expect.objectContaining({ evidence: "unverified", decision: false, wording: true })]);
    expect(result.corrections[1] ?? "").not.toContain("platform cannot do what a criterion");
  }, 90_000);
});

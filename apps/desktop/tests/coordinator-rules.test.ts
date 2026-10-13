import { describe, expect, test } from "bun:test";
import type { ApprovalRule } from "../src/renderer/client/coordinator.ts";

// The client picks its bridge from `window` when it loads; outside a browser it gets the mock.
const scope = globalThis as { window?: unknown };
scope.window = {};
const { ApiError } = await import("../src/renderer/client/api.ts");
const { coordinator } = await import("../src/renderer/client/coordinator.ts");
const { emptyDraft, newRuleId, ruleFromDraft, ruleLine } = await import(
  "../src/renderer/screens/coordinator/rules.ts"
);
const { noteTone } = await import("../src/renderer/screens/coordinator/model.ts");
delete scope.window;

describe("approval rules in the desktop app", () => {
  test("drafts become rules, or say what is wrong", () => {
    const none: ApprovalRule[] = [];
    expect(ruleFromDraft(emptyDraft("web-search"), none)).toEqual({
      rule: { id: "web-search", kind: "web-search" },
    });
    expect(
      ruleFromDraft({ ...emptyDraft("fetch-page"), hosts: "https://Docs.GitHub.com/en, bun.sh bun.sh" }, none),
    ).toEqual({ rule: { id: "fetch-page", kind: "fetch-page", hosts: ["docs.github.com", "bun.sh"] } });
    expect(ruleFromDraft({ ...emptyDraft("fetch-page"), hosts: "" }, none)).toEqual({
      error: "Name at least one host, such as docs.github.com.",
    });
    expect(ruleFromDraft({ ...emptyDraft("fetch-page"), hosts: "localhost" }, none)).toEqual({
      error: "localhost is not a host name.",
    });
    expect(ruleFromDraft({ ...emptyDraft("plan-review"), maxSteps: "0" }, none)).toEqual({
      error: "Steps are a whole number from 1 to 50.",
    });
    expect(
      ruleFromDraft({ ...emptyDraft("run-approval"), maxTokens: "1,5", paths: "src/** tests/**" }, none),
    ).toEqual({
      rule: { id: "run-approval", kind: "run-approval", maxTokens: 1_500_000, paths: ["src/**", "tests/**"] },
    });
    const search: ApprovalRule[] = [{ id: "web-search", kind: "web-search" }];
    expect(ruleFromDraft(emptyDraft("web-search"), search)).toEqual({
      error: "Web searches are approved already.",
    });
    expect(newRuleId("fetch-page", [{ id: "fetch-page", kind: "fetch-page", hosts: ["a.io"] }])).toBe(
      "fetch-page-2",
    );
  });

  test("a rule reads as the core writes it in the log (tests/coordinator-approval-rules.test.ts)", () => {
    const rules: ApprovalRule[] = [
      { id: "a", kind: "web-search" },
      { id: "b", kind: "fetch-page", hosts: ["github.com", "bun.sh"] },
      { id: "c", kind: "plan-review", maxSteps: 3 },
      { id: "d", kind: "run-approval", maxTokens: 2_000_000, paths: ["src/**", "tests/**"] },
      { id: "e", kind: "run-approval", maxTokens: 800_000 },
    ];
    expect(rules.map(ruleLine)).toEqual([
      "Approve web searches of launched sessions",
      "Approve fetching pages from github.com, bun.sh",
      "Approve plans of up to 3 steps",
      "Approve run plans with a budget up to 2M tokens that write only src/**, tests/**",
      "Approve run plans with a budget up to 800k tokens",
    ]);
  });

  test("an answer by rule is good news in the conversation", () => {
    expect(
      noteTone({ kind: "session", id: "s", status: "approved by rule", why: "r", event: "auto-answered" }),
    ).toBe("ok");
  });

  test("the mock keeps the rules off until saved, by revision", async () => {
    await coordinator.open("site");
    const rules = await coordinator.approvalRules("site");
    expect(rules.enabled).toBe(false);
    const saved = await coordinator.saveApprovalRules(
      "site",
      { enabled: true, rules: [...rules.rules, { id: "web-search", kind: "web-search" }] },
      rules.revision,
    );
    expect(saved).toMatchObject({ enabled: true, revision: rules.revision + 1 });
    const stale = await coordinator
      .saveApprovalRules("site", { enabled: false, rules: [] }, rules.revision)
      .catch((e: unknown) => e);
    expect(stale instanceof ApiError && stale.status).toBe(409);
  });
});

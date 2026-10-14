import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfigs, saveProjectConfig } from "../src/config/index.js";
import { parseWorkflowConfig } from "../src/core/workflows/config-policy.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { readGates, writeGates } from "../src/core/workflows/gates.js";
import type { Check } from "../src/core/workflows/schemas.js";
import type { AppConfig } from "../src/types/index.js";

// Smoke 2026-10-14 (#1049): docs say to set `workflows.policy.autoApproval` in
// `.baked/config.json`; a policy with only that and `checks` failed every workflow command with a
// ZodError listing each policy field it lacked.

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const check: Check = { id: "tests", executable: "bun", args: ["test"], cwd: ".", timeoutMs: 60_000, required: true, scope: "feature", envNames: [], writes: [] };
const autoApproval = { renewal: true, limits: null };
const partial = { workflows: { policy: { autoApproval, checks: [check] } } } as unknown as Partial<AppConfig>;

describe("a partial workflows.policy (#1049)", () => {
  test("is merged over the default policy", () => {
    const workflows = mergeConfigs(DEFAULT_CONFIG, partial).workflows;
    expect(workflows?.policy).toEqual({ ...defaultWorkflowPolicy, autoApproval, checks: [check] });
    expect(workflows?.defaultWorkflow).toBe("sdd");
  });

  test("nested objects keep the default fields they do not name", () => {
    const workflows = parseWorkflowConfig({ policy: { reviewProfiles: { language: "ts-reviewer" } } }, "test");
    expect(workflows.policy.reviewProfiles).toEqual({ ...defaultWorkflowPolicy.reviewProfiles, language: "ts-reviewer" });
    // Arrays replace the default rather than adding to it.
    expect(parseWorkflowConfig({ policy: { allowedTools: ["read"] } }, "test").policy.allowedTools).toEqual(["read"]);
  });

  test("a full policy parses to exactly what it says", () => {
    const full = { ...defaultWorkflowPolicy, maxTotalTokens: 2_000_000, checks: [check] };
    expect(parseWorkflowConfig({ policy: full }, "test").policy).toEqual(full);
  });

  test("an invalid field fails with one line naming the file and the field", () => {
    const bad = { workflows: { policy: { autoApproval: { enabled: true } } } } as unknown as Partial<AppConfig>;
    let message = "";
    try {
      mergeConfigs(DEFAULT_CONFIG, bad);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toStartWith("Invalid workflow settings in .baked/config.json: workflows.policy.autoApproval");
    expect(message).not.toContain("\n");
  });

  test("editing the gates keeps the project policy partial", () => {
    const root = mkdtempSync(join(tmpdir(), "baked-partial-policy-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    saveProjectConfig(root, { workflows: { policy: { autoApproval } } } as unknown as Partial<AppConfig>);
    expect(readGates(root)).toEqual([]);
    writeGates(root, [check]);
    const saved = JSON.parse(readFileSync(join(root, ".baked", "config.json"), "utf8"));
    expect(saved.workflows.policy).toEqual({ autoApproval, checks: [check] });
    expect(readGates(root)).toEqual([check]);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileRegistry } from "../src/core/agents/profiles/registry.js";
import {
  agentId,
  convertAgents,
  listAgents,
  removeAgentFile,
  suggestStage,
  writeAgentFile,
} from "../src/core/workflows/agent-import.js";
import { defaultWorkflowPolicy } from "../src/core/workflows/defaults.js";
import { withImplementationProfiles } from "../src/core/workflows/plan-consistency.js";
import type { RunPolicy, TaskGraph } from "../src/core/workflows/schemas.js";
import { loadDefinition } from "../src/core/workflows/v2/definitions.js";
import { readConfirmations } from "../src/core/workflows/v2/library.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const check = (id: string, scope: "task" | "feature") => ({
  id,
  executable: "bun",
  args: ["test"],
  cwd: ".",
  timeoutMs: 60000,
  required: true,
  scope,
  envNames: [],
  writes: [],
});
const policy: RunPolicy = {
  ...defaultWorkflowPolicy,
  checks: [check("typecheck", "feature"), check("tests", "feature"), check("unit", "task")],
};

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "baked-agents-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const REVIEWER = `---
name: security-auditor
description: Reviews changes for injection and secrets
tools: Read, Grep, Glob
model: opus
---
Look for SQL injection and leaked secrets.`;
const PLANNER = `---
name: architect
description: Plans the change before coding
tools: [Read, Grep]
---
Write the plan as small steps.`;
const BUILDER = `---
description: Builds React components
---
Use function components and hooks.`;

describe("listAgents", () => {
  test("a project without agents lists none", () => {
    expect(listAgents(workspace({ "README.md": "hi" }))).toEqual({ agents: [], problems: [] });
  });

  test("reads Claude Code, Copilot, OpenCode and Roo agents", () => {
    const dir = workspace({
      ".claude/agents/security-auditor.md": REVIEWER,
      ".github/agents/architect.agent.md": PLANNER,
      ".github/chatmodes/frontend.chatmode.md": BUILDER,
      ".opencode/agent/explorer.md": "---\nmode: subagent\ndescription: Explores the codebase\n---\nRead widely.",
      ".roomodes": JSON.stringify({
        customModes: [
          { slug: "docs-writer", name: "Docs", roleDefinition: "You write docs.", groups: ["read", ["edit", { fileRegex: "\\.md$" }]] },
          { slug: "orchestrator", name: "Orchestrator", roleDefinition: "Delegate." },
        ],
      }),
      ".claude/agents/notes.txt": "not an agent",
    });
    const { agents, problems } = listAgents(dir);
    expect(problems).toEqual([]);
    expect(agents.map((a) => [a.key, a.source, a.stage])).toEqual([
      [".claude/agents/security-auditor.md", "claude", "review"],
      [".github/agents/architect.agent.md", "copilot", "plan"],
      [".github/chatmodes/frontend.chatmode.md", "copilot", "implement"],
      [".opencode/agent/explorer.md", "opencode", "research"],
      [".roomodes#docs-writer", "roo", "implement"],
      [".roomodes#orchestrator", "roo", "skip"],
    ]);
    const auditor = agents[0];
    expect(auditor?.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(auditor?.model).toBe("opus");
    expect(auditor?.instructions).toBe("Look for SQL injection and leaked secrets.");
    expect(agents[2]?.name).toBe("frontend");
    expect(agents[4]?.removable).toBe(false);
    expect(agents[5]?.orchestrator).toBe(true);
  });

  test("a broken file is a problem, not a failure", () => {
    const dir = workspace({ ".roomodes": "{ not json", ".claude/agents/a.md": "Body only" });
    const { agents, problems } = listAgents(dir);
    expect(agents.map((a) => a.name)).toEqual(["a"]);
    expect(problems[0]).toStartWith(".roomodes:");
  });
});

test("suggestStage reads words and tools", () => {
  const base = { orchestrator: false, tools: [] as string[] };
  expect(suggestStage({ ...base, name: "code-reviewer", description: "" })).toBe("review");
  expect(suggestStage({ ...base, name: "helper", description: "", tools: ["Read"] })).toBe(
    "research",
  );
  expect(suggestStage({ ...base, name: "helper", description: "", tools: ["Read", "Edit"] })).toBe(
    "implement",
  );
  expect(suggestStage({ ...base, orchestrator: true, name: "x", description: "" })).toBe("skip");
});

test("agentId avoids taken IDs", () => {
  expect(agentId("Security Auditor!", new Set())).toBe("security-auditor");
  expect(agentId("planner", new Set(["planner"]))).toBe("planner-2");
});

describe("edit and remove", () => {
  test("writes only over the hash it read and removes whole files", () => {
    const dir = workspace({ ".claude/agents/a.md": BUILDER, ".roomodes": "customModes:\n  - slug: m\n    roleDefinition: R\n" });
    const [a, roo] = listAgents(dir).agents;
    expect(writeAgentFile(dir, a?.key ?? "", "new", "0".repeat(64)).status).toBe("changed");
    const written = writeAgentFile(dir, a?.key ?? "", "---\nname: renamed\n---\nBody", a?.hash ?? "");
    expect(written.status).toBe("written");
    expect(written.status === "written" && written.agent?.name).toBe("renamed");
    expect(removeAgentFile(dir, roo?.key ?? "").status).toBe("changed");
    expect(removeAgentFile(dir, a?.key ?? "").status).toBe("written");
    expect(existsSync(join(dir, ".claude/agents/a.md"))).toBe(false);
    expect(removeAgentFile(dir, "../outside.md").status).toBe("unknown");
  });
});

describe("convertAgents", () => {
  test("writes profiles, a confirmed review gate and a custom workflow that uses them", () => {
    const dir = workspace({
      ".claude/agents/security-auditor.md": REVIEWER,
      ".claude/agents/architect.md": PLANNER,
      ".claude/agents/frontend.md": BUILDER,
    });
    const result = convertAgents(dir, policy, {
      workflowId: "team",
      agents: [
        { key: ".claude/agents/security-auditor.md", stage: "review" },
        { key: ".claude/agents/architect.md", stage: "plan" },
        { key: ".claude/agents/frontend.md", stage: "implement" },
      ],
      removeOriginals: true,
    });
    expect(result.problems).toEqual([]);
    expect(result.profiles.map((p) => [p.id, p.stage])).toEqual([
      ["architect", "plan"],
      ["frontend", "implement"],
    ]);
    expect(result.gates.map((g) => g.id)).toEqual(["security-auditor-review"]);
    expect(result.removed).toHaveLength(3);
    expect(listAgents(dir).agents).toEqual([]);
    expect(result.notes.join("\n")).toContain("asked for model opus");

    const loaded = loadDefinition(dir, "team", policy);
    expect(loaded.schemaVersion).toBe(2);
    if (loaded.schemaVersion !== 2) return;
    const stages = loaded.definition.stages;
    expect(stages.find((s) => s.id === "plan")).toMatchObject({ profileId: "architect" });
    expect(stages.find((s) => s.type === "tasks")).toMatchObject({ profileId: "frontend" });
    const review = stages.find((s) => s.type === "review");
    expect(review?.type === "review" && review.gates.map((g) => g.gateId)).toEqual([
      "correctness-review",
      "security-auditor-review",
    ]);
    expect(loaded.definition.stages.some((s) => s.type === "approval" && s.decision !== "human")).toBe(false);

    // The registry accepts the written profiles as they are.
    const registry = new ProfileRegistry(dir, { active: "m" }, join(dir, "no-global"));
    const architect = registry.get("architect");
    expect(architect.role).toBe("planner");
    expect(architect.instructions).toContain("Write the plan as small steps.");
    expect(registry.get("frontend").output).toBe("implementation");
    const gate = JSON.parse(readFileSync(join(dir, "baked/gates/security-auditor-review.json"), "utf8"));
    expect(gate.review.instructions).toContain("SQL injection");
    expect(readConfirmations(dir)["security-auditor-review"]).toBeString();
  });

  test("refuses two agents for one stage and an existing workflow, writing nothing", () => {
    const dir = workspace({
      ".claude/agents/a.md": PLANNER,
      ".claude/agents/b.md": PLANNER.replace("architect", "other"),
    });
    expect(() =>
      convertAgents(dir, policy, {
        workflowId: "x",
        agents: [
          { key: ".claude/agents/a.md", stage: "plan" },
          { key: ".claude/agents/b.md", stage: "plan" },
        ],
      }),
    ).toThrow("One agent per plan stage");
    expect(existsSync(join(dir, "baked"))).toBe(false);
    mkdirSync(join(dir, "baked/workflows"), { recursive: true });
    writeFileSync(join(dir, "baked/workflows/x.json"), "{}");
    expect(() =>
      convertAgents(dir, policy, { workflowId: "x", agents: [{ key: ".claude/agents/a.md", stage: "plan" }] }),
    ).toThrow("already exists");
  });

  test("a project without checks still gets its workflow, with the problem to fix", () => {
    const dir = workspace({ ".claude/agents/a.md": PLANNER });
    const result = convertAgents(dir, defaultWorkflowPolicy, {
      workflowId: "mine",
      agents: [{ key: ".claude/agents/a.md", stage: "plan" }],
    });
    expect(existsSync(result.path)).toBe(true);
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.removed).toEqual([]);
    expect(listAgents(dir).agents).toHaveLength(1);
  });
});

test("the tasks stage's profile replaces the default implementer only", () => {
  const graph = {
    tasks: [
      { id: "T1", profileId: "implementer" },
      { id: "T2", profileId: "docs-writer" },
      { id: "T3", profileId: "planner" },
    ],
  } as unknown as TaskGraph;
  const profiles = [
    { id: "implementer", output: "implementation" },
    { id: "frontend", output: "implementation" },
    { id: "docs-writer", output: "implementation" },
    { id: "planner", output: "plan" },
  ] as const;
  const ids = (g: TaskGraph) => g.tasks.map((t) => t.profileId);
  expect(ids(withImplementationProfiles(graph, profiles, "frontend"))).toEqual([
    "frontend",
    "docs-writer",
    "frontend",
  ]);
  expect(ids(withImplementationProfiles(graph, profiles))).toEqual([
    "implementer",
    "docs-writer",
    "implementer",
  ]);
  expect(ids(withImplementationProfiles(graph, profiles, "unknown"))).toEqual([
    "implementer",
    "docs-writer",
    "implementer",
  ]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCwd, setCwd } from "../src/core/cwd.js";
import { WorkflowFault } from "../src/core/workflows/errors.js";
import { parseRoutingTarget, runRoutingCli } from "../src/headless/workflow-routing.js";
import { removeTempDir } from "./helpers/temp-dir.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), "baked-routing-"));
  const home = mkdtempSync(join(tmpdir(), "baked-routing-home-"));
  cleanups.push(() => removeTempDir(workspace), () => removeTempDir(home));
  const run = (argv: string[]) => {
    const previous = getCwd();
    setCwd(workspace, { changeProcess: false });
    const out: string[] = [];
    const err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => out.push(String(chunk)) > 0) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => err.push(String(chunk)) > 0) as typeof process.stderr.write;
    try {
      const code = runRoutingCli(argv, home);
      return { code, stdout: out.join(""), stderr: err.join("") };
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      setCwd(previous, { changeProcess: false });
    }
  };
  const project = () => JSON.parse(readFileSync(join(workspace, ".baked", "config.json"), "utf8")) as Record<string, unknown>;
  return { workspace, home, run, project };
}

describe("baked workflow routing", () => {
  test("targets name classes, roles, profiles and stages", () => {
    expect(parseRoutingTarget("$coding")).toEqual({ kind: "class", name: "coding" });
    expect(parseRoutingTarget("class:cheap")).toEqual({ kind: "class", name: "cheap" });
    expect(parseRoutingTarget("role:reviewer")).toEqual({ kind: "role", role: "reviewer" });
    expect(parseRoutingTarget("profile:implementer")).toEqual({ kind: "profile", id: "implementer" });
    expect(parseRoutingTarget("stage:sdd/plan")).toEqual({ kind: "stage", workflowId: "sdd", stageId: "plan" });
    for (const bad of ["reviewer", "role:nobody", "stage:sdd", "stage:/plan", "profile:"])
      expect(() => parseRoutingTarget(bad)).toThrow(WorkflowFault);
  });

  test("set, review and clear write only modelRouting of the project config", () => {
    const { workspace, home, run, project } = setup();
    expect(run(["set", "role:reviewer", "openai/gpt-5", "--effort", "high", "--fallback", "anthropic/claude-sonnet-4-6"]).code).toBe(0);
    expect(run(["review", "require"]).code).toBe(0);
    expect(project()).toEqual({
      modelRouting: {
        roles: { reviewer: { model: "openai/gpt-5", effort: "high", fallback: ["anthropic/claude-sonnet-4-6"] } },
        independentReview: "require",
      },
    });
    const shown = JSON.parse(run(["show", "--json"]).stdout) as { project: unknown; global: unknown };
    expect(shown.global).toBeNull();
    expect(shown.project).toEqual(project().modelRouting);

    expect(run(["clear", "role:reviewer"]).code).toBe(0);
    expect(run(["review", "unset"]).code).toBe(0);
    expect(project()).toEqual({});
    expect(existsSync(join(home, "config.json"))).toBe(false);
  });

  test("web-search turns the opt-in code web search on, off and unset (#1239)", () => {
    const { run, project } = setup();
    expect(run(["web-search", "on"]).code).toBe(0);
    expect(project()).toEqual({ modelRouting: { codeWebSearch: true } });
    expect(run(["web-search", "off"]).code).toBe(0);
    expect(project()).toEqual({ modelRouting: { codeWebSearch: false } });
    expect(run(["web-search", "unset"]).code).toBe(0);
    expect(project()).toEqual({});
    expect(() => run(["web-search", "yes"])).toThrow(/on, off or unset/);
  });

  test("context sets the routing-wide window and --context one route's (#1256)", () => {
    const { run, project } = setup();
    expect(run(["context", "auto"]).code).toBe(0);
    expect(project()).toEqual({ modelRouting: { context: "auto" } });
    expect(run(["set", "role:reviewer", "claude-code/opus", "--context", "1m"]).code).toBe(0);
    expect(project()).toEqual({
      modelRouting: {
        context: "auto",
        roles: { reviewer: { model: "claude-code/opus", context: 1_000_000 } },
      },
    });
    expect(run(["context", "unset"]).code).toBe(0);
    expect(() => run(["context", "huge"])).toThrow(/default, max, auto/);
    expect(() => run(["set", "role:reviewer", "claude-code/opus", "--context", "x"])).toThrow(
      /--context/,
    );
  });

  test("specify-sonnet turns the opt-in specify route on, off and unset (#1173)", () => {
    const { run, project } = setup();
    expect(run(["specify-sonnet", "on"]).code).toBe(0);
    expect(project()).toEqual({ modelRouting: { specifyOnSonnet: true } });
    expect(run(["specify-sonnet", "off"]).code).toBe(0);
    expect(project()).toEqual({ modelRouting: { specifyOnSonnet: false } });
    expect(run(["specify-sonnet", "unset"]).code).toBe(0);
    expect(project()).toEqual({});
    expect(() => run(["specify-sonnet", "yes"])).toThrow(/on, off or unset/);
  });

  test("--scope global writes the global config", () => {
    const { home, run } = setup();
    const result = run(["set", "$fast", "openai/gpt-5-mini", "--scope", "global", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ saved: true, modelRouting: { classes: { fast: "openai/gpt-5-mini" } } });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({
      modelRouting: { classes: { fast: "openai/gpt-5-mini" } },
    });
  });

  test("a change the checks refuse is not written and exits 1", () => {
    const { workspace, run } = setup();
    const refused = run(["set", "stage:sdd/plan", "$missing"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("$missing, which no class defines");
    expect(run(["set", "$fast", "$coding", "--json"]).stdout).toContain('"saved": false');
    expect(existsSync(join(workspace, ".baked", "config.json"))).toBe(false);
    expect(() => run(["set", "role:reviewer", "openai/gpt-5", "--effort", "huge"])).toThrow("--effort");
    expect(() => run(["set", "role:reviewer"])).toThrow("set takes TARGET MODEL");
    expect(() => run(["clear", "role:reviewer", "--scope", "team"])).toThrow("--scope");
  });
});

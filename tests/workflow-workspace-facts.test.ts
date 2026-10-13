import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import { contradictsFacts, workspaceFacts } from "../src/core/workflows/workspace-facts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "baked-facts-"));
  dirs.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "bun test", lint: "biome check" } }),
  );
  writeFileSync(join(root, "tsconfig.json"), "{}");
  writeFileSync(join(root, "biome.json"), "{}");
  writeFileSync(join(root, "README.md"), "# cronsay\n");
  mkdirSync(join(root, "node_modules", "p"), { recursive: true });
  writeFileSync(join(root, "node_modules", "p", "index.js"), "");
  return root;
}

describe("workspace facts", () => {
  test("a scaffold lists its files, manifests and scripts instead of reading as empty", () => {
    const facts = workspaceFacts(scaffold());
    expect(facts.kind).toBe("scaffold");
    expect(facts.files.map((f) => f.path)).toEqual(["README.md", "biome.json", "package.json", "tsconfig.json"]);
    expect(facts.files.every((f) => f.bytes > 0 || f.path.endsWith(".json"))).toBe(true);
    expect(facts.manifests).toEqual(["biome.json", "package.json", "tsconfig.json"]);
    expect(facts.scripts).toEqual({ test: "bun test", lint: "biome check" });
    expect(facts.summary).toContain("package.json");
    expect(facts.summary).toContain("never create them again");
  });
  test("an analysis claim that a listed file does not exist contradicts the inventory", () => {
    const facts = workspaceFacts(scaffold());
    expect(contradictsFacts("Research says package.json does not exist, but T001 modifies it", facts)).toBe(true);
    expect(contradictsFacts("src/cli.ts does not exist", facts)).toBe(false);
    expect(contradictsFacts("package.json lists no test script", facts)).toBe(false);
  });
  test("the stages that read the workspace are told to use the inventory", () => {
    const text = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    for (const id of ["researcher", "spec-author", "planner", "quick-planner", "spec-reviewer"])
      expect(text(id)).toContain("workspaceFacts");
    expect(text("researcher")).toContain("scaffold:");
  });
  test("the planners and the reviewer are told what an empty or scaffold workspace means", () => {
    const text = (id: string) => builtinProfiles.find((p) => p.id === id)?.instructions ?? "";
    expect(text("planner")).toContain("When its kind is empty or scaffold");
    expect(text("quick-planner")).toContain("When its kind is empty or scaffold");
    expect(text("reviewer")).toContain("extra.baseline.greenfield");
  });
});

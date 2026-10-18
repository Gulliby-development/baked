import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectNativeChecks, detectProfile } from "../src/core/tools/project.js";
import { ruffSource } from "../src/core/tools/python-tooling.js";
import { detectGates } from "../src/core/workflows/gates.js";

// Bench round 44 (#1537): ignorewhy and expenses-py configure ruff in pyproject.toml. The edit
// tools' profile read ruff only from ruff.toml, so every edit ran `black <file>` (not installed)
// and stayed unformatted until the `ruff format --check` gate failed.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "baked-python-tooling-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
};

describe("ruff in a Python project (#1537)", () => {
  const cases: [string, Record<string, string>, string | null][] = [
    ["pyproject.toml [tool.ruff]", { "pyproject.toml": "[project]\nname = 'x'\n\n[tool.ruff]\nline-length = 100\n" }, "pyproject.toml [tool.ruff]"],
    ["ruff.toml", { "pyproject.toml": "[project]\nname = 'x'\n", "ruff.toml": "line-length = 100\n" }, "ruff.toml"],
    ["a requirements file", { "requirements.txt": "requests\n", "requirements-dev.txt": "pytest\nruff==0.6.0\n" }, "declared ruff dependency"],
    ["a pyproject dependency", { "pyproject.toml": "[project]\nname = 'x'\n\n[dependency-groups]\ndev = [\"ruff>=0.6\"]\n" }, "declared ruff dependency"],
    ["nothing", { "pyproject.toml": "[project]\nname = 'x'\ndependencies = ['ruffus']\n" }, null],
  ];
  for (const [name, files, source] of cases)
    test(`configured in ${name}: the edit profile and the gates agree`, async () => {
      const root = project(files);
      const profile = await detectProfile(root);
      expect(profile.lint).toBe(source ? "ruff check" : "flake8");
      expect(profile.formatFile).toBe(source ? "ruff format" : "black");
      expect((await detectNativeChecks(root))?.startsWith(source ? "ruff check" : "flake8")).toBe(true);
      expect(detectGates(root).some((g) => g.check.id === "ruff")).toBe(source !== null);
      expect(detectGates(root).find((g) => g.check.id === "ruff")?.source ?? null).toBe(source);
    });

  test("runs through the project's environment manager", async () => {
    const root = project({ "pyproject.toml": "[tool.ruff]\n", "uv.lock": "" });
    expect(await detectProfile(root)).toMatchObject({ lint: "uv run ruff check", formatFile: "uv run ruff format" });
    expect(await detectNativeChecks(root)).toBe("uv run ruff check && uv run mypy .");
  });

  test("ruffSource reads the config files in order", () => {
    const none = { ruffToml: false, dotRuffToml: false, pyproject: "", requirements: "" };
    expect(ruffSource({ ...none, dotRuffToml: true })).toBe(".ruff.toml");
    expect(ruffSource({ ...none, requirements: "  Ruff>=0.5" })).toBe("declared ruff dependency");
    expect(ruffSource(none)).toBeNull();
  });
});

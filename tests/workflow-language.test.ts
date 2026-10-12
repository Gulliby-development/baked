import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProfiles } from "../src/core/agents/profiles/builtin.js";
import {
  detectLanguages,
  dotnetFiles,
  LANGUAGE_REVIEW_PROFILE,
  languageReviewProfile,
} from "../src/core/workflows/language.js";
import { workspaceFacts } from "../src/core/workflows/workspace-facts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "baked-language-"));
  dirs.push(root);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

describe("project language", () => {
  test("manifests at the root select the language", () => {
    expect(detectLanguages(workspace({ "go.mod": "module x\n" }))).toEqual(["go"]);
    expect(detectLanguages(workspace({ "App.csproj": "<Project />" }))).toEqual(["dotnet"]);
    expect(detectLanguages(workspace({ "Cargo.toml": "" }))).toEqual(["rust"]);
    expect(detectLanguages(workspace({ "pom.xml": "" }))).toEqual(["java"]);
    expect(detectLanguages(workspace({ "package.json": "{}" }))).toEqual([]);
  });
  test(".NET solutions rank before projects", () => {
    expect(dotnetFiles(workspace({ "b.csproj": "", "a.sln": "", "c.slnx": "", "readme.md": "" }))).toEqual([
      "c.slnx",
      "a.sln",
      "b.csproj",
    ]);
  });
  test("the language review profile exists, is a review profile and applies to these languages only", () => {
    const profile = builtinProfiles.find((p) => p.id === LANGUAGE_REVIEW_PROFILE);
    expect(profile?.output).toBe("review");
    expect(profile?.allowedTools).not.toContain("edit_file");
    expect(languageReviewProfile(workspace({ "go.mod": "module x\n" }))).toBe(LANGUAGE_REVIEW_PROFILE);
    expect(languageReviewProfile(workspace({ "package.json": "{}" }))).toBeNull();
  });
  test("workspace facts list .NET, Go, Rust and Maven manifests", () => {
    const root = workspace({
      "App.slnx": "<Solution />",
      "src/App/App.csproj": "<Project />",
      "global.json": "{}",
      "go.mod": "module x\n",
      "Program.cs": "",
    });
    expect(workspaceFacts(root).manifests).toEqual(["App.slnx", "global.json", "go.mod", "src/App/App.csproj"]);
  });
});

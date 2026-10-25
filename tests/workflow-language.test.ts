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
  touchesLanguageFiles,
} from "../src/core/workflows/language.js";
import { fixturePolicy, workflowFixture } from "./helpers/workflow-fixture.js";
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
    expect(detectLanguages(workspace({ "composer.json": "{}" }))).toEqual(["php"]);
    // A Lua project has a rockspec or the config of its tools (#1495).
    expect(detectLanguages(workspace({ "calc-0.1-1.rockspec": "package = 'calc'\n" }))).toEqual(["lua"]);
    expect(detectLanguages(workspace({ ".luacheckrc": "std = 'max'\n" }))).toEqual(["lua"]);
    // A Ruby application has a Gemfile; a gem may have only its gemspec (#1493).
    expect(detectLanguages(workspace({ Gemfile: "gem 'rspec'\n" }))).toEqual(["ruby"]);
    expect(detectLanguages(workspace({ "calc.gemspec": "Gem::Specification.new\n" }))).toEqual(["ruby"]);
    expect(detectLanguages(workspace({ "pubspec.yaml": "name: calc\n" }))).toEqual(["dart"]);
    expect(detectLanguages(workspace({ "build.sbt": "" }))).toEqual(["scala"]);
    expect(detectLanguages(workspace({ "Package.swift": "" }))).toEqual(["swift"]);
    expect(detectLanguages(workspace({ "package.json": "{}" }))).toEqual([]);
    // A module manifest or PSScriptAnalyzer settings (#1498); a script alone is not a project.
    expect(detectLanguages(workspace({ "Sum.psd1": "@{}" }))).toEqual(["powershell"]);
    expect(detectLanguages(workspace({ "PSScriptAnalyzerSettings.psd1": "@{}" }))).toEqual(["powershell"]);
    expect(detectLanguages(workspace({ "build.ps1": "" }))).toEqual([]);
    expect(touchesLanguageFiles(["src/Sum.psm1"])).toBe(true);
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

describe("language review scope", () => {
  test("language files are recognized by extension and manifest name", () => {
    expect(touchesLanguageFiles(["cmd/main.go"])).toBe(true);
    expect(touchesLanguageFiles(["src\\App\\Program.cs"])).toBe(true);
    expect(touchesLanguageFiles(["Cargo.toml"])).toBe(true);
    expect(touchesLanguageFiles(["service/pom.xml"])).toBe(true);
    expect(touchesLanguageFiles(["src/Sum.php"])).toBe(true);
    expect(touchesLanguageFiles(["composer.json"])).toBe(true);
    expect(touchesLanguageFiles(["src/calc.lua", "calc-0.1-1.rockspec"])).toBe(true);
    expect(touchesLanguageFiles([".luacheckrc"])).toBe(true);
    expect(touchesLanguageFiles(["lib/calc.rb", "Gemfile"])).toEqual(true);
    expect(touchesLanguageFiles(["Gemfile.lock"])).toBe(true);
    expect(touchesLanguageFiles(["README.md", "scripts/run.sh", "docs/go.md"])).toBe(false);
  });

  async function reviewDimensions(language: string, prompts?: string[]) {
    const policy = { ...fixturePolicy, reviewProfiles: { ...fixturePolicy.reviewProfiles, language } };
    const fixture = workflowFixture({ policy });
    try {
      const run = await fixture.start();
      for (let i = 0; i < 12; i++) {
        const state = await fixture.service.get(run.runId);
        if (state.status === "completed") break;
        if (state.pendingRequestIds.length) await fixture.approve(run.runId);
        else if (state.status === "paused" || state.status === "created") await fixture.resume(run.runId);
        await fixture.service.drive(run.runId, new AbortController().signal);
      }
      expect((await fixture.service.get(run.runId)).status).toBe("completed");
      prompts?.push(...(fixture.executor.prompts.review ?? []));
      return fixture.service.store
        .steps(run.runId)
        .map((step) => step.stage_id)
        .filter((stage) => stage.startsWith("dimension-"));
    } finally {
      await fixture.dispose();
    }
  }

  test("the host-added language reviewer skips a change with no language files", async () => {
    // The fixture task writes value.txt only.
    expect(await reviewDimensions(LANGUAGE_REVIEW_PROFILE)).not.toContain("dimension-language");
  });

  test("a language reviewer the policy names always runs", async () => {
    expect(await reviewDimensions("reviewer")).toContain("dimension-language");
  });

  test("the language review sees the request and the diff, not the spec, plan or check output", async () => {
    const prompts: string[] = [];
    await reviewDimensions("reviewer", prompts);
    const parse = (prompt: string) => {
      const lines = prompt.split("\n");
      return {
        documents: JSON.parse(lines.at(-2) ?? "{}") as Record<string, unknown>,
        extra: (JSON.parse(lines.at(-1) ?? "{}") as { extra: Record<string, unknown> }).extra,
      };
    };
    const language = prompts.map(parse).find((p) => p.extra.dimension === "language");
    const correctness = prompts.map(parse).find((p) => p.extra.dimension === "correctness");
    expect(Object.keys(language?.documents ?? {})).toEqual(["request"]);
    expect(language?.extra.diffReview).toBeUndefined();
    const kinds = (language?.extra.evidence as { kind: string }[]).map((e) => e.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((kind) => kind === "diff")).toBe(true);
    // The other dimensions keep the full context.
    expect(correctness?.documents.spec).toBeDefined();
    expect((correctness?.extra.evidence as { kind: string }[]).some((e) => e.kind === "command")).toBe(true);
  });
});

import { fileSymlinksAvailable } from "./helpers/symlinks.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/core/context/manager.js";
import { buildInstructionPrompt, loadInstructions } from "../src/core/instructions.js";

const INSTRUCTIONS_MODULE_URL = new URL("../src/core/instructions.ts", import.meta.url).href;

function loadInstructionsInFreshProcess(
  projectDir: string,
  homeDir: string,
): ReturnType<typeof loadInstructions> {
  const script = `
    import { loadInstructions } from ${JSON.stringify(INSTRUCTIONS_MODULE_URL)};

    const projectDir = process.env.PROJECT_DIR;
    if (!projectDir) throw new Error("PROJECT_DIR missing");

    const loaded = loadInstructions(projectDir, ["baked"]);
    process.stdout.write(JSON.stringify(loaded));
  `;

  return JSON.parse(
    execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        PROJECT_DIR: projectDir,
        USERPROFILE: homeDir,
      },
    }),
  ) as ReturnType<typeof loadInstructions>;
}

describe("instruction loading", () => {
  let rootDir: string;
  let projectDir: string;
  let homeDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "sf-instructions-"));
    projectDir = join(rootDir, "project");
    homeDir = join(rootDir, "home");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("loads project-local instructions when no global file exists", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "project codex");

    const loaded = loadInstructions(projectDir, ["codex"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "codex",
      file: "AGENTS.md",
      scope: "project",
      content: "project codex",
    });
    expect(buildInstructionPrompt(loaded)).toBe("Project instructions:\n[AGENTS.md]\nproject codex");
  });

  it("loads global instructions from the home directory", () => {
    mkdirSync(join(homeDir, ".baked"), { recursive: true });
    writeFileSync(join(homeDir, ".baked", "baked.md"), "global baked");

    const loaded = loadInstructions(projectDir, ["baked"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "baked",
      file: ".baked/baked.md",
      scope: "global",
      content: "global baked",
    });
  });

  it("includes both project-local and global instructions in the prompt", () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "project codex");
    mkdirSync(join(homeDir, ".agents"), { recursive: true });
    writeFileSync(join(homeDir, ".agents", "instructions.md"), "global codex");

    const loaded = loadInstructions(projectDir, ["codex"], { homeDir });
    const prompt = buildInstructionPrompt(loaded);

    expect(loaded.map((inst) => inst.scope)).toEqual(["project", "global"]);
    expect(prompt).toContain(
      "Global instruction files apply across all projects, but project-local instruction files take priority when they conflict.",
    );
    expect(prompt).toContain("Project-local instruction files:");
    expect(prompt).toContain("[project:AGENTS.md]");
    expect(prompt).toContain("project codex");
    expect(prompt).toContain("[global:.agents/instructions.md]");
    expect(prompt).toContain("global codex");
    expect(prompt.indexOf("Global instruction files apply across all projects")).toBeLessThan(
      prompt.indexOf("[project:AGENTS.md]"),
    );
    expect(prompt.indexOf("project codex")).toBeGreaterThan(prompt.indexOf("global codex"));
  });

  it("keeps both scopes when project and global instructions share source", () => {
    writeFileSync(join(projectDir, "baked.md"), "project baked");
    mkdirSync(join(homeDir, ".baked"), { recursive: true });
    writeFileSync(join(homeDir, ".baked", "baked.md"), "global baked");

    const loaded = loadInstructions(projectDir, ["baked"], { homeDir });
    const prompt = buildInstructionPrompt(loaded);

    expect(loaded.map((inst) => inst.scope)).toEqual(["project", "global"]);
    expect(loaded.map((inst) => inst.content)).toEqual(["project baked", "global baked"]);
    expect(loaded.map((inst) => inst.file)).toEqual(["baked.md", ".baked/baked.md"]);
    expect(prompt.indexOf("project baked")).toBeGreaterThan(prompt.indexOf("global baked"));
  });

  it("loads global instructions from homedir() by default in fresh process", () => {
    mkdirSync(join(homeDir, ".baked"), { recursive: true });
    writeFileSync(join(homeDir, ".baked", "baked.md"), "global baked");

    const loaded = loadInstructionsInFreshProcess(projectDir, homeDir);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "baked",
      file: ".baked/baked.md",
      scope: "global",
      content: "global baked",
    });
  });

  it("dedupes project and global roots when they resolve to same directory", () => {
    writeFileSync(join(projectDir, "baked.md"), "project baked");
    const linkedHome = join(rootDir, "linked-home");
    symlinkSync(projectDir, linkedHome, process.platform === "win32" ? "junction" : "dir");

    const loaded = loadInstructions(`${projectDir}/`, ["baked"], { homeDir: linkedHome });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "baked",
      file: "baked.md",
      scope: "project",
      content: "project baked",
    });
  });

  it.skipIf(!fileSymlinksAvailable)("dedupes symlinked global file targeting project instruction", () => {
    writeFileSync(join(projectDir, "baked.md"), "project baked");
    mkdirSync(join(homeDir, ".baked"), { recursive: true });
    symlinkSync(join(projectDir, "baked.md"), join(homeDir, ".baked", "baked.md"));

    const loaded = loadInstructions(projectDir, ["baked"], { homeDir });

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      source: "baked",
      file: "baked.md",
      scope: "project",
      content: "project baked",
    });
  });

  it("invalidates ContextManager instruction cache key when instructions change", () => {
    const ctx = Object.create(ContextManager.prototype) as ContextManager;
    Object.assign(ctx as object, {
      repoMapGeneration: 0,
      skills: new Map(),
      memoryManager: { generation: 0 },
      bakeMode: "default",
      projectInstructions: "",
      projectInstructionsVersion: 0,
      isChild: false,
    });

    const before = ctx.getInstructionsCacheKey("anthropic/claude-sonnet-4-6");
    ctx.setProjectInstructions("global baked");
    const after = ctx.getInstructionsCacheKey("anthropic/claude-sonnet-4-6");

    expect(after).not.toBe(before);
    expect(after).toContain("|pi1");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editInstructionFile,
  listInstructionFiles,
  sha256,
  toggledInstructionSources,
  writeInstructionFile,
} from "../src/core/instruction-files.js";
import { removeTempDir } from "./helpers/temp-dir.js";

describe("instruction files for the front ends", () => {
  let project: string;
  let home: string;
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "baked-instruction-files-"));
    project = join(root, "project");
    home = join(root, "home");
    mkdirSync(project);
    mkdirSync(home);
  });
  afterEach(async () => {
    await removeTempDir(join(project, ".."));
  });

  it("lists files of switched-off sources unnumbered and numbers the rest in prompt order", () => {
    writeFileSync(join(project, "baked.md"), "Project rules\n");
    writeFileSync(join(project, "CLAUDE.md"), "Claude rules\n");
    writeFileSync(join(home, "baked.md"), "Personal rules\n");
    const files = listInstructionFiles(project, undefined, { homeDir: home });
    expect(files.map((f) => [f.path, f.scope, f.order, f.enabled])).toEqual([
      ["baked.md", "project", 1, true],
      ["baked.md", "global", 2, true],
      ["CLAUDE.md", "project", null, false],
    ]);
    expect(files[0]?.hash).toBe(sha256("Project rules\n"));
    expect(files[2]?.sourceLabel).toBe("CLAUDE.md");
    const on = listInstructionFiles(project, ["claude"], { homeDir: home });
    expect(on.map((f) => [f.path, f.enabled])).toEqual([
      ["baked.md", false],
      ["baked.md", false],
      ["CLAUDE.md", true],
    ]);
  });

  it("switches sources in source order, starting from the defaults", () => {
    expect(toggledInstructionSources(undefined, "codex", true)).toEqual(["baked", "codex"]);
    expect(toggledInstructionSources(["codex", "claude"], "baked", true)).toEqual([
      "baked",
      "claude",
      "codex",
    ]);
    expect(toggledInstructionSources(undefined, "baked", false)).toEqual([]);
  });

  it("writes only with the hash that was read and creates files a source reads", () => {
    writeFileSync(join(project, "baked.md"), "v1\n");
    const files = listInstructionFiles(project, undefined, { homeDir: home });
    const hash = files[0]?.hash ?? "";
    expect(writeInstructionFile(project, files, "baked.md", "v2\n", hash).status).toBe("saved");
    expect(writeInstructionFile(project, files, "baked.md", "v3\n", hash).status).toBe("changed");
    expect(readFileSync(join(project, "baked.md"), "utf8")).toBe("v2\n");
    expect(writeInstructionFile(project, files, "notes.md", "x", null).status).toBe("unknown");
    expect(writeInstructionFile(project, files, ".agents/instructions.md", "a\n", null).status).toBe(
      "saved",
    );
    expect(readFileSync(join(project, ".agents", "instructions.md"), "utf8")).toBe("a\n");
  });

  it("edits a file in the editor, keeping an edit that lost a race in a temporary file", async () => {
    writeFileSync(join(project, "baked.md"), "Rules\n");
    const editor = (next: string, before?: () => void) => ({
      homeDir: home,
      env: { EDITOR: "fake" },
      run: async (invocation: { args: string[]; cmd: string }) => {
        const file = invocation.args.at(-1) ?? invocation.cmd.split('"')[1] ?? "";
        before?.();
        writeFileSync(file, next);
        return 0;
      },
    });
    const saved = await editInstructionFile(project, undefined, "baked.md", editor("Rules v2\n"));
    expect(saved).toMatchObject({ status: "saved", created: false, enabled: true, affectedRuns: [] });
    expect(readFileSync(join(project, "baked.md"), "utf8")).toBe("Rules v2\n");

    const same = await editInstructionFile(project, undefined, "baked.md", editor("Rules v2\n"));
    expect(same.status).toBe("unchanged");

    const raced = await editInstructionFile(
      project,
      undefined,
      "baked.md",
      editor("Mine\n", () => writeFileSync(join(project, "baked.md"), "Theirs\n")),
    );
    expect(raced.status).toBe("conflict");
    if (raced.status !== "conflict") throw new Error("expected a conflict");
    expect(readFileSync(join(project, "baked.md"), "utf8")).toBe("Theirs\n");
    expect(readFileSync(raced.keptAt, "utf8")).toBe("Mine\n");

    const created = await editInstructionFile(project, undefined, "AGENTS.md", editor("Agents"));
    expect(created).toMatchObject({ status: "saved", created: true, enabled: false });
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("Agents\n");

    const unknown = await editInstructionFile(project, undefined, "notes.md", editor("x"));
    expect(unknown.status).toBe("error");
  });
});

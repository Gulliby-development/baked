import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNewProject, createProject } from "../src/core/projects/create.js";
import { listKnownProjects } from "../src/core/projects/known.js";
import { readManifest } from "../src/core/projects/manifest.js";
import {
  folderNameError,
  projectFolderName,
  projectNameError,
} from "../src/core/projects/new-project.js";
import { realPath } from "../src/core/projects/paths.js";
import { clearProjectCache } from "../src/core/projects/resolve.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  clearProjectCache();
});

function layout() {
  const base = realPath(mkdtempSync(join(tmpdir(), "baked-create-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const profile = join(base, "profile");
  mkdirSync(profile);
  return { base, opts: { configDir: profile } };
}

describe("new project names", () => {
  test("suggests a folder name from the project name", () => {
    expect(projectFolderName("My New App")).toBe("my-new-app");
    expect(projectFolderName("  Weird / name: v2!  ")).toBe("weird-name-v2");
    expect(projectFolderName("Café über")).toBe("café-über");
    expect(projectFolderName("???")).toBe("project");
    expect(projectFolderName("CON")).toBe("project");
  });

  test("refuses empty or long names and unsafe folder names", () => {
    expect(projectNameError("  ")).not.toBeNull();
    expect(projectNameError("x".repeat(121))).not.toBeNull();
    expect(projectNameError("Fine")).toBeNull();
    expect(folderNameError("a/b")).not.toBeNull();
    expect(folderNameError("..")).not.toBeNull();
    expect(folderNameError("nul")).not.toBeNull();
    expect(folderNameError("trailing.")).not.toBeNull();
    expect(folderNameError("my-app")).toBeNull();
  });
});

describe("createProject", () => {
  test("makes the folder, names the manifest and lists the project", () => {
    const { base, opts } = layout();
    const folder = join(base, "work", "my-app");
    expect(checkNewProject(folder, "My App", opts)).toEqual({
      path: folder,
      creates: true,
      error: null,
    });
    const { project, created } = createProject({ folder, name: " My App " }, opts);
    expect(project.path).toBe(folder);
    expect(project.name).toBe("My App");
    expect(created).toContain("baked/project.json");
    expect(readManifest(folder)?.name).toBe("My App");
    expect(listKnownProjects(opts).map((p) => p.path)).toEqual([folder]);
  });

  test("uses an existing empty folder", () => {
    const { base, opts } = layout();
    const folder = join(base, "empty");
    mkdirSync(folder);
    expect(checkNewProject(folder, "Empty", opts).creates).toBe(false);
    expect(createProject({ folder, name: "Empty" }, opts).project.name).toBe("Empty");
  });

  test("refuses a folder that is not empty and writes nothing", () => {
    const { base, opts } = layout();
    const folder = join(base, "busy");
    mkdirSync(folder);
    writeFileSync(join(folder, "notes.txt"), "x");
    expect(checkNewProject(folder, "Busy", opts).error).toContain("not empty");
    expect(() => createProject({ folder, name: "Busy" }, opts)).toThrow("not empty");
    expect(existsSync(join(folder, "baked"))).toBe(false);
    expect(listKnownProjects(opts)).toEqual([]);
  });

  test("refuses a file, a drive root, the home folder, a relative path and a bad name", () => {
    const { base, opts } = layout();
    const file = join(base, "file.txt");
    writeFileSync(file, "x");
    expect(checkNewProject(file, "F", opts).error).toContain("file");
    expect(checkNewProject(join(file, "child"), "F", opts).error).toContain("file");
    expect(checkNewProject(realPath("/"), "Root", opts).error).toContain("drive root");
    const previousHome = process.env.HOME;
    const home = join(base, "home");
    mkdirSync(home);
    process.env.HOME = home;
    try {
      expect(checkNewProject(home, "Home", opts).error).toContain("home folder");
    } finally {
      process.env.HOME = previousHome;
    }
    expect(checkNewProject("relative/app", "R", opts).error).toContain("absolute");
    expect(checkNewProject(join(base, "x"), "", opts).error).toContain("name");
    expect(checkNewProject(join(base, "x"), "x".repeat(121), opts).error).toContain("120");
  });

  test("keeps the name in the list when a registered project already covers the folder", () => {
    const { base, opts } = layout();
    const outer = join(base, "outer");
    createProject({ folder: outer, name: "Outer" }, opts);
    clearProjectCache();
    const inner = join(outer, "inner");
    const { project } = createProject({ folder: inner, name: "Inner" }, opts);
    expect(readManifest(inner)).toBeNull();
    expect(project.name).toBe("Inner");
  });
});

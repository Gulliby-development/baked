import { describe, expect, test } from "bun:test";
import { checkDraft, newProjectFolder } from "../src/main/new-project.js";
import {
  defaultLocation,
  draftOf,
  folderOf,
  type NewProjectForm,
  parentFolder,
} from "../src/renderer/components/new-project-model.js";
import type { DesktopProject } from "../src/shared/api.js";

const form = (patch: Partial<NewProjectForm> = {}): NewProjectForm => ({
  name: "My App",
  parent: "/home/you/code",
  folderEdit: null,
  useParent: false,
  ...patch,
});

describe("Create project form", () => {
  test("finds the parent of POSIX and Windows paths", () => {
    expect(parentFolder("/home/you/code/app")).toBe("/home/you/code");
    expect(parentFolder("/app")).toBe("/");
    expect(parentFolder("C:\\Project\\BAKED")).toBe("C:\\Project");
    expect(parentFolder("C:\\BAKED")).toBe("C:\\");
    expect(parentFolder("app")).toBeNull();
  });

  test("starts next to the most recently opened project", () => {
    const projects = [
      { path: "/old/one", lastOpenedAt: 1 },
      { path: "/new/two", lastOpenedAt: 5 },
    ] as DesktopProject[];
    expect(defaultLocation(projects)).toBe("/new");
    expect(defaultLocation([])).toBeNull();
  });

  test("the folder name follows the project name until edited", () => {
    expect(folderOf(form())).toBe("my-app");
    expect(folderOf(form({ name: "  " }))).toBe("");
    expect(folderOf(form({ folderEdit: "mine" }))).toBe("mine");
  });

  test("sends a subfolder, the folder itself, or nothing without a location", () => {
    expect(draftOf(form())).toEqual({ name: "My App", parent: "/home/you/code", folder: "my-app" });
    expect(draftOf(form({ useParent: true }))?.folder).toBeNull();
    expect(draftOf(form({ parent: null }))).toBeNull();
  });
});

describe("Create project in the main process", () => {
  test("joins the location and the folder name, or uses the location itself", () => {
    expect(newProjectFolder({ name: "A", parent: "/tmp/x", folder: "a" })).toMatch(/[\\/]tmp[\\/]x[\\/]a$/);
    expect(newProjectFolder({ name: "A", parent: "/tmp/x", folder: null })).toBe("/tmp/x");
  });

  test("refuses a relative location and a folder name with a separator", () => {
    expect(() => newProjectFolder({ name: "A", parent: "rel", folder: "a" })).toThrow("Browse");
    expect(() => newProjectFolder({ name: "A", parent: "/tmp", folder: "../up" })).toThrow();
  });

  test("answers form problems itself and asks the backend otherwise", async () => {
    const asked: string[] = [];
    const check = async (folder: string) => {
      asked.push(folder);
      return { path: folder, creates: true, error: null };
    };
    expect((await checkDraft({ name: "", parent: "/tmp", folder: "a" }, check)).error).toBe(
      "Enter a project name.",
    );
    expect((await checkDraft({ name: "A", parent: "/tmp", folder: "a/b" }, check)).path).toBe("");
    expect(asked).toEqual([]);
    expect((await checkDraft({ name: "A", parent: "/tmp", folder: null }, check)).error).toBeNull();
    expect(asked).toEqual(["/tmp"]);
  });
});

import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { configDir as defaultConfigDir } from "../platform/index.js";
import {
  addKnownProject,
  type KnownProject,
  type KnownProjectOptions,
  listKnownProjects,
  renameKnownProject,
} from "./known.js";
import { readManifest } from "./manifest.js";
import { projectNameError } from "./new-project.js";
import { realPath } from "./paths.js";
import { scaffoldProject } from "./scaffold.js";

export interface NewProjectCheck {
  /** The absolute folder the project would live in. */
  path: string;
  /** Whether the folder has to be created. */
  creates: boolean;
  /** Why the project cannot be created there, or null. */
  error: string | null;
}

export interface CreatedProject {
  project: KnownProject;
  /** Workspace-relative paths the scaffold wrote. */
  created: string[];
}

/** The deepest part of `path` that exists, so a new folder's permissions can be checked. */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Checks a new project without writing anything: the folder must be missing or an empty folder,
 * not the home folder, a drive root or BAKED's config directory, and writable.
 */
export function checkNewProject(
  folder: string,
  name: string,
  opts: KnownProjectOptions = {},
): NewProjectCheck {
  const path = existsSync(folder) ? realPath(folder) : resolve(folder);
  const fail = (error: string, creates = false): NewProjectCheck => ({ path, creates, error });
  if (!isAbsolute(folder)) return fail("Choose an absolute folder path.");
  const nameError = projectNameError(name);
  if (nameError) return fail(nameError);
  const home = realPath(process.env.HOME ?? homedir());
  const config = opts.configDir ?? defaultConfigDir();
  if (path === parse(path).root) return fail(`${path} is a drive root, not a project folder.`);
  if (path === home) return fail("The home folder cannot be a project; choose a folder inside it.");
  if (existsSync(config) && path === realPath(config))
    return fail(`${path} holds BAKED's own settings.`);
  if (existsSync(path)) {
    if (!statSync(path).isDirectory()) return fail(`${path} is a file, not a folder.`);
    if (readdirSync(path).length > 0)
      return fail(
        `${path} is not empty. Choose an empty folder, or open it as an existing folder.`,
      );
    if (listKnownProjects(opts).some((p) => p.path === path))
      return fail(`${path} is already in the project list.`);
  }
  const creates = !existsSync(path);
  const base = existingAncestor(path);
  if (!statSync(base).isDirectory()) return fail(`${base} is a file, not a folder.`, creates);
  try {
    accessSync(base, constants.W_OK);
  } catch {
    return fail(`No permission to write in ${base}.`, creates);
  }
  return { path, creates, error: null };
}

/**
 * Creates a project in a new or empty folder: makes the folder, writes `baked/project.json` with
 * `name` (see scaffoldProject) and adds the folder to the project list under that name. Every
 * front end (TUI picker, `baked projects create`, the desktop dialog) goes through here.
 */
export function createProject(
  input: { folder: string; name: string; id?: string },
  opts: KnownProjectOptions = {},
): CreatedProject {
  const check = checkNewProject(input.folder, input.name, opts);
  if (check.error) throw new Error(check.error);
  const name = input.name.trim();
  mkdirSync(check.path, { recursive: true });
  const configDir = opts.configDir ? { configDir: opts.configDir } : {};
  const scaffold = scaffoldProject(check.path, {
    ...configDir,
    name,
    ...(input.id ? { id: input.id } : {}),
  });
  if (scaffold.skipped)
    throw new Error(`${check.path} is ${scaffold.skipped}; nothing was created.`);
  let project = addKnownProject(scaffold.root, opts);
  // A folder inside a registered project gets no manifest, so the list keeps the name instead.
  if (readManifest(scaffold.root)?.name !== name)
    project = renameKnownProject(scaffold.root, name, opts);
  return { project, created: scaffold.created };
}

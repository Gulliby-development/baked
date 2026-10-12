import { execFile } from "node:child_process";
import type { KnownProject, NewProjectCheck } from "../shared/api.js";
import type { BackendCommand } from "./backend-command.js";

export type CliRunner = (args: string[]) => Promise<string>;

/** Runs a short `baked` subcommand and returns its stdout. */
export function cliRunner(command: BackendCommand): CliRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        command.command,
        [...command.prefix, ...args],
        { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error) reject(new Error(stderr.trim() || error.message));
          else resolve(stdout);
        },
      );
    });
}

/** The project list as `baked projects list --json` prints it; works before any backend runs. */
export async function listKnownProjects(run: CliRunner): Promise<KnownProject[]> {
  const parsed = JSON.parse(await run(["projects", "list", "--json"])) as {
    projects?: KnownProject[];
  };
  if (!Array.isArray(parsed.projects)) throw new Error("baked projects list returned no projects");
  return parsed.projects;
}

export async function addKnownProject(run: CliRunner, folder: string): Promise<void> {
  await run(["projects", "add", folder]);
}

/** `baked projects create PATH --name NAME --check --json`: whether a project can be created. */
export async function checkNewProject(
  run: CliRunner,
  folder: string,
  name: string,
): Promise<NewProjectCheck> {
  const parsed = JSON.parse(
    await run(["projects", "create", folder, "--name", name, "--check", "--json"]),
  ) as Partial<NewProjectCheck>;
  if (typeof parsed.path !== "string") throw new Error("baked projects create returned no path");
  return { path: parsed.path, creates: parsed.creates === true, error: parsed.error ?? null };
}

/** Creates the folder, scaffolds it with `name` and adds it to the project list. */
export async function createKnownProject(
  run: CliRunner,
  folder: string,
  name: string,
): Promise<string> {
  const parsed = JSON.parse(
    await run(["projects", "create", folder, "--name", name, "--json"]),
  ) as { project?: { path?: string } };
  if (typeof parsed.project?.path !== "string")
    throw new Error("baked projects create returned no project");
  return parsed.project.path;
}

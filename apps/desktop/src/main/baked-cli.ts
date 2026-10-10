import { execFile } from "node:child_process";
import type { KnownProject } from "../shared/api.js";
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

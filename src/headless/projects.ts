import { basename, resolve } from "node:path";
import { getCwd } from "../core/cwd.js";
import { checkNewProject, createProject } from "../core/projects/create.js";
import {
  addKnownProject,
  forgetKnownProject,
  type KnownProject,
  listKnownProjects,
  renameKnownProject,
  setProjectPinned,
} from "../core/projects/known.js";
import { type ProjectOverview, projectOverview } from "../core/projects/overview.js";
import { scaffoldProjectQuietly } from "../core/projects/scaffold.js";

const help = `Usage: baked projects [command]

Commands:
  list [--json]         Folders BAKED was opened in, pinned first (the default)
  add [PATH]            Add a folder without opening it (default: this directory)
  create PATH [--name NAME] [--check] [--json]
                        Create a project in a new or empty folder: make the folder, write
                        baked/project.json with NAME (default: the folder name) and add it
                        to the list. --check only reports whether it can be created.
  pin [PATH]            Keep a folder at the top of the list
  unpin [PATH]
  rename [PATH] NAME    Show the folder under NAME ("" restores the default name)
  forget [PATH]         Remove a folder from the list; its sessions and runs stay in it

Each folder keeps its own sessions and workflow runs in .baked/. Open a project with
"baked --cwd PATH" or from the project picker (/projects) in the terminal UI.
`;

function age(at: number | null, now: number): string {
  if (at === null) return "never";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function line(project: KnownProject, overview: ProjectOverview, now: number): string {
  const parts = [
    `${overview.sessions} session${overview.sessions === 1 ? "" : "s"}`,
    `${overview.activeRuns} active run${overview.activeRuns === 1 ? "" : "s"}`,
  ];
  if (overview.attention) parts.push(`${overview.attention} waiting`);
  if (!project.exists) parts.push("missing");
  const mark = project.pinned ? "*" : " ";
  return `${mark} ${project.name}  ${project.path}  ${parts.join(", ")}  opened ${age(project.lastOpenedAt, now)}`;
}

function createCommand(args: string[], folder: (arg: string | undefined) => string): number {
  const json = args.includes("--json");
  const check = args.includes("--check");
  let name: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--name") name = args[++i];
    else if (arg.startsWith("--name=")) name = arg.slice("--name=".length);
    else if (arg !== "--json" && arg !== "--check") positional.push(arg);
  }
  if (!positional[0]) throw new Error("create needs a folder path.");
  if (name === undefined && args.includes("--name")) throw new Error("--name needs a value.");
  const path = folder(positional[0]);
  const projectName = name ?? basename(path);
  if (check) {
    const result = checkNewProject(path, projectName);
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (result.error) process.stdout.write(`${result.error}\n`);
    else
      process.stdout.write(
        `${projectName} can be created in ${result.path}${result.creates ? " (new folder)" : ""}.\n`,
      );
    // With --json the verdict is in the output, so callers can read it without an exit code.
    return result.error && !json ? 1 : 0;
  }
  const { project, created } = createProject({ folder: path, name: projectName });
  if (json) process.stdout.write(`${JSON.stringify({ project, created }, null, 2)}\n`);
  else
    process.stdout.write(
      `Created ${project.name} in ${project.path}. Open it with "baked --cwd ${project.path}".\n`,
    );
  return 0;
}

export async function runProjectsCli(argv: string[]): Promise<number> {
  const [command = "list", ...rest] = argv;
  if (command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return 0;
  }
  const folder = (arg: string | undefined): string => resolve(getCwd(), arg ?? ".");
  try {
    switch (command) {
      case "list":
      case "--json": {
        const json = command === "--json" || rest.includes("--json");
        const now = Date.now();
        const projects = listKnownProjects().map((project) => ({
          ...project,
          overview: projectOverview(project.path),
        }));
        if (json) {
          process.stdout.write(`${JSON.stringify({ projects }, null, 2)}\n`);
          return 0;
        }
        if (projects.length === 0) {
          process.stdout.write(
            'No projects yet. Open BAKED in a folder or run "baked projects add".\n',
          );
          return 0;
        }
        for (const { overview, ...project } of projects)
          process.stdout.write(`${line(project, overview, now)}\n`);
        return 0;
      }
      case "add": {
        const project = addKnownProject(folder(rest[0]));
        scaffoldProjectQuietly(project.path);
        process.stdout.write(`Added ${project.name} (${project.path}).\n`);
        return 0;
      }
      case "create":
        return createCommand(rest, folder);
      case "pin":
      case "unpin": {
        const project = setProjectPinned(folder(rest[0]), command === "pin");
        process.stdout.write(`${command === "pin" ? "Pinned" : "Unpinned"} ${project.name}.\n`);
        return 0;
      }
      case "rename": {
        const [path, name] = rest.length >= 2 ? rest : [undefined, rest[0]];
        if (name === undefined) throw new Error("rename needs a name.");
        const project = renameKnownProject(folder(path), name);
        process.stdout.write(`Renamed to ${project.name}.\n`);
        return 0;
      }
      case "forget": {
        const path = folder(rest[0]);
        if (!forgetKnownProject(path)) throw new Error(`${path} is not in the project list.`);
        process.stdout.write(`Forgot ${path}. Its sessions and runs stay in the folder.\n`);
        return 0;
      }
      default:
        process.stderr.write(`Unknown projects command: ${command}\n\n${help}`);
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

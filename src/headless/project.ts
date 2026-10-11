import { getCwd } from "../core/cwd.js";
import { readManifest } from "../core/projects/manifest.js";
import { scaffoldProject } from "../core/projects/scaffold.js";
import { ProjectService, type ProjectSummary } from "../core/projects/service.js";

const help = `Usage: baked project <command>

Commands:
  init [--name NAME] [--id ID] [--root PATH]...
                     Set up this folder: baked/project.json (registered for
                     you), .baked/ and the workflow store; keeps what exists
  show [--json]      The project, its working set, sessions and runs
  add <path|glob>... Add entries to the working set
  remove <entry>...  Remove entries from the working set
  register           Trust the secondary roots baked/project.json names now

The working set goes into the chat context at the start of each session and into the first
agents of each workflow run. Roots outside this checkout are used only after "register".
`;

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function options(argv: string[], name: string): string[] {
  return argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function render(summary: ProjectSummary): string {
  const lines = [`${summary.name} (${summary.id})`, `Roots: ${summary.roots.join(", ")}`];
  if (summary.ignoredRoots.length)
    lines.push(
      `Not trusted (run "baked project register" to use): ${summary.ignoredRoots.join(", ")}`,
    );
  lines.push("", `Working set (${summary.workingSet.files.length} files):`);
  for (const file of summary.workingSet.files) lines.push(`  ${file.path}  ${kb(file.bytes)}`);
  for (const skip of summary.workingSet.skipped)
    lines.push(`  skipped ${skip.path}: ${skip.reason}`);
  if (summary.instructions.files.length || summary.instructions.skipped.length) {
    lines.push("", "Instructions:");
    for (const file of summary.instructions.files) lines.push(`  ${file}`);
    for (const skip of summary.instructions.skipped) lines.push(`  skipped ${skip}`);
  }
  lines.push("", `Sessions (${summary.sessions.length}):`);
  for (const s of summary.sessions)
    lines.push(`  ${new Date(s.updatedAt).toISOString()}  ${s.title}  [${s.root}]`);
  lines.push("", `Workflow runs (${summary.runs.length}):`);
  for (const r of summary.runs)
    lines.push(`  ${r.runId}  ${r.featureId}  ${r.status}  [${r.root}]`);
  return `${lines.join("\n")}\n`;
}

export async function runProjectCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help")) {
    process.stdout.write(help);
    return command ? 0 : 1;
  }
  const service = new ProjectService(getCwd());
  try {
    switch (command) {
      case "init": {
        const id = option(rest, "--id");
        const name = option(rest, "--name");
        const roots = options(rest, "--root");
        // Explicit options describe a new manifest; without them init completes a partial setup.
        if ((id || name || roots.length) && readManifest(getCwd()))
          throw new Error(
            "This directory already has baked/project.json; edit it or use add/remove.",
          );
        const result = scaffoldProject(getCwd(), {
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
          roots,
        });
        if (result.skipped) throw new Error(`BAKED does not set up ${result.skipped}.`);
        process.stdout.write(
          result.created.length
            ? `Created ${result.created.join(", ")}.\n`
            : "This project is already set up.\n",
        );
        return 0;
      }
      case "show": {
        const summary = service.summary();
        process.stdout.write(
          rest.includes("--json") ? `${JSON.stringify(summary, null, 2)}\n` : render(summary),
        );
        return 0;
      }
      case "add":
      case "remove": {
        if (rest.length === 0) throw new Error(`${command} needs at least one path or glob.`);
        const project =
          command === "add" ? service.addToWorkingSet(rest) : service.removeFromWorkingSet(rest);
        process.stdout.write(
          `Working set: ${project.manifest.workingSet.join(", ") || "(empty)"}\n`,
        );
        return 0;
      }
      case "register": {
        const project = service.register();
        process.stdout.write(`Registered ${project.id} with roots ${project.roots.join(", ")}.\n`);
        return 0;
      }
      default:
        process.stderr.write(`Unknown project command: ${command}\n\n${help}`);
        return 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

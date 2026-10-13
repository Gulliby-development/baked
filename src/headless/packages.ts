import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config/index.js";
import { getCwd } from "../core/cwd.js";
import { PackageError } from "../core/packages/manifest.js";
import {
  describeInstall,
  describeInstalled,
  describePlan,
  describeRemoval,
  type InspectOptions,
  inspectPackage,
  installPackage,
  listPackages,
  removePackage,
} from "../core/packages/packages.js";
import { defaultWorkflowPolicy } from "../core/workflows/defaults.js";
import { PolicySchema } from "../core/workflows/schemas.js";

const help = `Usage: baked add PATH [--yes] [--overwrite] [--json]
       baked packages list|remove NAME [--json]

A package is a local folder with a baked-package.json that lists its agent profiles, skills,
workflow definitions and gates with their SHA-256 hashes (docs/packages.md). Installing copies
them into the project's baked/agents, baked/skills, baked/workflows and baked/gates after the
hashes and definitions check out, and records them in baked/packages.json.

Commands:
  add PATH [--yes] [--overwrite] [--json]
                          Show what the package would write; install it after a yes at the
                          prompt, or with --yes. --overwrite replaces project files that differ.
  packages list [--json]  Installed packages, with the files changed since the install
  packages remove NAME [--json]
                          Delete the package's files that are unchanged since the install;
                          edited files stay

--cwd DIR picks the project. Installed gates still need baked workflow gates confirm before a
run uses them. Exit codes:
0 done, 1 refused or not approved, 2 bad arguments, an unknown path or package.
`;

export interface PackagesCliDeps {
  workspace?: string;
  print?: (text: string) => void;
  /** Whether a person can answer a prompt; defaults to stdin and stdout being terminals. */
  isInteractive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** Validation settings; defaults to the configured run policy. */
  options?: InspectOptions;
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

function configuredOptions(): InspectOptions {
  const config = loadConfig();
  return { policy: PolicySchema.parse(config.workflows?.policy ?? defaultWorkflowPolicy) };
}

/** `baked add PATH` (argv starts with `add`) and `baked packages list|remove` (argv starts there). */
export async function runPackagesCli(argv: string[], deps: PackagesCliDeps = {}): Promise<number> {
  const workspace = deps.workspace ?? getCwd();
  const out = deps.print ?? ((text: string) => process.stdout.write(text));
  // boot.tsx already applied `--cwd DIR`, which picks the project.
  const args = argv.filter(
    (a, i) => a !== "--cwd" && !a.startsWith("--cwd=") && argv[i - 1] !== "--cwd",
  );
  const [command = "list", ...rest] = args;
  const json = rest.includes("--json");
  const positional = rest.filter((a) => !a.startsWith("--"));
  const unknown = rest.filter(
    (a) => a.startsWith("--") && !["--json", "--yes", "--overwrite", "--help"].includes(a),
  );
  const print = (value: unknown, lines: string[]) =>
    out(json ? `${JSON.stringify(value, null, 2)}\n` : `${lines.join("\n")}\n`);
  if (rest.includes("--help") || rest.includes("-h")) {
    out(help);
    return 0;
  }
  if (unknown.length) {
    process.stderr.write(`Unknown option ${unknown[0]}\n${help}`);
    return 2;
  }
  try {
    switch (command) {
      case "--help":
      case "-h":
      case "help":
        out(help);
        return 0;
      case "add": {
        const [path] = positional;
        if (!path || positional.length > 1) break;
        const options = deps.options ?? configuredOptions();
        const plan = inspectPackage(path, workspace, options);
        const overwrite = rest.includes("--overwrite");
        const refusal = plan.problems.length
          ? "The package cannot be installed."
          : plan.overwrites > 0 && !overwrite
            ? "Run again with --overwrite to replace the differing project files."
            : null;
        if (refusal) {
          print({ plan, installed: false }, [...describePlan(plan), refusal]);
          return 1;
        }
        let approved = rest.includes("--yes");
        if (
          !approved &&
          !json &&
          (deps.isInteractive ?? (process.stdin.isTTY && process.stdout.isTTY))
        ) {
          out(`${describePlan(plan).join("\n")}\n`);
          approved = await (deps.confirm ?? ask)(`Install ${plan.name} ${plan.version}?`);
          if (!approved) {
            out("Not installed.\n");
            return 1;
          }
          const result = installPackage(plan, { approved: true, overwrite, ...options });
          out(`${describeInstall(result).join("\n")}\n`);
          return 0;
        }
        if (!approved) {
          print({ plan, installed: false }, [
            ...describePlan(plan),
            "Run again with --yes to install.",
          ]);
          return 1;
        }
        const result = installPackage(plan, { approved: true, overwrite, ...options });
        print({ plan, installed: true, result }, [
          ...describePlan(plan),
          ...describeInstall(result),
        ]);
        return 0;
      }
      case "list": {
        if (positional.length) break;
        const items = listPackages(workspace);
        print(
          { packages: items },
          items.length ? items.map(describeInstalled) : ["No packages installed."],
        );
        return 0;
      }
      case "remove": {
        const [name] = positional;
        if (!name || positional.length > 1) break;
        const result = removePackage(workspace, name);
        print(result, describeRemoval(result));
        return 0;
      }
    }
    process.stderr.write(help);
    return 2;
  } catch (error) {
    if (error instanceof PackageError) {
      process.stderr.write(`${error.message}\n`);
      return error.code === "NOT_FOUND" || error.code === "NOT_INSTALLED" ? 2 : 1;
    }
    throw error;
  }
}

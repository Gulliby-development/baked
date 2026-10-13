import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";
import { type DeployPlan, deployArtifact, planDeploy } from "../core/artifacts/deploy.js";
import { ArtifactError, type ArtifactMeta, ArtifactStore } from "../core/artifacts/store.js";
import { VercelError } from "../core/artifacts/vercel.js";
import { getCwd } from "../core/cwd.js";
import type { AppConfig } from "../types/index.js";

const help = `Usage: baked artifacts [command]

Artifacts are HTML pages kept for your user, shared by every project and chat.

Commands:
  list [--json]                          Every artifact, the most recently updated first (default)
  show ID [--version N] [--html] [--json]
                                         The artifact's details; --html prints the page
  save FILE [--id ID] [--title TEXT] [--json]
                                         Save an HTML file as a new artifact, or as a new
                                         version of ID
  deploy ID [--prod] [--yes] [--json]    Publish the latest version to your Vercel account:
                                         a preview deployment, or production with --prod.
                                         Without --yes it only prints what would be sent.
  remove ID                              Delete the artifact and all its versions

Deploying needs artifactDeploy: true in the user config and a Vercel token (VERCEL_TOKEN or
the saved vercel-token secret); vercelTeamId or VERCEL_TEAM_ID picks a team. A page that looks
like it holds a secret is refused. Exit codes: 1 refused or failed, 2 bad arguments or an
unknown artifact.
`;

const flag = (rest: string[], name: string): string | undefined => {
  const at = rest.indexOf(name);
  return at >= 0 ? rest[at + 1] : undefined;
};

const line = (a: ArtifactMeta): string => {
  const last = a.deploys.at(-1);
  return [
    a.id,
    `v${a.version}`,
    a.updatedAt.slice(0, 16).replace("T", " "),
    a.title,
    last ? `→ ${last.url}` : "",
  ]
    .filter(Boolean)
    .join("  ");
};

export function describePlan(plan: DeployPlan): string {
  const a = plan.artifact;
  return [
    `Deploy "${a.title}" (${a.id} v${a.version}, ${a.bytes} bytes) as a ${plan.target} deployment`,
    `to the Vercel project ${plan.project}${plan.teamId ? ` in team ${plan.teamId}` : " in your personal account"}.`,
    plan.target === "production"
      ? "A production deployment is public: anyone with the link can open it."
      : "A preview deployment is visible to your Vercel team only, unless its protection is off.",
  ].join("\n");
}

export async function runArtifactsCli(
  argv: string[],
  store = new ArtifactStore(),
  out: (text: string) => void = (text) => process.stdout.write(text),
  config: () => Pick<AppConfig, "artifactDeploy" | "vercelTeamId"> = loadConfig,
): Promise<number> {
  const [command = "list", ...rest] = argv;
  const json = rest.includes("--json");
  const print = (value: unknown, text: string) =>
    out(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
  try {
    switch (command) {
      case "--help":
      case "-h":
      case "help":
        out(help);
        return 0;
      case "list": {
        const items = store.list();
        print(items, items.length ? items.map(line).join("\n") : "No artifacts yet.");
        return 0;
      }
      case "show": {
        const id = rest[0];
        if (!id || id.startsWith("--")) break;
        const version = flag(rest, "--version");
        if (rest.includes("--html")) {
          out(store.read(id, version ? Number(version) : undefined));
          return 0;
        }
        const meta = store.get(id);
        print(
          meta,
          [
            line(meta),
            ...meta.deploys.map((d) => `  ${d.at.slice(0, 16)} v${d.version} ${d.target} ${d.url}`),
          ].join("\n"),
        );
        return 0;
      }
      case "save": {
        const file = rest[0];
        if (!file || file.startsWith("--")) break;
        const id = flag(rest, "--id");
        const title = flag(rest, "--title");
        const meta = store.save({
          html: readFileSync(resolve(getCwd(), file), "utf8"),
          ...(id ? { id } : {}),
          ...(title ? { title } : {}),
          project: getCwd(),
        });
        print(meta, `Saved ${meta.id} v${meta.version}`);
        return 0;
      }
      case "deploy": {
        const id = rest[0];
        if (!id || id.startsWith("--")) break;
        const target = rest.includes("--prod") ? "production" : "preview";
        const settings = config();
        const plan = planDeploy(store, settings, id, target);
        if (plan.refusal) {
          print({ plan }, `${describePlan(plan)}\nRefused: ${plan.refusal}`);
          return 1;
        }
        if (!rest.includes("--yes")) {
          print({ plan }, `${describePlan(plan)}\nRun again with --yes to deploy.`);
          return 1;
        }
        const { deployment } = await deployArtifact(store, settings, id, target);
        print(deployment, `Deployed ${id} v${plan.artifact.version}: ${deployment.url}`);
        return 0;
      }
      case "remove": {
        const id = rest[0];
        if (!id || id.startsWith("--")) break;
        store.remove(id);
        out(`Removed ${id}\n`);
        return 0;
      }
    }
    out(help);
    return 2;
  } catch (error) {
    if (error instanceof ArtifactError || error instanceof VercelError) {
      process.stderr.write(`${error.message}\n`);
      return error instanceof ArtifactError && error.code === "NOT_FOUND" ? 2 : 1;
    }
    throw error;
  }
}

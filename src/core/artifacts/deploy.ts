import type { AppConfig } from "../../types/index.js";
import { getSecret } from "../secrets.js";
import { findSecrets, type SecretFinding } from "./scan.js";
import { ArtifactError, type ArtifactMeta, type ArtifactStore } from "./store.js";
import {
  type DeployTarget,
  deployToVercel,
  projectNameFor,
  type VercelDeployment,
  type VercelOptions,
} from "./vercel.js";

/** What a deploy would send, shown to the person before they approve it. */
export interface DeployPlan {
  artifact: Pick<ArtifactMeta, "id" | "title" | "version" | "bytes">;
  target: DeployTarget;
  /** The Vercel project the page goes to. */
  project: string;
  teamId: string | null;
  /** Lines that look like secrets; any finding refuses the deploy. */
  findings: SecretFinding[];
  /** Why the deploy cannot go ahead, or null. */
  refusal: string | null;
}

export const VERCEL_TOKEN_SECRET = "vercel-token";

/** The Vercel team from the config or `VERCEL_TEAM_ID`, or null for the personal account. */
export const vercelTeamId = (config: Pick<AppConfig, "vercelTeamId">): string | null =>
  config.vercelTeamId?.trim() || process.env.VERCEL_TEAM_ID?.trim() || null;

export function planDeploy(
  store: ArtifactStore,
  config: Pick<AppConfig, "artifactDeploy" | "vercelTeamId">,
  id: string,
  target: DeployTarget = "preview",
  token: string | null = getSecret(VERCEL_TOKEN_SECRET),
): DeployPlan {
  const meta = store.get(id);
  const findings = findSecrets(store.read(id));
  const refusal = !config.artifactDeploy
    ? "Deploying artifacts is off. Turn on artifactDeploy (Settings > Tools > Artifacts) first."
    : !token
      ? "No Vercel token. Save one in Settings > Tools > Artifacts or set VERCEL_TOKEN."
      : findings.length
        ? `The page looks like it holds a secret (${findings
            .map((f) => `line ${f.line}: ${f.kind}`)
            .join("; ")}). Remove it and save a new version first.`
        : null;
  return {
    artifact: { id: meta.id, title: meta.title, version: meta.version, bytes: meta.bytes },
    target,
    project: projectNameFor(meta.id),
    teamId: vercelTeamId(config),
    findings,
    refusal,
  };
}

/**
 * Deploys the artifact's latest version after the person approved the plan, and records the
 * deploy on the artifact. The plan is checked again, so a page changed since stays refused.
 */
export async function deployArtifact(
  store: ArtifactStore,
  config: Pick<AppConfig, "artifactDeploy" | "vercelTeamId">,
  id: string,
  target: DeployTarget = "preview",
  options: Partial<VercelOptions> = {},
): Promise<{ deployment: VercelDeployment; artifact: ArtifactMeta }> {
  const token = options.token ?? getSecret(VERCEL_TOKEN_SECRET);
  const plan = planDeploy(store, config, id, target, token);
  if (plan.refusal || !token) throw new ArtifactError("INVALID", plan.refusal ?? "No Vercel token");
  const deployment = await deployToVercel(plan.project, store.read(id), target, {
    ...options,
    token,
    teamId: plan.teamId,
  });
  const artifact = store.recordDeploy(id, {
    id: deployment.id,
    url: deployment.url,
    target,
    version: plan.artifact.version,
    at: new Date().toISOString(),
  });
  return { deployment, artifact };
}

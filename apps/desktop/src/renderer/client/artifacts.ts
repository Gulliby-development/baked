/**
 * Artifacts over `/v1/artifacts*`: HTML pages kept for the user and shared by every project, and
 * their deploys to the user's Vercel. Shapes follow `docs/desktop/api.md#artifacts`.
 */
import { call } from "./api.js";
import { ARTIFACTS_CAPABILITY } from "./capabilities.js";
import { withCapability } from "./setup.js";

export type DeployTarget = "preview" | "production";

export interface ArtifactDeploy {
  id: string;
  url: string;
  target: DeployTarget;
  version: number;
  at: string;
}

export interface Artifact {
  id: string;
  title: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  project: string | null;
  bytes: number;
  deploys: ArtifactDeploy[];
}

/** What a deploy would send; `refusal` says why it cannot go ahead. */
export interface DeployPlan {
  artifact: Pick<Artifact, "id" | "title" | "version" | "bytes">;
  target: DeployTarget;
  project: string;
  teamId: string | null;
  findings: { line: number; kind: string }[];
  refusal: string | null;
}

const path = (id: string, action?: string): string =>
  `/v1/artifacts/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export const artifacts = {
  list: (key: string) =>
    withCapability(key, ARTIFACTS_CAPABILITY, () =>
      call<{ items: Artifact[] }>(key, "GET", "/v1/artifacts"),
    ),
  page: (key: string, id: string) =>
    call<{ id: string; version: number; html: string }>(key, "GET", path(id, "page")),
  open: (key: string, id: string) =>
    call<{ opened: boolean; path: string }>(key, "POST", path(id, "open")),
  plan: (key: string, id: string, target: DeployTarget) =>
    call<DeployPlan>(key, "GET", `${path(id, "deploy")}?target=${target}`),
  /** Sent only after the person approved the plan. */
  deploy: (key: string, id: string, target: DeployTarget) =>
    call<{ deployment: { id: string; url: string; target: DeployTarget }; artifact: Artifact }>(
      key,
      "POST",
      path(id, "deploy"),
      { target, confirm: true },
    ),
  remove: (key: string, id: string) => call<{ removed: string }>(key, "DELETE", path(id)),
};

/**
 * Deploys one HTML page to the user's own Vercel account over the REST API: a deployment with the
 * page inlined as `index.html`, no build step, then polling until it is ready. Preview unless the
 * target is production. Tests point `baseUrl` at a local fake.
 */

export type DeployTarget = "preview" | "production";

export interface VercelOptions {
  token: string;
  teamId?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** How long to wait for the deployment to be ready. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export interface VercelDeployment {
  id: string;
  url: string;
  target: DeployTarget;
}

export class VercelError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "VercelError";
  }
}

const DEFAULT_BASE = "https://api.vercel.com";

/** A Vercel project name for an artifact ID (lowercase, at most 100 characters). */
export const projectNameFor = (artifactId: string): string =>
  `baked-${artifactId}`.slice(0, 100).replace(/-+$/, "");

export async function deployToVercel(
  name: string,
  html: string,
  target: DeployTarget,
  options: VercelOptions,
): Promise<VercelDeployment> {
  const call = options.fetch ?? fetch;
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const query = options.teamId ? `?teamId=${encodeURIComponent(options.teamId)}` : "";
  const headers = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await call(`${base}${path}${query}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = data.error as { message?: string } | undefined;
      throw new VercelError(
        response.status === 401 || response.status === 403
          ? `Vercel refused the token (${response.status}): ${error?.message ?? "check VERCEL_TOKEN or the saved Vercel token"}`
          : `Vercel answered ${response.status}: ${error?.message ?? response.statusText}`,
        response.status,
      );
    }
    return data;
  };

  const created = await request("POST", "/v13/deployments", {
    name,
    files: [{ file: "index.html", data: Buffer.from(html).toString("base64"), encoding: "base64" }],
    projectSettings: { framework: null },
    ...(target === "production" ? { target: "production" } : {}),
  });
  const id = String(created.id ?? "");
  if (!id) throw new VercelError("Vercel did not return a deployment ID");

  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let state = created;
  for (;;) {
    const ready = String(state.readyState ?? state.status ?? "");
    if (ready === "READY") break;
    if (ready === "ERROR" || ready === "CANCELED")
      throw new VercelError(`The Vercel deployment ${id} ended ${ready}`);
    if (Date.now() > deadline)
      throw new VercelError(`The Vercel deployment ${id} was not ready in time`);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1500));
    state = await request("GET", `/v13/deployments/${encodeURIComponent(id)}`);
  }
  const alias = Array.isArray(state.alias) ? state.alias.map(String) : [];
  // Production is reached through its alias; a preview through the deployment's own URL.
  const host = (target === "production" ? alias[0] : undefined) ?? String(state.url ?? "");
  if (!host) throw new VercelError(`The Vercel deployment ${id} has no URL`);
  return { id, url: host.startsWith("http") ? host : `https://${host}`, target };
}

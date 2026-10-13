import type { Artifact, DeployPlan, DeployTarget } from "./artifacts.js";
import { type MockRoute, response } from "./mock-routes.js";

/** Artifacts are shared by every project, so the mock keeps one list for all of them. */
const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><style>body{font-family:sans-serif;padding:24px}</style></head><body><h1>${title}</h1>${body}</body></html>`;

let items: { meta: Artifact; html: string }[] | null = null;

function all(): { meta: Artifact; html: string }[] {
  if (items) return items;
  const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const entry = (
    id: string,
    title: string,
    body: string,
    hours: number,
    deploys: Artifact["deploys"] = [],
  ) => {
    const html = page(title, body);
    return {
      meta: {
        id,
        title,
        description: "",
        version: deploys.length ? 2 : 1,
        createdAt: at(hours + 24),
        updatedAt: at(hours),
        project: "C:\\Project\\BAKED",
        bytes: html.length,
        deploys,
      },
      html,
    };
  };
  items = [
    entry("release-notes", "Release notes 0.3", "<p>135 pull requests since 0.2.0.</p>", 1, [
      {
        id: "dpl_mock1",
        url: "https://baked-release-notes-abc.vercel.app",
        target: "preview",
        version: 2,
        at: at(2),
      },
    ]),
    entry("token-chart", "Token use by round", "<p>Rounds 5 to 8.</p>", 6),
  ];
  return items;
}

function plan(meta: Artifact, target: DeployTarget): DeployPlan {
  return {
    artifact: { id: meta.id, title: meta.title, version: meta.version, bytes: meta.bytes },
    target,
    project: `baked-${meta.id}`,
    teamId: null,
    findings: [],
    refusal: null,
  };
}

export const artifactRoutes: MockRoute = ({ method, path, query, body }) => {
  if (!path.startsWith("/v1/artifacts")) return undefined;
  if (path === "/v1/artifacts" && method === "GET")
    return response(200, { items: all().map((a) => a.meta) });
  const match = /^\/v1\/artifacts\/([^/]+)(?:\/(page|open|deploy))?$/.exec(path);
  const found = all().find((a) => a.meta.id === decodeURIComponent(match?.[1] ?? ""));
  if (!match || !found)
    return response(404, { error: { code: "NOT_FOUND", message: "No artifact" } });
  const action = match[2];
  if (!action && method === "DELETE") {
    items = all().filter((a) => a !== found);
    return response(200, { removed: found.meta.id });
  }
  if (!action) return response(200, found.meta);
  if (action === "page")
    return response(200, { id: found.meta.id, version: found.meta.version, html: found.html });
  if (action === "open")
    return response(200, {
      opened: true,
      path: `C:\\Users\\me\\.baked\\artifacts\\${found.meta.id}\\v${found.meta.version}.html`,
    });
  if (method === "GET")
    return response(
      200,
      plan(found.meta, query.get("target") === "production" ? "production" : "preview"),
    );
  const target = (body as { target?: DeployTarget }).target ?? "preview";
  const deployment = {
    id: `dpl_${Date.now()}`,
    url:
      target === "production"
        ? `https://baked-${found.meta.id}.vercel.app`
        : `https://baked-${found.meta.id}-new.vercel.app`,
    target,
  };
  found.meta = {
    ...found.meta,
    deploys: [
      ...found.meta.deploys,
      { ...deployment, version: found.meta.version, at: new Date().toISOString() },
    ],
  };
  return response(200, { deployment, artifact: found.meta });
};

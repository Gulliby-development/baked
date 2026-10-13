import { type MockRoute, response } from "./mock-routes.js";
import type { InstalledPackage, PackagePlan } from "./packages.js";

/** The one package folder the mock knows; any other path is not found. */
export const MOCK_PACKAGE_PATH = "/home/you/packages/acme-review";

const hash = (n: number): string => n.toString(16).padStart(64, "0");
const installed = new Map<string, InstalledPackage[]>();

function plan(key: string): PackagePlan {
  const current = installed.get(key)?.find((p) => p.name === "acme-review") ?? null;
  const files: PackagePlan["files"] = [
    ["agents/acme-reviewer.json", "agents"],
    ["skills/review-notes/SKILL.md", "skills"],
    ["workflows/acme-quick.json", "workflows"],
    ["gates/lint.json", "gates"],
  ].map(([path = "", kind = ""], i) => ({
    path,
    target: `baked/${path}`,
    kind: kind as PackagePlan["files"][number]["kind"],
    sha256: hash(i + 1),
    size: 400 + i * 100,
    status: current ? "identical" : path === "gates/lint.json" ? "overwrite" : "new",
  }));
  return {
    source: MOCK_PACKAGE_PATH,
    workspace: "C:\\Project\\BAKED",
    name: "acme-review",
    version: "1.2.0",
    description: "Acme's review profile, its checklist skill, a quick workflow and the lint gate.",
    installed: current?.version ?? null,
    files,
    stale: [],
    contents: {
      agents: ["acme-reviewer"],
      skills: ["review-notes"],
      workflows: ["acme-quick"],
      gates: ["lint"],
    },
    gatesToConfirm: ["lint"],
    problems: [],
    overwrites: files.filter((f) => f.status === "overwrite").length,
    planHash: hash(current ? 99 : 42),
  };
}

const notFound = (message: string) => response(404, { error: { code: "NOT_FOUND", message } });

export const packageRoutes: MockRoute = ({ key, method, path, body }) => {
  if (path !== "/v1/packages" && !path.startsWith("/v1/packages/")) return undefined;
  const list = installed.get(key) ?? [];
  if (path === "/v1/packages" && method === "GET") return response(200, { packages: list });
  const request = (body ?? {}) as { path?: string; planHash?: string; overwrite?: boolean };
  if (path === "/v1/packages/inspect" && method === "POST")
    return request.path === MOCK_PACKAGE_PATH
      ? response(200, plan(key))
      : notFound(`${request.path} has no baked-package.json`);
  if (path === "/v1/packages/install" && method === "POST") {
    if (request.path !== MOCK_PACKAGE_PATH) return notFound(`${request.path} does not exist`);
    const current = plan(key);
    if (request.planHash !== current.planHash)
      return response(409, {
        error: {
          code: "STALE_PLAN",
          message: "The package or the project changed; inspect it again",
        },
      });
    if (current.overwrites > 0 && !request.overwrite)
      return response(409, {
        error: { code: "CONFLICT", message: "It would replace baked/gates/lint.json" },
      });
    installed.set(key, [
      ...list.filter((p) => p.name !== current.name),
      {
        name: current.name,
        version: current.version,
        ...(current.description ? { description: current.description } : {}),
        installedAt: new Date().toISOString(),
        files: current.files.map((f) => ({ path: f.target, sha256: f.sha256 })),
        changed: [],
      },
    ]);
    return response(201, {
      name: current.name,
      version: current.version,
      written: current.files.filter((f) => f.status !== "identical").map((f) => f.target),
      unchanged: current.files.filter((f) => f.status === "identical").map((f) => f.target),
      removed: [],
      kept: [],
      gatesToConfirm: current.gatesToConfirm,
    });
  }
  const name = decodeURIComponent(/^\/v1\/packages\/([^/]+)$/.exec(path)?.[1] ?? "");
  const found = list.find((p) => p.name === name);
  if (method === "DELETE" && found) {
    installed.set(
      key,
      list.filter((p) => p !== found),
    );
    return response(200, {
      name,
      version: found.version,
      removed: found.files.map((f) => f.path),
      kept: [],
      missing: [],
    });
  }
  return notFound(`No installed package ${name}`);
};

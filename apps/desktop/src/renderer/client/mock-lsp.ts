import type { IntelligenceCheck, LspActionView, LspServer, LspView } from "./lsp.js";
import { type MockRequest, type MockRoute, response } from "./mock-routes.js";

type Seed = Pick<LspServer, "id" | "languages"> & Partial<LspServer>;

const SEED: Seed[] = [
  {
    id: "typescript-language-server",
    languages: ["typescript", "javascript"],
    detected: true,
    installed: true,
    source: "baked",
    path: "C:\\Users\\you\\AppData\\Local\\baked\\lsp-servers\\node_modules\\.bin\\typescript-language-server.cmd",
    package: "typescript-language-server",
  },
  {
    id: "biome",
    languages: ["typescript", "javascript", "css", "json"],
    detected: true,
    installed: true,
    source: "PATH",
    path: "biome",
    disabled: true,
    disabledIn: ["global"],
    package: "biome",
  },
  {
    id: "pyright-langserver",
    languages: ["python"],
    detected: true,
    package: "pyright",
  },
  {
    id: "gopls",
    languages: ["go"],
    detected: true,
    installed: true,
    source: "PATH",
    path: "gopls",
    lastError: {
      message: "gopls: go.mod not found in the workspace root",
      at: Date.now() - 5 * 60_000,
    },
    package: "gopls",
  },
  { id: "rust-analyzer", languages: ["rust"], package: "rust-analyzer" },
  {
    id: "jdtls",
    languages: ["java"],
    package: "jdtls",
    requiresToolchain: null,
  },
  {
    id: "csharp-ls",
    languages: ["csharp"],
    package: "csharp-language-server",
    requiresToolchain: "dotnet",
    installable: false,
  },
];

interface LspState {
  servers: LspServer[];
  started: boolean;
}

const states = new Map<string, LspState>();

function server(seed: Seed): LspServer {
  return {
    detected: false,
    installed: false,
    source: null,
    path: null,
    disabled: false,
    disabledIn: [],
    running: false,
    ready: false,
    pids: [],
    openFiles: 0,
    diagnosticCount: 0,
    lastError: null,
    package: null,
    requiresToolchain: null,
    installable: true,
    ...seed,
  };
}

function state(key: string): LspState {
  let s = states.get(key);
  if (!s) {
    s = { servers: SEED.map(server), started: false };
    states.set(key, s);
  }
  return s;
}

function start(s: LspState, only?: LspServer): string[] {
  const restarted: string[] = [];
  for (const srv of s.servers) {
    if ((only && srv !== only) || !srv.detected || !srv.installed || srv.disabled) continue;
    if (srv.lastError) continue;
    srv.running = true;
    srv.ready = true;
    srv.pids = [4000 + s.servers.indexOf(srv)];
    srv.openFiles = 3;
    srv.diagnosticCount = srv.id === "typescript-language-server" ? 2 : 0;
    restarted.push(`${srv.languages[0]}:${srv.id}`);
  }
  return restarted;
}

function view(s: LspState): LspView {
  const languages = [...new Set(s.servers.filter((v) => v.detected).flatMap((v) => v.languages))];
  const covered = new Set(
    s.servers.filter((v) => v.installed && !v.disabled).flatMap((v) => v.languages),
  );
  return {
    servers: [...s.servers].sort((a, b) => Number(b.detected) - Number(a.detected)),
    languages,
    uncovered: languages.filter((l) => !covered.has(l)),
    started: s.started,
    registry: true,
    paths: {
      global: "C:\\Users\\you\\AppData\\Local\\baked\\config.json",
      project: "C:\\Project\\BAKED\\.baked\\config.json",
    },
  };
}

const OPERATIONS = ["findSymbols", "findImports", "getFileOutline", "getDiagnostics"];

/** What `/diagnose` finds in a TypeScript project with its language server running or not. */
function diagnose(s: LspState): IntelligenceCheck {
  const ts = s.servers.find((v) => v.id === "typescript-language-server");
  const lspUp = s.started && ts?.ready === true;
  const backends: IntelligenceCheck["backends"] = [
    {
      backend: "lsp:standalone",
      tier: 1,
      supports: true,
      initialized: lspUp,
      probes: OPERATIONS.map((operation, i) => ({
        operation,
        status: lspUp ? "pass" : "empty",
        ms: lspUp ? 12 + i * 7 : 0,
      })),
    },
    {
      backend: "ts-morph",
      tier: 2,
      supports: true,
      initialized: true,
      initMs: 840,
      probes: OPERATIONS.map((operation, i) => ({ operation, status: "pass", ms: 3 + i * 40 })),
    },
    {
      backend: "tree-sitter",
      tier: 3,
      supports: true,
      initialized: true,
      initMs: 60,
      probes: OPERATIONS.map((operation, i) =>
        operation === "getDiagnostics"
          ? { operation, status: "unsupported" }
          : { operation, status: "pass", ms: 20 + i * 5 },
      ),
    },
    {
      backend: "regex",
      tier: 4,
      supports: true,
      initialized: true,
      probes: OPERATIONS.map((operation) =>
        operation === "getDiagnostics"
          ? { operation, status: "unsupported" }
          : { operation, status: "pass", ms: 1 },
      ),
    },
  ];
  return {
    language: "typescript",
    probeFile: "C:\\Project\\BAKED\\src\\boot.tsx",
    backends,
    failing: [],
  };
}

const fail = (status: number, code: string, message: string) =>
  response(status, { error: { code, message } });

const ITEM = /^\/v1\/lsp\/([^/]+)\/(install|enable|disable|restart)$/;

export const lspRoutes: MockRoute = (request: MockRequest) => {
  const { key, method, path } = request;
  if (path !== "/v1/lsp" && !path.startsWith("/v1/lsp/")) return undefined;
  const s = state(key);
  const answer = (restarted: string[], extra: Partial<LspActionView> = {}) =>
    response(200, { ...view(s), restarted, ...extra });
  if (path === "/v1/lsp" && method === "GET") return response(200, view(s));
  if (path === "/v1/lsp/restart" && method === "POST") {
    const first = !s.started;
    s.started = true;
    const restarted = start(s);
    return answer(first ? [] : restarted, { startedNow: first });
  }
  if (path === "/v1/lsp/diagnose" && method === "POST") {
    if (!s.started) {
      s.started = true;
      start(s);
    }
    return response(200, diagnose(s));
  }
  const match = ITEM.exec(path);
  if (!match || method !== "POST") return fail(404, "NOT_FOUND", `No endpoint at ${path}`);
  const id = decodeURIComponent(match[1] ?? "");
  const srv = s.servers.find((v) => v.id === id || v.package === id);
  if (!srv) return fail(404, "NOT_FOUND", `No language server named ${id}`);
  switch (match[2]) {
    case "install": {
      if (!srv.installable)
        return fail(
          409,
          "NOT_INSTALLABLE",
          `${srv.package} needs ${srv.requiresToolchain} on PATH`,
        );
      srv.installed = true;
      srv.source = "baked";
      srv.path = `C:\\Users\\you\\AppData\\Local\\baked\\lsp-servers\\bin\\${srv.id}.exe`;
      const restarted = s.started ? start(s, srv) : [];
      return answer(restarted, {
        installed: { server: srv.id, package: srv.package ?? srv.id },
        log: [`Installing ${srv.package}…`, "Done"],
      });
    }
    case "enable":
    case "disable": {
      srv.disabled = match[2] === "disable";
      srv.disabledIn = srv.disabled ? ["global"] : [];
      if (srv.disabled) {
        srv.running = false;
        srv.ready = false;
        srv.pids = [];
      }
      const restarted = s.started && !srv.disabled ? start(s, srv) : [];
      return answer(restarted);
    }
    default: {
      if (!s.started) {
        s.started = true;
        start(s);
        return answer([], { startedNow: true });
      }
      srv.lastError = null;
      return answer(start(s, srv));
    }
  }
};

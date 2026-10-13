/**
 * Language servers of the project's backend (`/v1/lsp`, `lsp` capability): what `/lsp status`
 * shows in the terminal and the changes `/lsp` makes there. Shapes follow `docs/desktop/api.md`.
 */
import { ApiError, call } from "./api.js";
import { LSP_CAPABILITY, LSP_DIAGNOSE_CAPABILITY, offers } from "./capabilities.js";

export type LspScope = "global" | "project";
export type LspSource = "PATH" | "baked" | "mason";

export interface LspServer {
  /** The server's command; actions and `disabledLspServers` name it by this. */
  id: string;
  languages: string[];
  /** The project has files of one of its languages. */
  detected: boolean;
  installed: boolean;
  source: LspSource | null;
  path: string | null;
  disabled: boolean;
  disabledIn: LspScope[];
  running: boolean;
  ready: boolean;
  pids: number[];
  openFiles: number;
  diagnosticCount: number;
  lastError: { message: string; at: number } | null;
  /** The Mason package that installs it. */
  package: string | null;
  requiresToolchain: string | null;
  installable: boolean;
}

export interface LspView {
  servers: LspServer[];
  languages: string[];
  /** Detected languages that no enabled, installed server covers. */
  uncovered: string[];
  /** Whether the backend started code intelligence; servers run only then. */
  started: boolean;
  /** Whether the Mason registry is cached; the first install downloads it. */
  registry: boolean;
  paths: Record<LspScope, string>;
}

export interface LspActionView extends LspView {
  /** Running servers restarted to apply the change, as `language:command`. */
  restarted: string[];
  /** Restart found nothing running and started the project's servers instead. */
  startedNow?: boolean;
  /** `warning` says why the installed server did not start when it was started once. */
  installed?: { server: string; package: string; warning?: string };
  log?: string[];
}

export type ProbeStatus = "pass" | "empty" | "error" | "timeout" | "unsupported";

export interface BackendCheck {
  /** `lsp:standalone`, `ts-morph`, `tree-sitter` or `regex`. */
  backend: string;
  tier: number;
  /** Whether the backend handles the project's main language at all. */
  supports: boolean;
  initialized: boolean;
  initMs?: number;
  initError?: string;
  probes: { operation: string; status: ProbeStatus; ms?: number; error?: string }[];
}

/** The code intelligence health check `/diagnose` shows in the terminal. */
export interface IntelligenceCheck {
  language: string;
  /** The project file the probes ran against; empty when none was found. */
  probeFile: string;
  backends: BackendCheck[];
  /** Backends that support the language but failed to start, or whose probes failed. */
  failing: string[];
}

const item = (id: string, action: string) => `/v1/lsp/${encodeURIComponent(id)}/${action}`;

async function offered(key: string, capability = LSP_CAPABILITY): Promise<void> {
  let capabilities: string[] | null = null;
  try {
    capabilities =
      (await call<{ capabilities?: string[] }>(key, "GET", "/v1/health")).capabilities ?? null;
  } catch {
    capabilities = null;
  }
  if (offers(capabilities, capability) === false)
    throw new ApiError(
      404,
      "NOT_FOUND",
      capability === LSP_CAPABILITY
        ? "This BAKED has no language-server endpoints"
        : "This BAKED cannot check code intelligence; update it",
    );
}

export const lsp = {
  status: async (key: string) => {
    await offered(key);
    return call<LspView>(key, "GET", "/v1/lsp");
  },
  /** Downloads and builds the server; it can take minutes. 409 NOT_INSTALLABLE without its toolchain. */
  install: (key: string, id: string) => call<LspActionView>(key, "POST", item(id, "install"), {}),
  setDisabled: (key: string, id: string, disabled: boolean) =>
    call<LspActionView>(key, "POST", item(id, disabled ? "disable" : "enable"), {}),
  /** One server, or every server without `id`; starts the project's servers when none run yet. */
  restart: (key: string, id?: string) =>
    call<LspActionView>(key, "POST", id ? item(id, "restart") : "/v1/lsp/restart", {}),
  /** Starts the servers when none run yet, then probes every backend; it can take a while. */
  diagnose: async (key: string) => {
    await offered(key, LSP_DIAGNOSE_CAPABILITY);
    return call<IntelligenceCheck>(key, "POST", "/v1/lsp/diagnose", {});
  },
};

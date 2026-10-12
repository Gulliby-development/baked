import type { IntelligenceClient } from "../workers/intelligence-client.js";
import { LspBackend, type LspServerError } from "./backends/lsp/index.js";
import { RegexBackend } from "./backends/regex.js";
import { TreeSitterBackend } from "./backends/tree-sitter.js";
import { TsMorphBackend } from "./backends/ts-morph.js";
import { CodeIntelligenceRouter } from "./router.js";
import type { CodeIntelligenceConfig } from "./types.js";

let router: CodeIntelligenceRouter | null = null;
let _client: IntelligenceClient | null = null;

/** Check if the intelligence system has been initialized (router or client exists). */
export function isIntelligenceReady(): boolean {
  return router !== null || _client !== null;
}

/**
 * Set the intelligence client (worker proxy).
 * Called once during app startup after the worker is ready.
 * Tools should prefer getIntelligenceClient() over getIntelligenceRouter().
 */
export function setIntelligenceClient(client: IntelligenceClient | null): void {
  _client = client;
}

/**
 * Get the intelligence client (worker proxy).
 * Returns null if the worker isn't ready yet — callers should fall back to router.
 */
export function getIntelligenceClient(): IntelligenceClient | null {
  return _client;
}

export function getIntelligenceRouter(
  cwd: string,
  config: CodeIntelligenceConfig = {},
): CodeIntelligenceRouter {
  if (router) return router;

  router = new CodeIntelligenceRouter(cwd, config);

  // When the worker client is available, it owns LSP + ts-morph backends.
  // Main-thread router only registers lightweight fallback backends
  // to avoid spawning duplicate LSP servers.
  if (!_client) {
    const lsp = new LspBackend();
    router.registerBackend(lsp);
    const tsMorph = new TsMorphBackend();
    router.registerBackend(tsMorph);
  }

  // tree-sitter + regex always available as lightweight fallback
  const treeSitter = new TreeSitterBackend();
  router.registerBackend(treeSitter);
  const regex = new RegexBackend();
  regex.setCache(router.fileCache);
  router.registerBackend(regex);

  return router;
}

/**
 * Eagerly warm up the intelligence system.
 * Initializes all backends for the detected project language and
 * spawns LSP servers so they're ready before the first tool call.
 * Call this once at app startup — runs in the background.
 */
export function warmupIntelligence(cwd: string, config: CodeIntelligenceConfig = {}): void {
  // Worker handles its own warmup (spawns LSP servers in background).
  // Skip main-thread warmup to avoid duplicate LSP server spawning.
  if (_client) return;
  const r = getIntelligenceRouter(cwd, config);
  r.warmup().catch(() => {
    // Non-fatal — tools will lazy-init if warmup fails
  });
}

/** Get the status of the intelligence system (null if not yet initialized) */
export async function getIntelligenceStatus(): Promise<{
  initialized: string[];
  lspServers: Array<{ language: string; command: string }>;
} | null> {
  if (_client) {
    try {
      return await _client.routerGetStatus();
    } catch {
      /* fall through */
    }
  }
  if (!router) return null;
  return router.getStatus();
}

/** Get detailed LSP server info for the status popup */
export async function getDetailedLspServers(): Promise<
  Array<{
    language: string;
    command: string;
    args: string[];
    pid: number | null;
    cwd: string;
    openFiles: number;
    diagnosticCount: number;
    diagnostics: Array<{ file: string; message: string; severity: number }>;
    ready: boolean;
  }>
> {
  if (_client) {
    try {
      return await _client.routerGetDetailedLspServers();
    } catch {
      /* fall through */
    }
  }
  if (!router) return [];
  return router.getDetailedLspServers();
}

/** The last start failure of each language server that has not started since. */
export async function getLspServerErrors(): Promise<LspServerError[]> {
  if (_client) {
    try {
      return await _client.routerGetLspErrors();
    } catch {
      /* fall through */
    }
  }
  if (!router) return [];
  return router.getLspErrors();
}

/** Restart LSP servers. Pass filter to restart specific server/language, or omit for all. */
export async function restartLspServers(filter?: string): Promise<string[]> {
  if (_client) {
    try {
      return await _client.routerRestartLspServers(filter);
    } catch {
      /* fall through */
    }
  }
  if (!router) return [];
  return router.restartLspServers(filter);
}

/** Stops the language servers rooted at or below `path`; call it before deleting that directory. */
export async function stopLanguageServersUnder(path: string): Promise<number> {
  let stopped = 0;
  if (_client) {
    try {
      stopped += await _client.routerStopLspServersUnder(path);
    } catch {
      /* fall through */
    }
  }
  if (router) stopped += await router.stopLspServersUnder(path);
  return stopped;
}

/** Get PIDs of all child processes managed by the intelligence system */
export async function getIntelligenceChildPids(): Promise<number[]> {
  if (_client) {
    try {
      return await _client.routerGetChildPids();
    } catch {
      /* fall through */
    }
  }
  if (!router) return [];
  return router.getChildPids();
}

/** Run intelligence health check — probes all backends */
export async function runIntelligenceHealthCheck(
  onProgress?: (partial: import("./router.js").HealthCheckResult) => void,
) {
  if (_client) {
    try {
      return await _client.routerRunHealthCheck();
    } catch {
      /* fall through */
    }
  }
  if (!router) return null;
  return router.runHealthCheck(onProgress);
}

/** Dispose the singleton router and all backends, including the worker's router */
export function disposeIntelligenceRouter(): void {
  if (_client) {
    _client.close().catch(() => {});
    _client = null;
  }
  if (router) {
    router.dispose();
    router = null;
  }
}

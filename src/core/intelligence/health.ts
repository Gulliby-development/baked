/**
 * The code intelligence health check that `/diagnose` shows in the terminal UI, read by
 * `baked diagnose` and `POST /v1/lsp/diagnose`: which backends support the project's main
 * language and how each key operation went against a real file of the project.
 */
import type { BackendProbeResult, HealthCheckResult } from "./router.js";

export interface HealthCheckView extends HealthCheckResult {
  /** Backends that support the language but failed to start, or whose probes errored or timed out. */
  failing: string[];
}

function failed(backend: BackendProbeResult): boolean {
  if (!backend.supports) return false;
  if (backend.initError) return true;
  return backend.probes.some((p) => p.status === "error" || p.status === "timeout");
}

export function healthCheckView(result: HealthCheckResult): HealthCheckView {
  return { ...result, failing: result.backends.filter(failed).map((b) => b.backend) };
}

const PROBE_MARK = {
  pass: "ok",
  empty: "empty",
  error: "error",
  timeout: "timeout",
  unsupported: "-",
};

/** Plain-text lines for the terminal, one block per backend. */
export function healthCheckLines(view: HealthCheckView): string[] {
  const lines = [`Language: ${view.language}`, `Probe file: ${view.probeFile || "none found"}`];
  for (const backend of view.backends) {
    const state = !backend.supports
      ? "does not support this language"
      : backend.initError
        ? `failed to start: ${backend.initError}`
        : view.failing.includes(backend.backend)
          ? "failing"
          : backend.probes.some((p) => p.status === "pass")
            ? "ok"
            : "no results";
    const init = backend.initMs !== undefined ? ` (started in ${backend.initMs}ms)` : "";
    lines.push("", `${backend.backend} (tier ${backend.tier}): ${state}${init}`);
    if (!backend.supports || backend.initError) continue;
    for (const probe of backend.probes) {
      const timing = probe.ms !== undefined ? ` ${probe.ms}ms` : "";
      const error = probe.error ? `: ${probe.error}` : "";
      lines.push(`  ${probe.operation}  ${PROBE_MARK[probe.status]}${timing}${error}`);
    }
  }
  return lines;
}

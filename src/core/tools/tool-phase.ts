import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Steps inside a tool call (#1533): a workflow journals each one as `tool.phase`, so a call that
 * never returns names the step it stopped in (match, analyze, pre_diagnostics, cas, write,
 * format, diagnostics). Outside a journaled
 * call, reporting a phase does nothing.
 */
const reporter = new AsyncLocalStorage<(phase: string) => void>();

/** Runs `action` with `report` receiving the phases the tools report inside it. */
export function withToolPhases<T>(report: (phase: string) => void, action: () => T): T {
  return reporter.run(report, action);
}

/** Reports that the current tool call starts `phase`. */
export function toolPhase(phase: string): void {
  try {
    reporter.getStore()?.(phase);
  } catch {
    // The journal is evidence; a tool never fails because a phase could not be written.
  }
}

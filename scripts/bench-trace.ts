#!/usr/bin/env bun
/**
 * Usage traces of bench-round runs (#1649).
 *
 *   bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]
 *   bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]
 *   bun scripts/bench-trace.ts recordings <workspace> <out-dir> [--run RUN_ID ...]
 *
 * `export` writes the anonymised trace of a workspace's workflow database (see
 * src/core/workflows/trace.ts); the bench loop stores one per app per round under
 * tests/fixtures/bench-traces/RNN/. `replay` runs the forecast gate of the current code at every
 * recorded attempt and prints the stops and cap growth that differ from the recorded run.
 * `recordings` writes the model calls of runs started with `--record-model-calls` (#1715).
 */
import { exportRecordings, exportTrace, replayTrace } from "../src/core/workflows/trace.js";

const usage =
  "Usage: bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]\n" +
  "       bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]\n" +
  "       bun scripts/bench-trace.ts recordings <workspace> <out-dir> [--run RUN_ID ...]";

const [command, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith("--"));
const args: string[] = [];
const runIds: string[] = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i] ?? "";
  if (arg === "--run") runIds.push(rest[++i] ?? "");
  else if (!arg.startsWith("--")) args.push(arg);
}

const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(2)}`);

if (command === "export" && args.length === 2) {
  const [workspace = "", out = ""] = args;
  const result = exportTrace(workspace, out, runIds.length ? { runIds } : {});
  console.log(
    `${result.path}: ${result.runs} runs, ${result.initiatives} initiatives, ${(result.bytes / 1024).toFixed(0)} KiB`,
  );
} else if (command === "recordings" && args.length === 2) {
  const [workspace = "", outDir = ""] = args;
  const entries = exportRecordings(workspace, outDir, runIds.length ? { runIds } : {});
  for (const entry of entries)
    console.log(`${entry.file}: ${entry.featureId}, ${entry.calls} calls, ${entry.status}`);
  if (!entries.length) console.log("No run recorded its model calls (--record-model-calls)");
} else if (command === "replay" && args.length > 0) {
  const replays = args.map((path) => replayTrace(path));
  if (flags.includes("--json")) console.log(JSON.stringify(replays, null, 2));
  else
    for (const replay of replays) {
      console.log(replay.trace);
      for (const run of replay.runs) {
        const ratios = run.ratios.map((r) => `${r.at * 100}%: ${r.ratio.toFixed(2)}x`).join(", ");
        console.log(
          `  ${run.featureId} ${run.runId}: final ${usd(run.finalUsd)}, ${run.boundaries.length} attempts, ` +
            `new stops ${run.newStops}, new growth ${run.newGrowth}, stops removed ${run.removedStops}` +
            (ratios ? `, forecast/final ${ratios}` : ""),
        );
        for (const b of run.boundaries.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${new Date(b.at).toISOString()} ${b.attemptId}: recorded ${b.recorded}, now ${b.replayed} ` +
              `(forecast ${usd(b.projectedUsd)}, ceiling ${usd(b.ceilingUsd)}, spent ${usd(b.spentUsd)})`,
          );
      }
    }
} else {
  console.error(usage);
  process.exit(2);
}

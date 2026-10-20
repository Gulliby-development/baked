#!/usr/bin/env bun
/**
 * Usage traces of bench-round runs (#1649).
 *
 *   bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]
 *   bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]
 *   bun scripts/bench-trace.ts latencies <trace.sqlite.gz> ... [--json]
 *   bun scripts/bench-trace.ts recordings <workspace> <out-dir> [--run RUN_ID ...]
 *
 * `export` writes the anonymised trace of a workspace's workflow database (see
 * src/core/workflows/trace.ts); the bench loop stores one per app per round under
 * tests/fixtures/bench-traces/RNN/. `replay` runs the forecast gate of the current code at every
 * recorded attempt and prints the stops and cap growth that differ from the recorded run.
 * `latencies` prints the healthy first-byte percentiles and retry-after waits of the recorded
 * calls by provider, stage and effort: what the provider fault matrix tests limits against (#1729).
 * `recordings` writes the model calls of runs started with `--record-model-calls` (#1715).
 */
import { corpusCallProfile, exportRecordings, exportTrace, replayTrace } from "../src/core/workflows/trace.js";

const usage =
  "Usage: bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]\n" +
  "       bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]\n" +
  "       bun scripts/bench-trace.ts latencies <trace.sqlite.gz> ... [--json]\n" +
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
} else if (command === "latencies" && args.length > 0) {
  const profile = corpusCallProfile(args);
  if (flags.includes("--json")) console.log(JSON.stringify(profile, null, 2));
  else {
    for (const shape of profile.firstByte)
      console.log(
        `${shape.provider} ${shape.stage ?? "-"} ${shape.effort ?? "-"}: ${shape.calls} calls, first byte ` +
          `p50 ${(shape.p50Ms / 1000).toFixed(1)} s, p99 ${(shape.p99Ms / 1000).toFixed(1)} s, max ${(shape.maxMs / 1000).toFixed(1)} s` +
          (shape.estimated ? " (attempt lengths)" : ""),
      );
    for (const [provider, waits] of Object.entries(profile.retryAfterMs))
      console.log(`${provider} retry-after: ${waits.map((ms) => `${Math.ceil(ms / 1000)} s`).join(", ")}`);
  }
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
            `new stops ${run.newStops}, new growth ${run.newGrowth}, stops removed ${run.removedStops}, ` +
            `first-response stops ${run.newFirstByteStops} of ${run.firstByte.length} calls, ` +
            `cost-cap refusals ${run.newCostStops} of ${run.costCap.length} attempts` +
            (ratios ? `, forecast/final ${ratios}` : ""),
        );
        for (const b of run.boundaries.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${new Date(b.at).toISOString()} ${b.attemptId}: recorded ${b.recorded}, now ${b.replayed} ` +
              `(forecast ${usd(b.projectedUsd)}, ceiling ${usd(b.ceilingUsd)}, spent ${usd(b.spentUsd)})`,
          );
        for (const b of run.costCap.filter((b) => b.replayed === "stop"))
          console.log(
            `    ${b.attemptId} (${b.stage} ${b.model}, ${b.tokens} tokens): now refused ` +
              `(call ${usd(b.requestedUsd)}, spent ${usd(b.spentUsd)}, reserved ${usd(b.reservedUsd)}, ceiling ${usd(b.ceilingUsd)})`,
          );
        for (const b of run.firstByte.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${b.attemptId} call ${b.call} (${b.provider} ${b.stage ?? "?"} ${b.effort ?? "default"}): ` +
              `recorded ${b.recorded}, now ${b.replayed} (first response ${b.firstByteMs === null ? "none" : `${Math.round(b.firstByteMs / 1000)} s`}` +
              `${b.estimated ? " estimated" : ""}, deadline ${Math.round(b.limitMs / 1000)} s)`,
          );
      }
      for (const initiative of replay.initiatives) {
        console.log(
          `  initiative ${initiative.initiativeId}: ${initiative.shareGate.length} share-gate decisions, new parks ${initiative.newShareStops}`,
        );
        for (const b of initiative.shareGate.filter((b) => b.recorded !== b.replayed))
          console.log(`    ${b.featureId}: recorded ${b.recorded}, now ${b.replayed}`);
      }
    }
} else {
  console.error(usage);
  process.exit(2);
}

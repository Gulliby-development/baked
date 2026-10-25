#!/usr/bin/env bun
/**
 * Usage traces of bench-round runs (#1649).
 *
 *   bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]
 *   bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]
 *   bun scripts/bench-trace.ts latencies <trace.sqlite.gz> ... [--json]
 *   bun scripts/bench-trace.ts recordings <workspace> <out-dir> [--run RUN_ID ...]
 *   bun scripts/bench-trace.ts chains <trace.sqlite.gz> ... [--json]
 *
 * `export` writes the anonymised trace of a workspace's workflow database (see
 * src/core/workflows/trace.ts); the bench loop stores one per app per round under
 * tests/fixtures/bench-traces/RNN/. `replay` runs the forecast gate of the current code at every
 * recorded attempt and prints the stops and cap growth that differ from the recorded run.
 * `latencies` prints the healthy first-byte percentiles and retry-after waits of the recorded
 * calls by provider, stage and effort: what the provider fault matrix tests limits against (#1729).
 * `recordings` writes the model calls of runs started with `--record-model-calls` (#1715).
 * `chains` prints each run's finding chains for the round report (#1981): from `chains/` records,
 * the chain length, each corrective's decision, tokens and cost, and the battery's results; for
 * every run, where a chain-rewrite policy would have rewritten and what its battery would hold.
 */
import {
  chainCosts,
  corpusCallProfile,
  exportRecordings,
  exportTrace,
  openTrace,
  replayChainEscalation,
  replayPlanApprovals,
  replayTrace,
} from "../src/core/workflows/trace.js";

const usage =
  "Usage: bun scripts/bench-trace.ts export <workspace> <out.sqlite.gz> [--run RUN_ID ...]\n" +
  "       bun scripts/bench-trace.ts replay <trace.sqlite.gz> ... [--json]\n" +
  "       bun scripts/bench-trace.ts latencies <trace.sqlite.gz> ... [--json]\n" +
  "       bun scripts/bench-trace.ts recordings <workspace> <out-dir> [--run RUN_ID ...]\n" +
  "       bun scripts/bench-trace.ts chains <trace.sqlite.gz> ... [--json]";

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
} else if (command === "chains" && args.length > 0) {
  const traces = args.map((path) => {
    const { store, dispose } = openTrace(path);
    try {
      const runs = (
        store.connection.query("SELECT id, feature_id FROM runs ORDER BY created_at").all() as {
          id: string;
          feature_id: string;
        }[]
      ).map((run) => ({
        runId: run.id,
        featureId: run.feature_id,
        chains: chainCosts(store, run.id),
        escalation: replayChainEscalation(store, run.id),
      }));
      return { trace: path, runs };
    } finally {
      dispose();
    }
  });
  if (flags.includes("--json")) console.log(JSON.stringify(traces, null, 2));
  else
    for (const trace of traces) {
      console.log(trace.trace);
      for (const run of trace.runs) {
        const rewrites = run.escalation.steps.filter((s) => s.decision === "rewrite");
        if (!run.chains.length && !rewrites.length && !run.escalation.missingBodies.length) continue;
        console.log(`  ${run.featureId} ${run.runId}: ${run.chains.length} recorded chains`);
        for (const chain of run.chains)
          console.log(
            `    ${chain.file ?? "-"} ${chain.family ? `family ${chain.family} (last ${chain.symbol})` : chain.symbol}: length ${chain.length} (${chain.findings.join(", ")}), ` +
              `correctives ${chain.tasks.map((t) => `${t.taskId} ${t.decision}`).join(", ")}, ` +
              `${chain.tokens} tokens, ${usd(chain.costUsd)}; battery ${chain.battery.runs} runs, ` +
              `${chain.battery.cases} cases (${chain.battery.reproduced} reproduced, ${chain.battery.refuted} refuted, ` +
              `${chain.battery.inconclusive} inconclusive), ${chain.battery.reopened} reopened`,
          );
        const first = rewrites[0];
        if (first)
          console.log(
            `    with chainRewrite on: first rewrite at ${first.findingId} (chain ${first.chain.join(" > ")}${first.family ? `, family ${first.family}` : ""}, ` +
              `battery ${first.battery.length} cases)`,
          );
        if (run.escalation.missingBodies.length)
          console.log(`    no finding body in the trace: ${run.escalation.missingBodies.join(", ")}`);
      }
    }
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
            `cost-cap refusals ${run.newCostStops} of ${run.costCap.length} attempts, ` +
            `new test splits ${run.newTestSplits} of ${run.testSplits.length} test tasks, ` +
            `new recovery rungs ${run.newRecoveries} of ${run.stallLadder.length} stalls, ` +
            `repeated failures ${run.repeatedFailures.filter((b) => b.replayed === "repeat").length} of ${run.repeatedFailures.length} failing correctives (new ${run.newRepeatStops}), ` +
            `conflict decisions changed ${run.newConflictDecisions} of ${run.requestConflicts.length} reports, ` +
            `new integrity findings ${run.newIntegrityFindings} in ${run.integrity.length} scans, ` +
            `new case refusals ${run.newCaseRefusals} in ${run.caseWalks.length} case walks` +
            (ratios ? `, forecast/final ${ratios}` : ""),
        );
        for (const b of run.boundaries.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${new Date(b.at).toISOString()} ${b.attemptId}: recorded ${b.recorded}, now ${b.replayed} ` +
              `(forecast ${usd(b.projectedUsd)}, ceiling ${usd(b.ceilingUsd)}, spent ${usd(b.spentUsd)})`,
          );
        for (const b of run.repeatedFailures.filter((b) => b.replayed === "repeat"))
          console.log(
            `    ${b.taskId}: fails as ${b.previous ?? "-"} did (recorded ${b.recorded}, now ${b.replayed})`,
          );
        for (const b of run.requestConflicts.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${b.taskId} conflict report ${b.report}: recorded ${b.recorded}, now ${b.replayed}`,
          );
        for (const b of run.integrity) {
          const added = b.replayed.filter((f) => !b.recorded.includes(f));
          if (added.length)
            console.log(`    integrity ${b.scope} ${b.taskId ?? ""}: now also ${added.join(", ")}`);
        }
        for (const b of run.caseWalks) {
          const added = b.replayed.filter((c) => !b.recorded.includes(c));
          if (added.length) console.log(`    case walk ${b.taskId}: now also refuses ${added.join(", ")}`);
        }
        for (const b of run.stallLadder.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    stall ${b.attemptId} (${b.stage ?? "?"} on ${b.model}): recorded ${b.recorded}, now ${b.replayed}`,
          );
        for (const b of run.costCap.filter((b) => b.replayed === "stop"))
          console.log(
            `    ${b.attemptId} (${b.stage} ${b.model}, ${b.tokens} tokens): now refused ` +
              `(call ${usd(b.requestedUsd)}, spent ${usd(b.spentUsd)}, reserved ${usd(b.reservedUsd)}, ceiling ${usd(b.ceilingUsd)})`,
          );
        for (const b of run.testSplits.filter((b) => b.recorded !== b.replayed))
          console.log(`    ${b.report} ${b.taskId} (${b.cases} cases): recorded ${b.recorded}, now ${b.replayed}`);
        for (const b of run.firstByte.filter((b) => b.recorded !== b.replayed))
          console.log(
            `    ${b.attemptId} call ${b.call} (${b.provider} ${b.stage ?? "?"} ${b.effort ?? "default"}): ` +
              `recorded ${b.recorded}, now ${b.replayed} (first response ${b.firstByteMs === null ? "none" : `${Math.round(b.firstByteMs / 1000)} s`}` +
              `${b.estimated ? " estimated" : ""}, deadline ${Math.round(b.limitMs / 1000)} s)`,
          );
      }
      for (const approval of replayPlanApprovals(replay.trace).filter((a) => a.recorded !== a.replayed))
        console.log(
          `  plan approval of ${approval.runId}: recorded ${approval.recorded}, now ${approval.replayed}` +
            (approval.reasons.length ? ` (${approval.reasons.join("; ")})` : ""),
        );
      for (const initiative of replay.initiatives) {
        console.log(
          `  initiative ${initiative.initiativeId}: ${initiative.shareGate.length} share-gate decisions, new parks ${initiative.newShareStops}`,
        );
        for (const b of initiative.shareGate.filter((b) => b.recorded !== b.replayed))
          console.log(`    ${b.featureId}: recorded ${b.recorded}, now ${b.replayed}`);
        console.log(
          `  initiative ${initiative.initiativeId}: ${initiative.starts.length} starts rewound, new parks ${initiative.newStartStops}, final ${usd(initiative.finalUsd)}` +
            (initiative.missingHistory.length
              ? `, ${initiative.missingHistory.length} history stores not in the corpus`
              : ""),
        );
        for (const b of initiative.starts)
          console.log(
            `    ${b.featureId} at ${b.accepted}/${b.features} accepted: ${b.replayed} ` +
              `(forecast ${usd(b.forecastUsd)}, ceiling ${usd(b.ceilingUsd)}, spent ${usd(b.spentUsd)})`,
          );
      }
    }
} else {
  console.error(usage);
  process.exit(2);
}

// Refreshes the per-file durations `test-shard.ts` balances shards with:
// `bun scripts/test-shard-weights.ts <windows|macos> <job log>...`. Each log is the full log of one
// `OS tests` shard of that OS (`gh run view <run> --log --job <job id>`, or the job's "Download log
// archive"); the shard prints a `##[group]tests/<file>:` line as each file starts. A file weighs the
// median of its measured times across the logs, in seconds from its line to the next file's (the
// last file ends at bun's `Ran N tests` line). The table keeps the files of 1 s or more; any other
// file weighs the median of all measured files.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ShardWeights, testFiles } from "./test-shard.js";

const STAMP = /(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)$/;
const GROUP = /##\[group\](tests[\\/]\S+\.test\.tsx?):/;
const END = /^Ran \d+ tests? across/;

/** Seconds each test file took in one shard log, keyed by its `/`-separated path. */
export function fileSeconds(log: string): Map<string, number> {
  const seconds = new Map<string, number>();
  let current: { file: string; start: number } | undefined;
  for (const line of log.split(/\r?\n/)) {
    const stamped = STAMP.exec(line);
    if (!stamped) continue;
    const at = Date.parse(stamped[1]);
    const group = GROUP.exec(stamped[2]);
    if (current && (group || END.test(stamped[2].trim()))) {
      seconds.set(current.file, (at - current.start) / 1000);
      current = undefined;
    }
    if (group) current = { file: group[1].replaceAll("\\", "/"), start: at };
  }
  return seconds;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const tenths = (value: number) => Math.round(value * 10) / 10;

/** The weight table for one OS from its shard logs, limited to the files that exist now. */
export function buildWeights(logs: string[], files: readonly string[]): ShardWeights {
  const runs = new Map<string, number[]>();
  for (const log of logs)
    for (const [file, value] of fileSeconds(log))
      runs.set(file, [...(runs.get(file) ?? []), value]);
  const known = new Set(files);
  const measured = [...runs]
    .filter(([file]) => known.has(file))
    .map(([file, values]) => [file, median(values)] as const);
  if (measured.length === 0) throw new Error("no test file timings in these logs");
  const table: Record<string, number> = {};
  for (const [file, value] of measured.sort(([a], [b]) => (a < b ? -1 : 1)))
    if (value >= 1) table[file] = tenths(value);
  return { default: tenths(median(measured.map(([, value]) => value))), files: table };
}

if (import.meta.main) {
  const [os, ...paths] = process.argv.slice(2);
  if ((os !== "windows" && os !== "macos") || paths.length === 0) {
    console.error("usage: bun scripts/test-shard-weights.ts <windows|macos> <job log>...");
    process.exit(2);
  }
  const target = join(import.meta.dir, "test-shard-weights.json");
  const table = JSON.parse(readFileSync(target, "utf8"));
  table[os] = buildWeights(
    paths.map((path) => readFileSync(path, "utf8")),
    testFiles(),
  );
  writeFileSync(target, `${JSON.stringify(table, null, 2)}\n`);
  const total = Object.values(table[os].files as Record<string, number>).reduce(
    (sum, value) => sum + value,
    0,
  );
  console.log(
    `${os}: ${Object.keys(table[os].files).length} files of 1 s or more, ${Math.round(total / 60)} min`,
  );
}

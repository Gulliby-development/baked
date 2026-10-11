/**
 * Fails when a tracked text file still holds Git merge-conflict markers.
 * Run with `bun run check:conflicts`; CI runs it on every pull request.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ConflictMarker {
  line: number;
  text: string;
}

const OPEN = "<".repeat(7);
const BASE = "|".repeat(7);
const SPLIT = "=".repeat(7);
const CLOSE = ">".repeat(7);

function isMarker(line: string, marker: string): boolean {
  return line === marker || line.startsWith(`${marker} `);
}

/**
 * Marker lines in `text`. A bare `=======` also underlines Markdown headings,
 * so it only counts after an opening `<<<<<<<` line.
 */
export function findConflictMarkers(text: string): ConflictMarker[] {
  const out: ConflictMarker[] = [];
  let open = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isMarker(line, OPEN)) {
      open = true;
      out.push({ line: i + 1, text: line });
    } else if (isMarker(line, CLOSE)) {
      open = false;
      out.push({ line: i + 1, text: line });
    } else if (isMarker(line, BASE) || (open && line === SPLIT)) {
      out.push({ line: i + 1, text: line });
    }
  }
  return out;
}

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

if (import.meta.main) {
  let found = 0;
  for (const path of trackedFiles()) {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      continue; // deleted in the working tree, or a submodule
    }
    if (data.includes(0)) continue; // binary
    for (const marker of findConflictMarkers(data.toString("utf8"))) {
      found++;
      console.error(`${path}:${String(marker.line)}: merge-conflict marker: ${marker.text}`);
    }
  }
  if (found > 0) {
    console.error(`${String(found)} merge-conflict marker(s) found. Resolve them before merging.`);
    process.exit(1);
  }
  console.log("No merge-conflict markers in tracked files.");
}

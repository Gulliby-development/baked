/**
 * Static security analysis of the run's diff (#640): Semgrep on the code files the run changed,
 * when it is installed. Matches on lines the run added join the run's security findings: an
 * `ERROR` match blocks, the others are notes. Without Semgrep, or when it fails, the gate is
 * inconclusive and never blocks. BAKED does not install Semgrep.
 */
import { spawnSync } from "node:child_process";
import type { ChangedFile } from "./rules.js";
import { addedLines } from "./rules.js";

export type SastMode = "auto" | "off";
export const sastOf = (policy: { sast?: SastMode | undefined }): SastMode => policy.sast ?? "auto";
/** Artifact of the latest Semgrep run of a run. */
export const QUALITY_SAST = "quality/sast.json";
/** Whether a finding's claim is one the SAST gate made. */
export const sastClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^SAST \S+: /.test(claim);
/** The Semgrep configuration used when the project names none. */
export const DEFAULT_SAST_CONFIG = "p/default";

export interface SastFinding {
  rule: string;
  file: string;
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
  blocking: boolean;
}

export interface SastResult {
  schemaVersion: 1;
  ran: boolean;
  config: string;
  note?: string;
  findings: SastFinding[];
}

/** The Semgrep executable, or null when it is not installed. */
export function semgrepExecutable(): string | null {
  const probe = spawnSync("semgrep", ["--version"], { encoding: "utf8", timeout: 15_000 });
  return probe.status === 0 ? "semgrep" : null;
}

interface SemgrepOutput {
  results?: {
    check_id?: string;
    path?: string;
    start?: { line?: number };
    extra?: { message?: string; severity?: string };
  }[];
  errors?: { message?: string }[];
}

export type SastRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

const runProcess: SastRunner = (executable, args, cwd) => {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** Runs Semgrep on the changed code files and keeps the matches on added lines. */
export function runSast(
  root: string,
  files: ChangedFile[],
  config: string,
  executable: string | null = semgrepExecutable(),
  run: SastRunner = runProcess,
): SastResult {
  const base = { schemaVersion: 1 as const, config, findings: [] as SastFinding[] };
  if (!files.length) return { ...base, ran: false, note: "no code changed" };
  if (!executable) return { ...base, ran: false, note: "Semgrep is not installed" };
  const result = run(
    executable,
    ["scan", "--json", "--metrics=off", "--quiet", "--config", config, ...files.map((f) => f.path)],
    root,
  );
  let output: SemgrepOutput;
  try {
    output = JSON.parse(result.stdout || "{}") as SemgrepOutput;
  } catch {
    return {
      ...base,
      ran: false,
      note: `Semgrep failed: ${(result.stderr || `exit ${result.status}`).trim().slice(0, 300)}`,
    };
  }
  const added = new Map(files.map((f) => [f.path, addedLines(f.before, f.content)]));
  const known = new Map(files.map((f) => [f.path, f.before !== undefined]));
  const findings: SastFinding[] = [];
  for (const match of output.results ?? []) {
    const path = (match.path ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
    const line = match.start?.line ?? 0;
    if (!added.get(path)?.has(line - 1)) continue;
    const raw = (match.extra?.severity ?? "").toUpperCase();
    const severity = raw === "ERROR" ? "error" : raw === "WARNING" ? "warning" : "info";
    findings.push({
      rule: match.check_id ?? "semgrep",
      file: path,
      line,
      severity,
      message: (match.extra?.message ?? match.check_id ?? "Semgrep match").trim().slice(0, 500),
      blocking: severity === "error" && known.get(path) === true,
    });
  }
  const errors = (output.errors ?? []).map((e) => e.message ?? "").filter(Boolean);
  return {
    ...base,
    ran: true,
    findings,
    ...(errors.length ? { note: errors.join("; ").slice(0, 300) } : {}),
  };
}

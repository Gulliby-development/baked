import { spawn } from "node:child_process";
import { buildSafeEnv } from "../spawn.js";

const encoder = new TextEncoder();

interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  isDirty: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicts: string[];
  ahead: number;
  behind: number;
}

interface GitLogEntry {
  hash: string;
  subject: string;
  date: string;
}

export function run(
  args: string[],
  cwd: string,
  timeout = 5_000,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = spawn("git", args, {
      cwd,
      timeout,
      env: buildSafeEnv(),
      // stderr is never read; piping it lets a long message (git's usage text
      // outside a repository) fill the pipe and block git until the timeout.
      stdio: ["ignore", "pipe", "ignore"],
    });
    proc.stdout?.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: chunks.join("") }));
    proc.on("error", () => resolve({ ok: false, stdout: "" }));
  });
}

export function parseGitLogLine(line: string): GitLogEntry {
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) return { hash: line, subject: "", date: "" };
  const hash = line.slice(0, spaceIdx);
  const rest = line.slice(spaceIdx + 1);
  const parenIdx = rest.lastIndexOf("(");
  const subject = parenIdx >= 0 ? rest.slice(0, parenIdx).trim() : rest;
  const date = parenIdx >= 0 ? rest.slice(parenIdx + 1, -1) : "";
  return { hash, subject, date };
}

const NAMED_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  a: "\x07",
  b: "\b",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

export function unquoteGitPath(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const inner = path.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch === "\\" && i + 1 < inner.length) {
      const next = inner.charAt(i + 1);
      if (next >= "0" && next <= "7") {
        let octal = next;
        const c2 = inner.charAt(i + 2);
        if (c2 >= "0" && c2 <= "7") {
          octal += c2;
          const c3 = inner.charAt(i + 3);
          if (c3 >= "0" && c3 <= "7") {
            octal += c3;
          }
        }
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length;
        continue;
      }
      const named = NAMED_ESCAPES[next];
      if (named !== undefined) {
        for (let j = 0; j < named.length; j++) {
          bytes.push(named.charCodeAt(j));
        }
        i++;
        continue;
      }
    }
    const code = ch.charCodeAt(0);
    if (code < 0x80) {
      bytes.push(code);
    } else {
      const encoded = encoder.encode(ch);
      for (const b of encoded) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseStatusLine(line: string): {
  x: string;
  y: string;
  file: string;
  category: "untracked" | "staged" | "modified" | "none";
} {
  const x = line[0] ?? "";
  const y = line[1] ?? "";
  const raw = line.slice(3);
  const arrowIdx = raw.indexOf(" -> ");
  const file = unquoteGitPath(arrowIdx >= 0 ? raw.slice(arrowIdx + 4) : raw);
  let category: "untracked" | "staged" | "modified" | "none" = "none";
  if (x === "?") {
    category = "untracked";
  } else {
    if (x && x !== " " && x !== "?") category = "staged";
    if (y && y !== " " && y !== "?") category = "modified";
  }
  return { x, y, file, category };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const { ok } = await run(["rev-parse", "--is-inside-work-tree"], cwd);
  return ok;
}

export async function getGitBranch(cwd: string): Promise<string | null> {
  const { ok, stdout } = await run(["branch", "--show-current"], cwd);
  return ok ? stdout.trim() || null : null;
}

export async function getGitStatus(cwd: string): Promise<GitStatus> {
  const repoCheck = await isGitRepo(cwd);
  if (!repoCheck) {
    return {
      isRepo: false,
      branch: null,
      isDirty: false,
      staged: [],
      modified: [],
      untracked: [],
      conflicts: [],
      ahead: 0,
      behind: 0,
    };
  }

  const [branchResult, statusResult, aheadBehindResult] = await Promise.all([
    getGitBranch(cwd),
    run(["status", "--porcelain=v1"], cwd),
    run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd),
  ]);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];

  if (statusResult.ok) {
    for (const raw of statusResult.stdout.split("\n")) {
      if (!raw) continue;
      const parsed = parseStatusLine(raw);
      const x = raw[0];
      const y = raw[1];
      if (x === "U" || y === "U" || (x === "D" && y === "D") || (x === "A" && y === "A")) {
        conflicts.push(parsed.file);
      } else if (parsed.category === "untracked") {
        untracked.push(parsed.file);
      } else {
        if (x && x !== " " && x !== "?") staged.push(parsed.file);
        if (y && y !== " " && y !== "?") modified.push(parsed.file);
      }
    }
  }

  let ahead = 0;
  let behind = 0;
  if (aheadBehindResult.ok) {
    const parts = aheadBehindResult.stdout.trim().split(/\s+/);
    ahead = Number.parseInt(parts[0] ?? "0", 10) || 0;
    behind = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  return {
    isRepo: true,
    branch: branchResult,
    isDirty: staged.length > 0 || modified.length > 0 || untracked.length > 0,
    staged,
    modified,
    untracked,
    conflicts,
    ahead,
    behind,
  };
}

export async function getGitDiff(cwd: string, staged?: boolean): Promise<string> {
  const args = staged ? ["diff", "--cached"] : ["diff"];
  const { ok, stdout } = await run(args, cwd);
  return ok ? stdout : "";
}

export async function getGitLog(cwd: string, count = 10): Promise<GitLogEntry[]> {
  const { ok, stdout } = await run(
    ["log", `--oneline`, `-n`, String(count), "--format=%h %s (%cr)"],
    cwd,
  );
  if (!ok) return [];
  const lines = stdout.trim().split("\n").filter(Boolean);
  // NOTE: this used to offload to the IO worker via dynamic import of
  // io-client.js — that pulled the worker store + zustand + React into
  // the worker bundle and produced a self-referential loop when the
  // worker called getGitLog itself. Always parse inline; parseGitLogLine
  // is a regex match, cheap enough for the main thread.
  return lines.map(parseGitLogLine);
}

export async function gitInit(cwd: string): Promise<boolean> {
  const { ok } = await run(["init"], cwd);
  return ok;
}

const CO_AUTHOR_LINE = "Co-Authored-By: BAKED <noreply@github.com>";
let _coAuthorEnabled = true;

export function setCoAuthorEnabled(enabled: boolean) {
  _coAuthorEnabled = enabled;
}

export async function gitCommit(
  cwd: string,
  message: string,
  amend?: boolean,
): Promise<{ ok: boolean; output: string }> {
  const cleaned = message.replace(/\\n/g, "\n");
  const fullMessage = _coAuthorEnabled ? `${cleaned}\n\n${CO_AUTHOR_LINE}` : cleaned;
  const args = amend ? ["commit", "--amend", "-m", fullMessage] : ["commit", "-m", fullMessage];
  const { ok, stdout } = await run(args, cwd);
  return { ok, output: stdout };
}

export async function gitShow(cwd: string, ref: string): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["show", "--stat", "--format=%H %s%n%an <%ae>%n%ai", ref], cwd);
  return { ok, output: stdout };
}

export async function gitUnstage(
  cwd: string,
  files: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["reset", "HEAD", ...files], cwd);
  return { ok, output: stdout || `Unstaged ${String(files.length)} file(s)` };
}

export async function gitRestore(
  cwd: string,
  files: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["restore", ...files], cwd);
  return { ok, output: stdout || `Restored ${String(files.length)} file(s)` };
}

export async function gitAdd(cwd: string, files: string[]): Promise<boolean> {
  const { ok } = await run(["add", ...files], cwd);
  return ok;
}

export async function gitPush(
  cwd: string,
  args?: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["push", ...(args ?? [])], cwd, 30_000);
  return { ok, output: stdout };
}

export async function gitPull(
  cwd: string,
  args?: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["pull", ...(args ?? [])], cwd, 30_000);
  return { ok, output: stdout };
}

export async function gitStash(
  cwd: string,
  message?: string,
): Promise<{ ok: boolean; output: string }> {
  const args = message ? ["stash", "push", "-m", message] : ["stash"];
  const { ok, stdout } = await run(args, cwd);
  return { ok, output: stdout };
}

export async function gitStashPop(cwd: string): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "pop"], cwd);
  return { ok, output: stdout };
}

export async function gitStashList(cwd: string): Promise<{ ok: boolean; entries: string[] }> {
  const { ok, stdout } = await run(["stash", "list"], cwd);
  if (!ok) return { ok: false, entries: [] };
  return { ok: true, entries: stdout.trim().split("\n").filter(Boolean) };
}

export async function gitStashShow(
  cwd: string,
  index = 0,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "show", "-p", `stash@{${String(index)}}`], cwd);
  return { ok, output: stdout };
}

export async function gitStashDrop(
  cwd: string,
  index = 0,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["stash", "drop", `stash@{${String(index)}}`], cwd);
  return { ok, output: stdout };
}

export async function gitCreateBranch(
  cwd: string,
  name: string,
  checkout = true,
): Promise<{ ok: boolean; output: string }> {
  if (checkout) {
    const { ok, stdout } = await run(["checkout", "-b", name], cwd);
    return { ok, output: stdout };
  }
  const { ok, stdout } = await run(["branch", name], cwd);
  return { ok, output: stdout };
}

export async function gitSwitchBranch(
  cwd: string,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["checkout", name], cwd);
  return { ok, output: stdout };
}

export async function gitTag(
  cwd: string,
  subAction?: string,
  name?: string,
  message?: string,
  ref?: string,
): Promise<{ ok: boolean; output: string }> {
  const action = subAction ?? "list";
  switch (action) {
    case "list": {
      const { ok, stdout } = await run(["tag", "-l", "--sort=-creatordate"], cwd);
      return { ok, output: stdout || "No tags." };
    }
    case "create": {
      if (!name) return { ok: false, output: "Tag name required" };
      const args = message
        ? ["tag", "-a", name, "-m", message, ...(ref ? [ref] : [])]
        : ["tag", name, ...(ref ? [ref] : [])];
      const { ok, stdout } = await run(args, cwd);
      return { ok, output: stdout || `Created tag ${name}` };
    }
    case "delete": {
      if (!name) return { ok: false, output: "Tag name required" };
      const { ok, stdout } = await run(["tag", "-d", name], cwd);
      return { ok, output: stdout || `Deleted tag ${name}` };
    }
    default:
      return { ok: false, output: `Unknown tag action: ${action}` };
  }
}

export async function gitCherryPick(
  cwd: string,
  ref: string,
  flags?: string[],
): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["cherry-pick", ...(flags ?? []), ref], cwd, 15_000);
  return { ok, output: stdout || (ok ? `Cherry-picked ${ref}` : `Failed to cherry-pick ${ref}`) };
}

export async function gitRebase(
  cwd: string,
  subAction?: string,
  ref?: string,
  flags?: string[],
): Promise<{ ok: boolean; output: string }> {
  const action = subAction ?? "start";
  switch (action) {
    case "abort": {
      const { ok, stdout } = await run(["rebase", "--abort"], cwd, 15_000);
      return { ok, output: stdout || "Rebase aborted." };
    }
    case "continue": {
      const { ok, stdout } = await run(["rebase", "--continue"], cwd, 15_000);
      return { ok, output: stdout || "Rebase continued." };
    }
    case "skip": {
      const { ok, stdout } = await run(["rebase", "--skip"], cwd, 15_000);
      return { ok, output: stdout || "Skipped commit." };
    }
    default: {
      if (!ref) return { ok: false, output: "Ref/branch required for rebase" };
      const { ok, stdout } = await run(["rebase", ...(flags ?? []), ref], cwd, 30_000);
      return { ok, output: stdout || (ok ? `Rebased onto ${ref}` : `Rebase failed`) };
    }
  }
}

export async function gitReset(
  cwd: string,
  ref?: string,
  mode?: string,
  files?: string[],
): Promise<{ ok: boolean; output: string }> {
  if (files && files.length > 0) {
    const { ok, stdout } = await run(["reset", ref ?? "HEAD", "--", ...files], cwd);
    return { ok, output: stdout || `Reset ${String(files.length)} file(s)` };
  }
  const flag = mode === "hard" ? "--hard" : mode === "soft" ? "--soft" : "--mixed";
  const { ok, stdout } = await run(["reset", flag, ref ?? "HEAD"], cwd);
  return { ok, output: stdout || `Reset ${flag} to ${ref ?? "HEAD"}` };
}

export async function gitBlame(
  cwd: string,
  file: string,
  startLine?: number,
  endLine?: number,
): Promise<{ ok: boolean; output: string }> {
  const args = ["blame", "--porcelain"];
  if (startLine != null && endLine != null) {
    args.push(`-L${String(startLine)},${String(endLine)}`);
  } else if (startLine != null) {
    args.push(`-L${String(startLine)},`);
  }
  args.push(file);
  const { ok, stdout } = await run(args, cwd, 10_000);
  if (!ok) return { ok, output: stdout || `Failed to blame ${file}` };

  // Parse porcelain output into a compact readable format
  const lines: string[] = [];
  const commits = new Map<string, { author: string; date: string; summary: string }>();
  const outputLines = stdout.split("\n");
  for (let i = 0; i < outputLines.length; i++) {
    const line = outputLines[i] ?? "";
    const headerMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (headerMatch) {
      const hash = headerMatch[1] ?? "";
      const lineNo = headerMatch[2] ?? "";
      if (!commits.has(hash)) {
        const info = { author: "", date: "", summary: "" };
        for (let j = i + 1; j < outputLines.length; j++) {
          const l = outputLines[j] ?? "";
          if (l.startsWith("author ")) info.author = l.slice(7);
          else if (l.startsWith("author-time ")) {
            const ts = Number.parseInt(l.slice(12), 10);
            info.date = new Date(ts * 1000).toISOString().slice(0, 10);
          } else if (l.startsWith("summary ")) info.summary = l.slice(8);
          else if (l.startsWith("\t")) break;
        }
        commits.set(hash, info);
      }
      const c = commits.get(hash) ?? { author: "", date: "", summary: "" };
      // Find the content line (starts with \t)
      let content = "";
      for (let j = i + 1; j < outputLines.length; j++) {
        const ol = outputLines[j] ?? "";
        if (ol.startsWith("\t")) {
          content = ol.slice(1);
          break;
        }
      }
      lines.push(
        `${lineNo.padStart(4)} ${hash.slice(0, 8)} ${c.date} ${c.author.padEnd(15).slice(0, 15)} ${content}`,
      );
    }
  }
  return { ok: true, output: lines.join("\n") || "No blame output." };
}

export async function buildGitContext(cwd: string): Promise<string | null> {
  const status = await getGitStatus(cwd);
  if (!status.isRepo) return null;

  const { ok: upOk, stdout: upOut } = await run(["rev-parse", "--abbrev-ref", "@{upstream}"], cwd);
  const upstream = upOk ? upOut.trim() : null;

  const lines: string[] = [];
  const branchLine = `Branch: ${status.branch ?? "(detached)"}`;
  lines.push(upstream ? `${branchLine} → ${upstream}` : branchLine);
  if (status.conflicts.length > 0) {
    lines.push(
      `⚠ Merge conflicts (${String(status.conflicts.length)}): ${status.conflicts.join(", ")}`,
    );
  }
  if (status.isDirty) {
    const parts: string[] = [];
    if (status.staged.length > 0) parts.push(`${String(status.staged.length)} staged`);
    if (status.modified.length > 0) parts.push(`${String(status.modified.length)} modified`);
    if (status.untracked.length > 0) parts.push(`${String(status.untracked.length)} untracked`);
    lines.push(`Status: dirty (${parts.join(", ")})`);
  } else {
    lines.push("Status: clean");
  }
  if (status.ahead > 0) lines.push(`Ahead: ${String(status.ahead)} commit(s)`);
  if (status.behind > 0) lines.push(`Behind: ${String(status.behind)} commit(s)`);

  const log = await getGitLog(cwd, 5);
  if (log.length > 0) {
    lines.push("", "Recent commits:");
    for (const entry of log) {
      lines.push(`  ${entry.hash} ${entry.subject} (${entry.date})`);
    }
  }

  return lines.join("\n");
}
export async function gitResetHard(cwd: string): Promise<{ ok: boolean; output: string }> {
  const { ok, stdout } = await run(["reset", "--hard", "HEAD"], cwd);
  return { ok, output: stdout };
}

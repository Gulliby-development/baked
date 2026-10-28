/**
 * The sites of a finding family's code-text pattern (#2343). A family that is a pattern in the
 * test text ("inputs built by `*`, `pack`, interpolation or a loop where the request asks for
 * literal examples") was corrected one reported site per round: R74 callmend's literal-input class
 * rewrote `stream_command_spec.rb`, then `check_command_spec.rb`, then `cli_spec.rb`, 4.25M tokens
 * (14.6 percent of the run). A reviewer now states every site of the pattern (`sites` on the
 * finding), the host keeps each site whose text is code on that line of the file (after
 * `maskNonCode`, as the derivation audit checks a quote against the request), and the corrective
 * gets the kept sites as one list across files and may write each of their files.
 *
 * Each check is recorded under `chains/sites/<task>.json` with the lines it read, raw and masked,
 * so `replayFindingChains` decides it again without the workspace.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { canonical } from "../specs/hash.js";
import { CHAIN_KIND } from "../workflows/finding-chain.js";
import { maskNonCode } from "../workflows/quality/code-mask.js";
import type { Review } from "../workflows/schemas.js";
import type { WorkflowStore } from "../workflows/store.js";

type Finding = Review["findings"][number];
export type FamilySite = NonNullable<Finding["sites"]>[number];

/** The most sites a finding states; past that the list stops being a checklist (`ReviewSchema`). */
export const MAX_FAMILY_SITES = 32;

/** How many lines above and below the stated line a site's text may sit: line numbers drift. */
export const SITE_SLACK = 2;

/** Where the host's site checks are recorded, one file per corrective task. */
export const CHAIN_SITES_DIR = "chains/sites/";

/**
 * A stated site's verdict: `kept` when its text is code within `SITE_SLACK` lines of its line,
 * `not_code` when the text is there only in a comment or a string, `not_on_line` when it is not
 * there, `no_file` when the file does not exist and `unwritable` when the corrective may not write
 * the file (no planned task writes it).
 */
export type SiteVerdict = "kept" | "not_code" | "not_on_line" | "no_file" | "unwritable";

/** One line a site check read: its number, its text and its text after `maskNonCode`. */
export interface SiteLine {
  line: number;
  raw: string;
  masked: string;
}

export interface SiteCheck extends FamilySite {
  findingId: string;
  verdict: SiteVerdict;
  /** The line the text was found on as code, when kept. */
  foundLine?: number;
  /** The lines around the stated line that the check read; empty for `no_file`. */
  window: SiteLine[];
}

export interface SitesRecord {
  taskId: string;
  findingIds: string[];
  sites: SiteCheck[];
}

/**
 * Whether a site's text is code on one of `window`'s lines, the nearest to `line` first: an
 * occurrence counts when its span in the masked line holds something other than blanks and quote
 * delimiters, so a comment or the inside of a string literal is not a site.
 */
export function siteDecision(
  text: string,
  line: number,
  window: readonly SiteLine[],
): { verdict: "kept" | "not_code" | "not_on_line"; foundLine?: number } {
  const needle = text.trim();
  if (!needle) return { verdict: "not_on_line" };
  let seen = false;
  const nearest = [...window].sort(
    (a, b) => Math.abs(a.line - line) - Math.abs(b.line - line) || a.line - b.line,
  );
  for (const row of nearest) {
    for (let at = row.raw.indexOf(needle); at >= 0; at = row.raw.indexOf(needle, at + 1)) {
      seen = true;
      if (/[^\s"'`]/.test(row.masked.slice(at, at + needle.length)))
        return { verdict: "kept", foundLine: row.line };
    }
  }
  return { verdict: seen ? "not_code" : "not_on_line" };
}

/** The lines of `path` within `SITE_SLACK` of `line`, raw and masked. */
export function siteWindow(path: string, content: string, line: number): SiteLine[] {
  const raw = content.split("\n");
  const masked = maskNonCode(path, content).split("\n");
  const rows: SiteLine[] = [];
  for (let n = Math.max(1, line - SITE_SLACK); n <= Math.min(raw.length, line + SITE_SLACK); n++)
    rows.push({ line: n, raw: raw[n - 1] ?? "", masked: masked[n - 1] ?? "" });
  return rows;
}

/**
 * The host's check of every site the findings state, under the run's root: a site outside the
 * root or in a missing file is `no_file`, and one whose file `writable` refuses is `unwritable`.
 * Duplicate sites (one file, line and text) are checked once.
 */
export function checkSites(
  root: string,
  findings: readonly Pick<Finding, "id" | "sites">[],
  writable: (path: string) => boolean,
): SiteCheck[] {
  const seen = new Set<string>();
  const checks: SiteCheck[] = [];
  const contents = new Map<string, string | null>();
  const read = (file: string): string | null => {
    if (!contents.has(file)) {
      const path = join(root, file);
      const inside =
        !isAbsolute(file) && !relative(root, normalize(path)).startsWith("..") && existsSync(path);
      let content: string | null = null;
      if (inside)
        try {
          content = readFileSync(path, "utf8");
        } catch {}
      contents.set(file, content);
    }
    return contents.get(file) ?? null;
  };
  for (const finding of findings)
    for (const site of (finding.sites ?? []).slice(0, MAX_FAMILY_SITES)) {
      const key = `${site.file}\n${String(site.line)}\n${site.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const content = read(site.file);
      if (content === null) {
        checks.push({ ...site, findingId: finding.id, verdict: "no_file", window: [] });
        continue;
      }
      const window = siteWindow(site.file, content, site.line);
      const decided = siteDecision(site.text, site.line, window);
      const verdict =
        decided.verdict === "kept" && !writable(site.file) ? "unwritable" : decided.verdict;
      checks.push({
        ...site,
        findingId: finding.id,
        verdict,
        ...(decided.foundLine !== undefined ? { foundLine: decided.foundLine } : {}),
        window,
      });
    }
  return checks;
}

/** The kept sites of a check, each at the line its text was found on, each place once. */
export function keptSites(checks: readonly SiteCheck[]): FamilySite[] {
  const seen = new Set<string>();
  return checks
    .filter((c) => c.verdict === "kept")
    .map((c) => ({ file: c.file, line: c.foundLine ?? c.line, text: c.text }))
    .filter((s) => {
      const key = `${s.file}\n${String(s.line)}\n${s.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The corrective's step that lists the kept sites, one list across files; empty when none. */
export function sitesStep(sites: readonly FamilySite[]): string {
  if (!sites.length) return "";
  const list = sites.map((s) => `- ${s.file}:${String(s.line)}: ${s.text}`).join("\n");
  return `\n\nSites of this defect class: the reviewer named every place the same pattern appears, and the host checked that each one holds it in code (not in a comment or a string). Fix every site below in this task, not only the reported one, so the next review finds none of them; each file listed is writable here.\n${list}`;
}

/** Records a corrective's site checks for the trace and the next review's earlier findings. */
export function recordSites(
  store: WorkflowStore,
  runId: string,
  taskId: string,
  findingIds: string[],
  sites: SiteCheck[],
): void {
  const record: SitesRecord = { taskId, findingIds, sites };
  store.artifact(runId, CHAIN_KIND, `${CHAIN_SITES_DIR}${taskId}.json`, canonical(record));
}

/** The kept sites of a finding, from its corrective's record, or none. */
export function recordedSites(
  store: WorkflowStore,
  runId: string,
  taskId: string,
  findingId: string,
): FamilySite[] {
  const row = store.latestArtifact(runId, `${CHAIN_SITES_DIR}${taskId}.json`);
  if (!row) return [];
  try {
    const record = JSON.parse(store.readArtifact(runId, row.id)) as SitesRecord;
    return keptSites(record.sites.filter((s) => s.findingId === findingId));
  } catch {
    return [];
  }
}

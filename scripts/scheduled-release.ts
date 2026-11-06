/**
 * Plans and stamps the scheduled release (.github/workflows/scheduled-release.yml).
 *
 * A scheduled release does not change `main`: it commits the version bump on top of
 * `main` outside any branch, tags that commit `vX.Y.Z` and starts release.yml on the tag.
 * The next version is therefore one bump above the higher of the latest `v*` tag and
 * `package.json` (which keeps the version of the last release cut by hand).
 *
 * Usage:
 *   bun scripts/scheduled-release.ts plan     # writes release/version/tag/reason to $GITHUB_OUTPUT
 *   bun scripts/scheduled-release.ts current  # prints the version the next bump starts from
 *   bun scripts/scheduled-release.ts stamp <version>
 * `plan` reads BUMP (patch|minor|major, default minor), FORCE (1 skips the interval check),
 * MIN_INTERVAL_HOURS (default 44, so a daily cron releases every second day) and BASE (default origin/main).
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

export type Bump = "patch" | "minor" | "major";

export const VERSION_FILES = ["package.json", "apps/desktop/package.json"] as const;
export const DEFAULT_MIN_INTERVAL_HOURS = 44;

type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The highest `vX.Y.Z` tag, ignoring tags of any other shape. */
export function latestTag(tags: readonly string[]): string | null {
  let best: { tag: string; version: Version } | null = null;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    const version = parseVersion(tag);
    if (version && (!best || compare(version, best.version) > 0)) best = { tag, version };
  }
  return best?.tag ?? null;
}

/** The version a bump starts from: the higher of the latest tag and package.json. */
export function baseVersion(tag: string | null, packageVersion: string): string {
  const fromPackage = parseVersion(packageVersion);
  const fromTag = tag ? parseVersion(tag) : null;
  if (!fromPackage) throw new Error(`package.json version "${packageVersion}" is not X.Y.Z`);
  const base = fromTag && compare(fromTag, fromPackage) > 0 ? fromTag : fromPackage;
  return base.join(".");
}

export function bumpVersion(version: string, bump: Bump): string {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not X.Y.Z`);
  const [major, minor, patch] = parsed;
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export interface PlanInput {
  /** Latest `v*` tag, or null before the first release. */
  tag: string | null;
  /** When that tag was created, in seconds since the epoch. */
  tagCreatedAt: number | null;
  /** Commits on main that the tag does not contain. */
  newCommits: number;
  packageVersion: string;
  bump: Bump;
  force: boolean;
  now: number;
  minIntervalHours?: number;
}

export type Plan = { release: true; version: string; tag: string; reason: string } | { release: false; reason: string };

export function planRelease(input: PlanInput): Plan {
  if (input.newCommits <= 0) {
    return { release: false, reason: `main has no new commits since ${input.tag ?? "the start"}` };
  }
  const minHours = input.minIntervalHours ?? DEFAULT_MIN_INTERVAL_HOURS;
  if (!input.force && input.tag && input.tagCreatedAt !== null) {
    const ageHours = (input.now - input.tagCreatedAt) / 3600;
    if (ageHours < minHours) {
      return {
        release: false,
        reason: `${input.tag} is ${ageHours.toFixed(1)} h old; the next scheduled release waits for ${minHours} h`,
      };
    }
  }
  const version = bumpVersion(baseVersion(input.tag, input.packageVersion), input.bump);
  return {
    release: true,
    version,
    tag: `v${version}`,
    reason: `${input.newCommits} new commit(s) since ${input.tag ?? "the start"}`,
  };
}

/** Replaces the top-level "version" field, keeping the file's formatting. */
export function stampVersion(text: string, version: string): string {
  if (!/"version": "[^"]+"/.test(text)) throw new Error("no version field");
  return text.replace(/"version": "[^"]+"/, `"version": "${version}"`);
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function packageVersion(): string {
  return JSON.parse(readFileSync("package.json", "utf8")).version;
}

function readBump(value: string | undefined): Bump {
  const bump = value || "minor";
  if (bump !== "patch" && bump !== "minor" && bump !== "major") throw new Error(`BUMP must be patch, minor or major`);
  return bump;
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  if (command === "current") {
    console.log(baseVersion(latestTag(git("tag", "--list", "v*").split("\n")), packageVersion()));
  } else if (command === "stamp") {
    if (!arg || !parseVersion(arg)) throw new Error("Usage: scheduled-release.ts stamp <X.Y.Z>");
    for (const file of VERSION_FILES) writeFileSync(file, stampVersion(readFileSync(file, "utf8"), arg));
  } else if (command === "plan") {
    const base = process.env.BASE || "origin/main";
    const tag = latestTag(git("tag", "--list", "v*").split("\n"));
    // A scheduled release tag sits on a commit outside main, so count from the merge base.
    const from = tag ? git("merge-base", tag, base) : null;
    const plan = planRelease({
      tag,
      tagCreatedAt: tag ? Number(git("for-each-ref", "--format=%(creatordate:unix)", `refs/tags/${tag}`)) : null,
      newCommits: Number(git("rev-list", "--count", from ? `${from}..${base}` : base)),
      packageVersion: packageVersion(),
      bump: readBump(process.env.BUMP),
      force: process.env.FORCE === "1" || process.env.FORCE === "true",
      now: Math.floor(Date.now() / 1000),
      minIntervalHours: process.env.MIN_INTERVAL_HOURS ? Number(process.env.MIN_INTERVAL_HOURS) : undefined,
    });
    console.log(plan.release ? `Release ${plan.tag}: ${plan.reason}` : `No release: ${plan.reason}`);
    const output = process.env.GITHUB_OUTPUT;
    if (output) {
      const lines = [`release=${plan.release}`, `reason=${plan.reason}`];
      if (plan.release) lines.push(`version=${plan.version}`, `tag=${plan.tag}`);
      appendFileSync(output, `${lines.join("\n")}\n`);
    }
  } else {
    console.error("Usage: bun scripts/scheduled-release.ts plan|current|stamp <version>");
    process.exit(1);
  }
}

/**
 * The dependency check (#640), always on: every registry dependency a run adds to a manifest,
 * and every npm package its new JS/TS lines import without declaring it, is looked up before the
 * run's checks install or run anything. A package that does not exist, looks like a typosquat
 * of a popular one or was published days ago blocks the run with a finding; every other new
 * dependency is listed in the run report, which is the delivery's pull request body. A lookup
 * that fails (offline, registry down) is inconclusive and never blocks.
 */

import {
  type Dependency,
  type Ecosystem,
  importedPackages,
  isManifestPath,
  manifestDependencies,
} from "./manifests.js";
import { type PackageFacts, packageFacts, type RegistryFetch, typosquatOf } from "./registry.js";
import type { ChangedFile } from "./rules.js";
import { addedLines } from "./rules.js";

/** Artifact of the latest dependency check of a run. */
export const QUALITY_DEPENDENCIES = "quality/dependencies.json";
/** Whether a finding's claim is one the dependency check made. */
export const dependencyClaim = (claim: unknown): boolean =>
  typeof claim === "string" && /^Dependency \S+: /.test(claim);

/** A package younger than this many days is suspicious (slopsquatting registers names fast). */
const MIN_AGE_DAYS = 14;
/** A typosquat-like name with fewer weekly downloads than this blocks. */
const TYPOSQUAT_DOWNLOADS = 10_000;
/** Fewer weekly downloads than this is noted as rarely used. */
const RARE_DOWNLOADS = 100;

export interface DependencyVerdict extends Dependency {
  kind: "declared" | "imported";
  verdict: "ok" | "missing" | "typosquat" | "new-package" | "rare" | "undeclared" | "unknown";
  blocking: boolean;
  detail: string;
  facts: PackageFacts;
}

export interface DependencyResult {
  schemaVersion: 1;
  /** Whether the host looked the packages up; false when lookups are turned off. */
  lookups: boolean;
  dependencies: DependencyVerdict[];
}

const key = (d: { ecosystem: Ecosystem; name: string }) => `${d.ecosystem}:${d.name.toLowerCase()}`;

/** The dependencies the run added: declared in changed manifests, or imported on added lines. */
export function addedDependencies(files: ChangedFile[]): {
  declared: Dependency[];
  imported: Dependency[];
} {
  const declaredBefore = new Set<string>();
  const declaredAfter = new Map<string, Dependency>();
  for (const file of files) {
    if (!isManifestPath(file.path)) continue;
    // A manifest whose baseline is unknown declares nothing new: no verdict on old entries.
    if (file.before === undefined) continue;
    for (const d of file.before === null ? [] : manifestDependencies(file.path, file.before))
      declaredBefore.add(key(d));
    for (const d of manifestDependencies(file.path, file.content)) declaredAfter.set(key(d), d);
  }
  const declared = [...declaredAfter.values()].filter((d) => !declaredBefore.has(key(d)));
  return {
    declared,
    imported: files.flatMap((file) =>
      importedPackages(file.path, file.content, addedLines(file.before, file.content)),
    ),
  };
}

function judge(
  dependency: Dependency,
  kind: DependencyVerdict["kind"],
  facts: PackageFacts,
  now: number,
): DependencyVerdict {
  const verdict = (
    v: DependencyVerdict["verdict"],
    blocking: boolean,
    detail: string,
  ): DependencyVerdict => ({
    ...dependency,
    kind,
    verdict: v,
    blocking,
    detail,
    facts,
  });
  const where = `${dependency.ecosystem} package ${dependency.name}`;
  if (facts.status === "missing")
    return verdict(
      "missing",
      true,
      `${where} does not exist in the registry; the name may be made up`,
    );
  if (facts.status === "unknown")
    return verdict(
      "unknown",
      false,
      `${where} could not be checked: ${facts.reason ?? "lookup failed"}`,
    );
  const ageDays = facts.created ? (now - Date.parse(facts.created)) / 86_400_000 : null;
  const popular = typosquatOf(dependency.ecosystem, dependency.name);
  if (
    popular &&
    (facts.downloads !== undefined
      ? facts.downloads < TYPOSQUAT_DOWNLOADS
      : ageDays !== null && ageDays < 365)
  )
    return verdict("typosquat", true, `${where} looks like a typosquat of ${popular}`);
  if (ageDays !== null && ageDays < MIN_AGE_DAYS)
    return verdict(
      "new-package",
      true,
      `${where} was first published ${Math.max(0, Math.floor(ageDays))} days ago`,
    );
  if (kind === "imported")
    return verdict("undeclared", false, `${where} is imported but not declared in package.json`);
  if (facts.downloads !== undefined && facts.downloads < RARE_DOWNLOADS)
    return verdict("rare", false, `${where} has ${facts.downloads} downloads a week`);
  return verdict("ok", false, `new ${where}`);
}

/**
 * Checks what the run added. `declaredNow` are the npm packages the changed and unchanged
 * package.json files declare after the run, so an import of a declared package is not undeclared.
 */
export async function checkDependencies(
  files: ChangedFile[],
  declaredNow: Set<string>,
  options: { lookups: boolean; fetcher?: RegistryFetch; now?: number; aliases?: string[] },
): Promise<DependencyResult> {
  const { declared, imported } = addedDependencies(files);
  const seen = new Set(declared.map(key));
  const aliased = (name: string) =>
    (options.aliases ?? []).some((alias) => name === alias || name.startsWith(`${alias}/`));
  const undeclared = imported.filter((d) => {
    if (declaredNow.has(d.name) || seen.has(key(d)) || aliased(d.name)) return false;
    seen.add(key(d));
    return true;
  });
  const fetcher = options.fetcher ?? (fetch as unknown as RegistryFetch);
  const now = options.now ?? Date.now();
  const lookup = (d: Dependency): Promise<PackageFacts> =>
    options.lookups
      ? packageFacts(fetcher, d.ecosystem, d.name)
      : Promise.resolve({
          status: "unknown",
          reason: "registry lookups are off (quality.registryLookups)",
        });
  const dependencies = await Promise.all([
    ...declared.map(async (d) => judge(d, "declared", await lookup(d), now)),
    ...undeclared.map(async (d) => judge(d, "imported", await lookup(d), now)),
  ]);
  return { schemaVersion: 1, lookups: options.lookups, dependencies };
}

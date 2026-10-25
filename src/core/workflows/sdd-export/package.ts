import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findSecrets } from "../../artifacts/scan.js";
import { canonical, hashBytes } from "../../specs/hash.js";
import { specPublication } from "../../specs/render.js";
import { WorkflowFault } from "../errors.js";
import { type InitiativeFeature, InitiativeId, type InitiativePlan } from "../initiatives/plan.js";
import { InitiativeStore } from "../initiatives/store.js";
import { SafeId, type Spec, type TaskGraph } from "../schemas.js";
import type { WorkflowStore } from "../store.js";
import { zipFiles } from "./zip.js";

/**
 * Version of the package layout. A change to what the package holds or where (a new document of
 * `specPublication`, a new initiative plan field, a new graph edge) bumps it and updates the
 * export golden test and the importer (AGENTS.md "SDD export package").
 */
export const SDD_EXPORT_FORMAT_VERSION = 1;

export interface ExportedFeature {
  id: string;
  title: string;
  /** `not_started` when no run stands for the feature, else the status of its current run. */
  status: string;
  runId: string | null;
  /** Whether the run's spec, plan and tasks were approved; only accepted features have a folder. */
  accepted: boolean;
  dependsOn: string[];
  /** The feature's folder in the package, or null when it has no accepted documents. */
  dir: string | null;
}
export interface SddExportManifest {
  formatVersion: number;
  kind: "run" | "initiative";
  id: string;
  title: string;
  /** The Git commit the workspace was at when exported; null outside a repository. */
  gitHead: string | null;
  /** Initiative only: the accepted plan revision the package holds. */
  planRevision?: number;
  planDigest?: string;
  status: string;
  features: ExportedFeature[];
  /** sha256 of every other file of the package, by path. */
  files: Record<string, string>;
}
export interface SddPackage {
  manifest: SddExportManifest;
  /** Every file of the package, `manifest.json` included, by forward-slash path. */
  files: Record<string, string>;
}

interface FeatureDocuments {
  feature: ExportedFeature;
  spec: Spec | null;
  plan: string | null;
  graph: TaskGraph | null;
  /** Initiative only: the feature as the accepted plan states it. */
  planned?: InitiativeFeature;
}

/** Names Windows refuses for a file or folder, whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const folderName = (featureId: string): string =>
  RESERVED.test(featureId) ? `${featureId}_` : featureId;

/** A run's documents when its spec, plan and tasks are approved; null documents otherwise. */
function runDocuments(
  store: WorkflowStore,
  runId: string,
): Omit<FeatureDocuments, "feature"> & {
  status: string;
  accepted: boolean;
} {
  const run = store.run(runId);
  const state = store.state(runId);
  const accepted = state.approvalRoot !== null && !!state.spec && !!state.plan && !!state.graph;
  return {
    status: run.status,
    accepted,
    spec: accepted ? state.spec : null,
    plan: accepted ? state.plan : null,
    graph: accepted ? state.graph : null,
  };
}

function gitHead(workspace: string): string | null {
  if (!Bun.which("git")) return null;
  const rev = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  return rev.exitCode === 0 ? rev.stdout.toString().trim() : null;
}

/** Features in dependency order: each after those it depends on, plan order between equals. */
function dependencyOrder(features: FeatureDocuments[]): FeatureDocuments[] {
  const done = new Set<string>();
  const ordered: FeatureDocuments[] = [];
  const ids = new Set(features.map((f) => f.feature.id));
  while (ordered.length < features.length) {
    const next = features.find(
      (f) =>
        !done.has(f.feature.id) && f.feature.dependsOn.every((d) => done.has(d) || !ids.has(d)),
    );
    // The accepted plan is a DAG; a cycle here would be a corrupt store, so keep the rest as is.
    const pick = next ?? features.find((f) => !done.has(f.feature.id));
    if (!pick) break;
    done.add(pick.feature.id);
    ordered.push(pick);
  }
  return ordered;
}

/** Sorted keys like `canonical`, indented for a person reading the package. */
const pretty = (value: unknown): string =>
  `${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`;

const mermaidId = (value: string): string => value.replace(/[^A-Za-z0-9_]/g, "_");
const mermaidLabel = (value: string): string =>
  value.replace(/"/g, "#quot;").replace(/[\r\n]+/g, " ");

function graphJson(kind: "run" | "initiative", id: string, features: FeatureDocuments[]) {
  return {
    formatVersion: SDD_EXPORT_FORMAT_VERSION,
    kind,
    id,
    features: features.map(({ feature, graph }) => ({
      id: feature.id,
      title: feature.title,
      status: feature.status,
      accepted: feature.accepted,
      dependsOn: feature.dependsOn,
      dir: feature.dir,
      tasks:
        graph?.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          dependsOn: t.dependsOn,
          requirementIds: t.requirementIds,
          criterionIds: t.criterionIds,
          writes: t.writes.map((w) => w.path),
        })) ?? [],
    })),
  };
}

function graphMarkdown(features: FeatureDocuments[]): string {
  const lines = ["# Graph", "", "Features, their dependencies and their tasks.", "", "```mermaid"];
  lines.push("flowchart TD");
  for (const { feature, graph } of features) {
    const fid = `f_${mermaidId(feature.id)}`;
    const label = `${feature.id}: ${feature.title} (${feature.accepted ? "accepted" : feature.status})`;
    lines.push(`  subgraph ${fid}["${mermaidLabel(label)}"]`);
    if (!graph?.tasks.length) lines.push(`    ${fid}_none["no accepted tasks"]`);
    for (const task of graph?.tasks ?? [])
      lines.push(`    ${fid}_${mermaidId(task.id)}["${mermaidLabel(`${task.id} ${task.title}`)}"]`);
    lines.push("  end");
    for (const task of graph?.tasks ?? [])
      for (const dependency of task.dependsOn)
        lines.push(`  ${fid}_${mermaidId(dependency)} --> ${fid}_${mermaidId(task.id)}`);
  }
  for (const { feature } of features)
    for (const dependency of feature.dependsOn)
      lines.push(`  f_${mermaidId(dependency)} ==> f_${mermaidId(feature.id)}`);
  lines.push("```", "");
  lines.push("A thick arrow goes from a feature to a feature that builds on it; a thin arrow goes");
  lines.push("from a task to a task of the same feature that needs it first.", "");
  return lines.join("\n");
}

function agentsMarkdown(manifest: SddExportManifest, ordered: FeatureDocuments[]): string {
  const initiative = manifest.kind === "initiative";
  const lines = [
    `# ${manifest.title}`,
    "",
    `This folder is an exported spec-driven development (SDD) package of ${initiative ? "an initiative" : "a run"} (\`${manifest.id}\`), format version ${manifest.formatVersion}. It is plain Markdown and JSON: any coding agent or person can read it without the tool that wrote it.`,
    "",
    "## Reading order",
    "",
    ...(initiative
      ? [
          "1. `initiative.md`: the request, goals, completion criteria and the accepted split into features.",
          "2. `graph.md`: features, their dependencies and their tasks (`graph.json` holds the same data).",
          "3. For each feature, in the order of the table below: `specs/<feature>/spec.md`, `plan.md`, `tasks.md`.",
        ]
      : [
          "1. `graph.md`: the feature and its tasks (`graph.json` holds the same data).",
          "2. `specs/<feature>/spec.md`, `plan.md`, `tasks.md`.",
        ]),
    "",
    "`spec.json` and `tasks.json` are the canonical data the Markdown is rendered from; `manifest.json` lists every file with its sha256.",
    "",
    "## Features",
    "",
    "| Feature | Status | Depends on | Folder |",
    "| --- | --- | --- | --- |",
    ...ordered.map(
      ({ feature }) =>
        `| ${feature.id}: ${feature.title.replace(/\|/g, "\\|")} | ${feature.accepted ? `${feature.status}, spec accepted` : feature.status} | ${feature.dependsOn.join(", ") || "none"} | ${feature.dir ? `\`${feature.dir}/\`` : "none"} |`,
    ),
    "",
    "## Continuing the work",
    "",
    "- Each folder under `specs/` holds an accepted spec: implement against its requirements and acceptance criteria, and change the spec first when the scope changes.",
    "- Work the features in the order of the table: a feature builds on the contracts of the features it depends on.",
    ...(initiative
      ? [
          "- A feature without a folder had no accepted spec when this package was written; it still needs a spec.",
        ]
      : []),
    ...(manifest.gitHead ? [`- The package was written at commit \`${manifest.gitHead}\`.`] : []),
    "",
  ];
  return lines.join("\n");
}

function initiativeMarkdown(
  row: { id: string; title: string; prompt: string; status: string },
  plan: InitiativePlan,
  revision: { revision: number; digest: string; budget: unknown },
  costBudget: unknown,
  ordered: FeatureDocuments[],
): string {
  const lines = [
    `# ${row.title}`,
    "",
    `Initiative \`${row.id}\`; status: ${row.status}; accepted plan revision ${revision.revision} (digest \`${revision.digest}\`).`,
    "",
    "## Request",
    "",
    row.prompt,
    "",
    "## Goals",
    "",
    ...plan.goals.map((g) => `- ${g}`),
    "",
    "## Completion criteria",
    "",
    ...plan.completionCriteria.map((c) => `- ${c}`),
    "",
    "## Features",
    "",
  ];
  for (const { feature, planned } of ordered) {
    if (!planned) continue;
    lines.push(`### ${planned.id}: ${planned.title}`, "");
    lines.push(
      `- Status: ${feature.accepted ? `${feature.status}, spec accepted` : feature.status}`,
    );
    lines.push(`- Depends on: ${planned.dependsOn.join(", ") || "none"}`);
    lines.push(`- Mandatory: ${planned.mandatory ? "yes" : "no"}`);
    lines.push(`- Size: ${planned.size ?? "medium"}`);
    if (planned.workflow) lines.push(`- Workflow: ${planned.workflow}`);
    if (planned.testedBy) lines.push(`- Tested by: ${planned.testedBy}`);
    lines.push(`- Scope: ${planned.boundary.scope}`);
    if (planned.boundary.paths.length)
      lines.push(`- Paths: ${planned.boundary.paths.map((p) => `\`${p}\``).join(", ")}`);
    lines.push(`- Contract: ${planned.contract}`);
    if (planned.serial) lines.push(`- Kept whole because: ${planned.serial}`);
    if (planned.skeleton?.length)
      lines.push(`- Skeleton files: ${planned.skeleton.map((s) => `\`${s.path}\``).join(", ")}`);
    if (feature.dir) lines.push(`- Documents: \`${feature.dir}/\``);
    lines.push("");
  }
  if (plan.chain) lines.push("## Longest dependency chain", "", plan.chain, "");
  lines.push(
    "## Budget",
    "",
    "```json",
    canonical({ budget: revision.budget, costBudget }),
    "```",
    "",
  );
  return lines.join("\n");
}

function features(
  store: WorkflowStore,
  initiatives: InitiativeStore,
  id: string,
): {
  documents: FeatureDocuments[];
  plan: InitiativePlan;
  revision: number;
  digest: string;
  budget: unknown;
} {
  const row = initiatives.get(id);
  if (row.approved_plan_revision === null)
    throw new WorkflowFault(
      "ARTIFACT_MISSING",
      `Initiative ${id} has no accepted plan yet; approve its split first`,
    );
  const revision = initiatives.revision(id, row.approved_plan_revision);
  const plan = initiatives.plan(revision);
  const documents = plan.features.map((planned): FeatureDocuments => {
    const link = initiatives.current(id, planned.id);
    const docs = link ? runDocuments(store, link.run_id) : null;
    return {
      planned,
      spec: docs?.spec ?? null,
      plan: docs?.plan ?? null,
      graph: docs?.graph ?? null,
      feature: {
        id: planned.id,
        title: planned.title,
        status: docs?.status ?? "not_started",
        runId: link?.run_id ?? null,
        accepted: docs?.accepted ?? false,
        dependsOn: planned.dependsOn,
        dir: docs?.accepted ? `specs/${folderName(planned.id)}` : null,
      },
    };
  });
  return {
    documents,
    plan,
    revision: revision.revision,
    digest: revision.digest,
    budget: JSON.parse(revision.budget_json),
  };
}

/**
 * The portable SDD package of a run or an initiative (#2206): only accepted documents, read from
 * the store with no model call. Refuses (CAPABILITY_DENIED) when a file looks like it holds a
 * secret, naming the file and line but never the value, and (ARTIFACT_MISSING) when nothing is
 * accepted yet.
 */
export function buildSddPackage(store: WorkflowStore, id: string): SddPackage {
  const initiatives = new InitiativeStore(store);
  const isInitiative = InitiativeId.safeParse(id).success && initiatives.exists(id);
  if (!isInitiative && !SafeId.safeParse(id).success)
    throw new WorkflowFault("NOT_FOUND", `Unknown run or initiative ${id}`);
  const files: Record<string, string> = {};
  let ordered: FeatureDocuments[];
  let manifestBase: Omit<SddExportManifest, "features" | "files" | "gitHead">;
  if (isInitiative) {
    const row = initiatives.get(id);
    const found = features(store, initiatives, id);
    ordered = dependencyOrder(found.documents);
    manifestBase = {
      formatVersion: SDD_EXPORT_FORMAT_VERSION,
      kind: "initiative",
      id,
      title: row.title,
      planRevision: found.revision,
      planDigest: found.digest,
      status: row.status,
    };
    files["initiative.md"] = initiativeMarkdown(
      row,
      found.plan,
      found,
      initiatives.settings(row).costBudget,
      ordered,
    );
    files["initiative.json"] = pretty({
      formatVersion: SDD_EXPORT_FORMAT_VERSION,
      id,
      title: row.title,
      prompt: row.prompt,
      status: row.status,
      planRevision: found.revision,
      planDigest: found.digest,
      plan: found.plan,
      budget: found.budget,
      costBudget: initiatives.settings(row).costBudget,
    });
  } else {
    const docs = runDocuments(store, id);
    if (!docs.accepted || !docs.spec)
      throw new WorkflowFault(
        "ARTIFACT_MISSING",
        `Run ${id} has no accepted spec, plan and tasks yet; approve them first`,
      );
    ordered = [
      {
        ...docs,
        feature: {
          id: docs.spec.featureId,
          title: docs.spec.title,
          status: docs.status,
          runId: id,
          accepted: true,
          dependsOn: [],
          dir: `specs/${folderName(docs.spec.featureId)}`,
        },
      },
    ];
    manifestBase = {
      formatVersion: SDD_EXPORT_FORMAT_VERSION,
      kind: "run",
      id,
      title: docs.spec.title,
      status: docs.status,
    };
  }
  for (const { feature, spec, plan, graph } of ordered)
    if (feature.dir && spec && plan && graph)
      for (const [name, content] of Object.entries(specPublication(spec, plan, graph)))
        files[`${feature.dir}/${name}`] = content;
  files["graph.json"] = pretty(graphJson(manifestBase.kind, id, ordered));
  files["graph.md"] = graphMarkdown(ordered);
  const partial: SddExportManifest = {
    ...manifestBase,
    gitHead: gitHead(store.workspace),
    features: ordered.map((f) => f.feature),
    files: {},
  };
  files["AGENTS.md"] = agentsMarkdown(partial, ordered);
  const findings = Object.entries(files).flatMap(([path, content]) =>
    findSecrets(content).map((f) => `${path} line ${f.line}: ${f.kind}`),
  );
  if (findings.length)
    throw new WorkflowFault(
      "CAPABILITY_DENIED",
      `Export refused: a file looks like it holds a secret (${findings.join("; ")}). Remove it from the spec or plan first.`,
      { findings },
    );
  const sorted = Object.keys(files).sort();
  const manifest: SddExportManifest = {
    ...partial,
    files: Object.fromEntries(sorted.map((path) => [path, hashBytes(files[path] ?? "")])),
  };
  files["manifest.json"] = pretty(manifest);
  return { manifest, files };
}

/** The default place of an export: `.baked/exports/<id>-export` (`.zip` with `zip`). */
export const defaultExportPath = (workspace: string, id: string, zip: boolean): string =>
  join(workspace, ".baked", "exports", `${id}-export${zip ? ".zip" : ""}`);

/**
 * Writes the package to `out`: a new folder, or one zip archive with the same tree when `zip` is
 * set. Never overwrites: an existing `out` is refused (INPUT_CHANGED).
 */
export function writeSddPackage(
  pkg: SddPackage,
  out: string,
  zip: boolean,
): { path: string; zip: boolean; manifest: SddExportManifest; files: string[] } {
  if (existsSync(out))
    throw new WorkflowFault(
      "INPUT_CHANGED",
      `Export destination ${out} already exists; choose a new path`,
    );
  if (zip) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, zipFiles(pkg.files), { flag: "wx" });
  } else {
    for (const [path, content] of Object.entries(pkg.files)) {
      const target = join(out, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: "wx" });
    }
  }
  return { path: out, zip, manifest: pkg.manifest, files: Object.keys(pkg.files).sort() };
}

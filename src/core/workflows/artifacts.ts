import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { importEcc } from "../agents/profiles/importers/ecc.js";
import { canonical, hashBytes, hashJson } from "../specs/hash.js";
import { importSpecKit } from "../specs/importers/spec-kit.js";
import { validatePackage, workspacePath } from "../specs/validate.js";
import { adoptCurrentInstructions, frozenInstructions } from "./context.js";
import { fileHash } from "./effects.js";
import { WorkflowFault } from "./errors.js";
import { addHostRequiredCriteria, HOST_REQUIRED_CRITERIA } from "./host-required-criteria.js";
import { redactSecrets } from "./redaction.js";
import {
  type ArtifactService,
  PolicySchema,
  repairHostBoundCriteria,
  SafeId,
  type Spec,
  SpecSchema,
  TaskGraphSchema,
} from "./schemas.js";
import type { NativeWorkflowService } from "./service.js";
import { statedRequest } from "./stated-request.js";
import { runRoot } from "./worktree.js";

export class WorkflowArtifacts implements ArtifactService {
  constructor(
    private service: NativeWorkflowService,
    private approveOutside?: (path: string) => Promise<boolean>,
  ) {}
  async read(runId: string, artifactId: string) {
    const content = this.service.store.readArtifact(runId, artifactId);
    return { content: new TextEncoder().encode(content), hash: hashBytes(content) };
  }
  async stageRevision(runId: string, request: Parameters<ArtifactService["stageRevision"]>[1]) {
    const store = this.service.store;
    const candidatePath = `candidates/${SafeId.parse(request.commandId)}.json`;
    const requestHash = hashJson(request);
    const existing = store.latestArtifact(runId, candidatePath);
    if (existing) {
      if (JSON.parse(store.readArtifact(runId, existing.id)).requestHash !== requestHash)
        throw new WorkflowFault(
          "COMMAND_CONFLICT",
          "Candidate command ID reused with different input",
        );
      return { candidateHash: existing.content_hash, reportArtifactId: existing.id };
    }
    if (store.run(runId).input_hash !== request.expectedInputHash)
      throw new WorkflowFault("INPUT_CHANGED", "Candidate input hash is stale");
    const state = store.state(runId);
    const instructions = frozenInstructions(store.workspace, this.service.config.instructionFiles);
    // Definitions remain the version frozen in this run; an explicit revision
    // adopts current project instructions and execution configuration.
    // A definition revision replaces the definition and gate files itself (definitionCandidate).
    const replaced =
      request.definition !== undefined ? /\/(?:\.baked|baked)\/(workflows|gates)\//i : null;
    adoptCurrentInstructions(state, store, runId, instructions, replaced);
    for (const path of Object.keys(state.published)) {
      const current = fileHash(workspacePath(runRoot(store.workspace, state), path));
      if (current === null) delete state.published[path];
      else state.published[path] = current;
    }
    // A revised spec gets the repairs the specify stage makes, before its hash is computed: a
    // host-bound criterion becomes post-release and a criterion the host requires is added (#1964).
    const repairs = request.spec
      ? reviseSpecRepairs(store, runId, state, SpecSchema.parse(request.spec))
      : null;
    state.spec = repairs ? repairs.spec : state.spec;
    state.plan = request.plan ?? state.plan;
    state.graph = request.graph ? TaskGraphSchema.parse(request.graph) : state.graph;
    if (request.graph) state.hostEdits = [];
    let policy = PolicySchema.parse(request.policy ?? JSON.parse(store.run(runId).policy_json));
    const complete = Boolean(state.spec && state.plan && state.graph);
    // A definition revision may come before the run has a package; a package revision needs all of it.
    const packageEdited = Boolean(request.spec || request.plan || request.graph);
    if (!complete && (request.definition === undefined || packageEdited))
      throw new WorkflowFault(
        "INVALID_DEFINITION",
        "Candidate package requires spec, plan and graph",
      );
    if (state.spec && state.plan && state.graph) {
      state.graph = {
        ...state.graph,
        specHash: hashJson(state.spec),
        planHash: hashBytes(state.plan),
      };
      validatePackage(store.workspace, state.spec, state.plan, state.graph);
      state.manifest.specHash = hashJson(state.spec);
      state.manifest.planHash = hashBytes(state.plan);
      state.manifest.effectiveGraphHash = hashJson(state.graph);
    }
    let revised: { definition: unknown; gates: unknown } | null = null;
    if (request.definition !== undefined) {
      const bound = this.service.definitionCandidate(runId, state, policy, {
        definition: request.definition,
        ...(request.definitionPath ? { definitionPath: request.definitionPath } : {}),
        ...(request.autoApprovalConfirmation
          ? { autoApprovalConfirmation: request.autoApprovalConfirmation }
          : {}),
      });
      policy = bound.policy;
      revised = { definition: bound.definition, gates: bound.gates };
    }
    state.manifest.policyHash = hashJson(policy);
    const content = canonical({
      requestHash,
      expectedInputHash: request.expectedInputHash,
      state,
      policy,
      ...(repairs && (repairs.hostBound.length || repairs.hostRequired.length)
        ? { repairs: { hostBound: repairs.hostBound, hostRequired: repairs.hostRequired } }
        : {}),
      ...(revised ?? {}),
    });
    return store.transaction(() => {
      const artifact = store.artifact(runId, "revision-candidate", candidatePath, content);
      return { candidateHash: artifact.content_hash, reportArtifactId: artifact.id };
    });
  }
  async importCandidate(
    request: Parameters<ArtifactService["importCandidate"]>[0],
  ): ReturnType<ArtifactService["importCandidate"]> {
    if (!this.service.config.workflows?.importsEnabled)
      throw new WorkflowFault("CAPABILITY_DENIED", "Workflow importers are disabled");
    SafeId.parse(request.featureId);
    SafeId.parse(request.commandId);
    const commandPath = workspacePath(
      this.service.workspace,
      `.baked/workflow-imports/commands/${request.commandId}.json`,
    );
    const requestHash = hashJson(request);
    if (existsSync(commandPath)) {
      const old = JSON.parse(readFileSync(commandPath, "utf8"));
      if (old.requestHash !== requestHash)
        throw new WorkflowFault(
          "COMMAND_CONFLICT",
          "Import command ID reused with different input",
        );
      return old.result;
    }
    const report =
      request.source === "ecc" ? importEcc(request.sourcePath) : importSpecKit(request.sourcePath);
    const content = canonical({
      featureId: request.featureId,
      importer: request.source,
      ...report,
    });
    const candidateHash = hashBytes(content);
    const directory = workspacePath(
      this.service.workspace,
      `.baked/workflow-imports/${candidateHash}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "candidate.json"), content, { mode: 0o600 });
    writeFileSync(
      join(directory, "imports.lock"),
      canonical({
        source: report.source,
        revision: report.revision,
        adapterVersion: report.adapterVersion,
        hashes: report.hashes,
        license: report.license,
        unsupported: report.unsupported,
      }),
      { mode: 0o600 },
    );
    const result = { candidateHash, warnings: report.warnings, unsupported: report.unsupported };
    mkdirSync(resolve(commandPath, ".."), { recursive: true });
    try {
      writeFileSync(commandPath, canonical({ requestHash, result }), {
        flag: "wx",
        flush: true,
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return this.importCandidate(request);
    }
    return result;
  }
  async exportRun(runId: string, destination: string) {
    const store = this.service.store;
    const snapshot = store.snapshot(runId);
    const root = resolve(destination);
    const rel = relative(store.workspace, root);
    if (isAbsolute(rel) || rel.startsWith("..")) {
      if (!(await this.approveOutside?.(root)))
        throw new WorkflowFault("CAPABILITY_DENIED", "Export outside workspace needs approval");
    } else if (rel) workspacePath(store.workspace, rel.replaceAll("\\", "/"));
    if (existsSync(root))
      throw new WorkflowFault(
        "INPUT_CHANGED",
        "Export destination already exists; choose an empty new directory",
      );
    const artifacts = store
      .artifacts(runId)
      .filter((a) =>
        ["spec", "plan", "tasks", "review", "correction", "manual", "learning-candidate"].includes(
          a.kind,
        ),
      );
    const data = {
      schemaVersion: 1,
      snapshot,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        hash: a.content_hash,
        ...(() => {
          if (store.latestArtifact(runId, `redactions/${a.id}.json`))
            return { redacted: true, content: null };
          const content = redactSecrets(store.readArtifact(runId, a.id));
          return { content, exportedHash: hashBytes(content) };
        })(),
      })),
      requests: store.requests(runId),
      checks: store.checks(runId),
      findings: store.findings(runId),
    };
    const content = redactSecrets(canonical(data));
    // Raw provider messages, full environment and raw command output are not exported.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "manifest.json"), content, { flag: "wx", mode: 0o600 });
    return { manifestHash: hashBytes(content), path: root };
  }
  async exportProgress(runId: string) {
    const store = this.service.store;
    const state = store.snapshot(runId);
    const path = workspacePath(
      store.workspace,
      `.baked/workflow-runs/${runId}/exports/progress-${state.eventSeq}.md`,
    );
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(
      path,
      [
        `# ${state.featureId}`,
        `Status: ${state.status}; verification: ${state.verificationState}`,
        "",
        ...store.tasks(runId).map((t) => `- ${t.id}: ${t.status}`),
        "",
        ...store.findings(runId).map((f) => `- Finding ${f.id}: ${f.status}`),
      ].join("\n"),
    );
    return { path };
  }
  async gc(request: Parameters<ArtifactService["gc"]>[0]) {
    return this.service.store.collectGarbage(request.before, request.dryRun);
  }
  async redact(runId: string, artifactId: string, reason: string): Promise<void> {
    this.service.store.redact(runId, artifactId, reason);
  }
}

/**
 * The repairs of the specify stage on a revised spec (#1964): host-bound criteria become
 * post-release with a fallback this host can check, and the criteria the host requires for the
 * request with its answers are added. A revision that brings in a CI-results criterion would
 * otherwise be enforced as automated, since a revision restarts at analysis.
 */
function reviseSpecRepairs(
  store: NativeWorkflowService["store"],
  runId: string,
  state: ReturnType<NativeWorkflowService["store"]["state"]>,
  spec: Spec,
): { spec: Spec; hostBound: string[]; hostRequired: string[] } {
  const bound = repairHostBoundCriteria(spec);
  const request = statedRequest(state, store.requests(runId));
  const root = runRoot(store.workspace, state);
  const required = addHostRequiredCriteria(
    bound.spec,
    HOST_REQUIRED_CRITERIA.filter((c) => c.required(request, root)),
  );
  return { spec: required.spec, hostBound: bound.repaired, hostRequired: required.added };
}

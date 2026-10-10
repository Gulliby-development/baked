import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { configDir } from "../platform/index.js";
import { type SessionListEntry, SessionManager } from "../sessions/manager.js";
import type { RunSnapshot } from "../workflows/schemas.js";
import { WorkflowStore } from "../workflows/store.js";
import { projectInstructionFiles } from "./defaults.js";
import { defaultProjectId, type ProjectManifest, readManifest, writeManifest } from "./manifest.js";
import { displayPath, realPath } from "./paths.js";
import { registerProject } from "./registry.js";
import { clearProjectCache, projectAt, type ResolvedProject, resolveProject } from "./resolve.js";
import { checkEntries, resolveWorkingSet } from "./working-set.js";

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  registered: boolean;
  roots: string[];
  ignoredRoots: string[];
  workingSet: {
    entries: string[];
    files: { path: string; bytes: number }[];
    skipped: { path: string; reason: string }[];
  };
  instructions: { files: string[]; skipped: string[] };
  sessions: (SessionListEntry & { root: string })[];
  runs: (RunSnapshot & { root: string })[];
}

/**
 * Project operations for the CLI and the local API. A project lives in `baked/project.json` of
 * its primary root; its sessions and runs stay in each root's own stores and are found by ID.
 */
export class ProjectService {
  private readonly configDir: string;
  constructor(
    readonly cwd: string,
    opts: { configDir?: string } = {},
  ) {
    this.configDir = opts.configDir ?? configDir();
  }

  current(): ResolvedProject | null {
    return resolveProject(this.cwd, { configDir: this.configDir });
  }

  private require(): ResolvedProject {
    const project = this.current();
    if (!project)
      throw new Error(`No project here. Run "baked project init" to create baked/project.json.`);
    return project;
  }

  /** Writes a manifest for the current directory and registers it with its declared roots. */
  init(opts: { id?: string; name?: string; roots?: string[] } = {}): ResolvedProject {
    if (readManifest(this.cwd))
      throw new Error("This directory already has baked/project.json; edit it or use add/remove.");
    const manifest: ProjectManifest = {
      schemaVersion: 1,
      id: opts.id ?? defaultProjectId(realPath(this.cwd)),
      name: opts.name ?? (opts.id || defaultProjectId(realPath(this.cwd))),
      roots: opts.roots ?? [],
      workingSet: [],
      defaults: {},
    };
    writeManifest(this.cwd, manifest);
    return this.register();
  }

  /** Trusts the manifest's current secondary roots for this user. */
  register(): ResolvedProject {
    const manifest = readManifest(this.cwd);
    if (!manifest) throw new Error("register runs in the directory that holds baked/project.json.");
    const root = realPath(this.cwd);
    const roots = [
      ...new Set(
        manifest.roots
          .map((r) => realPath(resolve(root, r)))
          .filter((r) => r !== root && existsSync(r)),
      ),
    ];
    registerProject({ id: manifest.id, root, roots }, this.configDir);
    clearProjectCache();
    return projectAt(root, manifest, { configDir: this.configDir });
  }

  addToWorkingSet(entries: string[]): ResolvedProject {
    const project = this.require();
    const problems = checkEntries(project, entries);
    if (problems.length) throw new Error(problems.join("; "));
    const workingSet = [...project.manifest.workingSet];
    for (const entry of entries) if (!workingSet.includes(entry)) workingSet.push(entry);
    return this.save(project, { ...project.manifest, workingSet });
  }

  removeFromWorkingSet(entries: string[]): ResolvedProject {
    const project = this.require();
    const drop = new Set(entries);
    const workingSet = project.manifest.workingSet.filter((entry) => !drop.has(entry));
    return this.save(project, { ...project.manifest, workingSet });
  }

  private save(project: ResolvedProject, manifest: ProjectManifest): ResolvedProject {
    writeManifest(project.root, manifest);
    clearProjectCache();
    return projectAt(project.root, manifest, { configDir: this.configDir });
  }

  /** The project with its working set, and its latest sessions and runs from every trusted root. */
  summary(limit = 20): ProjectSummary {
    const project = this.require();
    const set = resolveWorkingSet(project);
    const instructions = projectInstructionFiles(project);
    const sessions: ProjectSummary["sessions"] = [];
    const runs: ProjectSummary["runs"] = [];
    for (const root of project.roots) {
      for (const session of new SessionManager(root).listSessions())
        if (session.projectId === project.id) sessions.push({ ...session, root });
      if (!existsSync(join(root, ".baked", "workflows.sqlite"))) continue;
      let store: WorkflowStore | null = null;
      try {
        store = new WorkflowStore(root, true);
        for (const run of store.projectRuns(project.id, limit)) runs.push({ ...run, root });
      } catch {
        // A store this build cannot read is left out of the listing.
      } finally {
        store?.close();
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      id: project.id,
      name: project.name,
      root: project.root,
      registered: project.registered,
      roots: project.roots,
      ignoredRoots: project.ignoredRoots,
      workingSet: {
        entries: project.manifest.workingSet,
        files: set.files.map((f) => ({ path: displayPath(this.cwd, f.path), bytes: f.bytes })),
        skipped: set.skipped.map((s) => ({
          path: isAbsolute(s.path) ? displayPath(this.cwd, s.path) : s.path,
          reason: s.reason,
        })),
      },
      instructions: {
        files: instructions.files.map((f) => displayPath(this.cwd, f.path)),
        skipped: instructions.skipped,
      },
      sessions: sessions.slice(0, limit),
      runs: runs.slice(0, limit),
    };
  }
}

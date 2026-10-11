import { homedir } from "node:os";
import { confirm, openSelect, promptText } from "../../components/ui/dialogs/index.js";
import { reasonText, statusGlyph } from "../../components/workflow/format.js";
import { drivingWorkflowRuns } from "../../hooks/useWorkflow.js";
import { useDialogStore } from "../../stores/dialog.js";
import { getAppSessionId } from "../../stores/session.js";
import { useUIStore } from "../../stores/ui.js";
import { useWorkflowStore } from "../../stores/workflow.js";
import {
  addKnownProject,
  forgetKnownProject,
  type KnownProject,
  listKnownProjects,
  renameKnownProject,
  setProjectPinned,
} from "../projects/known.js";
import { projectOverview } from "../projects/overview.js";
import { realPath } from "../projects/paths.js";
import {
  fitLabel,
  overviewBrief,
  projectDetails,
  resolveFolderInput,
  runsExecutingInProcess,
} from "../projects/switcher.js";
import { SessionManager } from "../sessions/manager.js";
import type { CommandContext, CommandHandler } from "./types.js";
import { sysMsg } from "./utils.js";

/** What the project picker needs from the app; the keybinding has no command context. */
export interface ProjectHost {
  cwd: string;
  notify: (text: string) => void;
  /** Saves the session and runs BAKED again in `folder`, resuming `sessionId` when given. */
  switchProject: (folder: string, sessionId?: string) => void;
}

const OPEN_FOLDER = "\u0000open-folder";
/** Characters a picker row leaves for the label beside its meta column (DialogSelect, 80 wide). */
const PICKER_LABEL_WIDTH = 32;

function shortPath(path: string): string {
  const home = process.env.HOME ?? homedir();
  return home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

function age(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Switches to another folder after the user confirms that runs executing here will pause. A run
 * stopped by the exit is left paused (scheduler: an aborted run becomes `paused`/`user_pause`) and
 * is resumed from /workflow when the user comes back; nothing resumes it on startup.
 */
export async function switchToProject(
  host: ProjectHost,
  folder: string,
  sessionId?: string,
): Promise<void> {
  const target = realPath(folder);
  if (target === realPath(host.cwd) && !sessionId) {
    host.notify(`Already in ${shortPath(target)}.`);
    return;
  }
  const running = [...new Set([...drivingWorkflowRuns(), ...runsExecutingInProcess(host.cwd)])];
  if (running.length) {
    const ok = await confirm({
      title: "Switch project?",
      message: `${running.length === 1 ? "A workflow run is" : `${running.length} workflow runs are`} executing in this project. Switching pauses ${running.length === 1 ? "it" : "them"}; resume from /workflow when you come back.`,
    });
    if (!ok) return;
  }
  host.switchProject(target, sessionId);
}

async function pickSession(host: ProjectHost, project: KnownProject): Promise<void> {
  let sessions: ReturnType<SessionManager["listSessions"]> = [];
  try {
    sessions = new SessionManager(project.path)
      .listSessions()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    // An unreadable session store lists nothing.
  }
  if (!sessions.length) {
    host.notify(`${project.name} has no saved sessions.`);
    return;
  }
  const picked = await openSelect<string>({
    title: `Sessions · ${project.name}`,
    titleIcon: "clock_alt",
    placeholder: `${sessions.length} sessions · fuzzy filter…`,
    options: sessions.map((s) => ({
      value: s.id,
      label: s.title || s.id.slice(0, 8),
      meta: `${s.messageCount} msgs · ${age(s.updatedAt)}`,
    })),
  });
  if (picked) await switchToProject(host, project.path, picked.value);
}

/** Per-project actions behind Tab in the picker. Returns true when the picker should close. */
async function projectActions(host: ProjectHost, project: KnownProject): Promise<boolean> {
  type Action = "open" | "session" | "pin" | "rename" | "forget";
  const current = project.path === realPath(host.cwd);
  const options: { value: Action; label: string; disabled?: boolean }[] = [
    {
      value: "open",
      label: current ? "Already open" : "Open",
      disabled: current || !project.exists,
    },
    { value: "session", label: "Resume a session…", disabled: !project.exists },
    { value: "pin", label: project.pinned ? "Unpin" : "Pin to the top" },
    { value: "rename", label: "Rename…" },
    { value: "forget", label: "Forget (keeps its sessions and runs)" },
  ];
  const picked = await openSelect<Action>({
    title: project.name,
    titleIcon: "folder",
    skipFilter: true,
    options,
  });
  if (!picked) return false;
  try {
    switch (picked.value) {
      case "open":
        await switchToProject(host, project.path);
        return true;
      case "session":
        await pickSession(host, project);
        return true;
      case "pin":
        setProjectPinned(project.path, !project.pinned);
        return false;
      case "rename": {
        const name = await promptText({
          title: "Rename project",
          message: "An empty name restores the folder or manifest name.",
          initial: project.name,
          validate: (v) => (v.trim().length > 120 ? "At most 120 characters." : null),
        });
        if (name !== null) renameKnownProject(project.path, name);
        return false;
      }
      case "forget": {
        const ok = await confirm({
          title: "Forget project?",
          message: `${project.name} leaves the list. Its sessions and runs stay in ${shortPath(project.path)}.`,
          danger: true,
        });
        if (ok) forgetKnownProject(project.path);
        return false;
      }
    }
  } catch (error) {
    host.notify(error instanceof Error ? error.message : String(error));
  }
  return false;
}

async function openFolder(host: ProjectHost): Promise<boolean> {
  let resolved = "";
  const input = await promptText({
    title: "Open folder",
    message: "Path to a folder; ~ and paths relative to this project work.",
    placeholder: "~/code/other-project",
    icon: "folder",
    validate: (value) => {
      const result = resolveFolderInput(value, host.cwd);
      if ("error" in result) return result.error;
      resolved = result.path;
      return null;
    },
  });
  if (input === null || !resolved) return false;
  try {
    addKnownProject(resolved);
  } catch (error) {
    host.notify(error instanceof Error ? error.message : String(error));
    return false;
  }
  await switchToProject(host, resolved);
  return true;
}

/** The project picker: every known folder with its sessions, active runs and waiting requests. */
export async function openProjectPicker(host: ProjectHost): Promise<void> {
  const here = realPath(host.cwd);
  for (;;) {
    let projects: KnownProject[] = [];
    try {
      projects = listKnownProjects();
    } catch (error) {
      host.notify(error instanceof Error ? error.message : String(error));
    }
    // Set by a picker action or choice; runs after the picker closed, then the picker reopens.
    const pending: { next: (() => Promise<boolean>) | null } = { next: null };
    const byPath = new Map(projects.map((p) => [p.path, p]));
    const picked = await openSelect<string>({
      title: "Projects",
      titleIcon: "folder",
      placeholder: `${projects.length} projects · fuzzy filter…`,
      current: here,
      options: [
        { value: OPEN_FOLDER, label: "Open folder…", pinned: true },
        ...projects.map((p) => {
          const overview = p.exists ? projectOverview(p.path) : null;
          return {
            value: p.path,
            label: fitLabel(p.name, shortPath(p.path), PICKER_LABEL_WIDTH),
            meta: overview ? overviewBrief(overview) : "missing",
            category: p.pinned ? "Pinned" : "Recent",
            status: !p.exists
              ? ("offline" as const)
              : overview?.attention
                ? ("warning" as const)
                : undefined,
          };
        }),
      ],
      actions: [
        {
          key: "tab",
          label: "actions",
          enabledFor: (option) => option.value !== OPEN_FOLDER,
          onTrigger: (option) => {
            const project = option ? byPath.get(String(option.value)) : undefined;
            if (!project) return;
            pending.next = () => projectActions(host, project);
            useDialogStore.getState().pop();
          },
        },
      ],
    });
    if (picked?.value === OPEN_FOLDER) pending.next = () => openFolder(host);
    else if (picked) {
      const project = byPath.get(picked.value);
      if (project && !project.exists) {
        host.notify(`${project.path} no longer exists. Forget it with Tab, or restore the folder.`);
        continue;
      }
      await switchToProject(host, picked.value);
      return;
    }
    if (!pending.next) return;
    if (await pending.next()) return;
  }
}

function describeWorkingSet(details: ReturnType<typeof projectDetails>): string {
  if (!details.workingSet) return "No baked/project.json: a plain folder without a working set.";
  const { entries, files, skipped } = details.workingSet;
  if (!entries.length) return `Project ${details.projectId}: no working set.`;
  return `Project ${details.projectId}: working set ${entries.join(", ")} (${files} file${files === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped` : ""}).`;
}

/** /project: the current folder, its sessions and runs, and what waits for a person. */
export async function showCurrentProject(ctx: CommandContext): Promise<void> {
  const details = projectDetails(ctx.cwd);
  const waitingRuns = new Set(details.attention.map((a) => a.run_id));
  const lines = [
    `${details.name} · ${shortPath(details.path)}`,
    describeWorkingSet(details),
    `${details.sessions.length} session${details.sessions.length === 1 ? "" : "s"} · ${details.runs.length} workflow run${details.runs.length === 1 ? "" : "s"} · ${details.attention.length} waiting for you`,
  ];
  for (const item of details.attention)
    lines.push(
      `  ⚑ ${item.feature_id}: ${item.request_id ? reasonText(item.kind) : `blocked (${reasonText(item.kind)})`}`,
    );
  sysMsg(ctx, lines.join("\n"));
  if (!details.sessions.length && !details.runs.length) return;

  const currentSession = getAppSessionId();
  type Pick = { kind: "session" | "run"; id: string };
  const picked = await openSelect<Pick>({
    title: `Project · ${details.name}`,
    titleIcon: "folder",
    placeholder: "Sessions and workflow runs · fuzzy filter…",
    equals: (a, b) => a.kind === b.kind && a.id === b.id,
    current: { kind: "session", id: currentSession },
    options: [
      ...details.runs
        .filter((r) => waitingRuns.has(r.runId))
        .map((r) => ({
          value: { kind: "run" as const, id: r.runId },
          label: r.featureId,
          meta: `${r.status} · ${reasonText(r.reason)}`,
          category: "Waiting for you",
          icon: statusGlyph(r.status, true),
          status: "warning" as const,
        })),
      ...details.sessions.map((s) => ({
        value: { kind: "session" as const, id: s.id },
        label: s.title || s.id.slice(0, 8),
        meta: `${s.messageCount} msgs · ${age(s.updatedAt)}`,
        category: "Sessions",
      })),
      ...details.runs
        .filter((r) => !waitingRuns.has(r.runId))
        .map((r) => ({
          value: { kind: "run" as const, id: r.runId },
          label: r.featureId,
          meta: r.status,
          category: "Workflow runs",
        })),
    ],
  });
  if (!picked) return;
  if (picked.value.kind === "run") {
    useWorkflowStore.getState().select(picked.value.id, ctx.tabMgr.activeTabId);
    useUIStore.getState().openModal("workflow");
    return;
  }
  if (picked.value.id === currentSession) {
    sysMsg(ctx, "That session is already open.");
    return;
  }
  await ctx.resumeSession(picked.value.id);
}

/**
 * /project rename NAME: sets the current folder's display name in the shared project list, which
 * the picker, `baked projects` and the desktop app all read. No name restores the default.
 */
export function renameCurrentProject(input: string, ctx: CommandContext): void {
  const name = input.replace(/^\s*\/project\s+rename\b/i, "").trim();
  try {
    const project = renameKnownProject(ctx.cwd, name);
    sysMsg(
      ctx,
      name ? `Renamed this project to ${project.name}.` : `Restored the name ${project.name}.`,
    );
  } catch (error) {
    sysMsg(ctx, error instanceof Error ? error.message : String(error));
  }
}

export function projectHost(ctx: CommandContext): ProjectHost {
  return {
    cwd: ctx.cwd,
    notify: (text) => sysMsg(ctx, text),
    switchProject: ctx.switchProject,
  };
}

export function register(map: Map<string, CommandHandler>): void {
  map.set("/projects", (_input, ctx) => openProjectPicker(projectHost(ctx)));
  map.set("/project", (_input, ctx) => showCurrentProject(ctx));
  map.set("/project rename", (input, ctx) => renameCurrentProject(input, ctx));
}

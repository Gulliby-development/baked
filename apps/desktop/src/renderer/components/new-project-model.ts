import { projectFolderName } from "../../../../../src/core/projects/new-project.js";
import type { DesktopProject, NewProjectDraft } from "../../shared/api.js";

/** The folder that holds `path`, for Windows and POSIX paths alike; null for a root. */
export function parentFolder(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return null;
  if (cut === 0) return trimmed.slice(0, 1);
  // "C:\\app" keeps the drive's separator: "C:\\".
  return /^[A-Za-z]:$/.test(trimmed.slice(0, cut))
    ? trimmed.slice(0, cut + 1)
    : trimmed.slice(0, cut);
}

/** Where a new project goes by default: next to the most recently opened project. */
export function defaultLocation(projects: readonly DesktopProject[]): string | null {
  const recent = [...projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  return recent ? parentFolder(recent.path) : null;
}

export interface NewProjectForm {
  name: string;
  parent: string | null;
  /** The subfolder name the user typed; null while it follows the project name. */
  folderEdit: string | null;
  useParent: boolean;
}

/** The subfolder shown in the form: the user's own, or one made from the project name. */
export function folderOf(form: NewProjectForm): string {
  return form.folderEdit ?? (form.name.trim() ? projectFolderName(form.name) : "");
}

/** The request the form sends, or null until a location is chosen. */
export function draftOf(form: NewProjectForm): NewProjectDraft | null {
  if (!form.parent) return null;
  return { name: form.name, parent: form.parent, folder: form.useParent ? null : folderOf(form) };
}

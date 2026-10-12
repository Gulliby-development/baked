/**
 * Name rules for a new project, kept free of Node APIs so the desktop renderer can check a form
 * as the user types; `create.ts` applies the same rules before it touches the disk.
 */

/** The longest display name the project list keeps (`known-projects.json`). */
export const PROJECT_NAME_MAX = 120;

const FOLDER_NAME_MAX = 64;
/** Characters Windows refuses in a file name; macOS and Linux refuse `/` too. */
const UNSAFE = /[<>:"/\\|?*]/;
const hasControl = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 32);
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Why a project name cannot be used, or null. */
export function projectNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a project name.";
  if (trimmed.length > PROJECT_NAME_MAX) return `At most ${PROJECT_NAME_MAX} characters.`;
  return null;
}

/** A folder name suggested for a project name: lower case, words joined by `-`. */
export function projectFolderName(name: string): string {
  const slug = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, FOLDER_NAME_MAX)
    .replace(/[-.]+$/, "");
  return slug && !RESERVED.test(slug) ? slug : "project";
}

/** Why a single folder name (not a path) cannot be created on every supported OS, or null. */
export function folderNameError(folder: string): string | null {
  if (!folder.trim()) return "Enter a folder name.";
  if (folder !== folder.trim()) return "A folder name cannot start or end with a space.";
  if (folder === "." || folder === "..") return "Choose a real folder name.";
  if (UNSAFE.test(folder) || hasControl(folder))
    return 'A folder name cannot contain < > : " / \\ | ? or *.';
  if (folder.endsWith(".")) return "A folder name cannot end with a dot.";
  if (RESERVED.test(folder)) return `${folder} is a reserved name on Windows.`;
  if (folder.length > 255) return "The folder name is too long.";
  return null;
}

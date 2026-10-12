import { isAbsolute, join } from "node:path";
import { folderNameError, projectNameError } from "../../../../src/core/projects/new-project.js";
import type { NewProjectCheck, NewProjectDraft } from "../shared/api.js";

/**
 * The folder a Create project form points at: the chosen folder itself, or a new subfolder of
 * it. Throws on input the renderer should not have sent, so a bad call never reaches the disk.
 */
export function newProjectFolder(draft: NewProjectDraft): string {
  if (typeof draft?.parent !== "string" || !isAbsolute(draft.parent))
    throw new Error("Choose a location with Browse….");
  if (typeof draft.name !== "string") throw new Error("A project name is text");
  if (draft.folder === null) return draft.parent;
  if (typeof draft.folder !== "string") throw new Error("A folder name is text");
  const problem = folderNameError(draft.folder);
  if (problem) throw new Error(problem);
  return join(draft.parent, draft.folder);
}

/**
 * Checks a Create project form: input problems are answered here, the rest (empty folder, write
 * access, refused folders) by `check`, which runs `baked projects create --check`.
 */
export async function checkDraft(
  draft: NewProjectDraft,
  check: (folder: string, name: string) => Promise<NewProjectCheck>,
): Promise<NewProjectCheck> {
  let path: string;
  try {
    path = newProjectFolder(draft);
  } catch (error) {
    return {
      path: "",
      creates: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const nameError = projectNameError(draft.name);
  if (nameError) return { path, creates: false, error: nameError };
  return check(path, draft.name);
}

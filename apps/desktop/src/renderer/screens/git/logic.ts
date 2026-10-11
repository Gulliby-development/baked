import type { GitAction, GitOverview } from "../../client/git.js";

/** The Git actions that ask first: push changes the remote, the others can lose work. */
export type Confirmable = "push" | "force-push" | "reset-hard";

export interface ConfirmText {
  title: string;
  confirmLabel: string;
  danger: boolean;
  body: (view: GitOverview) => string;
}

const branch = (view: GitOverview): string => view.branch ?? "HEAD";

/** The questions, worded like the terminal Git menu's confirmations. */
export const CONFIRMS: Record<Confirmable, ConfirmText> = {
  push: {
    title: "Push to the remote?",
    confirmLabel: "Push",
    danger: false,
    body: (view) =>
      view.upstream
        ? `Sends ${view.ahead} commit${view.ahead === 1 ? "" : "s"} of ${branch(view)} to ${view.upstream}.`
        : `${branch(view)} has no upstream branch; Git refuses the push unless push.autoSetupRemote is set.`,
  },
  "force-push": {
    title: "Force-push to the remote?",
    confirmLabel: "Force push",
    danger: true,
    body: (view) =>
      `git push --force-with-lease overwrites ${view.upstream ?? "the remote branch"}. Other contributors' commits may be discarded; the lease refuses only when the remote moved since your last fetch.`,
  },
  "reset-hard": {
    title: "Reset the working tree?",
    confirmLabel: "Reset hard",
    danger: true,
    body: (view) => {
      const count = new Set([...view.staged, ...view.modified]).size;
      return `git reset --hard HEAD discards the uncommitted changes of ${count} tracked file${count === 1 ? "" : "s"}. Untracked files are kept.`;
    },
  },
};

export interface ChangeGroup {
  label: string;
  tone?: "warn" | "err";
  files: string[];
}

/** The changed files by kind, conflicts first; empty groups are left out. */
export function changeGroups(view: GitOverview): ChangeGroup[] {
  const groups: ChangeGroup[] = [
    { label: "conflict", tone: "err", files: view.conflicts },
    { label: "staged", files: view.staged },
    { label: "modified", tone: "warn", files: view.modified },
    { label: "untracked", files: view.untracked },
  ];
  return groups.filter((group) => group.files.length > 0);
}

/** Whether an action can move HEAD to another branch, which the project list shows. */
export function isBranchChange(action: GitAction): boolean {
  return action.action === "create-branch" || action.action === "switch-branch";
}

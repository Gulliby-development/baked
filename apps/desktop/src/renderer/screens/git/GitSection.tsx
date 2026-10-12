import { type FormEvent, useState } from "react";
import { type GitAction, type GitOverview, git } from "../../client/git.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { useDesktop } from "../../store.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  ADD,
  errorText,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  ROW,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "../setup/shared.js";
import { CONFIRMS, type Confirmable, changeGroups, isBranchChange } from "./logic.js";

const COMMIT_MAX = 10_000;
const NAME_MAX = 200;

/**
 * The terminal Git menu for one project: status, commit, push and pull, branches, stashes and the
 * two destructive steps. Push, force push and hard reset ask first; the backend refuses the
 * destructive ones without that confirmation and while a workflow run holds the workspace.
 */
export function GitSection({ project }: SectionProps) {
  const key = project.key;
  const { refresh } = useDesktop();
  const [loaded, reload, setOverview] = useLoad(() => git.overview(key), [key, "git-overview"]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; output: string } | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [stageAll, setStageAll] = useState(false);
  const [branchName, setBranchName] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [asking, setAsking] = useState<Confirmable | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const act = async (action: GitAction): Promise<{ ok: boolean; message: string }> => {
    setBusy(true);
    setResult(null);
    try {
      const answer = await git.run(key, action);
      setOverview(answer.overview);
      setResult({ ok: answer.ok, message: answer.message, output: answer.output });
      // The project list shows the branch; read it again after a branch change.
      if (answer.ok && isBranchChange(action)) void refresh();
      return answer;
    } catch (e) {
      const failed = { ok: false, message: errorText(e) };
      setResult({ ...failed, output: "" });
      return failed;
    } finally {
      setBusy(false);
    }
  };

  const confirmAsked = async (): Promise<void> => {
    if (!asking) return;
    setConfirmError(null);
    const action: GitAction =
      asking === "push" ? { action: "push" } : { action: asking, confirm: true };
    const answer = await act(action);
    // A refusal stays in the dialog, as the other confirmations of the app do.
    if (answer.ok) setAsking(null);
    else setConfirmError(answer.message);
  };

  const commit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    if ((await act({ action: "commit", message: text, stageAll })).ok) {
      setMessage("");
      setStageAll(false);
    }
  };
  const createBranch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const name = branchName.trim();
    if (name && (await act({ action: "create-branch", name })).ok) setBranchName("");
  };
  const stash = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const text = stashMessage.trim();
    if ((await act(text ? { action: "stash", message: text } : { action: "stash" })).ok)
      setStashMessage("");
  };

  if (loaded.state !== "ready") return <LoadState value={loaded} what="Git" />;
  const view: GitOverview = loaded.data;
  if (!view.isRepo)
    return (
      <Empty>
        This folder is not a Git repository. Run <span className="font-mono">git init</span> in it,
        or <span className="font-mono">/git init</span> in the terminal app.
      </Empty>
    );
  const locked = busy || view.busy;
  const groups = changeGroups(view);
  const dialog = asking ? CONFIRMS[asking] : null;

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        The terminal&apos;s Git menu for this folder. Git runs in the project folder with your own
        Git configuration and credentials.
      </p>
      {view.busy && (
        <Alert>
          A workflow run holds the workspace. Git actions wait until it finishes or you pause it.
        </Alert>
      )}

      <div className={ROW}>
        <Badge tone="info" className="normal-case tracking-normal" title="Current branch">
          {view.branch ?? "detached HEAD"}
        </Badge>
        <span className={cn(NOTE, "font-mono text-dim-foreground")}>
          {view.upstream
            ? `${view.upstream} · ${view.ahead} ahead · ${view.behind} behind`
            : "no upstream branch"}
        </span>
        <span className={cn(ACTIONS, "ml-auto")}>
          <Button
            variant="secondary"
            size="md"
            disabled={locked}
            onClick={() => void act({ action: "pull" })}
          >
            Pull
          </Button>
          <Button variant="primary" size="md" disabled={locked} onClick={() => setAsking("push")}>
            Push
          </Button>
          <Button variant="secondary" size="md" disabled={busy} onClick={reload}>
            Refresh
          </Button>
        </span>
      </div>

      {result && (
        <Alert tone={result.ok ? "info" : "error"} role="status" className={WRAP}>
          {result.message}
          {result.ok && result.output && (
            <details className="mt-1">
              <summary className="cursor-pointer">Git output</summary>
              <pre className={cn("m-0 mt-1 font-mono text-[12px]", WRAP)}>{result.output}</pre>
            </details>
          )}
        </Alert>
      )}

      <section aria-label="Changes" className={STACK}>
        <h2 className={LABEL}>Changes</h2>
        {groups.length === 0 ? (
          <span className={cn(NOTE, "text-dim-foreground")}>Working tree clean.</span>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {groups.flatMap(({ label, tone, files }) =>
              files.map((file) => (
                <li key={`${label}:${file}`} className={LINE}>
                  <span className={cn(GROW, WRAP, "font-mono")}>{file}</span>
                  <Tag {...(tone ? { tone } : {})}>{label}</Tag>
                </li>
              )),
            )}
          </ul>
        )}
        <form className={STACK} onSubmit={(e) => void commit(e)}>
          <label htmlFor="git-message" className="sr-only">
            Commit message
          </label>
          <Textarea
            id="git-message"
            placeholder="Describe your changes"
            value={message}
            maxLength={COMMIT_MAX}
            onChange={(e) => setMessage(e.target.value)}
            disabled={locked}
          />
          <div className={ROW}>
            <label className={cn(NOTE, "flex items-center gap-2 text-soft-foreground")}>
              <input
                type="checkbox"
                checked={stageAll}
                onChange={(e) => setStageAll(e.target.checked)}
                disabled={locked}
              />
              Stage all changes
            </label>
            <span className={cn(NOTE, "text-dim-foreground")}>
              {view.staged.length === 0 || stageAll
                ? "Commits every modified and untracked file."
                : "Commits the staged files only."}
            </span>
            <Button
              type="submit"
              variant="primary"
              size="md"
              className="ml-auto"
              disabled={locked || !message.trim() || groups.length === 0}
            >
              Commit
            </Button>
          </div>
        </form>
      </section>

      <section aria-label="Branches" className={STACK}>
        <h2 className={LABEL}>Branches</h2>
        <form className={ADD} onSubmit={(e) => void createBranch(e)}>
          <label htmlFor="git-branch" className="sr-only">
            New branch
          </label>
          <input
            id="git-branch"
            type="text"
            placeholder="New branch from here, e.g. feature/pricing"
            value={branchName}
            maxLength={NAME_MAX}
            onChange={(e) => setBranchName(e.target.value)}
            disabled={locked}
          />
          <Button type="submit" variant="primary" size="md" disabled={locked || !branchName.trim()}>
            Create and switch
          </Button>
        </form>
        <ul className={cn(PANEL, LIST, "p-0")}>
          {view.branches.map((branch) => (
            <li key={branch} className={LINE}>
              <span className={cn(GROW, WRAP, "font-mono")}>{branch}</span>
              {branch === view.branch ? (
                <Tag>current</Tag>
              ) : (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={locked}
                  onClick={() => void act({ action: "switch-branch", name: branch })}
                >
                  Switch
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Stashes" className={STACK}>
        <h2 className={LABEL}>Stashes</h2>
        <form className={ADD} onSubmit={(e) => void stash(e)}>
          <label htmlFor="git-stash" className="sr-only">
            Stash message
          </label>
          <input
            id="git-stash"
            type="text"
            placeholder="Optional stash message"
            value={stashMessage}
            maxLength={NAME_MAX}
            onChange={(e) => setStashMessage(e.target.value)}
            disabled={locked}
          />
          <Button type="submit" variant="secondary" size="md" disabled={locked || !view.isDirty}>
            Stash changes
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={locked || view.stashes.length === 0}
            onClick={() => void act({ action: "stash-pop" })}
          >
            Pop latest
          </Button>
        </form>
        {view.stashes.length > 0 && (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {view.stashes.map((line) => (
              <li key={line} className={LINE}>
                <span className={cn(GROW, WRAP, "font-mono")}>{line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Recent commits" className={STACK}>
        <h2 className={LABEL}>Recent commits</h2>
        {view.log.length === 0 ? (
          <span className={cn(NOTE, "text-dim-foreground")}>No commits yet.</span>
        ) : (
          <ul className={cn(PANEL, LIST, "p-0")}>
            {view.log.map((entry) => (
              <li key={entry.hash} className={LINE}>
                <span className="font-mono text-dim-foreground">{entry.hash}</span>
                <span className={cn(GROW, WRAP)}>{entry.subject}</span>
                <span className={cn(NOTE, "text-dim-foreground")}>{entry.date}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Discard or overwrite" className={STACK}>
        <h2 className={LABEL}>Discard or overwrite</h2>
        <div className={ACTIONS}>
          <Button
            variant="secondary"
            size="md"
            disabled={locked || !view.upstream}
            onClick={() => setAsking("force-push")}
          >
            Force push (with lease)
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={locked || (view.staged.length === 0 && view.modified.length === 0)}
            onClick={() => setAsking("reset-hard")}
          >
            Reset hard
          </Button>
        </div>
      </section>

      {dialog && (
        <ConfirmDialog
          open
          title={dialog.title}
          confirmLabel={dialog.confirmLabel}
          danger={dialog.danger}
          busy={busy}
          error={confirmError}
          onConfirm={() => void confirmAsked()}
          onClose={() => {
            setAsking(null);
            setConfirmError(null);
          }}
        >
          {dialog.body(view)}
        </ConfirmDialog>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ApiError } from "../../client/api.js";
import { errorText, type PullRequestChecks, runs } from "../../client/runs.js";
import { start } from "../../client/start.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { LABEL, PANEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";

const STATE: Record<PullRequestChecks["state"], string> = {
  none: "No checks reported yet",
  pending: "Checks running",
  passed: "All checks passed",
  failed: "A check failed",
};

/**
 * The checks GitHub reports on a delivered run's pull request, read by the host without a model.
 * With a failed check it starts a fix-ci run, whose result is delivered as a follow-up commit to
 * the same pull request. On request it reads the unresolved review threads and starts a
 * quick-fix run for them, whose follow-up delivery answers those threads. Shows nothing for a run
 * that was never delivered.
 */
export function PullRequestPanel({ projectKey, runId }: { projectKey: string; runId: string }) {
  const [read, setRead] = useState<PullRequestChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const load = async (reviews = false) => {
    setBusy(true);
    try {
      setRead(await runs.checks(projectKey, runId, reviews));
      setError(null);
    } catch (e) {
      // A run without a pushed delivery has no pull request to follow.
      if (e instanceof ApiError && e.status === 404) setRead(null);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per run.
  useEffect(() => {
    void load();
  }, [projectKey, runId]);
  if (!read && !error) return null;
  const fix = read?.fix;
  const repair = read?.repair;
  const startRun = async (request: { featureId: string; prompt: string; workflowId: string }) => {
    setBusy(true);
    try {
      const run = await start.run(projectKey, {
        commandId: crypto.randomUUID(),
        feature: request.featureId,
        prompt: request.prompt,
        workflow: request.workflowId,
      });
      if (request === repair && repair.threads.length) {
        // The threads are answered by the follow-up delivery of the new run; keep the command.
        setStarted(
          `baked workflow deliver ${run.runId} --follow-up ${runId} --answer-threads ${repair.threads.join(",")}`,
        );
        return;
      }
      window.location.hash = projectHref(projectKey, "runs", run.runId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Pull request checks" className={PANEL}>
      <span className={LABEL}>Pull request</span>
      {read && (
        <>
          <p className="text-[13px]">
            {read.pullRequest ? (
              <a href={read.pullRequest.url} target="_blank" rel="noreferrer">
                #{read.pullRequest.number}
              </a>
            ) : (
              <span className="font-mono">{read.branch}</span>
            )}{" "}
            · {STATE[read.state]}
          </p>
          {read.checks.map((c) => (
            <div key={`${c.name}-${c.url ?? ""}`} className="flex gap-3 text-[13px]">
              <span className="font-mono">{c.state}</span>
              <span>{c.name}</span>
              {c.state === "failed" && c.detail && (
                <span className="text-dim-foreground">{c.detail.slice(0, 160)}</span>
              )}
            </div>
          ))}
          {fix && (
            <p className="text-[13px] text-muted-foreground">
              Fixing starts a fix-ci run for the failed checks. When it completes, deliver it as a
              follow-up: its commit goes onto this pull request's branch.
            </p>
          )}
          {read.reviews && (
            <>
              <p className="text-[13px]">
                {read.reviews.state === "clear"
                  ? "No unresolved review comments"
                  : `${read.reviews.threads.length} unresolved review thread(s), ${read.reviews.changesRequested.length} review(s) requesting changes`}
              </p>
              {read.reviews.threads.map((t) => (
                <div key={t.id} className="flex gap-3 text-[13px]">
                  <span className="font-mono">
                    {t.path}
                    {t.line ? `:${t.line}` : ""}
                  </span>
                  <span className="text-dim-foreground">
                    {t.comments[0]?.author}: {(t.comments[0]?.body ?? "").slice(0, 160)}
                  </span>
                </div>
              ))}
            </>
          )}
          {started && (
            <p className="text-[13px] text-muted-foreground">
              The repair run started. When it completes, deliver it as a follow-up that answers the
              threads: <span className="font-mono">{started}</span>
            </p>
          )}
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex gap-3">
        <Button variant="secondary" size="md" disabled={busy} onClick={() => void load()}>
          Check again
        </Button>
        {read?.state !== "failed" && (
          <Button variant="secondary" size="md" disabled={busy} onClick={() => void load(true)}>
            Read review comments
          </Button>
        )}
        {fix && (
          <Button variant="primary" size="md" disabled={busy} onClick={() => void startRun(fix)}>
            Fix failed checks
          </Button>
        )}
        {repair && !started && (
          <Button variant="primary" size="md" disabled={busy} onClick={() => void startRun(repair)}>
            Fix review comments
          </Button>
        )}
      </div>
    </section>
  );
}

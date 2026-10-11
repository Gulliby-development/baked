import { useEffect, useState } from "react";
import { errorText, runs } from "../../client/runs.js";

/** File name the report is saved under. */
export const reportFileName = (runId: string): string =>
  `baked-report-${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.md`;

/**
 * The run report (`baked workflow report`): one Markdown file with what the run did, its checks,
 * findings, decisions and token usage. Read again whenever the run records an event.
 */
export function ReportView({
  projectKey,
  runId,
  stamp,
}: {
  projectKey: string;
  runId: string;
  stamp: number;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: stamp re-reads the report on new events.
  useEffect(() => {
    let live = true;
    runs
      .report(projectKey, runId)
      .then((text) => {
        if (!live) return;
        setMarkdown(text);
        setError(null);
      })
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [projectKey, runId, stamp]);

  const copy = async () => {
    if (markdown === null) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const save = () => {
    if (markdown === null) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = reportFileName(runId);
    link.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <div className="banner error">{error}</div>;
  if (markdown === null) return <div className="muted">Loading report…</div>;
  return (
    <section className="report" aria-label="Run report">
      <div className="report-head">
        <p className="lede">
          One Markdown file for the whole run. Delivery uses it as the pull request description.
        </p>
        <button type="button" className="btn" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="btn" onClick={save}>
          Save as .md
        </button>
      </div>
      <pre className="card doc">{markdown}</pre>
    </section>
  );
}

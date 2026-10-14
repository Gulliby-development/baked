import { useEffect, useState } from "react";
import { errorText, runs } from "../../client/runs.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { LEDE, PANEL } from "../../lib/styles.js";
import { Markdown } from "../chat/Markdown.js";

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

  if (error) return <Alert tone="error">{error}</Alert>;
  if (markdown === null) return <Skeleton lines={6} label="Loading the report" />;
  return (
    <section aria-label="Run report">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className={cn(LEDE, "flex-1")}>
          One Markdown file for the whole run. Delivery uses it as the pull request description.
        </p>
        <Button variant="secondary" size="md" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button variant="secondary" size="md" onClick={save}>
          Save as .md
        </Button>
      </div>
      <div className={PANEL}>
        <Markdown text={markdown} />
      </div>
    </section>
  );
}

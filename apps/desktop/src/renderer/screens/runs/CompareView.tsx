import { useEffect, useState } from "react";
import { errorText, type RunComparison, runCompare } from "../../client/runs.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { tokens } from "../../format.js";
import { cn } from "../../lib/cn.js";
import { LEDE, TABLE } from "../../lib/styles.js";
import { compareRows } from "./compare-model.js";

const BETTER = "bg-fill-ok font-semibold";

/**
 * Two runs side by side (`baked workflow compare`): the routes that differ, then the outcome and
 * its cost, for an A/B of one feature run with two routing maps.
 */
export function CompareView({
  projectKey,
  a,
  b,
  onClose,
}: {
  projectKey: string;
  a: string;
  b: string;
  onClose: () => void;
}) {
  const [comparison, setComparison] = useState<RunComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    setComparison(null);
    setError(null);
    runCompare.compare(projectKey, a, b).then(
      (c) => live && setComparison(c),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [projectKey, a, b]);

  const copy = async () => {
    if (!comparison) return;
    await navigator.clipboard.writeText(comparison.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section aria-label="Run comparison" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">
          Compare <span className="font-mono">{a}</span> (A) and{" "}
          <span className="font-mono">{b}</span> (B)
        </h2>
        <Button variant="secondary" size="md" disabled={!comparison} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy as Markdown"}
        </Button>
        <Button variant="secondary" size="md" onClick={onClose}>
          Close
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {!error && !comparison && <Skeleton lines={6} label="Comparing the runs" />}
      {comparison && (
        <>
          {!comparison.sameFeature && (
            <Alert>
              A and B are different features ({comparison.a.featureId}, {comparison.b.featureId}).
            </Alert>
          )}
          {!comparison.sameWorkflow && (
            <Alert>
              A and B ran different workflows ({comparison.a.workflowId ?? "unknown"},{" "}
              {comparison.b.workflowId ?? "unknown"}).
            </Alert>
          )}
          <h3 className="m-0 text-[13px] font-semibold">Routing</h3>
          {comparison.routeDifferences.length === 0 ? (
            <p className={LEDE}>Both runs used the same models.</p>
          ) : (
            <table className={TABLE} aria-label="Routes that differ">
              <thead>
                <tr>
                  <th>Target</th>
                  <th>A</th>
                  <th>B</th>
                </tr>
              </thead>
              <tbody>
                {comparison.routeDifferences.map((d) => (
                  <tr key={d.target}>
                    <td className="font-mono">{d.target}</td>
                    <td className="font-mono">{d.a ?? "not routed"}</td>
                    <td className="font-mono">{d.b ?? "not routed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h3 className="m-0 text-[13px] font-semibold">Result</h3>
          <table className={TABLE} aria-label="Result">
            <thead>
              <tr>
                <th />
                <th>A</th>
                <th>B</th>
                <th className="text-right">B - A</th>
              </tr>
            </thead>
            <tbody>
              {compareRows(comparison).map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className={cn("font-mono", row.better === "a" && BETTER)}>{row.a}</td>
                  <td className={cn("font-mono", row.better === "b" && BETTER)}>{row.b}</td>
                  <td className="text-right font-mono">{row.delta}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 className="m-0 text-[13px] font-semibold">Tokens by stage</h3>
          <table className={TABLE} aria-label="Tokens by stage">
            <thead>
              <tr>
                <th>Stage</th>
                <th className="text-right">A</th>
                <th className="text-right">B</th>
              </tr>
            </thead>
            <tbody>
              {comparison.stages.map((s) => (
                <tr key={s.stage}>
                  <td className="font-mono">{s.stage}</td>
                  <td className="text-right font-mono">{s.a === null ? "–" : tokens(s.a)}</td>
                  <td className="text-right font-mono">{s.b === null ? "–" : tokens(s.b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

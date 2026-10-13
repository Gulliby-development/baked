/**
 * The JSON result protocol of custom gates: a script or container prints one JSON object as its
 * last JSON line, and that object decides the gate (docs/workflows/runtime.md, "Custom gates").
 * A passing report counts only with exit code 0.
 */
import { z } from "zod";

export const GateReportSchema = z.object({
  status: z.enum(["passed", "failed", "inconclusive"]),
  summary: z.string().max(2000).optional(),
  findings: z
    .array(
      z.object({
        severity: z.enum(["critical", "high", "medium", "low"]),
        message: z.string().min(1).max(4000),
        path: z.string().min(1).max(512).optional(),
        line: z.number().int().min(1).optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type GateReport = z.infer<typeof GateReportSchema>;

/** The last output line that is a valid report; log lines and other JSON before it are ignored. */
export function readGateReport(output: string): GateReport | null {
  const lines = output.replaceAll("\r\n", "\n").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const parsed = GateReportSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; keep looking.
    }
  }
  return null;
}

/** The report as text appended to the gate's output, one `path:line` per finding for the repair. */
export function renderGateReport(report: GateReport): string {
  const lines = [`Gate report: ${report.status}${report.summary ? `. ${report.summary}` : ""}`];
  for (const finding of report.findings ?? []) {
    const where = finding.path ? ` ${finding.path}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(`- [${finding.severity}]${where} ${finding.message}`);
  }
  return lines.join("\n");
}

export const MISSING_GATE_REPORT =
  'Gate report: missing. A gate with the JSON protocol must print one line such as {"status":"passed"} (status passed, failed or inconclusive; optional summary and findings) as its last JSON line.';

import { isTestFile } from "../intelligence/language-traits.js";
import { matchGlob } from "../platform/index.js";

export type DeliverableKind = "test" | "docs";
export const normalizePath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\.\//, "");

export function deliverableKind(path: string): DeliverableKind | null {
  const file = normalizePath(path);
  if (isTestFile(file)) return "test";
  if (/\.(md|mdx|markdown|rst|adoc)$/i.test(file) || /(^|\/)docs?\//i.test(file)) return "docs";
  return null;
}

/** A broad source boundary can hold tests too; a literal implementation file cannot. */
export function canHold(paths: readonly string[], kind: DeliverableKind): boolean {
  const samples =
    kind === "test"
      ? ["test_x.py", "x.test.ts", "x_test.go", "XTest.java", "XTests.cs", "tests/x.rs"]
      : ["README.md", "docs/x.md"];
  return paths.some((raw) => {
    const path = normalizePath(raw);
    if (deliverableKind(path) === kind) return true;
    if (!/[*?]/.test(path)) return false;
    const prefix = path.slice(0, path.search(/[*?]/));
    const directory = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    if (samples.some((sample) => matchGlob(`${directory}${sample}`, path))) return true;
    const names =
      kind === "test"
        ? ["tests", "test_x", "x_test", "XTest", "XTests", "x.test", "x.spec"]
        : ["docs", "README"];
    return names.some((name) => {
      const candidate = path.replace(/\*+/g, name).replaceAll("?", "x");
      return matchGlob(candidate, path) && deliverableKind(candidate) === kind;
    });
  });
}

/** Delivery requests, rather than any mention of a test used as evidence of a code defect. */
export function requestedDeliverable(finding: {
  kind: string;
  claim: string;
  suggestedFix: string;
}): DeliverableKind | null {
  const text = `${finding.claim}\n${finding.suggestedFix}`;
  const asks =
    finding.kind === "missing" ||
    /\b(add|supply|deliver|write|strengthen|extend|update)\b[^.\n]{0,100}\b(test|tests|coverage|documentation|docs)\b/i.test(
      finding.suggestedFix,
    ) ||
    /\b(test|tests|coverage|documentation|docs)\b[^.\n]{0,80}\b(missing|absent|not delivered|not been delivered)\b/i.test(
      finding.claim,
    );
  if (!asks) return null;
  if (/\b(tests?|tests-written|coverage)\b/i.test(text)) return "test";
  if (/\b(documentation|docs)\b/i.test(text)) return "docs";
  return null;
}

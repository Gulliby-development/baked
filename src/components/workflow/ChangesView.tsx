import { useEffect, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { RunFileDiff } from "../../core/workflows/run-diff.js";
import type { FileChange } from "../../core/workflows/view.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { Hint } from "../ui/index.js";

const MARK: Record<FileChange["action"], string> = { created: "+", modified: "~", deleted: "-" };

export function ChangesView({
  changes,
  active,
  loadDiff,
}: {
  changes: FileChange[];
  active: boolean;
  loadDiff: (path: string) => Promise<RunFileDiff>;
}) {
  const t = useTheme();
  const [cursor, setCursor] = useState(0);
  const [diff, setDiff] = useState<RunFileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Code first, then the published spec documents.
  const ordered = [...changes].sort(
    (a, b) =>
      Number(a.source !== "code") - Number(b.source !== "code") || a.path.localeCompare(b.path),
  );
  const selected = ordered[Math.min(cursor, Math.max(0, ordered.length - 1))];
  useEffect(() => {
    if (cursor >= ordered.length && ordered.length) setCursor(ordered.length - 1);
  }, [cursor, ordered.length]);

  const open = (path: string): void => {
    setLoading(true);
    setError(null);
    loadDiff(path)
      .then(setDiff)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };
  useKeyboard((evt) => {
    if (!active || !ordered.length) return;
    const key = evt.name.toLowerCase();
    if (key === "up" || key === "k") {
      evt.preventDefault();
      setCursor((c) => (c > 0 ? c - 1 : ordered.length - 1));
    } else if (key === "down" || key === "j") {
      evt.preventDefault();
      setCursor((c) => (c < ordered.length - 1 ? c + 1 : 0));
    } else if (key === "return" && selected) {
      evt.preventDefault();
      open(selected.path);
    }
  });

  if (!ordered.length)
    return <text fg={t.textMuted}>No files changed yet. Edits appear here after approval.</text>;
  const code = ordered.filter((c) => c.source === "code").length;
  const drifted = ordered.filter((c) => c.drifted).length;
  return (
    <box flexDirection="column">
      <text fg={t.textMuted}>
        {`${code} source file${code === 1 ? "" : "s"} · ${ordered.length - code} spec document${ordered.length - code === 1 ? "" : "s"}${drifted ? ` · ${drifted} changed outside the run` : ""}`}
      </text>
      <box height={1} />
      {ordered.map((change) => {
        const isSelected = change === selected;
        const unsettled = change.status !== "applied" && change.status !== "reconciled";
        const color = unsettled
          ? t.error
          : change.action === "created"
            ? t.success
            : change.action === "deleted"
              ? t.error
              : t.textPrimary;
        return (
          <text
            key={change.path}
            fg={color}
            bg={isSelected ? t.bgPopupHighlight : t.bgPopup}
            attributes={isSelected ? 1 : 0}
          >
            {`${isSelected ? "▸" : " "} ${MARK[change.action]} ${change.path}`}
            <span fg={t.textFaint}>
              {`  ${change.source === "spec" ? "spec · " : ""}${change.edits} edit${change.edits === 1 ? "" : "s"}${unsettled ? ` · ${change.status}` : ""}`}
            </span>
            {change.drifted ? <span fg={t.warning}>{"  · edited outside the run"}</span> : null}
          </text>
        );
      })}
      <box height={1} />
      {loading ? <text fg={t.textMuted}>Loading diff…</text> : null}
      {error ? <text fg={t.error}>{`✗ ${error}`}</text> : null}
      {diff && !loading ? (
        <box flexDirection="column">
          <text fg={t.textSecondary} attributes={1}>
            {diff.path}
          </text>
          {diff.preexistingChanges ? (
            <Hint kind="warn">
              This file had uncommitted changes before the run; the diff against HEAD includes them.
            </Hint>
          ) : null}
          {diff.text.split("\n").map((line, i) => (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional and immutable
              key={i}
              fg={
                diff.kind !== "git"
                  ? t.textMuted
                  : line.startsWith("+") && !line.startsWith("+++")
                    ? t.success
                    : line.startsWith("-") && !line.startsWith("---")
                      ? t.error
                      : line.startsWith("@@")
                        ? t.info
                        : t.textMuted
              }
            >
              {line || " "}
            </text>
          ))}
          {diff.truncated ? <Hint>Diff truncated at 2000 lines.</Hint> : null}
        </box>
      ) : !loading && !error ? (
        <Hint>↑/↓ select a file, Enter shows its diff.</Hint>
      ) : null}
    </box>
  );
}

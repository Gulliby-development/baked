import { readFile } from "node:fs/promises";
import { memo, useEffect, useMemo, useState } from "react";
import { computeDiff, type DiffLine, langFromPath } from "../../core/diff.js";
import { icon } from "../../core/icons.js";
import { useTheme } from "../../core/theme/index.js";
import { getSyntaxStyle, getTSClient } from "../../core/utils/syntax.js";

const LARGE_DIFF_THRESHOLD = 50;

type DiffMode = "default" | "sidebyside" | "compact";

interface Props {
  filePath: string;
  oldString: string;
  newString: string;
  success: boolean;
  errorMessage?: string;
  mode?: DiffMode;
}

function toUnifiedDiff(filePath: string, diffLines: DiffLine[]): string {
  let oldCount = 0;
  let newCount = 0;
  const body: string[] = [];
  for (const line of diffLines) {
    if (line.kind === "collapsed") continue;
    const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
    body.push(`${prefix}${line.content}`);
    if (line.kind !== "add") oldCount++;
    if (line.kind !== "remove") newCount++;
  }
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${String(oldCount)} +1,${String(newCount)} @@`,
    ...body,
  ].join("\n");
}

export const DiffView = memo(function DiffView({
  filePath,
  oldString,
  newString,
  success,
  errorMessage,
  mode = "default",
}: Props) {
  const t = useTheme();
  const [startLine, setStartLine] = useState(1);
  useEffect(() => {
    let cancelled = false;
    readFile(filePath, "utf-8")
      .then((content) => {
        if (cancelled) return;
        const idx = content.indexOf(newString);
        if (idx >= 0) {
          setStartLine(content.slice(0, idx).split("\n").length);
          return;
        }
        const idx2 = content.indexOf(oldString);
        if (idx2 >= 0) {
          setStartLine(content.slice(0, idx2).split("\n").length);
          return;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filePath, oldString, newString]);

  const computed = useMemo(() => {
    if (!success) return null;
    return computeDiff(oldString, newString, startLine);
  }, [oldString, newString, success, startLine]);

  const lang = useMemo(() => langFromPath(filePath), [filePath]);
  const isLarge = computed != null && computed.added + computed.removed > LARGE_DIFF_THRESHOLD;

  const verb = !success ? "Edit" : computed?.isCreation ? "New" : "Edit";
  const diffIcon = !success ? icon("fail") : icon("pencil");
  const iconColor = !success ? t.error : t.brand;

  const unifiedDiff = useMemo(() => {
    if (!success || !computed || isLarge) return null;
    return toUnifiedDiff(filePath, computed.lines);
  }, [success, computed, isLarge, filePath]);

  const viewMode = mode === "sidebyside" ? "split" : "unified";

  if (mode === "compact") {
    return (
      <box minHeight={1} flexShrink={0}>
        <text truncate>
          <span fg={iconColor}>{diffIcon} </span>
          <span fg={t.textPrimary}>{filePath}</span>
          {!success ? (
            <span fg={t.error}> {errorMessage ?? "failed"}</span>
          ) : computed ? (
            <>
              {computed.added > 0 ? <span fg={t.success}> +{String(computed.added)}</span> : null}
              {computed.removed > 0 ? <span fg={t.error}> -{String(computed.removed)}</span> : null}
            </>
          ) : null}
        </text>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexShrink={0} border borderStyle="rounded" borderColor={t.border}>
      <box
        height={1}
        flexShrink={0}
        paddingX={1}
        backgroundColor={t.bgElevated}
        alignSelf="flex-start"
        marginTop={-1}
      >
        <text truncate>
          <span fg={iconColor}>{diffIcon}</span> <span fg={t.brand}>{verb}</span>
          <span fg={t.border}> ─ </span>
          <span fg={t.textPrimary}>{filePath}</span>
          {success && computed ? (
            <>
              {computed.added > 0 ? <span fg={t.success}> +{String(computed.added)}</span> : null}
              {computed.removed > 0 ? <span fg={t.error}> -{String(computed.removed)}</span> : null}
            </>
          ) : null}
        </text>
      </box>
      {!success ? (
        <box paddingX={1}>
          <text fg={t.error}>{errorMessage ?? "old_string not found in file"}</text>
        </box>
      ) : isLarge ? (
        <box paddingX={1}>
          <text fg={t.textMuted}>{String(computed.added + computed.removed)} lines changed</text>
        </box>
      ) : unifiedDiff ? (
        <diff
          diff={unifiedDiff}
          view={viewMode}
          wrapMode="word"
          syncScroll={viewMode === "split"}
          filetype={lang}
          syntaxStyle={getSyntaxStyle()}
          treeSitterClient={getTSClient()}
          showLineNumbers
          addedBg={t.diffAddedBg}
          removedBg={t.diffRemovedBg}
          contextBg="transparent"
          addedContentBg={t.diffAddedBg}
          removedContentBg={t.diffRemovedBg}
          contextContentBg="transparent"
          addedLineNumberBg={t.diffAddedBg}
          removedLineNumberBg={t.diffRemovedBg}
          addedSignColor={t.diffAddedSign}
          removedSignColor={t.diffRemovedSign}
        />
      ) : null}
    </box>
  );
});

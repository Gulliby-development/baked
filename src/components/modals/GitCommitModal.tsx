import { useCallback, useEffect, useState } from "react";
import { commitChanges } from "../../core/git/menu.js";
import { getGitDiff, getGitStatus } from "../../core/git/status.js";
import { useTheme } from "../../core/theme/index.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { Hint, PremiumPopup, Section, Toggle, VSpacer } from "../ui/index.js";
import { fitPopupWidth } from "../ui/popup-geometry.js";

interface Props {
  visible: boolean;
  cwd: string;
  coAuthor: boolean;
  onClose: () => void;
  onCommitted: (msg: string) => void;
  onRefresh: () => void;
}

export function GitCommitModal({ visible, cwd, coAuthor, onClose, onCommitted, onRefresh }: Props) {
  const t = useTheme();
  const { width: tw } = useTerminalDimensions();
  const popupW = fitPopupWidth(Math.min(72, Math.max(56, Math.floor(tw * 0.6))), tw);

  const [message, setMessage] = useState("");
  const [staged, setStaged] = useState<string[]>([]);
  const [modified, setModified] = useState<string[]>([]);
  const [untracked, setUntracked] = useState<string[]>([]);
  const [diffSummary, setDiffSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stageAll, setStageAll] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setMessage("");
    setError(null);
    setStageAll(false);

    Promise.all([getGitStatus(cwd), getGitDiff(cwd, true)])
      .then(([status, diff]) => {
        setStaged(status.staged);
        setModified(status.modified);
        setUntracked(status.untracked);
        const lines = diff.split("\n").length;
        setDiffSummary(lines > 1 ? `${lines} lines changed` : "no staged changes");
      })
      .catch(() => {});
  }, [visible, cwd]);

  const handleCommit = useCallback(async () => {
    const result = await commitChanges(cwd, { message, stageAll, coAuthor });
    if (result.ok) {
      onCommitted(message.trim());
      onRefresh();
      onClose();
    } else {
      setError(result.message);
    }
  }, [message, stageAll, cwd, coAuthor, onCommitted, onRefresh, onClose]);

  useKeyboard((evt) => {
    if (!visible) return;
    if (evt.name === "escape") {
      onClose();
      evt.preventDefault();
      return;
    }
    if (evt.name === "tab") {
      setStageAll((p) => !p);
      evt.preventDefault();
      return;
    }
    evt.preventDefault();
  });

  if (!visible) return null;

  const totalChanges = staged.length + modified.length + untracked.length;
  const canStageAll = modified.length > 0 || untracked.length > 0;

  return (
    <PremiumPopup
      visible={visible}
      width={popupW}
      height={20}
      title="Git Commit"
      titleIcon="git"
      borderColor={t.warning}
      blurb={totalChanges === 0 ? "No changes to commit" : diffSummary}
      footerHints={[
        { key: "Enter", label: "commit" },
        { key: "Tab", label: "stage all" },
        { key: "Esc", label: "cancel" },
      ]}
      flash={error ? { kind: "err", message: error } : null}
    >
      <Section>
        <box flexDirection="row" backgroundColor={t.bgPopup}>
          {staged.length > 0 ? (
            <text bg={t.bgPopup} fg={t.success}>
              ● {staged.length} staged{"  "}
            </text>
          ) : null}
          {modified.length > 0 ? (
            <text bg={t.bgPopup} fg={t.warning}>
              ● {modified.length} modified{"  "}
            </text>
          ) : null}
          {untracked.length > 0 ? (
            <text bg={t.bgPopup} fg={t.error}>
              ● {untracked.length} untracked
            </text>
          ) : null}
        </box>
        {canStageAll ? (
          <>
            <VSpacer />
            <Toggle
              label="Stage all changes"
              on={stageAll}
              focused
              description="Press [Tab] to toggle"
            />
          </>
        ) : null}
        <VSpacer />
        <text bg={t.bgPopup} fg={t.textMuted}>
          Message:
        </text>
        <box paddingX={0} backgroundColor={t.bgPopup}>
          <box
            borderStyle="rounded"
            border={true}
            borderColor={t.brandDim}
            paddingX={1}
            width={popupW - 4}
            backgroundColor={t.bgPopup}
          >
            <input
              value={message}
              onInput={setMessage}
              onSubmit={handleCommit}
              placeholder="describe your changes..."
              focused={visible}
              backgroundColor={t.bgPopup}
            />
          </box>
        </box>
        {coAuthor ? (
          <>
            <VSpacer />
            <Hint>Co-authored trailer will be appended automatically.</Hint>
          </>
        ) : null}
      </Section>
    </PremiumPopup>
  );
}

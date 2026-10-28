import { useContext, useEffect, useState } from "react";
import { launchControl, stopEffect } from "../../core/chat/coordinator-control.js";
import type { LocalCoordinator } from "../../core/chat/coordinator-host.js";
import { launchLabel } from "../../core/chat/coordinator-launch.js";
import { requestSummary } from "../../core/chat/coordinator-summary.js";
import type { ChatPrompt, PromptAnswer } from "../../core/chat/sessions.js";
import { useTheme } from "../../core/theme/index.js";
import {
  type CoordinatorSnapshot,
  takeSummaryOnOpen,
  useCoordinatorSnapshot,
} from "../../hooks/useCoordinator.js";
import { useKeyboard, useTerminalDimensions } from "../../hooks/useTerminalEvents.js";
import { handleTextInputKey, PremiumPopup, Search } from "../ui/index.js";
import { PopupViewport } from "../ui/PopupViewport.js";
import {
  keyHints,
  launchedHeading,
  launchedLines,
  messageLines,
  openLaunched,
  promptLines,
  questionAnswer,
  SPLIT_EDIT_PREFIX,
  toneColor,
  type ViewLine,
  wrap,
} from "./model.js";
import { scheduleLines } from "./schedules.js";

/** At most this many lines of launched work show above the conversation. */
const LAUNCHED_ROWS = 4;
/** At most this many schedules show above the launched work. */
const SCHEDULE_ROWS = 3;

interface Props {
  visible: boolean;
  /** Opens the project's coordinator; called each time the view opens. */
  open: () => Promise<LocalCoordinator>;
  onClose: () => void;
}

/** Lines with keys that stay put while new lines are added below. */
function keyed(lines: ViewLine[], prefix: string): (ViewLine & { key: string })[] {
  const out: (ViewLine & { key: string })[] = [];
  for (const line of lines) out.push({ ...line, key: `${prefix}${out.length}` });
  return out;
}

/** The project coordinator over the current tab: its conversation, launched work and prompts. */
export function CoordinatorView({ visible, open, onClose }: Props) {
  const { width: tw, height: th } = useTerminalDimensions();
  const [local, setLocal] = useState<LocalCoordinator | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  // The launched item the stop and close keys act on, and the one a first ^X armed.
  const [selected, setSelected] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const view = useCoordinatorSnapshot(visible ? local : null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setError(null);
    open().then(
      (coordinator) => live && setLocal(coordinator),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [visible, open]);

  const prompt = view?.prompts[0];
  const working = view?.state === "working";
  const listed = openLaunched(view?.launched ?? []);
  const item = listed.length ? listed[Math.min(selected, listed.length - 1)] : undefined;
  const itemKey = item ? `${item.kind}:${item.id}:${item.feature ?? ""}` : null;

  /** Stops or closes the selected item; stopping a run or initiative takes a second ^X. */
  const control = (action: "stop" | "close"): void => {
    if (!local || !item || launchControl(item) !== action) return;
    const ref = {
      kind: item.kind,
      id: item.id,
      ...(item.feature ? { feature: item.feature } : {}),
    };
    if (action === "stop" && item.kind !== "session" && armed !== itemKey) {
      setArmed(itemKey);
      setNote(`${stopEffect(ref)}. Press ^X again to confirm.`);
      return;
    }
    setArmed(null);
    setNote(null);
    const done =
      action === "stop"
        ? local.chat.stopLaunched(local.session.id, ref)
        : local.chat.closeLaunched(local.session.id, ref).then(() => `Closed ${launchLabel(item)}`);
    done.then(
      (message) => {
        setError(null);
        setNote(message);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  };

  // `/coordinator summary` opens the view and asks once the coordinator is ready.
  useEffect(() => {
    if (!visible || !local || !takeSummaryOnOpen()) return;
    try {
      requestSummary(local.session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [visible, local]);

  const act = (fn: () => void): void => {
    try {
      fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const answer = (p: ChatPrompt, body: PromptAnswer): void =>
    act(() => local?.session.answer(p.id, body));

  useKeyboard((evt) => {
    if (!visible) return;
    evt.preventDefault();
    evt.stopPropagation();
    if (evt.name === "escape") {
      if (working && local) act(() => local.session.interrupt());
      else onClose();
      return;
    }
    if (!local) return;
    if (!prompt && evt.name === "tab" && listed.length) {
      setSelected(
        (i) =>
          (Math.min(i, listed.length - 1) + (evt.shift ? listed.length - 1 : 1)) % listed.length,
      );
      setArmed(null);
      setNote(null);
      return;
    }
    if (!prompt && evt.ctrl && (evt.name === "x" || evt.name === "r")) {
      control(evt.name === "x" ? "stop" : "close");
      return;
    }
    if (evt.ctrl && prompt && (evt.name === "y" || evt.name === "n")) {
      const yes = evt.name === "y";
      if (prompt.kind === "split" || prompt.kind === "workflow")
        answer(prompt, yes ? { approve: true, digest: prompt.digest } : { approve: false });
      else if (prompt.kind === "plan-review")
        answer(prompt, { action: yes ? "execute" : "cancel" });
      else if (prompt.kind !== "question") answer(prompt, { approve: yes });
      return;
    }
    if (evt.ctrl && evt.name === "s" && !prompt && !working) {
      act(() => requestSummary(local.session));
      return;
    }
    if (evt.ctrl && evt.name === "e" && prompt?.kind === "split") {
      answer(prompt, { approve: false });
      setInput((typed) =>
        typed.startsWith(SPLIT_EDIT_PREFIX) ? typed : SPLIT_EDIT_PREFIX + typed,
      );
      return;
    }
    if (evt.name === "return") {
      const typed = input.trim();
      if (prompt?.kind === "question") {
        if (!typed && !prompt.allowSkip) return;
        answer(prompt, { answer: questionAnswer(prompt, typed) });
        setInput("");
      } else if (!prompt && typed) {
        act(() => local.session.send(typed));
        setInput("");
      }
      return;
    }
    handleTextInputKey(evt, setInput);
  });

  if (!visible) return null;

  return (
    <PremiumPopup
      visible={visible}
      width={tw}
      height={th}
      title="Coordinator"
      titleIcon="dispatch"
      blurb={
        prompt
          ? "Waiting for your answer"
          : working
            ? "Working…"
            : "Launches runs and sessions for this project and keeps its brief"
      }
      footerHints={keyHints(prompt, working, item)}
      flash={
        error ? { kind: "err", message: error } : note ? { kind: "info", message: note } : null
      }
    >
      <CoordinatorBody
        view={view}
        prompt={prompt}
        input={input}
        loading={!local && !error}
        selected={prompt || !item ? undefined : Math.min(selected, listed.length - 1)}
      />
    </PremiumPopup>
  );
}

function CoordinatorBody({
  view,
  prompt,
  input,
  loading,
  selected,
}: {
  view: CoordinatorSnapshot | null;
  prompt: ChatPrompt | undefined;
  input: string;
  loading: boolean;
  /** The open launched item the stop and close keys act on. */
  selected: number | undefined;
}) {
  const t = useTheme();
  const viewport = useContext(PopupViewport) ?? { width: 80, height: 20 };
  const width = Math.max(10, viewport.width - 4);
  const launched = launchedLines(view?.launched ?? [], width, selected);
  const shownLaunched =
    launched.length > LAUNCHED_ROWS
      ? [
          ...launched.slice(0, LAUNCHED_ROWS - 1),
          { text: `… ${launched.length - LAUNCHED_ROWS + 1} more lines`, tone: "muted" as const },
        ]
      : launched;
  const schedules = scheduleLines(view?.schedules ?? [], width);
  const shownSchedules =
    schedules.length > SCHEDULE_ROWS
      ? [
          ...schedules.slice(0, SCHEDULE_ROWS - 1),
          { text: `… ${schedules.length - SCHEDULE_ROWS + 1} more`, tone: "muted" as const },
        ]
      : schedules;
  const card = prompt ? promptLines(prompt, width) : [];
  const conversation: ViewLine[] = loading
    ? [{ text: "Opening the coordinator…", tone: "muted" }]
    : view && (view.messages.length > 0 || view.live)
      ? messageLines(view.messages, view.live, width)
      : wrap("Ask about the project, or describe work to split into runs.", width).map((text) => ({
          text,
          tone: "muted" as const,
        }));
  // Search takes three rows; the launched block has a heading and a gap; the card has a gap.
  const room = Math.max(
    1,
    viewport.height -
      3 -
      (shownLaunched.length ? shownLaunched.length + 2 : 0) -
      (shownSchedules.length ? shownSchedules.length + 2 : 0) -
      (card.length ? card.length + 1 : 0),
  );
  const tail = conversation.slice(-room);

  return (
    <box flexDirection="column" paddingX={1} height={Math.max(4, viewport.height)}>
      {shownSchedules.length > 0 && (
        <box flexDirection="column" flexShrink={0}>
          <text fg={t.textMuted} attributes={1}>
            Schedules
          </text>
          {keyed(shownSchedules, "s").map((line) => (
            <text key={line.key} fg={toneColor(t, line.tone)} wrapMode="none" truncate>
              {line.text}
            </text>
          ))}
          <text> </text>
        </box>
      )}
      {shownLaunched.length > 0 && (
        <box flexDirection="column" flexShrink={0}>
          <text fg={t.textMuted} attributes={1}>
            {launchedHeading(view?.rulesOn ?? 0)}
          </text>
          {keyed(shownLaunched, "l").map((line) => (
            <text key={line.key} fg={toneColor(t, line.tone)} wrapMode="none" truncate>
              {line.text}
            </text>
          ))}
          <text> </text>
        </box>
      )}
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        justifyContent="flex-end"
      >
        {keyed(tail, "m").map((line) => (
          <text key={line.key} fg={toneColor(t, line.tone)} wrapMode="none" truncate>
            {line.text || " "}
          </text>
        ))}
      </box>
      {card.length > 0 && (
        <box flexDirection="column" flexShrink={0} paddingTop={1}>
          {keyed(card, "p").map((line) => (
            <text key={line.key} fg={toneColor(t, line.tone)} wrapMode="none" truncate>
              {line.text}
            </text>
          ))}
        </box>
      )}
      <Search
        value={input}
        focused={true}
        icon="pencil"
        placeholder={
          prompt?.kind === "question"
            ? "Type an option's number or an answer"
            : prompt
              ? "Answer the prompt above first"
              : "Message the coordinator"
        }
      />
    </box>
  );
}

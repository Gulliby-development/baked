import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type { PastRun } from "../../core/workflows/estimate.js";
import type { Stage, WorkflowV2 } from "../../core/workflows/v2/definition.js";
import { effectiveMode } from "../../core/workflows/v2/definition.js";
import {
  addGate,
  addTransition,
  bindingsAt,
  CONFIRM_PREFIX,
  changeStageField,
  confirmsAutoApproval,
  defaultTransitionDraft,
  duplicateAsCustom,
  type EditorSource,
  type EditorState,
  type EditResult,
  estimateDefinition,
  INSERTABLE_STAGES,
  insertStage,
  insertWaitStage,
  type LibraryGateView,
  markSaved,
  moveCursor,
  moveGate,
  openEditor,
  PANES,
  type Pane,
  pickerOptions,
  prepareSave,
  problemCount,
  removeGate,
  removeStage,
  removeTransition,
  type SaveReview,
  STATION_WORDS,
  selectedStage,
  selectedTarget,
  stageFields,
  switchPane,
  type TransitionDraft,
  targetName,
  targetsOf,
  toggleMode,
  transitionChoices,
  transitionOf,
  validateEditor,
  withHistory,
  withLibrary,
} from "../../core/workflows/v2/editor.js";
import {
  DRAFT_KIND_LABELS,
  DRAFT_KINDS,
  draftReport,
  type GateDraft,
  type GateDraftRequest,
} from "../../core/workflows/v2/gate-draft.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { Hint, PremiumPopup } from "../ui/index.js";

/** Everything the editor needs from the outside, so it renders the same in tests and in the app. */
export interface WorkflowEditorApi {
  open(id: string): EditorSource;
  /** Writes baked/workflows/ID.json and returns its path. */
  save(definition: WorkflowV2): string;
  /** Past runs of the project for the estimate; null when no estimate can be made. */
  history(): Promise<PastRun[] | null>;
  /** Drafts a gate from a sentence with the project's model; writes nothing. */
  draftGate?(request: GateDraftRequest): Promise<GateDraft>;
  /** Saves a confirmed draft to `baked/gates` and returns the gate library read again. */
  saveGate?(draft: GateDraft): LibraryGateView[];
}

export type EditorMode =
  | "browse"
  | "picker"
  | "describe"
  | "draft"
  | "transition"
  | "options"
  | "station"
  | "review"
  | "problems"
  | "discard"
  | "missing";

/** Footer keys for each state of the window, so the popup shows only keys that work right now. */
export const EDITOR_HINTS: Record<EditorMode, { key: string; label: string }[]> = {
  browse: [
    { key: "Tab", label: "pane" },
    { key: "↑↓", label: "select" },
    { key: "A", label: "add gate" },
    { key: "G", label: "new gate" },
    { key: "D", label: "remove" },
    { key: "M", label: "mode" },
    { key: "J/K", label: "move" },
    { key: "N", label: "transition" },
    { key: "I", label: "station" },
    { key: "W", label: "wait stage" },
    { key: "E", label: "options" },
    { key: "C", label: "duplicate" },
    { key: "Ctrl+S", label: "save" },
    { key: "Esc", label: "back" },
  ],
  picker: [
    { key: "type", label: "search" },
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "add" },
    { key: "Esc", label: "cancel" },
  ],
  describe: [
    { key: "Tab", label: "kind" },
    { key: "type", label: "describe" },
    { key: "Enter", label: "draft" },
    { key: "Esc", label: "cancel" },
  ],
  draft: [
    { key: "↑↓", label: "scroll" },
    { key: "Enter", label: "save and add" },
    { key: "Esc", label: "back" },
  ],
  transition: [
    { key: "↑↓", label: "field" },
    { key: "←→", label: "change" },
    { key: "Enter", label: "add" },
    { key: "Esc", label: "cancel" },
  ],
  station: [
    { key: "↑↓", label: "select" },
    { key: "Enter", label: "insert" },
    { key: "Esc", label: "cancel" },
  ],
  options: [
    { key: "↑↓", label: "option" },
    { key: "←→", label: "change" },
    { key: "Esc", label: "done" },
  ],
  review: [
    { key: "Enter", label: "write file" },
    { key: "Esc", label: "keep editing" },
  ],
  problems: [{ key: "Esc", label: "back" }],
  discard: [
    { key: "Y", label: "discard" },
    { key: "N/Esc", label: "keep editing" },
  ],
  missing: [{ key: "Esc", label: "back" }],
};

const GLYPH: Record<Stage["type"], string> = {
  agent: "◇",
  tasks: "✎",
  check: "✓",
  wait: "⧗",
  approval: "⚑",
  review: "◎",
  reflection: "↺",
  learn: "✦",
};
const PANE_TITLE: Record<Pane, string> = {
  stages: "Stages",
  transitions: "Transitions",
  gates: "Gates",
};
const TRANSITION_FIELDS = ["to", "on", "loop"] as const;

/**
 * The transition a new station goes on: the selected one in the transitions pane, else the one
 * `passed` transition out of the selected stage. Loops take no station.
 */
function stationArrow(state: EditorState): string | null {
  const target = selectedTarget(state);
  const d = state.definition;
  if (state.pane === "transitions" && target?.kind === "transition") {
    const t = d.transitions.find((x) => x.id === target.id);
    return t && !t.loop ? t.id : null;
  }
  const stage = selectedStage(state);
  const out = d.transitions.filter((t) => t.from === stage?.id && t.on === "passed" && !t.loop);
  return out.length === 1 ? (out[0]?.id ?? null) : null;
}

/** The rows of a list that fit, scrolled so the cursor stays visible. */
function visible<T>(
  items: readonly T[],
  cursor: number,
  rows: number,
): { start: number; items: T[]; rows: { index: number; item: T }[] } {
  const size = Math.max(1, rows);
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), items.length - size));
  const shown = items.slice(start, start + size);
  return { start, items: shown, rows: shown.map((item, n) => ({ index: start + n, item })) };
}
const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

export function WorkflowEditor({
  active,
  workspace,
  workflowId,
  api,
  width,
  height,
  onBack,
  onMode,
  notify,
}: {
  active: boolean;
  workspace: string;
  workflowId: string;
  api: WorkflowEditorApi;
  width: number;
  height: number;
  onBack: () => void;
  onMode?: (mode: EditorMode) => void;
  notify: (kind: "ok" | "err" | "info", message: string) => void;
}) {
  const t = useTheme();
  const [opened] = useState<{ state: EditorState | null; error: string | null }>(() => {
    try {
      return { state: openEditor(api.open(workflowId)), error: null };
    } catch (err) {
      return { state: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  const [state, setState] = useState<EditorState | null>(opened.state);
  const [mode, setMode] = useState<EditorMode>(opened.state ? "browse" : "missing");
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState(0);
  const [draft, setDraft] = useState<TransitionDraft | null>(null);
  const [field, setField] = useState(0);
  const [review, setReview] = useState<SaveReview | null>(null);
  const [typed, setTyped] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [kind, setKind] = useState(0);
  const [sentence, setSentence] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [gateDraft, setGateDraft] = useState<GateDraft | null>(null);
  const [scroll, setScroll] = useState(0);

  useEffect(() => onMode?.(mode), [mode, onMode]);
  useEffect(() => {
    let disposed = false;
    void api
      .history()
      .catch(() => null)
      .then((history) => {
        if (!disposed) setState((s) => (s ? withHistory(s, history) : s));
      });
    return () => {
      disposed = true;
    };
  }, [api]);

  const problems = useMemo(() => (state ? validateEditor(state) : []), [state]);
  const estimate = useMemo(
    () => (state ? estimateDefinition(state.definition, state.history) : null),
    [state],
  );
  const stage = state ? selectedStage(state) : undefined;
  const target = state ? selectedTarget(state) : undefined;
  const options = useMemo(
    () => (state && target ? pickerOptions(state, target, query) : []),
    [state, target, query],
  );
  const fields = state && stage ? stageFields(state, stage.id) : [];

  const apply = (result: EditResult): void => {
    if (result.error) notify(state?.readOnly ? "info" : "err", result.error);
    else setState(result.state);
  };
  const startSave = (): void => {
    if (!state) return;
    const next = prepareSave(state, workspace);
    if (next.kind === "read-only") notify("info", next.message);
    else if (next.kind === "unchanged")
      notify("info", "Nothing to save: the file already holds this definition.");
    else {
      setReview(next);
      setTyped("");
      setSaveError(null);
      setMode(next.kind === "problems" ? "problems" : "review");
    }
  };
  const write = (): void => {
    if (!state || review?.kind !== "review") return;
    if (review.autoApproval && !confirmsAutoApproval(typed, review.autoApproval.hash)) {
      setSaveError(
        `Type the first ${CONFIRM_PREFIX} characters of the limits hash to turn auto approval on.`,
      );
      return;
    }
    try {
      api.save(state.definition);
      setState(markSaved(state, review.text));
      setMode("browse");
      notify(
        "ok",
        `Saved baked/workflows/${state.id}.json. New runs use it; started runs keep their copy.`,
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  };

  const requestDraft = (): void => {
    const text = sentence.trim();
    if (!api.draftGate || drafting) return;
    if (!text) {
      notify("info", "Describe the check in a sentence first.");
      return;
    }
    setDrafting(true);
    api
      .draftGate({ text, kind: DRAFT_KINDS[kind] })
      .then((draft) => {
        setGateDraft(draft);
        setScroll(0);
        setMode("draft");
      })
      .catch((err: unknown) => notify("err", err instanceof Error ? err.message : String(err)))
      .finally(() => setDrafting(false));
  };
  const saveDraft = (): void => {
    if (!state || !target || !gateDraft || !api.saveGate) return;
    if (gateDraft.problems.length) {
      notify("err", gateDraft.problems[0] ?? "This draft cannot be saved.");
      return;
    }
    try {
      const next = withLibrary(state, api.saveGate(gateDraft));
      const result = addGate(next, target, gateDraft.gate.id);
      setState(result.error ? next : result.state);
      setGateDraft(null);
      setMode("browse");
      notify(
        result.error ? "err" : "ok",
        result.error
          ? `Saved ${gateDraft.path}, but it was not added: ${result.error}`
          : `Saved ${gateDraft.path} and added it to ${targetName(target)}. Ctrl+S saves the workflow.`,
      );
    } catch (err) {
      notify("err", err instanceof Error ? err.message : String(err));
    }
  };

  useKeyboard((evt) => {
    if (!active) return;
    const key = evt.name.toLowerCase();
    if (mode === "missing") {
      if (key === "escape") {
        evt.preventDefault();
        onBack();
      }
      return;
    }
    if (!state) return;
    if (mode === "discard") {
      evt.preventDefault();
      if (key === "y") onBack();
      else if (key === "n" || key === "escape") setMode("browse");
      return;
    }
    if (mode === "problems") {
      if (key === "escape" || key === "return") {
        evt.preventDefault();
        setMode("browse");
      }
      return;
    }
    if (mode === "review") {
      if (key === "escape") {
        evt.preventDefault();
        setMode("browse");
      } else if (key === "return") {
        evt.preventDefault();
        write();
      }
      return;
    }
    if (mode === "picker") {
      if (key === "escape") {
        evt.preventDefault();
        setMode("browse");
      } else if (key === "up" || key === "down") {
        evt.preventDefault();
        const max = options.length;
        if (max) setPick((p) => (p + (key === "up" ? max - 1 : 1)) % max);
      } else if (key === "return") {
        evt.preventDefault();
        const option = options[pick];
        if (!option || !target) return;
        if (option.disabled) {
          notify("info", `${option.gate.id}: ${option.disabled}`);
          return;
        }
        const result = addGate(state, target, option.gate.id);
        apply(result);
        if (!result.error) {
          setMode("browse");
          notify("ok", `${option.gate.id} added to ${targetName(target)}`);
        }
      }
      return;
    }
    if (mode === "describe") {
      if (key === "escape") {
        evt.preventDefault();
        setMode("browse");
      } else if (key === "tab") {
        evt.preventDefault();
        setKind((k) => (k + (evt.shift ? DRAFT_KINDS.length - 1 : 1)) % DRAFT_KINDS.length);
      } else if (key === "return") {
        evt.preventDefault();
        requestDraft();
      }
      return;
    }
    if (mode === "draft") {
      evt.preventDefault();
      if (key === "escape") setMode("describe");
      else if (key === "up" || key === "k") setScroll((n) => Math.max(0, n - 1));
      else if (key === "down" || key === "j") setScroll((n) => n + 1);
      else if (key === "return") saveDraft();
      return;
    }
    if (mode === "transition") {
      evt.preventDefault();
      if (!draft || !stage) return;
      const choices = transitionChoices(state.definition, stage.id);
      const name = TRANSITION_FIELDS[field] ?? "to";
      if (key === "escape") setMode("browse");
      else if (key === "up" || key === "down" || key === "tab")
        setField((f) => (f + (key === "up" ? 2 : 1)) % TRANSITION_FIELDS.length);
      else if (key === "left" || key === "right") {
        const delta = key === "left" ? -1 : 1;
        const step = <T,>(list: readonly T[], value: T): T =>
          list[(list.indexOf(value) + delta + list.length) % list.length] ?? value;
        setDraft(
          name === "to"
            ? { ...draft, to: step(choices.to, draft.to) }
            : name === "on"
              ? { ...draft, on: step(choices.on, draft.on) }
              : { ...draft, loop: step(choices.loop, draft.loop) },
        );
      } else if (key === "return") {
        const result = addTransition(state, stage.id, draft);
        apply(result);
        if (!result.error) setMode("browse");
      }
      return;
    }
    if (mode === "station") {
      evt.preventDefault();
      const arrow = stationArrow(state);
      const max = INSERTABLE_STAGES.length;
      if (key === "escape") setMode("browse");
      else if (key === "up" || key === "down")
        setPick((p) => (p + (key === "up" ? max - 1 : 1)) % max);
      else if (key === "return" && arrow) {
        const type = INSERTABLE_STAGES[pick] ?? "check";
        const result = insertStage(state, arrow, type);
        apply(result);
        if (!result.error) {
          setMode("browse");
          notify("ok", `${STATION_WORDS[type].name} station added on ${arrow}`);
        }
      }
      return;
    }
    if (mode === "options") {
      evt.preventDefault();
      if (!stage) return;
      if (key === "escape" || key === "return") setMode("browse");
      else if ((key === "up" || key === "down") && fields.length)
        setField((f) => (f + (key === "up" ? fields.length - 1 : 1)) % fields.length);
      else if ((key === "left" || key === "right") && fields[field])
        apply(changeStageField(state, stage.id, fields[field].key, key === "left" ? -1 : 1));
      return;
    }
    // browse
    if (evt.ctrl && key === "s") {
      evt.preventDefault();
      startSave();
      return;
    }
    if (key === "escape") {
      evt.preventDefault();
      if (state.dirty) setMode("discard");
      else onBack();
      return;
    }
    if (key === "tab") {
      evt.preventDefault();
      setState(switchPane(state, evt.shift ? -1 : 1));
      return;
    }
    const gatesPane = state.pane === "gates";
    if (key === "up" || key === "down" || (!gatesPane && (key === "k" || key === "j"))) {
      evt.preventDefault();
      setState(moveCursor(state, key === "up" || key === "k" ? -1 : 1));
      return;
    }
    if (gatesPane && (key === "j" || key === "k") && target) {
      evt.preventDefault();
      apply(moveGate(state, target, state.gate, key === "k" ? -1 : 1));
      return;
    }
    if (key === "a") {
      evt.preventDefault();
      if (state.readOnly) notify("info", state.readOnly);
      else if (!target) notify("info", "This stage has no gate list yet. N adds a transition.");
      else {
        setQuery("");
        setPick(0);
        setMode("picker");
      }
    } else if (key === "g") {
      evt.preventDefault();
      if (!api.draftGate) notify("info", "Gates from a sentence are not available here.");
      else if (state.readOnly) notify("info", state.readOnly);
      else if (!target) notify("info", "This stage has no gate list yet. N adds a transition.");
      else {
        setSentence("");
        setMode("describe");
      }
    } else if (key === "d") {
      evt.preventDefault();
      if (gatesPane && target) apply(removeGate(state, target, state.gate));
      else if (state.pane === "transitions" && target?.kind === "transition")
        apply(removeTransition(state, target.id));
      else if (state.pane === "stages" && stage) apply(removeStage(state, stage.id));
      else notify("info", "Select a gate, a transition or a stage to remove.");
    } else if (key === "m") {
      evt.preventDefault();
      if (gatesPane && target) apply(toggleMode(state, target, state.gate));
      else notify("info", "M works on a gate: Tab to the gates pane first.");
    } else if (key === "n" && stage) {
      evt.preventDefault();
      if (state.readOnly) notify("info", state.readOnly);
      else {
        setDraft(defaultTransitionDraft(state.definition, stage.id));
        setField(0);
        setMode("transition");
      }
    } else if (key === "i" && stage) {
      evt.preventDefault();
      const arrow = stationArrow(state);
      if (state.readOnly) notify("info", state.readOnly);
      else if (!arrow)
        notify("info", "Select a forward transition, or a stage with one passed transition.");
      else {
        setPick(0);
        setMode("station");
      }
    } else if (key === "w" && stage) {
      evt.preventDefault();
      apply(insertWaitStage(state, stage.id));
    } else if (key === "e" && stage) {
      evt.preventDefault();
      if (state.readOnly) notify("info", state.readOnly);
      else {
        setField(0);
        setMode("options");
      }
    } else if (key === "c") {
      evt.preventDefault();
      if (!state.readOnly) notify("info", "This workflow is already editable.");
      else {
        const copy = duplicateAsCustom(state);
        setState(copy);
        notify("ok", `Copied as ${copy.id}. Ctrl+S writes baked/workflows/${copy.id}.json.`);
      }
    }
  });

  if (!state)
    return (
      <box flexDirection="column">
        <text fg={t.error}>{`✗ ${opened.error ?? "The workflow could not be opened."}`}</text>
        <Hint>Open a workflow by its ID: /workflow edit standard. Esc goes back.</Hint>
      </box>
    );

  const definition = state.definition;
  const narrow = width < 90;
  const listRows = Math.max(3, height - (narrow ? 20 : 18));
  const count = problemCount(problems);
  const compact = narrow || height < 30;
  const banner = compact
    ? "Started runs keep their frozen copy."
    : "A saved definition applies to runs created afterwards; started runs keep their frozen copy.";
  const header = (
    <>
      <text fg={t.textPrimary} attributes={1}>
        {clip(
          `Workflow editor: ${state.id} ${definition.version}${state.readOnly ? " (read only)" : definition.preset === "custom" ? " (custom)" : ""}${state.dirty ? " · unsaved" : ""}`,
          width,
        )}
      </text>
      <text fg={t.textMuted}>{clip(banner, width)}</text>
      {mode === "discard" ? (
        <text fg={t.warning} attributes={1}>
          {clip("Discard unsaved changes? Y discards; N keeps editing.", width)}
        </text>
      ) : null}
      {state.readOnly && compact ? (
        <text fg={t.warning}>
          {clip("Read only. C duplicates it as a custom workflow.", width)}
        </text>
      ) : state.readOnly ? (
        <Hint kind="warn">{state.readOnly}</Hint>
      ) : null}
    </>
  );

  if (mode === "picker" && target) {
    const { start, items } = visible(options, pick, Math.max(2, Math.floor(listRows / 2)));
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>{`Add a gate to ${targetName(target)}`}</text>
        <box flexDirection="row" height={1}>
          <text fg={t.brand}>{"Search "}</text>
          <box width={Math.max(10, width - 10)} backgroundColor={t.bgPopupHighlight}>
            <input
              value={query}
              onInput={(value: string) => {
                setQuery(value);
                setPick(0);
              }}
              focused={active}
              placeholder="ID, type or description"
              backgroundColor={t.bgPopupHighlight}
            />
          </box>
        </box>
        {options.length === 0 ? (
          <text fg={t.textMuted}>No gate in the library matches.</text>
        ) : null}
        {items.map((option, i) => {
          const selected = start + i === pick;
          return (
            <box
              key={option.gate.id}
              flexDirection="column"
              backgroundColor={selected ? t.bgPopupHighlight : t.bgPopup}
            >
              <text fg={option.disabled ? t.textFaint : selected ? t.brand : t.textPrimary}>
                {clip(`${option.disabled ? "✗" : "+"} ${option.gate.id}  ${option.summary}`, width)}
              </text>
              <text fg={option.disabled ? t.warning : t.textFaint}>
                {option.disabled
                  ? `    cannot bind: ${option.disabled}`
                  : clip(`    ${option.gate.description}`, width)}
              </text>
            </box>
          );
        })}
      </box>
    );
  }

  if (mode === "station" && state) {
    const arrow = stationArrow(state);
    return (
      <box flexDirection="column">
        {header}
        <text
          fg={t.textPrimary}
          attributes={1}
        >{`Put a station on ${arrow ?? "the transition"}`}</text>
        {INSERTABLE_STAGES.map((type, i) => (
          <box
            key={type}
            flexDirection="row"
            backgroundColor={i === pick ? t.bgPopupHighlight : t.bgPopup}
          >
            <text fg={i === pick ? t.brand : t.textPrimary}>
              {clip(
                `${GLYPH[type]} ${STATION_WORDS[type].name}  ${STATION_WORDS[type].what}`,
                width,
              )}
            </text>
          </box>
        ))}
      </box>
    );
  }

  if (mode === "describe" && target) {
    const chosen = DRAFT_KINDS[kind] ?? "command";
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>{`New gate for ${targetName(target)}`}</text>
        <text>
          <span fg={t.textMuted}>{"Kind  "}</span>
          {DRAFT_KINDS.map((k, i) => (
            <span key={k} fg={k === chosen ? t.brand : t.textFaint}>
              {`${i ? " · " : ""}${k === chosen ? `[${DRAFT_KIND_LABELS[k]}]` : DRAFT_KIND_LABELS[k]}`}
            </span>
          ))}
        </text>
        <box flexDirection="row" height={1}>
          <text fg={t.brand}>{"Check "}</text>
          <box width={Math.max(10, width - 10)} backgroundColor={t.bgPopupHighlight}>
            <input
              value={sentence}
              onInput={setSentence}
              focused={active && !drafting}
              placeholder="In plain words, e.g. after the build, `app --sum 50 6` prints 56"
              backgroundColor={t.bgPopupHighlight}
            />
          </box>
        </box>
        <Hint>
          {drafting
            ? "Drafting the gate with the project's model…"
            : chosen === "command" || chosen === "ai-acceptance"
              ? "The project's model drafts the gate; you review it before anything is saved."
              : "Built from your sentence without a model; you review it before it is saved."}
        </Hint>
      </box>
    );
  }

  if (mode === "draft" && gateDraft && target) {
    const lines = draftReport(gateDraft);
    const rows = Math.max(4, height - 14);
    const top = Math.min(scroll, Math.max(0, lines.length - rows));
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>
          {clip(`Save ${gateDraft.path} and add it to ${targetName(target)}?`, width)}
        </text>
        {lines.slice(top, top + rows).map((line, n) => (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
            key={top + n}
            fg={line.startsWith("  Cannot be saved") ? t.error : t.textPrimary}
          >
            {clip(line, width)}
          </text>
        ))}
        {lines.length > top + rows ? (
          <text fg={t.textFaint}>{`… ${lines.length - top - rows} more lines`}</text>
        ) : null}
        {gateDraft.problems.length ? (
          <Hint kind="warn">Esc goes back to change the sentence or the kind.</Hint>
        ) : (
          <Hint>Saving confirms the gate for this workspace, because you just read it.</Hint>
        )}
      </box>
    );
  }

  if (mode === "transition" && draft && stage) {
    const values = {
      to: draft.to,
      on: draft.on,
      loop: draft.loop === null ? "none" : `loop, at most ${draft.loop} rounds`,
    };
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>{`New transition from ${stage.id}`}</text>
        <text fg={t.textMuted}>
          {clip(`It carries ${stage.produces}, the contract ${stage.id} produces.`, width)}
        </text>
        {TRANSITION_FIELDS.map((name, i) => (
          <text key={name} fg={i === field ? t.brand : t.textPrimary}>
            {`${i === field ? "▸" : " "} ${{ to: "To", on: "On", loop: "Loop" }[name].padEnd(6)}‹ ${values[name]} ›`}
          </text>
        ))}
        <Hint>A back edge needs a loop bound; validation below says when one is missing.</Hint>
        <ValidationStrip
          problems={problems}
          count={count}
          estimate={estimate?.label ?? null}
          width={width}
          rows={3}
        />
      </box>
    );
  }

  if (mode === "options" && stage) {
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>{`Options of ${stage.id} (${stage.type})`}</text>
        {fields.length === 0 ? (
          <text fg={t.textMuted}>This stage has no options to change here.</text>
        ) : (
          fields.map((f, i) => (
            <box key={f.key} flexDirection="column">
              <text fg={i === field ? t.brand : t.textPrimary}>
                {clip(`${i === field ? "▸" : " "} ${f.label.padEnd(18)}‹ ${f.value} ›`, width)}
              </text>
              {i === field ? <text fg={t.textFaint}>{clip(`    ${f.hint}`, width)}</text> : null}
            </box>
          ))
        )}
        {definition.autoApproval ? (
          <Hint kind="warn">
            {clip(
              "Auto approval is on: the first save asks you to type the hash of its limits.",
              width * 2,
            )}
          </Hint>
        ) : null}
        <ValidationStrip
          problems={problems}
          count={count}
          estimate={estimate?.label ?? null}
          width={width}
          rows={3}
        />
      </box>
    );
  }

  if (mode === "problems" && review?.kind === "problems")
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.error} attributes={1}>
          {`Not saved: ${problemCount(review.groups)} problem${problemCount(review.groups) === 1 ? "" : "s"}. A run could not start from this definition.`}
        </text>
        {review.groups.map((group) => (
          <box key={group.owner} flexDirection="column">
            <text fg={t.warning}>{group.owner}</text>
            {group.messages.map((message) => (
              <text key={message} fg={t.textPrimary}>
                {clip(`  ${message}`, width)}
              </text>
            ))}
          </box>
        ))}
      </box>
    );

  if (mode === "review" && review?.kind === "review") {
    const diffRows = Math.max(3, listRows);
    return (
      <box flexDirection="column">
        {header}
        <text fg={t.textPrimary} attributes={1}>
          {clip(`Save baked/workflows/${state.id}.json?`, width)}
        </text>
        {review.autoApproval ? (
          <box flexDirection="column">
            <text fg={t.warning} attributes={1}>
              Auto approval: plans inside these limits are approved without you.
            </text>
            <text fg={t.textPrimary}>{review.autoApproval.limits}</text>
            <text fg={t.textMuted}>
              {`To turn it on, type ${review.autoApproval.prefix} (the start of the limits hash ${review.autoApproval.hash}), then Enter:`}
            </text>
            <box width={Math.max(14, Math.min(width - 2, 40))} backgroundColor={t.bgPopupHighlight}>
              <input
                value={typed}
                onInput={setTyped}
                focused={active}
                placeholder={`${CONFIRM_PREFIX} characters`}
                backgroundColor={t.bgPopupHighlight}
              />
            </box>
          </box>
        ) : null}
        {saveError ? <text fg={t.error}>{`✗ ${saveError}`}</text> : null}
        <text fg={t.textMuted}>
          {state.savedText === null ? "A new file:" : "Changes against the saved file:"}
        </text>
        {review.diff
          .slice(0, diffRows)
          .map((line, n) => ({ n, line }))
          .map(({ n, line }) => (
            <text
              key={`diff-${n}`}
              fg={line.startsWith("+") ? t.success : line.startsWith("-") ? t.error : t.textFaint}
            >
              {clip(line, width)}
            </text>
          ))}
        {review.diff.length > diffRows ? (
          <text fg={t.textFaint}>{`… ${review.diff.length - diffRows} more lines`}</text>
        ) : null}
        <text fg={t.textMuted}>Effective gates:</text>
        {review.gates.length === 0 ? <text fg={t.textFaint}> none</text> : null}
        {review.gates.map((line) => (
          <text key={line} fg={t.textPrimary}>
            {clip(`  ${line}`, width)}
          </text>
        ))}
      </box>
    );
  }

  // Browse: three panes, or one list with a pane switcher on a narrow terminal.
  const targets = stage ? targetsOf(definition, stage.id) : [];
  const gates = target ? bindingsAt(definition, target) : [];
  const stageRow = (s: Stage): string =>
    `${GLYPH[s.type]} ${s.id}${s.effects === "workspace-write" ? " (writes)" : ""}`;
  const targetRow = (i: number): string => {
    const item = targets[i];
    if (!item) return "";
    const n = bindingsAt(definition, item).length;
    const gateCount = `[${n} gate${n === 1 ? "" : "s"}]`;
    if (item.kind === "stage") return `stage gates      ${gateCount}`;
    const tr = transitionOf(definition, item);
    if (!tr) return item.id;
    return `${tr.on.padEnd(8)}→ ${tr.to}${tr.loop ? ` loop ${tr.loop.maxIterations}` : ""}${tr.when ? " (when)" : ""}  ${gateCount}`;
  };
  const gateRow = (i: number): string => {
    const binding = gates[i];
    if (!binding) return "";
    const gate = state.library.get(binding.gateId)?.gate;
    const mode = gate ? effectiveMode(binding, gate) : "unknown gate";
    const kind =
      gate && gate.type !== "command"
        ? ` (${gate.type === "ai-review" ? "AI" : gate.type === "ai-acceptance" ? "AI walk" : gate.type})`
        : "";
    return `${i + 1} ${binding.gateId}  ${mode}${kind}${binding.mode ? " *" : ""}`;
  };
  const paneTitle: Record<Pane, string> = {
    stages: "Stages",
    transitions: stage ? `Transitions of "${stage.id}"` : "Transitions",
    gates: target ? `Gates on "${target.kind === "stage" ? target.stageId : target.id}"` : "Gates",
  };
  const pane = (which: Pane, paneWidth: number) => {
    const rows =
      which === "stages"
        ? definition.stages.map(stageRow)
        : which === "transitions"
          ? targets.map((_, i) => targetRow(i))
          : gates.map((_, i) => gateRow(i));
    const cursor =
      which === "stages" ? state.stage : which === "transitions" ? state.target : state.gate;
    const focused = state.pane === which;
    const shown = visible(rows, cursor, listRows).rows;
    const empty =
      which === "gates"
        ? target
          ? "No gates. A adds one."
          : "Select a transition."
        : which === "transitions"
          ? "No transitions. N adds one."
          : "";
    return (
      <box flexDirection="column" width={paneWidth} key={which}>
        <text fg={focused ? t.brand : t.textMuted} attributes={focused ? 1 : 0}>
          {clip(paneTitle[which], paneWidth - 1)}
        </text>
        {rows.length === 0 ? <text fg={t.textFaint}>{clip(empty, paneWidth - 1)}</text> : null}
        {shown.map(({ index, item: row }) => {
          const selected = index === cursor;
          return (
            <text
              key={`${which}:${index}`}
              fg={selected && focused ? t.brand : t.textPrimary}
              bg={selected && focused ? t.bgPopupHighlight : t.bgPopup}
            >
              {clip(`${selected ? "▸" : " "} ${row}`, paneWidth - 1)}
            </text>
          );
        })}
      </box>
    );
  };
  return (
    <box flexDirection="column">
      {header}
      {narrow ? (
        <>
          <text>
            {PANES.map((p, i) => (
              <span key={p} fg={p === state.pane ? t.brand : t.textFaint}>
                {`${i ? " · " : ""}${p === state.pane ? `[${PANE_TITLE[p]}]` : PANE_TITLE[p]}`}
              </span>
            ))}
            <span fg={count ? t.warning : t.success}>{`  ${count ? "⚠" : "✓"} ${count}`}</span>
          </text>
          {pane(state.pane, width)}
        </>
      ) : (
        <box flexDirection="row">
          {pane("stages", Math.floor(width * 0.24))}
          {pane("transitions", Math.floor(width * 0.4))}
          {pane("gates", width - Math.floor(width * 0.24) - Math.floor(width * 0.4))}
        </box>
      )}
      <ValidationStrip
        problems={problems}
        count={count}
        estimate={estimate?.label ?? null}
        width={width}
        rows={narrow ? 2 : 3}
      />
    </box>
  );
}

function ValidationStrip({
  problems,
  count,
  estimate,
  width,
  rows,
}: {
  problems: ReturnType<typeof validateEditor>;
  count: number;
  estimate: string | null;
  width: number;
  rows: number;
}) {
  const t = useTheme();
  const lines = problems.flatMap((g) => g.messages.map((m) => `${g.owner}: ${m}`));
  return (
    <box flexDirection="column" marginTop={1}>
      <text>
        <span fg={count ? t.warning : t.success}>
          {`Validation: ${count} problem${count === 1 ? "" : "s"}`}
        </span>
        {estimate && width >= 80 ? <span fg={t.textMuted}>{`   ${estimate}`}</span> : null}
      </text>
      {lines.slice(0, rows).map((line) => (
        <text key={line} fg={t.warning}>
          {clip(`  ${line}`, width)}
        </text>
      ))}
      {lines.length > rows ? (
        <text fg={t.textFaint}>
          {clip(`  … ${lines.length - rows} more; Ctrl+S lists them all`, width)}
        </text>
      ) : null}
      {estimate && width < 80 ? <text fg={t.textMuted}>{clip(estimate, width)}</text> : null}
    </box>
  );
}

/** The editor in the workflow popup, as the panel shows it. */
export function WorkflowEditorPopup({
  workspace,
  workflowId,
  api,
  width,
  height,
  onBack,
}: {
  workspace: string;
  workflowId: string;
  api: WorkflowEditorApi;
  width: number;
  height: number;
  onBack: () => void;
}) {
  const [mode, setMode] = useState<EditorMode>("browse");
  const [flash, setFlash] = useState<{ kind: "ok" | "err" | "info"; message: string } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(timer);
  }, [flash]);
  return (
    <PremiumPopup
      visible
      title="Workflow"
      blurb="Editor: stages, transitions and their gates"
      width={width}
      height={height}
      footerHints={EDITOR_HINTS[mode]}
      flash={flash}
    >
      <box flexDirection="column" paddingX={1}>
        <WorkflowEditor
          key={workflowId}
          active
          workspace={workspace}
          workflowId={workflowId}
          api={api}
          width={width - 6}
          height={height}
          onBack={onBack}
          onMode={setMode}
          notify={(kind, message) => setFlash({ kind, message })}
        />
      </box>
    </PremiumPopup>
  );
}

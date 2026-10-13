import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import {
  checkFromDraft,
  draftFromCheck,
  emptyGateDraft,
  formatCommandLine,
  type GateDraft,
  type GateRunResult,
  type GateSuggestion,
} from "../../core/workflows/gates.js";
import type { Check } from "../../core/workflows/types.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";
import { Hint } from "../ui/index.js";
import { formatDuration } from "./format.js";

/** Everything the window needs from the outside, so it renders the same in tests and in the app. */
export interface GatesApi {
  load(): Check[];
  save(checks: Check[]): Promise<void>;
  suggest(configured: Check[]): GateSuggestion[];
  run(check: Check, signal: AbortSignal): Promise<GateRunResult>;
}

export type GatesMode = "list" | "form" | "suggest" | "delete" | "running";
type Mode = Exclude<GatesMode, "running">;

/** Footer keys for each state of the window, so the panel shows only keys that work right now. */
export const GATES_HINTS: Record<GatesMode, { key: string; label: string }[]> = {
  list: [
    { key: "↑↓", label: "select" },
    { key: "N", label: "new" },
    { key: "E", label: "edit" },
    { key: "D", label: "delete" },
    { key: "R", label: "run now" },
    { key: "S", label: "detected" },
    { key: "Esc", label: "back" },
  ],
  form: [
    { key: "Tab/↑↓", label: "field" },
    { key: "←→", label: "toggle" },
    { key: "Ctrl+S", label: "save" },
    { key: "Esc", label: "cancel" },
  ],
  suggest: [
    { key: "↑↓", label: "select" },
    { key: "Space", label: "toggle" },
    { key: "Enter", label: "add selected" },
    { key: "Esc", label: "back" },
  ],
  delete: [
    { key: "Y", label: "remove" },
    { key: "N", label: "keep" },
  ],
  running: [{ key: "Esc", label: "stop" }],
};
const FIELDS = [
  "id",
  "command",
  "cwd",
  "timeout",
  "required",
  "scope",
  "result",
  "env",
  "writes",
  "save",
] as const;
type FieldId = (typeof FIELDS)[number];
const LABELS: Record<FieldId, string> = {
  id: "ID",
  command: "Command",
  cwd: "Directory",
  timeout: "Timeout (s)",
  required: "Required",
  scope: "Scope",
  result: "Result",
  env: "Env names",
  writes: "Writes",
  save: "",
};
const TEXT_FIELDS: FieldId[] = ["id", "command", "cwd", "timeout", "env", "writes"];

export function describeGateRun(result: GateRunResult): string {
  const how = {
    passed: "passed",
    failed: "failed",
    timeout: "timed out",
    cancelled: "stopped",
    error: "could not start",
  }[result.status];
  const exit = result.exitCode !== null ? ` · exit ${result.exitCode}` : "";
  return `${how}${exit} · ${formatDuration(result.durationMs)}`;
}
const gateLine = (check: Check): string =>
  `${check.required ? "required" : "advisory"} · ${check.scope}${check.report === "json" ? " · JSON report" : ""} · ${Math.round(check.timeoutMs / 1000)}s`;

export function GatesView({
  active,
  workspace,
  api,
  canRun,
  width,
  onBack,
  onMode,
  notify,
}: {
  active: boolean;
  workspace: string;
  api: GatesApi;
  /** False while workflows are off: nothing may start a worker for a disabled project. */
  canRun: boolean;
  width: number;
  onBack: () => void;
  onMode?: (mode: GatesMode) => void;
  notify: (kind: "ok" | "err" | "info", message: string) => void;
}) {
  const t = useTheme();
  const [gates, setGates] = useState<Check[]>(() => api.load());
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [results, setResults] = useState<Record<string, GateRunResult>>({});
  const [running, setRunning] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<GateDraft>(emptyGateDraft());
  const [editing, setEditing] = useState<string | null>(null);
  const [focus, setFocus] = useState<FieldId>("id");
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<GateSuggestion[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => onMode?.(running ? "running" : mode), [mode, running, onMode]);
  const selected = gates[Math.min(cursor, Math.max(0, gates.length - 1))];
  const persist = async (next: Check[], message: string): Promise<boolean> => {
    setSaving(true);
    try {
      await api.save(next);
      setGates(next);
      notify("ok", message);
      return true;
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setError(text);
      notify("err", text);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const openForm = (check: Check | undefined): void => {
    setDraft(check ? draftFromCheck(check) : emptyGateDraft());
    setEditing(check?.id ?? null);
    setFocus(check ? "command" : "id");
    setError(null);
    setMode("form");
  };
  const submitForm = async (): Promise<void> => {
    if (saving) return;
    const others = gates.filter((g) => g.id !== editing);
    const parsed = checkFromDraft(draft, workspace, others);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const next = editing
      ? gates.map((g) => (g.id === editing ? parsed.check : g))
      : [...gates, parsed.check];
    if (
      await persist(
        next,
        editing ? `Gate ${parsed.check.id} updated` : `Gate ${parsed.check.id} added`,
      )
    ) {
      if (editing && editing !== parsed.check.id)
        setResults(({ [editing]: _renamed, ...rest }) => rest);
      setCursor(next.findIndex((g) => g.id === parsed.check.id));
      setMode("list");
    }
  };
  const startRun = async (check: Check): Promise<void> => {
    if (running) return;
    if (!canRun) {
      notify("info", "Enable workflows first: press Esc, then E on the runs screen.");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setRunning(check.id);
    try {
      const result = await api.run(check, abort.signal);
      setResults((prev) => ({ ...prev, [check.id]: result }));
    } catch (err) {
      notify("err", err instanceof Error ? err.message : String(err));
    } finally {
      controller.current = null;
      setRunning(null);
    }
  };
  const openSuggestions = (): void => {
    const found = api.suggest(gates);
    if (!found.length) {
      notify("info", "Nothing new detected in this project.");
      return;
    }
    setSuggestions(found);
    setPicked(new Set(found.filter((s) => s.preselected).map((s) => s.check.id)));
    setCursor(0);
    setMode("suggest");
  };

  useKeyboard((evt) => {
    if (!active) return;
    const key = evt.name.toLowerCase();
    if (mode === "form") {
      if (key === "escape") {
        evt.preventDefault();
        setMode("list");
      } else if (evt.ctrl && key === "s") {
        evt.preventDefault();
        void submitForm();
      } else if (key === "tab" || key === "down" || key === "up") {
        evt.preventDefault();
        const delta = key === "up" || (key === "tab" && evt.shift) ? -1 : 1;
        setFocus((f) => FIELDS[(FIELDS.indexOf(f) + delta + FIELDS.length) % FIELDS.length] ?? f);
      } else if (
        focus === "required" &&
        (key === "left" || key === "right" || key === "space" || key === " ")
      ) {
        evt.preventDefault();
        setDraft((d) => ({ ...d, required: !d.required }));
      } else if (
        focus === "scope" &&
        (key === "left" || key === "right" || key === "space" || key === " ")
      ) {
        evt.preventDefault();
        setDraft((d) => ({ ...d, scope: d.scope === "feature" ? "task" : "feature" }));
      } else if (
        focus === "result" &&
        (key === "left" || key === "right" || key === "space" || key === " ")
      ) {
        evt.preventDefault();
        setDraft((d) => ({ ...d, jsonReport: !d.jsonReport }));
      } else if (key === "return") {
        evt.preventDefault();
        if (focus === "save") void submitForm();
        else setFocus((f) => FIELDS[FIELDS.indexOf(f) + 1] ?? f);
      }
      return;
    }
    if (mode === "suggest") {
      evt.preventDefault();
      const max = suggestions.length;
      if (key === "escape") setMode("list");
      else if (key === "up" || key === "k") setCursor((c) => (c > 0 ? c - 1 : max - 1));
      else if (key === "down" || key === "j") setCursor((c) => (c < max - 1 ? c + 1 : 0));
      else if (key === "space" || key === " ") {
        const id = suggestions[cursor]?.check.id;
        if (id)
          setPicked((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
          });
      } else if (key === "return" || key === "a") {
        const add = suggestions.filter((s) => picked.has(s.check.id)).map((s) => s.check);
        if (!add.length) notify("info", "Nothing selected. Space selects a gate.");
        else
          void persist(
            [...gates, ...add],
            `${add.length} gate${add.length > 1 ? "s" : ""} added`,
          ).then((ok) => {
            if (ok) {
              setCursor(gates.length);
              setMode("list");
            }
          });
      }
      return;
    }
    if (mode === "delete") {
      evt.preventDefault();
      if (key === "y" && selected) {
        const next = gates.filter((g) => g.id !== selected.id);
        void persist(next, `Gate ${selected.id} removed`).then((ok) => {
          if (ok) {
            setCursor((c) => Math.max(0, Math.min(c, next.length - 1)));
            setMode("list");
          }
        });
      } else if (key === "n" || key === "escape") setMode("list");
      return;
    }
    // list
    if (key === "escape") {
      evt.preventDefault();
      if (running) controller.current?.abort();
      else onBack();
      return;
    }
    if (running) return;
    const max = gates.length;
    if ((key === "up" || key === "k") && max) {
      evt.preventDefault();
      setCursor((c) => (c > 0 ? c - 1 : max - 1));
    } else if ((key === "down" || key === "j") && max) {
      evt.preventDefault();
      setCursor((c) => (c < max - 1 ? c + 1 : 0));
    } else if (key === "n") {
      evt.preventDefault();
      openForm(undefined);
    } else if ((key === "e" || key === "return") && selected) {
      evt.preventDefault();
      openForm(selected);
    } else if (key === "d" && selected) {
      evt.preventDefault();
      setMode("delete");
    } else if (key === "r" && selected) {
      evt.preventDefault();
      void startRun(selected);
    } else if (key === "s") {
      evt.preventDefault();
      openSuggestions();
    }
  });

  const labelW = 12;
  const inputW = Math.max(16, width - labelW - 8);
  const textValue: Record<string, string> = {
    id: draft.id,
    command: draft.command,
    cwd: draft.cwd,
    timeout: draft.timeoutSeconds,
    env: draft.envNames,
    writes: draft.writes,
  };
  const setText = (field: FieldId, value: string): void =>
    setDraft((d) => ({
      ...d,
      ...(field === "id"
        ? { id: value }
        : field === "command"
          ? { command: value }
          : field === "cwd"
            ? { cwd: value }
            : field === "timeout"
              ? { timeoutSeconds: value }
              : field === "env"
                ? { envNames: value }
                : { writes: value }),
    }));

  if (mode === "form")
    return (
      <box flexDirection="column">
        <text fg={t.textPrimary} attributes={1}>
          {editing ? `Edit gate ${editing}` : "New gate"}
        </text>
        <text fg={t.textMuted}>
          A gate is a command a run must pass. Changes apply to runs started afterwards.
        </text>
        <box height={1} />
        {FIELDS.filter((f) => f !== "save").map((field) => {
          const focused = focus === field;
          return (
            <box key={field} flexDirection="row" height={1}>
              <text fg={focused ? t.brand : t.textFaint}>{focused ? "▸ " : "  "}</text>
              <text fg={focused ? t.brand : t.textMuted}>{LABELS[field].padEnd(labelW)}</text>
              {TEXT_FIELDS.includes(field) ? (
                <box width={inputW} backgroundColor={focused ? t.bgPopupHighlight : t.bgPopup}>
                  <input
                    value={textValue[field] ?? ""}
                    onInput={(value: string) => setText(field, value)}
                    onSubmit={() => setFocus((f) => FIELDS[FIELDS.indexOf(f) + 1] ?? f)}
                    focused={active && focused}
                    placeholder={
                      field === "command"
                        ? "bun run test"
                        : field === "env"
                          ? "NAME, OTHER_NAME"
                          : field === "writes"
                            ? "generated/output, coverage"
                            : ""
                    }
                    backgroundColor={focused ? t.bgPopupHighlight : t.bgPopup}
                  />
                </box>
              ) : (
                <text fg={focused ? t.brand : t.textPrimary}>
                  {field === "required"
                    ? `‹ ${draft.required ? "required: the run cannot finish without it" : "advisory: result is shown only"} ›`
                    : field === "result"
                      ? `‹ ${draft.jsonReport ? "JSON report: its last JSON line decides" : "exit code: 0 passes"} ›`
                      : `‹ ${draft.scope === "feature" ? "feature: once per run, on the whole result" : "task: after each task"} ›`}
                </text>
              )}
            </box>
          );
        })}
        <box height={1} />
        <box flexDirection="row">
          <text
            fg={focus === "save" ? t.bgPopup : t.brand}
            bg={focus === "save" ? t.brand : t.bgPopup}
            attributes={1}
          >
            {saving ? " Saving… " : " Save gate "}
          </text>
          <text fg={t.textFaint}>{"  Ctrl+S from any field · Esc cancels"}</text>
        </box>
        {error ? <text fg={t.error}>{`✗ ${error}`}</text> : null}
        <Hint>
          The command runs without a shell: quote arguments that contain spaces. Env names are
          passed through; their values are never stored.
        </Hint>
      </box>
    );

  if (mode === "suggest")
    return (
      <box flexDirection="column">
        <text fg={t.textPrimary} attributes={1}>
          Detected in this project
        </text>
        <text fg={t.textMuted}>
          Space selects, Enter adds the selected gates to .baked/config.json. Nothing is added
          before that.
        </text>
        <box height={1} />
        {suggestions.map((s, i) => (
          <box
            key={s.check.id}
            flexDirection="column"
            backgroundColor={i === cursor ? t.bgPopupHighlight : t.bgPopup}
          >
            <text fg={i === cursor ? t.brand : t.textPrimary}>
              {`${picked.has(s.check.id) ? "[x]" : "[ ]"} ${s.check.id}  ${formatCommandLine(s.check.executable, s.check.args)}`}
            </text>
            <text fg={t.textFaint}>{`      ${s.source} · ${gateLine(s.check)}`}</text>
          </box>
        ))}
      </box>
    );

  const result = selected ? results[selected.id] : undefined;
  return (
    <box flexDirection="column">
      <text fg={t.textMuted}>
        Checks every new run uses. Runs already started keep the copy they began with.
      </text>
      <box height={1} />
      {gates.length === 0 ? (
        <>
          <text fg={t.textPrimary}>No gates yet.</text>
          <Hint>
            Press S to see what this project already offers, or N to add one. Automated criteria
            cannot be approved without a required gate.
          </Hint>
        </>
      ) : (
        gates.map((gate, i) => {
          const isSelected = i === cursor;
          const last = results[gate.id];
          const glyph =
            running === gate.id ? "⟳" : last ? (last.status === "passed" ? "✓" : "✗") : "·";
          const color =
            running === gate.id
              ? t.info
              : last
                ? last.status === "passed"
                  ? t.success
                  : t.error
                : t.textFaint;
          return (
            <box
              key={gate.id}
              flexDirection="column"
              backgroundColor={isSelected ? t.bgPopupHighlight : t.bgPopup}
            >
              <text fg={isSelected ? t.brand : t.textPrimary}>
                <span fg={color}>{`${glyph} `}</span>
                {gate.id.padEnd(14)}
                <span fg={t.textMuted}>{formatCommandLine(gate.executable, gate.args)}</span>
              </text>
              <text fg={t.textFaint}>
                {`    ${gateLine(gate)}${gate.cwd !== "." ? ` · in ${gate.cwd}` : ""}${last ? ` · last: ${describeGateRun(last)}` : ""}`}
              </text>
            </box>
          );
        })
      )}
      {mode === "delete" && selected ? (
        <text fg={t.warning}>
          {`Remove gate ${selected.id}? Runs already started keep it. Y removes; N keeps it.`}
        </text>
      ) : null}
      {running ? (
        <text fg={t.info}>{`Running ${running}… Esc stops it.`}</text>
      ) : result && selected ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={result.status === "passed" ? t.success : t.error} attributes={1}>
            {`${selected.id}: ${describeGateRun(result)}`}
          </text>
          {result.outputTail ? (
            <>
              <text fg={t.textFaint}>
                {result.truncated ? "Last output lines (output was cut):" : "Last output lines:"}
              </text>
              <text fg={t.textMuted}>{result.outputTail.split("\n").slice(-15).join("\n")}</text>
            </>
          ) : (
            <text fg={t.textFaint}>No output.</text>
          )}
        </box>
      ) : null}
      {!canRun ? (
        <Hint kind="warn">
          Workflows are turned off in this project, so gates cannot run. Press Esc, then E to turn
          them on.
        </Hint>
      ) : null}
    </box>
  );
}

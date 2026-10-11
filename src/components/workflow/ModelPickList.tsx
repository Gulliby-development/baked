import { useMemo, useState } from "react";
import {
  type ModelCatalog,
  type ModelChoiceGroup,
  modelChoiceGroups,
} from "../../core/llm/model-choices.js";
import { useTheme } from "../../core/theme/index.js";
import { useKeyboard } from "../../hooks/useTerminalEvents.js";

type Line =
  | { kind: "group"; group: ModelChoiceGroup }
  | { kind: "choice"; id: string; label: string; detail?: string | undefined }
  | { kind: "typed"; id: string }
  | { kind: "note"; text: string; tone: "muted" | "error" };

const clip = (text: string, width: number): string =>
  width <= 0 ? "" : text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`;

/**
 * The model list of the routing form: class references first, then each provider's models, with
 * providers that have no key or login greyed out. Typing filters it; when the text is no listed
 * choice, the first row uses it as typed, so a model the list does not show can still be named.
 */
export function ModelPickList({
  active,
  catalog,
  error,
  classes,
  classDetails,
  title,
  width,
  rows,
  onPick,
  onCancel,
}: {
  active: boolean;
  /** Null while the providers are still being asked. */
  catalog: ModelCatalog | null;
  error?: string | null | undefined;
  /** Class names without `$`; empty where only a model fits. */
  classes: readonly string[];
  classDetails?: Readonly<Record<string, string>> | undefined;
  title: string;
  width: number;
  rows: number;
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const lines = useMemo<Line[]>(() => {
    const groups = modelChoiceGroups(catalog ?? { providers: [] }, {
      classes,
      ...(classDetails ? { classDetails } : {}),
      query,
    });
    const out: Line[] = [];
    const typed = query.trim();
    const ids = new Set(groups.flatMap((g) => g.choices.map((c) => c.id)));
    // The typed text comes first only when nothing listed matches it, so filtering selects a match.
    const asTyped: Line[] = typed && !ids.has(typed) ? [{ kind: "typed", id: typed }] : [];
    if (!ids.size) out.push(...asTyped);
    for (const group of groups) {
      out.push({ kind: "group", group });
      for (const choice of group.choices) out.push({ kind: "choice", ...choice });
    }
    if (ids.size) out.push(...asTyped);
    if (error) out.push({ kind: "note", text: error, tone: "error" });
    else if (!catalog)
      out.push({ kind: "note", text: "Asking the providers for models…", tone: "muted" });
    else if (!groups.length) out.push({ kind: "note", text: "No model matches.", tone: "muted" });
    return out;
  }, [catalog, error, classes, classDetails, query]);
  const picks = lines.flatMap((line, i) =>
    line.kind === "choice" || line.kind === "typed" ? [i] : [],
  );
  const at = Math.min(cursor, Math.max(0, picks.length - 1));
  const selected = picks[at] ?? -1;

  useKeyboard((evt) => {
    if (!active) return;
    const key = evt.name.toLowerCase();
    evt.preventDefault();
    if (key === "escape") {
      onCancel();
      return;
    }
    if (key === "up" || key === "down") {
      if (picks.length) setCursor((at + (key === "up" ? picks.length - 1 : 1)) % picks.length);
      return;
    }
    if (key === "return") {
      const line = lines[selected];
      if (line?.kind === "choice" || line?.kind === "typed") onPick(line.id);
      return;
    }
    if (key === "backspace") {
      setQuery((q) => q.slice(0, -1));
      setCursor(0);
      return;
    }
    const ch = evt.sequence;
    if (
      !evt.ctrl &&
      !evt.meta &&
      typeof ch === "string" &&
      ch.length === 1 &&
      ch >= " " &&
      ch !== "\x7f"
    ) {
      setQuery((q) => q + ch);
      setCursor(0);
    }
  });

  const listRows = Math.max(3, rows - 2);
  const start = Math.max(0, Math.min(selected - Math.floor(listRows / 2), lines.length - listRows));
  const detailW = 10;
  return (
    <box flexDirection="column">
      <text fg={t.textPrimary} attributes={1}>
        {clip(title, width)}
      </text>
      <text>
        <span fg={t.textMuted}>Search </span>
        <span fg={t.brand}>{clip(query || "", Math.max(0, width - 9))}</span>
        <span fg={t.textFaint}>{query ? "▏" : "▏type to filter"}</span>
      </text>
      {lines.slice(start, start + listRows).map((line, n) => {
        const index = start + n;
        if (line.kind === "group")
          return (
            <text key={`g-${line.group.id}`}>
              <span
                fg={line.group.available ? t.brandAlt : t.textFaint}
                attributes={line.group.available ? 1 : 0}
              >
                {clip(line.group.title, width)}
              </span>
              {line.group.note ? (
                <span fg={t.textFaint}>
                  {clip(` · ${line.group.note}`, Math.max(0, width - line.group.title.length))}
                </span>
              ) : null}
            </text>
          );
        if (line.kind === "note")
          return (
            <text key={`n-${index}`} fg={line.tone === "error" ? t.error : t.textMuted}>
              {clip(`  ${line.text}`, width)}
            </text>
          );
        const isSelected = index === selected;
        const bg = isSelected ? t.bgPopupHighlight : t.bgPopup;
        const label = line.kind === "typed" ? `Use “${line.id}” as typed` : line.id;
        const detail = line.kind === "choice" ? (line.detail ?? "") : "";
        const labelW = Math.max(4, width - 2 - (detail ? detailW + 1 : 0));
        return (
          <text key={`c-${line.kind}-${line.id}`} bg={bg}>
            <span fg={isSelected ? t.brand : t.textFaint}>{isSelected ? "▸ " : "  "}</span>
            <span fg={line.kind === "typed" ? t.textSecondary : t.textPrimary}>
              {clip(label, labelW).padEnd(labelW)}
            </span>
            {detail ? <span fg={t.textFaint}>{` ${clip(detail, detailW)}`}</span> : null}
          </text>
        );
      })}
    </box>
  );
}

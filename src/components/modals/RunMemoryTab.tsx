/**
 * The Runs tab of `/memory`: project memory that new workflow runs read (answers people gave,
 * assumptions they approved, checks that passed, and their own notes). Changes go through
 * `baked workflow memory` in the workflow worker, so the TUI shares the CLI's and the local API's
 * core logic (src/core/workflows/project-memory.ts).
 */
import type { KeyEvent } from "@opentui/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "../../core/theme/index.js";
import type {
  MemoryEntry,
  MemoryEntryKind,
  ProjectMemoryView,
} from "../../core/workflows/project-memory.js";
import { workflowSession } from "../../hooks/useWorkflow.js";
import { Hint, Search, Table, type TableColumn, VSpacer } from "../ui/index.js";

export interface RunMemoryRow {
  id: string;
  kind: string;
  text: string;
  run: string;
  state: string;
  entry: MemoryEntry;
  forgotten: boolean;
}

const KIND: Record<MemoryEntryKind, string> = {
  note: "note",
  answer: "answer",
  assumption: "assume",
  check: "check",
};

/** Visible entries first, then forgotten ones, filtered by the query. */
export function runMemoryRows(view: ProjectMemoryView | null, query: string): RunMemoryRow[] {
  if (!view) return [];
  const row = (entry: MemoryEntry, forgotten: boolean, sent = true): RunMemoryRow => ({
    id: entry.id,
    kind: KIND[entry.kind],
    text: (entry.kind === "answer"
      ? `${entry.question ?? ""} → ${entry.text}`
      : entry.text
    ).replace(/[\n\r]+/g, " "),
    run: entry.runId ? entry.runId.slice(0, 8) : "you",
    state: forgotten ? "forgot" : !sent ? "policy" : entry.recorded ? "edited" : "",
    entry,
    forgotten,
  });
  const rows = [
    ...view.entries.map((e) => row(e, false, e.sent)),
    ...view.hidden.map((e) => row(e, true)),
  ];
  const q = query.toLowerCase().trim();
  return q ? rows.filter((r) => `${r.kind} ${r.text}`.toLowerCase().includes(q)) : rows;
}

const COLUMNS: TableColumn<RunMemoryRow>[] = [
  { key: "kind", width: 6 },
  { key: "text" },
  { key: "run", width: 8 },
  { key: "state", width: 6 },
];

type Editing = { id: string | null; text: string } | null;

interface Options {
  cwd: string;
  active: boolean;
  flash: (kind: "ok" | "err" | "info", message: string) => void;
}

export function useRunMemory({ cwd, active, flash }: Options) {
  const [view, setView] = useState<ProjectMemoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const busy = useRef(false);

  const run = useCallback(
    async (argv: string[]): Promise<boolean> => {
      if (busy.current) return false;
      busy.current = true;
      try {
        const result = (await workflowSession(cwd).command(
          ["memory", ...argv],
          new AbortController().signal,
        )) as ProjectMemoryView;
        setView(result);
        setError(null);
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (argv.length) flash("err", message);
        else setError(message);
        return false;
      } finally {
        busy.current = false;
      }
    },
    [cwd, flash],
  );

  useEffect(() => {
    if (!active) return;
    setQuery("");
    setCursor(0);
    setEditing(null);
    void run([]);
  }, [active, run]);

  const rows = runMemoryRows(view, query);
  useEffect(() => {
    if (cursor >= rows.length && rows.length > 0) setCursor(rows.length - 1);
  }, [rows.length, cursor]);

  /** Handles a key while the tab is shown; returns false for keys the popup should handle. */
  const handleKey = (evt: KeyEvent): boolean => {
    if (editing) {
      if (evt.name === "escape") setEditing(null);
      else if (evt.name === "return") {
        const text = editing.text.trim();
        if (!text) flash("err", "Text must not be empty");
        else {
          const argv = editing.id ? ["edit", editing.id, "--text", text] : ["add", "--text", text];
          void run(argv).then((ok) => {
            if (!ok) return;
            setEditing(null);
            flash("ok", editing.id ? "Saved; new runs read it" : "Note added");
          });
        }
      } else if (evt.name === "backspace" || evt.name === "delete")
        setEditing({ ...editing, text: editing.text.slice(0, -1) });
      else if (evt.ctrl && evt.name === "u") setEditing({ ...editing, text: "" });
      else {
        const ch = evt.sequence;
        if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta)
          setEditing({ ...editing, text: editing.text + ch });
      }
      return true;
    }
    if (evt.name === "escape" || evt.name === "tab") return false;
    const row = rows[cursor];
    if (evt.name === "up") setCursor((c) => (c > 0 ? c - 1 : Math.max(0, rows.length - 1)));
    else if (evt.name === "down") setCursor((c) => (c < rows.length - 1 ? c + 1 : 0));
    else if (evt.name === "return") {
      if (!row) return true;
      if (row.entry.kind === "check")
        flash("info", "Checks cannot be reworded; forget it or change the workspace checks");
      else setEditing({ id: row.id, text: row.entry.text });
    } else if (evt.ctrl && evt.name === "n") setEditing({ id: null, text: "" });
    else if (evt.ctrl && evt.name === "d") {
      if (row && !row.forgotten)
        void run(["forget", row.id]).then(
          (ok) => ok && flash("ok", row.entry.kind === "note" ? "Note deleted" : "Forgotten"),
        );
    } else if (evt.ctrl && evt.name === "r") {
      if (row && (row.forgotten || row.entry.recorded))
        void run(["restore", row.id]).then((ok) => ok && flash("ok", "Restored"));
    } else if (evt.name === "backspace" || evt.name === "delete") setQuery((p) => p.slice(0, -1));
    else if (evt.ctrl && evt.name === "u") setQuery("");
    else {
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta)
        setQuery((p) => p + ch);
    }
    return true;
  };

  const hints = editing
    ? [
        { key: "Enter", label: "save" },
        { key: "^U", label: "clear" },
        { key: "Esc", label: "cancel" },
      ]
    : [
        { key: "↑↓", label: "nav" },
        { key: "Enter", label: "edit" },
        { key: "^N", label: "note" },
        { key: "^D", label: "forget" },
        { key: "^R", label: "restore" },
        { key: "Tab", label: "panel" },
        { key: "Esc", label: "close" },
      ];

  return { view, error, query, cursor, editing, rows, handleKey, hints };
}

export function RunMemoryPanel({
  state,
  width,
  maxRows,
}: {
  state: ReturnType<typeof useRunMemory>;
  width: number;
  maxRows: number;
}) {
  const t = useTheme();
  const { view, error, query, cursor, editing, rows } = state;
  const total = view ? view.entries.length + view.hidden.length : 0;
  return (
    <>
      <box flexDirection="row" paddingX={2} backgroundColor={t.bgPopup}>
        <text bg={t.bgPopup} fg={t.textMuted}>
          {view && !view.enabled
            ? "Off for new runs (workflow policy projectMemory: false)."
            : "What earlier workflow runs taught new runs, plus your notes. Started runs keep their copy."}
        </text>
      </box>
      <VSpacer />
      {editing ? (
        <Search
          value={editing.text}
          focused
          icon="edit"
          placeholder={editing.id ? "Reword the entry…" : "A note every new run reads…"}
        />
      ) : (
        <Search
          value={query}
          focused
          placeholder="Filter run memory…"
          count={query ? `${String(rows.length)} / ${String(total)}` : undefined}
        />
      )}
      <VSpacer />
      {error ? (
        <Hint kind="warn">{error}</Hint>
      ) : (
        <Table
          columns={COLUMNS}
          rows={rows}
          width={width}
          selectedIndex={editing ? -1 : cursor}
          focused={!editing}
          maxRows={maxRows}
          emptyMessage={
            !view
              ? "Loading…"
              : query
                ? "No matches"
                : "Nothing yet. Runs record answers, approved assumptions and passing checks; ^N adds a note."
          }
        />
      )}
      {!editing && rows[cursor]?.entry.recorded ? (
        <>
          <VSpacer />
          <Hint kind="tip">Runs recorded: {rows[cursor]?.entry.recorded}</Hint>
        </>
      ) : null}
    </>
  );
}

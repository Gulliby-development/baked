import { useState } from "react";
import { ApiError, api } from "../../client/api.js";
import { type InstructionFile, setup } from "../../client/setup.js";
import "../../styles/setup.css";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { instructionOrigin, kb } from "./logic.js";
import { errorText, type Loaded, LoadState, NeedsNewer, Tag, useLoad } from "./shared.js";

const ACTIVE = new Set(["created", "running", "waiting", "paused", "blocked"]);

function Editor({
  projectKey,
  file,
  activeRuns,
  onSaved,
}: {
  projectKey: string;
  file: InstructionFile;
  activeRuns: number;
  onSaved: (file: InstructionFile) => void;
}) {
  const [text, setText] = useState(file.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = text !== file.content;
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await setup.saveInstruction(projectKey, file.path, text, file.hash));
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "INPUT_CHANGED"
          ? `${file.path} changed on disk since it was opened. Reload to see the new version; your edits are still in the box.`
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card setup-form" aria-label={file.path}>
      <div className="setup-row">
        <span className="mono setup-h">{file.path}</span>
        <Tag>{file.scope === "global" ? "every project" : "this project"}</Tag>
        <span className="setup-push" />
        <button
          type="button"
          className="btn"
          disabled={!dirty || busy}
          onClick={() => {
            setText(file.content);
            setSaved(false);
          }}
        >
          Revert
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!dirty || busy}
          onClick={() => void save()}
        >
          Save
        </button>
      </div>
      <label htmlFor="instruction-text" className="sr-only">
        {file.path} contents
      </label>
      <textarea
        id="instruction-text"
        className="setup-text mono"
        rows={22}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />
      {error && <div className="banner error">{error}</div>}
      <span className={activeRuns > 0 ? "setup-warn setup-note" : "muted setup-note"}>
        {activeRuns > 0
          ? `Used by ${activeRuns} active run${activeRuns === 1 ? "" : "s"}. Saving pauses ${activeRuns === 1 ? "it" : "them"} until you approve the new version.`
          : "A run freezes these files when it starts; a later change asks you to approve the run again."}
        {saved && !dirty ? " Saved." : ""}
      </span>
    </section>
  );
}

function countText(value: Loaded<number>): string {
  if (value.state === "ready") return String(value.data);
  if (value.state === "missing") return "needs a newer BAKED";
  return value.state === "error" ? "unavailable" : "…";
}

function AlsoGiven({ projectKey }: { projectKey: string }) {
  const [summary] = useLoad(() => setup.project(projectKey), [projectKey]);
  const [skills] = useLoad(
    () => setup.skills(projectKey).then((d) => d.skills.length),
    [projectKey],
  );
  const [commands] = useLoad(
    () =>
      setup
        .commands(projectKey)
        .then((d) => d.commands.filter((c) => c.scope === "project").length),
    [projectKey],
  );
  const files = summary.state === "ready" ? summary.data.workingSet.files : null;
  return (
    <section className="card setup-stack" aria-label="Also given to agents">
      <h2 className="label">Also given to agents</h2>
      <a className="setup-link" href={projectHref(projectKey, "working-set")}>
        <span>Working set</span>
        <span className="mono muted">
          {files
            ? `${files.length} files · ${kb(files.reduce((sum, f) => sum + f.bytes, 0))}`
            : "…"}
        </span>
      </a>
      <div className="setup-link">
        <span>
          Skills in <span className="mono">baked/skills</span>
        </span>
        <span className="mono muted">{countText(skills)}</span>
      </div>
      <div className="setup-link">
        <span>
          Commands in <span className="mono">.baked/commands</span>
        </span>
        <span className="mono muted">{countText(commands)}</span>
      </div>
    </section>
  );
}

/** What an older backend still tells: the manifest's instruction files, by name. */
function FromSummary({ projectKey }: { projectKey: string }) {
  const [summary] = useLoad(() => setup.project(projectKey), [projectKey]);
  if (summary.state !== "ready") return <LoadState value={summary} what="instruction files" />;
  const { files, skipped } = summary.data.instructions;
  return (
    <>
      <NeedsNewer what="or edit every instruction file" />
      {files.length > 0 && (
        <ul className="card setup-list setup-flush">
          {files.map((path) => (
            <li key={path} className="setup-line">
              <span className="mono setup-grow">{path}</span>
              <span className="muted">listed in baked/project.json</span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && <div className="banner">Left out: {skipped.join(", ")}</div>}
    </>
  );
}

export function InstructionsSection({ project }: SectionProps) {
  const key = project.key;
  const [list, , setList] = useLoad(() => setup.instructions(key), [key]);
  const [runs] = useLoad(() => api.runs(key, 50), [key]);
  const [selected, setSelected] = useState<string | null>(null);
  const activeRuns =
    runs.state === "ready" ? runs.data.items.filter((r) => ACTIVE.has(r.status)).length : 0;

  const intro = (
    <p className="lede">
      Every chat and every workflow agent in this project reads these, in this order. A run freezes
      them at start; editing one later asks you to approve the run again.
    </p>
  );
  if (list.state === "missing")
    return (
      <div className="setup">
        {intro}
        <FromSummary projectKey={key} />
        <AlsoGiven projectKey={key} />
      </div>
    );
  if (list.state !== "ready") return <LoadState value={list} what="instruction files" />;
  const files = list.data.files;
  const current =
    files.find((f) => f.absolutePath === selected) ??
    files.find((f) => f.scope === "project") ??
    files[0];

  return (
    <div className="setup">
      {intro}
      <div className="setup-split">
        <div className="setup-section">
          {files.length === 0 ? (
            <div className="empty">
              No instruction files. Add <span className="mono">baked.md</span> or{" "}
              <span className="mono">AGENTS.md</span> at the repository root, or list files in{" "}
              <span className="mono">baked/project.json</span>.
            </div>
          ) : (
            <ol className="card setup-list setup-flush">
              {files.map((file) => (
                <li key={file.absolutePath}>
                  <button
                    type="button"
                    className="setup-gate"
                    aria-pressed={file === current}
                    onClick={() => setSelected(file.absolutePath)}
                  >
                    <span className="mono muted setup-mark">{file.order}</span>
                    <span className="setup-grow stack">
                      <span className="mono">{file.path}</span>
                      <span className="muted setup-note">{instructionOrigin(file)}</span>
                    </span>
                    <span className="mono muted">{kb(file.bytes)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <span className="muted setup-note">
            {kb(list.data.promptBytes)} of instructions in every agent's prompt. Which file kinds
            are read (baked.md, AGENTS.md, CLAUDE.md, …) is set with{" "}
            <span className="mono">instructionFiles</span> in config.
          </span>
          <AlsoGiven projectKey={key} />
        </div>
        <div className="setup-side setup-wide">
          {current && (
            <Editor
              key={current.absolutePath}
              projectKey={key}
              file={current}
              activeRuns={activeRuns}
              onSaved={(saved) =>
                setList({
                  ...list.data,
                  files: files.map((f) => (f.absolutePath === saved.absolutePath ? saved : f)),
                })
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

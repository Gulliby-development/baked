import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { ApiError, api } from "../../client/api.js";
import {
  type InstructionFile,
  isMissingEndpoint,
  type SavedInstruction,
  setup,
} from "../../client/setup.js";
import { workflow } from "../../client/workflow.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { frozenRunState, instructionOrigin, kb } from "./logic.js";
import {
  errorText,
  FLUSH,
  FORM,
  GATE,
  GROW,
  H,
  LINE,
  LIST,
  type Loaded,
  LoadState,
  MARK,
  NeedsNewer,
  NOTE,
  OK,
  ROW,
  SETUP,
  SPLIT,
  SPLIT_MAIN,
  STACK,
  Tag,
  useLoad,
  WARN,
} from "./shared.js";

const LINK =
  "flex justify-between gap-3 px-0 py-[6px] text-[13px] text-soft-foreground no-underline";

const ACTIVE = new Set(["created", "running", "waiting", "paused", "blocked"]);

function saveNote(activeRuns: number): string {
  if (activeRuns === 0)
    return "A run freezes these files when it starts. If one changes later, the run stops at its next step and needs its plan revised before it resumes.";
  const them = activeRuns === 1 ? "it" : "them";
  return `${activeRuns} active run${activeRuns === 1 ? "" : "s"} may have frozen this file. Saving does not pause ${them}: a run that is driving stops at its next step as blocked (input changed), and a waiting or paused run cannot resume until its plan is revised.`;
}

function Editor({
  projectKey,
  file,
  activeRuns,
  onSaved,
}: {
  projectKey: string;
  file: InstructionFile;
  activeRuns: number;
  onSaved: (file: SavedInstruction) => void;
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
    <section className={`card ${FORM}`} aria-label={file.path}>
      <div className={ROW}>
        <span className={`mono ${H}`}>{file.path}</span>
        <Tag>{file.scope === "global" ? "every project" : "this project"}</Tag>
        <span className="ml-auto" />
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
        className="mono min-h-[360px] w-full resize-y rounded-base border-2 border-border bg-[var(--bg-code)] p-3 font-sans text-[13px] leading-[1.55] text-foreground"
        rows={22}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />
      {error && <div className="banner error">{error}</div>}
      <span className={activeRuns > 0 && dirty ? `${WARN} ${NOTE}` : `muted ${NOTE}`}>
        {saveNote(activeRuns)}
        {saved && !dirty ? " Saved." : ""}
      </span>
    </section>
  );
}

type Revision = { kind: "busy" } | { kind: "done" } | { kind: "error"; message: string };

/**
 * Runs that froze an instruction file that has since changed: the ones the last saves reported,
 * and any run blocked with `input_changed`. Each can get a revised plan that adopts the current
 * files (`candidate`, then `revise`); the plan then waits for approval like a new one.
 */
function FrozenRuns({
  projectKey,
  runs,
  affected,
  unreported,
  onChanged,
}: {
  projectKey: string;
  runs: RunSnapshot[];
  affected: string[];
  /** True when a save went to a backend that does not report the runs that froze the file. */
  unreported: boolean;
  onChanged: () => void;
}) {
  const [revisions, setRevisions] = useState<Record<string, Revision>>({});
  const blocked = runs
    .filter((r) => r.status === "blocked" && r.reason === "input_changed")
    .map((r) => r.runId);
  const ids = [...new Set([...affected, ...blocked])];
  if (ids.length === 0 && !unreported) return null;

  const revise = async (runId: string): Promise<void> => {
    setRevisions((r) => ({ ...r, [runId]: { kind: "busy" } }));
    try {
      const current = await workflow.status(projectKey, runId);
      const { candidateHash } = await workflow.candidate(projectKey, runId);
      await workflow.revise(projectKey, current, candidateHash);
      setRevisions((r) => ({ ...r, [runId]: { kind: "done" } }));
      onChanged();
    } catch (e) {
      const message = isMissingEndpoint(e)
        ? `Revising a plan from the app needs a newer BAKED. Run baked workflow candidate ${runId}, then baked workflow revise ${runId} --candidate HASH.`
        : errorText(e);
      setRevisions((r) => ({ ...r, [runId]: { kind: "error", message } }));
    }
  };

  return (
    <section className={`card ${STACK}`} aria-labelledby="frozen-runs">
      <div className={ROW}>
        <h2 id="frozen-runs" className={`label ${GROW}`}>
          Runs that froze an earlier version
        </h2>
        <button type="button" className="btn" onClick={onChanged}>
          Refresh
        </button>
      </div>
      {unreported && (
        <span className={`muted ${NOTE}`}>
          This BAKED does not report which runs froze a saved file; check your active runs.
        </span>
      )}
      {ids.length > 0 && (
        <ul className={LIST}>
          {ids.map((runId) => {
            const run = runs.find((r) => r.runId === runId);
            const state = run
              ? frozenRunState(run)
              : { text: "not among the recent runs", canRevise: false };
            const revision = revisions[runId];
            return (
              <li key={runId} className={STACK}>
                <div className={LINE}>
                  <a className="mono" href={projectHref(projectKey, "runs", runId)}>
                    {runId}
                  </a>
                  <span className={`muted ${GROW}`}>
                    {revision?.kind === "done" ? "plan revised; waiting for approval" : state.text}
                  </span>
                  {state.canRevise && revision?.kind !== "done" && (
                    <button
                      type="button"
                      className="btn"
                      disabled={revision?.kind === "busy"}
                      onClick={() => void revise(runId)}
                    >
                      Revise plan
                    </button>
                  )}
                </div>
                {revision?.kind === "done" && (
                  <span className={`${NOTE} ${OK}`}>
                    Plan revised to the current files. Approve it under Needs you or on the run
                    page; the run resumes after that.
                  </span>
                )}
                {revision?.kind === "error" && (
                  <div className="banner error">{revision.message}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function countText(value: Loaded<string>): string {
  if (value.state === "ready") return value.data;
  if (value.state === "missing") return "needs a newer BAKED";
  return value.state === "error" ? "unavailable" : "…";
}

function scopeCounts(items: { scope: "project" | "global" }[]): string {
  const project = items.filter((i) => i.scope === "project").length;
  return `${project} in this project · ${items.length - project} global`;
}

function AlsoGiven({ projectKey }: { projectKey: string }) {
  const [summary] = useLoad(() => setup.project(projectKey), [projectKey]);
  const [skills] = useLoad(
    () => setup.skills(projectKey).then((d) => scopeCounts(d.skills)),
    [projectKey],
  );
  const [commands] = useLoad(
    () => setup.commands(projectKey).then((d) => scopeCounts(d.commands)),
    [projectKey],
  );
  const files = summary.state === "ready" ? summary.data.workingSet.files : null;
  return (
    <section className={`card ${STACK}`} aria-label="Also given to agents">
      <h2 className="label">Also given to agents</h2>
      <a className={`${LINK} hover:text-foreground`} href={projectHref(projectKey, "working-set")}>
        <span>Working set</span>
        <span className="mono muted">
          {files
            ? `${files.length} files · ${kb(files.reduce((sum, f) => sum + f.bytes, 0))}`
            : "…"}
        </span>
      </a>
      <div className={LINK}>
        <span>
          Skills in <span className="mono">.baked</span>, <span className="mono">.agents</span>,{" "}
          <span className="mono">.claude</span>
        </span>
        <span className="mono muted">{countText(skills)}</span>
      </div>
      <div className={LINK}>
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
        <ul className={`card ${LIST} ${FLUSH}`}>
          {files.map((path) => (
            <li key={path} className={LINE}>
              <span className={`mono ${GROW}`}>{path}</span>
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
  const [runs, reloadRuns] = useLoad(() => api.runs(key, 50), [key]);
  const [selected, setSelected] = useState<string | null>(null);
  const [affected, setAffected] = useState<string[]>([]);
  const [unreported, setUnreported] = useState(false);
  const runItems = runs.state === "ready" ? runs.data.items : [];
  const activeRuns = runItems.filter((r) => ACTIVE.has(r.status)).length;

  const intro = (
    <p className="lede">
      Every chat and every workflow agent in this project reads these, in this order. A run freezes
      them when it starts; after a change it stops at its next step until its plan is revised.
    </p>
  );
  if (list.state === "missing")
    return (
      <div className={SETUP}>
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
    <div className={SETUP}>
      {intro}
      <FrozenRuns
        projectKey={key}
        runs={runItems}
        affected={affected}
        unreported={unreported}
        onChanged={reloadRuns}
      />
      <div className={SPLIT}>
        <div className={SPLIT_MAIN}>
          {files.length === 0 ? (
            <div className="empty">
              No instruction files. Add <span className="mono">baked.md</span> or{" "}
              <span className="mono">AGENTS.md</span> at the repository root, or list files in{" "}
              <span className="mono">baked/project.json</span>.
            </div>
          ) : (
            <ol className={`card ${LIST} ${FLUSH}`}>
              {files.map((file) => (
                <li key={file.absolutePath}>
                  <button
                    type="button"
                    className={GATE}
                    aria-pressed={file === current}
                    onClick={() => setSelected(file.absolutePath)}
                  >
                    <span className={`mono muted ${MARK}`}>{file.order}</span>
                    <span className={`${GROW} stack`}>
                      <span className="mono">{file.path}</span>
                      <span className={`muted ${NOTE}`}>{instructionOrigin(file)}</span>
                    </span>
                    <span className="mono muted">{kb(file.bytes)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <span className={`muted ${NOTE}`}>
            {kb(list.data.promptBytes)} of instructions in every agent's prompt. Which file kinds
            are read (baked.md, AGENTS.md, CLAUDE.md, …) is set with{" "}
            <span className="mono">instructionFiles</span> in config.
          </span>
          <AlsoGiven projectKey={key} />
        </div>
        <div className="min-w-0 flex-[1_1_480px]">
          {current && (
            <Editor
              key={current.absolutePath}
              projectKey={key}
              file={current}
              activeRuns={activeRuns}
              onSaved={({ affectedRuns, ...saved }) => {
                setList({
                  ...list.data,
                  files: files.map((f) => (f.absolutePath === saved.absolutePath ? saved : f)),
                });
                if (affectedRuns) setAffected((ids) => [...new Set([...ids, ...affectedRuns])]);
                else if (activeRuns > 0) setUnreported(true);
                reloadRuns();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

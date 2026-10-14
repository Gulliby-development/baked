import { useState } from "react";
import type { RunSnapshot } from "../../../shared/api.js";
import { ApiError, api } from "../../client/api.js";
import {
  type InstructionFile,
  type InstructionList,
  type InstructionSource,
  isMissingEndpoint,
  type SavedInstruction,
  setup,
} from "../../client/setup.js";
import { workflow } from "../../client/workflow.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Empty } from "../../components/ui/empty.js";
import { Switch } from "../../components/ui/switch.js";
import { cn } from "../../lib/cn.js";
import { STACK as COLUMN, LABEL, LEDE, PANEL } from "../../lib/styles.js";
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
  onDiscard,
}: {
  projectKey: string;
  file: InstructionFile;
  activeRuns: number;
  onSaved: (file: SavedInstruction) => void;
  /** Drops a file that is not saved yet. */
  onDiscard?: () => void;
}) {
  const [text, setText] = useState(file.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isNew = file.hash === "";
  const dirty = text !== file.content || (isNew && text.trim() !== "");
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await setup.saveInstruction(
          projectKey,
          file.path,
          text,
          file.hash === "" ? null : file.hash,
        ),
      );
      setSaved(true);
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "INPUT_CHANGED"
          ? isNew
            ? `${file.path} was created meanwhile. Reload to see it; your text is still in the box.`
            : `${file.path} changed on disk since it was opened. Reload to see the new version; your edits are still in the box.`
          : errorText(e),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={cn(PANEL, FORM)} aria-label={file.path}>
      <div className={ROW}>
        <span className={`font-mono ${H}`}>{file.path}</span>
        <Tag>{file.scope === "global" ? "every project" : "this project"}</Tag>
        {isNew && <Tag>new</Tag>}
        {file.enabled === false && <Tag>off</Tag>}
        <span className="ml-auto" />
        {onDiscard ? (
          <Button variant="secondary" size="md" disabled={busy} onClick={onDiscard}>
            Discard
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="md"
            disabled={!dirty || busy}
            onClick={() => {
              setText(file.content);
              setSaved(false);
            }}
          >
            Revert
          </Button>
        )}
        <Button variant="primary" size="md" disabled={!dirty || busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
      <label htmlFor="instruction-text" className="sr-only">
        {file.path} contents
      </label>
      <textarea
        id="instruction-text"
        className="min-h-[360px] w-full resize-y rounded-base border-2 border-border bg-[var(--bg-code)] p-3 font-sans text-[13px] leading-[1.55] text-foreground"
        rows={22}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
        }}
      />
      {error && <Alert tone="error">{error}</Alert>}
      {file.enabled === false && (
        <span className={`${WARN} ${NOTE}`}>
          Agents do not read this file: {file.sourceLabel ?? "its source"} is switched off below.
        </span>
      )}
      <span className={activeRuns > 0 && dirty ? `${WARN} ${NOTE}` : `text-dim-foreground ${NOTE}`}>
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
    <section className={cn(PANEL, STACK)} aria-labelledby="frozen-runs">
      <div className={ROW}>
        <h2 id="frozen-runs" className={`${LABEL} ${GROW}`}>
          Runs that froze an earlier version
        </h2>
        <Button variant="secondary" size="md" onClick={onChanged}>
          Refresh
        </Button>
      </div>
      {unreported && (
        <span className={`text-dim-foreground ${NOTE}`}>
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
                  <a className="font-mono" href={projectHref(projectKey, "runs", runId)}>
                    {runId}
                  </a>
                  <span className={`text-dim-foreground ${GROW}`}>
                    {revision?.kind === "done" ? "plan revised; waiting for approval" : state.text}
                  </span>
                  {state.canRevise && revision?.kind !== "done" && (
                    <Button
                      variant="secondary"
                      size="md"
                      disabled={revision?.kind === "busy"}
                      onClick={() => void revise(runId)}
                    >
                      Revise plan
                    </Button>
                  )}
                </div>
                {revision?.kind === "done" && (
                  <span className={`${NOTE} ${OK}`}>
                    Plan revised to the current files. Approve it under Needs you or on the run
                    page; the run resumes after that.
                  </span>
                )}
                {revision?.kind === "error" && <Alert tone="error">{revision.message}</Alert>}
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

function scopeCounts(items: { scope: "project" | "global" | "package" }[]): string {
  const count = (scope: string) => items.filter((i) => i.scope === scope).length;
  const packaged = count("package");
  return `${count("project")} in this project · ${count("global")} global${packaged ? ` · ${packaged} from packages` : ""}`;
}

/** The rest of an agent's project setup; the working set is the Files tab next to this one. */
function AlsoGiven({ projectKey }: { projectKey: string }) {
  const [skills] = useLoad(
    () => setup.skills(projectKey).then((d) => scopeCounts(d.skills)),
    [projectKey, "skill-counts"],
  );
  const [commands] = useLoad(
    () => setup.commands(projectKey).then((d) => scopeCounts(d.commands)),
    [projectKey, "command-counts"],
  );
  return (
    <section className={cn(PANEL, STACK)} aria-label="Also given to agents">
      <h2 className={LABEL}>Also given to agents</h2>
      <a className={`${LINK} hover:text-foreground`} href={projectHref(projectKey, "skills")}>
        <span>
          Skills in <span className="font-mono">.baked</span>,{" "}
          <span className="font-mono">.agents</span>, <span className="font-mono">.claude</span>
        </span>
        <span className="font-mono text-dim-foreground">{countText(skills)}</span>
      </a>
      <div className={LINK}>
        <span>
          Commands in <span className="font-mono">.baked/commands</span>
        </span>
        <span className="font-mono text-dim-foreground">{countText(commands)}</span>
      </div>
    </section>
  );
}

/** What an older backend still tells: the manifest's instruction files, by name. */
function FromSummary({ projectKey }: { projectKey: string }) {
  const [summary] = useLoad(() => setup.project(projectKey), [projectKey, "project"]);
  if (summary.state !== "ready") return <LoadState value={summary} what="instruction files" />;
  const { files, skipped } = summary.data.instructions;
  return (
    <>
      <NeedsNewer what="or edit every instruction file" />
      {files.length > 0 && (
        <ul className={cn(PANEL, LIST, FLUSH)}>
          {files.map((path) => (
            <li key={path} className={LINE}>
              <span className={`font-mono ${GROW}`}>{path}</span>
              <span className="text-dim-foreground">listed in baked/project.json</span>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && <Alert>Left out: {skipped.join(", ")}</Alert>}
    </>
  );
}

/** Starter text of a file created from the empty state. */
const STARTER = "# Instructions for agents\n\n";

/** A file the editor creates on save (`expectedHash: null`); its hash is empty until then. */
function draftFile(path: string, source: string, label: string): InstructionFile {
  return {
    order: null,
    path,
    absolutePath: path,
    source,
    sourceLabel: label,
    scope: "project",
    enabled: true,
    bytes: 0,
    hash: "",
    content: STARTER,
  };
}

/** One switch per instruction source; files of a switched-off source stay listed but unread. */
function Sources({
  list,
  busy,
  onToggle,
}: {
  list: InstructionList;
  busy: string | null;
  onToggle: (source: InstructionSource, enabled: boolean) => void;
}) {
  if (!list.sources) return null;
  return (
    <section className={cn(PANEL, STACK)} aria-labelledby="instruction-sources">
      <h2 id="instruction-sources" className={LABEL}>
        Sources agents read
      </h2>
      <ul className={LIST}>
        {list.sources.map((source) => {
          const found = list.files.filter((f) => f.source === source.id).length;
          const id = `source-${source.id}`;
          return (
            <li key={source.id} className={LINE}>
              <Switch
                id={id}
                checked={source.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) => onToggle(source, checked)}
              />
              <label htmlFor={id} className={`${GROW} ${COLUMN}`}>
                <span className="font-mono">{source.label}</span>
                <span className={`text-dim-foreground ${NOTE}`}>{source.files.join(", ")}</span>
              </label>
              <span className="text-dim-foreground">
                {found === 0 ? "no file" : found === 1 ? "1 file" : `${found} files`}
              </span>
            </li>
          );
        })}
      </ul>
      <span className={`text-dim-foreground ${NOTE}`}>
        Saved as <span className="font-mono">instructionFiles</span> in the{" "}
        {list.sourcesScope === "global" ? "global" : "project"} config. A run started earlier keeps
        the files it froze.
      </span>
    </section>
  );
}

/** The Rules tab of the Agent context screen: instruction files, their sources and an editor. */
export function InstructionsPane({ project }: Pick<SectionProps, "project">) {
  const key = project.key;
  const [list, reloadList, setList] = useLoad(() => setup.instructions(key), [key, "instructions"]);
  const [runs, reloadRuns] = useLoad(() => api.runs(key, 50), [key, "runs", 50]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<InstructionFile | null>(null);
  const [affected, setAffected] = useState<string[]>([]);
  const [unreported, setUnreported] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const runItems = runs.state === "ready" ? runs.data.items : [];
  const activeRuns = runItems.filter((r) => ACTIVE.has(r.status)).length;

  const intro = (
    <p className={LEDE}>
      Agents read these files in this order. After a change, a run that froze them stops at its next
      step until its plan is revised.
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
    draft ??
    files.find((f) => f.absolutePath === selected) ??
    files.find((f) => f.scope === "project" && f.enabled !== false) ??
    files[0];

  const toggle = async (source: InstructionSource, enabled: boolean): Promise<boolean> => {
    setSwitching(source.id);
    setSwitchError(null);
    try {
      setList(await setup.setInstructionSource(key, source.id, enabled));
      return true;
    } catch (e) {
      setSwitchError(
        isMissingEndpoint(e)
          ? "Switching sources from the app needs a newer BAKED; use /instructions in the terminal."
          : errorText(e),
      );
      return false;
    } finally {
      setSwitching(null);
    }
  };

  /** Opens the editor on a new file, switching its source on so agents read it once saved. */
  const create = async (path: string, sourceId: string): Promise<void> => {
    const source = list.data.sources?.find((s) => s.id === sourceId);
    if (source && !source.enabled && !(await toggle(source, true))) return;
    setDraft(draftFile(path, sourceId, source?.label ?? path));
  };

  const canCreate = list.data.sources !== undefined;
  // The AGENTS.md source is off by default, so the empty state must not promise it is read.
  const agentsMdOff = list.data.sources?.find((s) => s.id === "codex")?.enabled === false;
  const fileList =
    files.length === 0 && !draft ? (
      <Empty className={STACK}>
        {agentsMdOff ? (
          <span>
            No instruction files. Agents read <span className="font-mono">baked.md</span> at the
            repository root and files listed in{" "}
            <span className="font-mono">baked/project.json</span>;{" "}
            <span className="font-mono">AGENTS.md</span> is read once its source is switched on.
          </span>
        ) : (
          <span>
            No instruction files. Agents read <span className="font-mono">AGENTS.md</span> or{" "}
            <span className="font-mono">baked.md</span> at the repository root, and files listed in{" "}
            <span className="font-mono">baked/project.json</span>.
          </span>
        )}
        {canCreate && (
          <span className="flex flex-wrap justify-center gap-2">
            <Button
              variant="primary"
              size="md"
              disabled={switching !== null}
              onClick={() => void create("AGENTS.md", "codex")}
            >
              Create AGENTS.md
            </Button>
            <Button
              variant="secondary"
              size="md"
              disabled={switching !== null}
              onClick={() => void create("baked.md", "baked")}
            >
              Create baked.md
            </Button>
          </span>
        )}
      </Empty>
    ) : (
      <ol className={cn(PANEL, LIST, FLUSH)}>
        {draft && (
          <li>
            <button type="button" className={GATE} aria-pressed>
              <span className={`font-mono text-dim-foreground ${MARK}`}>+</span>
              <span className={`${GROW} font-mono`}>{draft.path}</span>
              <span className="text-dim-foreground">not saved yet</span>
            </button>
          </li>
        )}
        {files.map((file) => (
          <li key={file.absolutePath}>
            <button
              type="button"
              className={cn(GATE, file.enabled === false && "opacity-60")}
              aria-pressed={file === current}
              onClick={() => {
                setDraft(null);
                setSelected(file.absolutePath);
              }}
            >
              <span className={`font-mono text-dim-foreground ${MARK}`}>{file.order ?? "–"}</span>
              <span className={`${GROW} ${COLUMN}`}>
                <span className="font-mono">{file.path}</span>
                <span className={`text-dim-foreground ${NOTE}`}>
                  {file.enabled === false
                    ? `off: ${file.sourceLabel ?? file.source} is switched off`
                    : instructionOrigin(file)}
                </span>
              </span>
              <span className="font-mono text-dim-foreground">{kb(file.bytes)}</span>
            </button>
          </li>
        ))}
      </ol>
    );

  const side = (
    <>
      {!list.data.sources && (
        <span className={`text-dim-foreground ${NOTE}`}>
          Which file kinds are read (baked.md, AGENTS.md, CLAUDE.md, …) is set with{" "}
          <span className="font-mono">instructionFiles</span> in config.
        </span>
      )}
      {switchError && <Alert tone="error">{switchError}</Alert>}
      <Sources list={list.data} busy={switching} onToggle={(s, on) => void toggle(s, on)} />
      <AlsoGiven projectKey={key} />
    </>
  );

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
      {current ? (
        <div className={SPLIT}>
          <div className={SPLIT_MAIN}>
            {fileList}
            {side}
          </div>
          <div className="min-w-0 flex-[1_1_480px]">
            <Editor
              key={draft ? `new:${draft.path}` : current.absolutePath}
              projectKey={key}
              file={current}
              activeRuns={activeRuns}
              {...(draft ? { onDiscard: () => setDraft(null) } : {})}
              onSaved={({ affectedRuns, ...saved }) => {
                if (draft) {
                  setDraft(null);
                  setSelected(saved.absolutePath);
                  reloadList();
                } else
                  setList({
                    ...list.data,
                    files: files.map((f) => (f.absolutePath === saved.absolutePath ? saved : f)),
                  });
                if (affectedRuns) setAffected((ids) => [...new Set([...ids, ...affectedRuns])]);
                else if (activeRuns > 0) setUnreported(true);
                reloadRuns();
              }}
            />
          </div>
        </div>
      ) : (
        // Without files there is no editor column: the list and its panels take the full width.
        <div className={STACK}>
          {fileList}
          {side}
        </div>
      )}
    </div>
  );
}

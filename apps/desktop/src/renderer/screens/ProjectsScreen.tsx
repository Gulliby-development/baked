import { useState } from "react";
import { PROJECT_NAME_MAX } from "../../../../../src/core/projects/new-project.js";
import type { AttentionItem, DesktopProject } from "../../shared/api.js";
import { attentionTitle } from "../../shared/attention.js";
import type { ProjectAction } from "../../shared/bridge.js";
import { bridge } from "../client/bridge.js";
import { CreateProjectDialog } from "../components/CreateProjectDialog.js";
import { Alert } from "../components/ui/alert.js";
import { Button, buttonVariants } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Empty } from "../components/ui/empty.js";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { ago, backendLabel, initial } from "../format.js";
import { cn } from "../lib/cn.js";
import { LEDE, PAGE, PANEL, STACK, SUB_LINE } from "../lib/styles.js";
import { href, projectHref } from "../router.js";
import { useDesktop } from "../store.js";

const STATE_TONE = {
  ok: "text-[var(--info)]",
  warn: "text-[var(--warn)]",
  err: "text-[var(--err)]",
  muted: "text-dim-foreground",
} as const;

const ACTIONS = "flex flex-wrap items-center gap-2";

/** The state line in a card's corner: closed, starting, open, or how many items wait. */
export function projectState(
  project: DesktopProject,
  waiting: number,
): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  if (!project.exists) return { text: "folder missing", tone: "err" };
  if (!project.open) return { text: "closed", tone: "muted" };
  if (project.backend.kind === "failed") return { text: "open · backend stopped", tone: "err" };
  if (project.backend.kind !== "running")
    return { text: `open · ${backendLabel(project.backend).text}`, tone: "muted" };
  if (waiting > 0) return { text: `open · ${waiting} need you`, tone: "warn" };
  return { text: "open · in background", tone: "ok" };
}

export function matchesProject(project: DesktopProject, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [project.name, project.path, project.branch ?? ""].some((v) =>
    v.toLowerCase().includes(q),
  );
}

/** The rename form: an empty name restores the manifest or folder name. */
function RenameProject({
  project,
  onRename,
  onDone,
}: {
  project: DesktopProject;
  onRename: (name: string) => Promise<void>;
  onDone: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooLong = name.trim().length > PROJECT_NAME_MAX;
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onRename(name);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!tooLong) void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename project</DialogTitle>
        <DialogDescription>
          How BAKED shows <span className="font-mono">{project.path}</span> in every app. An empty
          name restores the folder or manifest name.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-rename">Name</Label>
        <Input
          id="project-rename"
          value={name}
          maxLength={PROJECT_NAME_MAX + 40}
          aria-invalid={tooLong || undefined}
          disabled={busy}
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        {tooLong && (
          <span className="text-[12px] text-[var(--err)]">
            At most {PROJECT_NAME_MAX} characters.
          </span>
        )}
      </div>
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}
      <div className={ACTIONS}>
        <Button type="submit" variant="primary" size="md" disabled={busy || tooLong}>
          Rename
        </Button>
        <Button type="button" variant="secondary" size="md" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Card({
  project,
  items,
  onAction,
  onRename,
  busy,
}: {
  project: DesktopProject;
  items: AttentionItem[];
  onAction: (action: ProjectAction) => void;
  onRename: (name: string) => Promise<void>;
  busy: boolean;
}) {
  const { open, close, restart } = useDesktop();
  const [confirmForget, setConfirmForget] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const { overview } = project;
  const waiting = project.open ? items.length : overview.attention;
  const state = projectState(project, waiting);
  return (
    <article
      className={cn(
        PANEL,
        "group flex min-w-0 flex-col gap-3 px-[18px] py-4 data-open:border-border data-open:bg-selected",
      )}
      aria-label={project.name}
      data-open={project.open || undefined}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 flex-none items-center justify-center rounded-[9px] border-2 border-border bg-fill-info font-mono text-[14px] font-medium text-[var(--bg)] group-data-open:bg-[var(--accent)]">
          {initial(project.name)}
        </span>
        <div className={STACK}>
          <h2 className="m-0 text-[16px] font-semibold">
            {project.open ? (
              <a
                className="text-foreground no-underline hover:text-[var(--accent-soft)]"
                href={projectHref(project.key)}
              >
                {project.name}
              </a>
            ) : (
              project.name
            )}
          </h2>
          <span className={SUB_LINE} title={project.path}>
            {project.path}
            {project.branch ? ` · ${project.branch}` : ""}
          </span>
        </div>
        <span className={`ml-auto flex-none text-[12px] ${STATE_TONE[state.tone]}`}>
          {state.text}
        </span>
      </div>
      <div className="flex flex-col gap-[6px] text-[13px] text-muted-foreground">
        <span>
          {overview.sessions} {overview.sessions === 1 ? "session" : "sessions"}
          {overview.lastSessionAt ? ` · last ${ago(overview.lastSessionAt)}` : ""}
        </span>
        {items.slice(0, 2).map((item) => (
          <span key={`${item.requestId}:${item.kind}`}>
            <span style={{ color: "var(--warn)" }} aria-hidden="true">
              ⚑{" "}
            </span>
            {attentionTitle(item)}
          </span>
        ))}
        <span>
          {overview.activeRuns > 0
            ? `${overview.activeRuns} active ${overview.activeRuns === 1 ? "run" : "runs"}`
            : "No active runs"}
        </span>
        {!project.open && project.exists && (
          <span className="text-dim-foreground">
            Opening starts its backend and language servers
          </span>
        )}
      </div>
      {project.backend.kind === "failed" && (
        <Alert tone="error" className="whitespace-pre-wrap font-mono text-[12px]">
          {project.backend.stderr.slice(-5).join("\n") || project.backend.lastError}
        </Alert>
      )}
      {confirmForget ? (
        <fieldset
          className={`${ACTIONS} mx-0 mt-auto mb-0 min-w-0 border-0 p-0`}
          aria-label={`Forget ${project.name}?`}
        >
          <span className="basis-full text-[13px] text-muted-foreground">
            Remove it from the list? Its sessions and runs stay in the folder.
          </span>
          <Button variant="secondary" size="md" disabled={busy} onClick={() => onAction("forget")}>
            Forget
          </Button>
          <Button variant="secondary" size="md" onClick={() => setConfirmForget(false)}>
            Keep
          </Button>
        </fieldset>
      ) : (
        <div className={`${ACTIONS} mt-auto`}>
          {project.open ? (
            <>
              <a
                className={buttonVariants({ variant: "primary", size: "md" })}
                href={projectHref(project.key)}
              >
                Go to project
              </a>
              {items.length > 0 && (
                <a
                  className={buttonVariants({ variant: "secondary", size: "md" })}
                  href={href({ name: "attention" })}
                >
                  Answer
                </a>
              )}
              {project.backend.kind === "failed" && (
                <Button variant="secondary" size="md" onClick={() => void restart(project.key)}>
                  Restart
                </Button>
              )}
              <Button variant="secondary" size="md" onClick={() => void close(project.key)}>
                Close
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="md"
                disabled={!project.exists}
                onClick={() =>
                  void open(project.key).then(() => {
                    window.location.hash = projectHref(project.key);
                  })
                }
              >
                Open
              </Button>
              <Button variant="secondary" size="md" onClick={() => setConfirmForget(true)}>
                Forget
              </Button>
            </>
          )}
          <Button
            variant="secondary"
            size="md"
            className="ml-auto"
            aria-label={`Rename ${project.name}`}
            disabled={busy}
            onClick={() => setRenaming(true)}
          >
            Rename…
          </Button>
          <Button
            variant="secondary"
            size="md"
            className="aria-pressed:text-[var(--accent-soft)]"
            aria-pressed={project.pinned}
            aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
            disabled={busy}
            onClick={() => onAction(project.pinned ? "unpin" : "pin")}
          >
            {project.pinned ? "★ Pinned" : "☆ Pin"}
          </Button>
        </div>
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="w-[min(480px,calc(100vw-48px))]">
          {renaming && (
            <RenameProject
              project={project}
              onRename={onRename}
              onDone={() => setRenaming(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function ProjectsScreen() {
  const { projects, attention, addFolder, refresh } = useDesktop();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = projects.filter((p) => matchesProject(p, query));
  const act = async (key: string, action: ProjectAction): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await bridge.manageProject(key, action);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className={PAGE}>
      <header className="flex flex-wrap items-center gap-[10px]">
        <h1 className="mr-auto">All projects</h1>
        <label htmlFor="proj-search" className="sr-only">
          Find a project
        </label>
        <input
          id="proj-search"
          type="search"
          className="min-h-[38px] w-[240px] max-w-full rounded-base border-2 border-border bg-background px-3 text-foreground [font-family:inherit] [font-size:inherit] [font-weight:inherit] [line-height:inherit]"
          placeholder="Find a project"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="secondary" size="md" onClick={() => void refresh()}>
          Refresh
        </Button>
        <Button variant="secondary" size="md" onClick={() => void addFolder()}>
          Open existing folder…
        </Button>
        <Button variant="primary" size="md" onClick={() => setCreating(true)}>
          Create project
        </Button>
      </header>
      <CreateProjectDialog open={creating} onOpenChange={setCreating} />
      <p className={LEDE}>
        Every folder you open becomes a project with its own sessions, runs, memory and settings.
        Open projects keep working in the background, each with its own backend; a closed project
        pauses its runs until you open it again.
      </p>
      {error && (
        <Alert tone="error" role="alert">
          {error}
        </Alert>
      )}
      {projects.length === 0 ? (
        <Empty>
          <span className="flex flex-col items-center gap-3">
            No projects yet.
            <span className={ACTIONS}>
              <Button variant="primary" size="md" onClick={() => setCreating(true)}>
                Create project
              </Button>
              <Button variant="secondary" size="md" onClick={() => void addFolder()}>
                Open existing folder…
              </Button>
            </span>
          </span>
        </Empty>
      ) : shown.length === 0 ? (
        <Empty>No project matches “{query}”.</Empty>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(380px,1fr))] gap-4 [@media(max-width:520px)]:grid-cols-[minmax(0,1fr)]">
          {shown.map((project) => (
            <Card
              key={project.key}
              project={project}
              items={attention.filter((i) => i.projectKey === project.key && i.blocking)}
              busy={busy === project.key}
              onAction={(action) => void act(project.key, action)}
              onRename={async (name) => {
                await bridge.renameProject(project.key, name);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

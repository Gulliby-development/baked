import { type ReactNode, useEffect, useState } from "react";
import { type CatalogSkill, type SkillEntry, type SkillScope, setup } from "../../client/setup.js";
import { Alert } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { Input } from "../../components/ui/input.js";
import { Segment, SegmentGroup } from "../../components/ui/segmented.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import {
  ACTIONS,
  errorText,
  GROW,
  LINE,
  LIST,
  LoadState,
  NOTE,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WRAP,
} from "./shared.js";

const SCOPES: [SkillScope, string, string][] = [
  [
    "project",
    "This project",
    "Agents of this project only. Goes into the project folder, so you can commit it with the code.",
  ],
  ["global", "All projects", "Every project on this computer. Goes into your home folder."],
];

const SEARCH_DELAY_MS = 300;
const FOOTER = "flex flex-wrap justify-end gap-2";

type Dialogs =
  | { kind: "view"; skill: SkillEntry }
  | { kind: "remove"; skill: SkillEntry }
  | { kind: "install"; skill: CatalogSkill };

function ViewSkill({ projectKey, skill }: { projectKey: string; skill: SkillEntry }) {
  const [file] = useLoad(
    () => setup.skill(projectKey, skill.scope, skill.id),
    [projectKey, "skill", skill.scope, skill.id],
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>{skill.id}</DialogTitle>
        <DialogDescription>
          <span className="font-mono">{skill.path}</span>
        </DialogDescription>
      </DialogHeader>
      {file.state === "ready" ? (
        <pre className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-base border-2 border-border bg-secondary-background p-3 font-mono text-[12px] wrap-anywhere">
          {file.data.content}
        </pre>
      ) : (
        <LoadState value={file} what="this skill" />
      )}
    </>
  );
}

function InstallSkill({
  skill,
  busy,
  error,
  onInstall,
  onCancel,
}: {
  skill: CatalogSkill;
  busy: boolean;
  error: string | null;
  onInstall: (scope: SkillScope) => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<SkillScope>("project");
  const about = SCOPES.find(([s]) => s === scope)?.[2];
  return (
    <>
      <DialogHeader>
        <DialogTitle>{`Install ${skill.skillId}`}</DialogTitle>
        <DialogDescription>
          From <span className="font-mono">{skill.source}</span> on skills.sh ·{" "}
          {skill.installs.toLocaleString()} installs
        </DialogDescription>
      </DialogHeader>
      <div className={STACK}>
        <span className={LABEL}>Who gets it</span>
        <SegmentGroup aria-label="Install for">
          {SCOPES.map(([value, label]) => (
            <Segment
              key={value}
              aria-pressed={scope === value}
              disabled={busy}
              onClick={() => setScope(value)}
            >
              {label}
            </Segment>
          ))}
        </SegmentGroup>
        <span className={cn("text-muted-foreground", NOTE)}>{about}</span>
      </div>
      {busy && (
        <span className="text-[13px] text-muted-foreground">
          Installing through the skills CLI; this can take up to half a minute…
        </span>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className={FOOTER}>
        <Button variant="secondary" size="md" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="md" disabled={busy} onClick={() => onInstall(scope)}>
          {busy ? "Installing…" : "Install"}
        </Button>
      </div>
    </>
  );
}

function InstalledGroup({
  label,
  about,
  skills,
  onOpen,
}: {
  label: string;
  about: ReactNode;
  skills: SkillEntry[];
  onOpen: (dialog: Dialogs) => void;
}) {
  return (
    <section aria-label={label} className={STACK}>
      <h2 className={LABEL}>
        {label} · {skills.length}
      </h2>
      <span className={cn("text-dim-foreground", NOTE)}>{about}</span>
      {skills.length === 0 ? (
        <Empty className="p-4 text-[13px]">None yet. Find one below.</Empty>
      ) : (
        <ul className={cn(PANEL, LIST, "p-0")}>
          {skills.map((skill) => (
            <li key={`${skill.scope}/${skill.id}`} className={LINE}>
              <span className={cn(GROW, "flex flex-col gap-0.5")}>
                <span className="font-mono font-semibold text-foreground">{skill.id}</span>
                {skill.description && (
                  <span className={cn(WRAP, "text-muted-foreground")}>{skill.description}</span>
                )}
                {skill.package && (
                  <span className={cn(NOTE, "text-dim-foreground")}>
                    From the package <span className="font-mono">{skill.package}</span>
                  </span>
                )}
              </span>
              <span className={ACTIONS}>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => onOpen({ kind: "view", skill })}
                >
                  Open
                </Button>
                {skill.scope !== "package" && (
                  <Button
                    variant="secondary"
                    size="md"
                    aria-label={`Remove ${skill.id}`}
                    onClick={() => onOpen({ kind: "remove", skill })}
                  >
                    Remove
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Catalog({
  projectKey,
  installed,
  onInstall,
}: {
  projectKey: string;
  installed: SkillEntry[];
  onInstall: (skill: CatalogSkill) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const [found] = useLoad(
    () => setup.skillCatalog(projectKey, debounced),
    [projectKey, "skillCatalog", debounced],
  );
  const scopesOf = (skill: CatalogSkill) =>
    installed.filter((s) => s.id === skill.skillId || s.id === skill.name).map((s) => s.scope);

  return (
    <section aria-label="Find skills" className={STACK}>
      <h2 className={LABEL}>Find on skills.sh</h2>
      <Input
        type="search"
        aria-label="Search skills"
        placeholder="Search skills, e.g. pdf, react, testing"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {found.state !== "ready" ? (
        <LoadState value={found} what="the skills catalog" />
      ) : found.data.skills.length === 0 ? (
        <Empty className="p-4 text-[13px]">Nothing matches “{debounced}”.</Empty>
      ) : (
        <>
          {!debounced.trim() && (
            <span className={cn("text-dim-foreground", NOTE)}>Popular skills</span>
          )}
          <ul className={cn(PANEL, LIST, "p-0")}>
            {found.data.skills.map((skill) => {
              const scopes = scopesOf(skill);
              return (
                <li key={skill.id} className={LINE}>
                  <span className={cn(GROW, "flex flex-col gap-0.5")}>
                    <span className="font-mono font-semibold text-foreground">{skill.skillId}</span>
                    <span className="font-mono text-[12px] text-dim-foreground">
                      {skill.source}
                    </span>
                  </span>
                  <span className="font-mono text-[12px] text-dim-foreground">
                    {skill.installs.toLocaleString()} installs
                  </span>
                  {scopes.map((scope) => (
                    <Tag key={scope}>
                      {scope === "project"
                        ? "in this project"
                        : scope === "package"
                          ? "from a package"
                          : "global"}
                    </Tag>
                  ))}
                  <Button variant="primary" size="md" onClick={() => onInstall(skill)}>
                    Install…
                  </Button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Installed project and global skills, and the skills.sh catalog: the same as `/skills` in the
 * terminal, through `/v1/skills*` of the project's backend.
 */
export function SkillsSection({ project }: SectionProps) {
  const [list, , setList] = useLoad(() => setup.skills(project.key), [project.key, "skills"]);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const open = (next: Dialogs) => {
    setError(null);
    setDialog(next);
  };
  const close = () => {
    if (!busy) setDialog(null);
  };
  const act = async (work: () => Promise<{ skills: SkillEntry[] }>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      setList({ skills: (await work()).skills });
      setNotice(done);
      setDialog(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (list.state !== "ready") return <LoadState value={list} what="skills" />;
  const skills = list.data.skills;

  return (
    <div className={SETUP}>
      <p className={LEDE}>
        Skills are folders with a <span className="font-mono">SKILL.md</span> that agents load when
        a task needs them. A project skill with the same name as a global one replaces it here.
        Changes apply to new chats and runs.
      </p>
      {notice && <Alert>{notice}</Alert>}
      <InstalledGroup
        label="In this project"
        about="In .baked/skills, .agents/skills or .claude/skills of this project."
        skills={skills.filter((s) => s.scope === "project")}
        onOpen={open}
      />
      <InstalledGroup
        label="Global"
        about="In the same folders of your home folder; every project gets them."
        skills={skills.filter((s) => s.scope === "global")}
        onOpen={open}
      />
      {skills.some((s) => s.scope === "package") && (
        <InstalledGroup
          label="From packages"
          about={
            <>
              Installed by packages into <span className="font-mono">baked/skills</span>. Workflow
              agents whose profile names them use them; chats do not. They go when you remove the
              package on the{" "}
              <a
                className="underline hover:text-foreground"
                href={projectHref(project.key, "packages")}
              >
                Packages
              </a>{" "}
              screen.
            </>
          }
          skills={skills.filter((s) => s.scope === "package")}
          onOpen={open}
        />
      )}
      <Catalog
        projectKey={project.key}
        installed={skills}
        onInstall={(skill) => open({ kind: "install", skill })}
      />

      <Dialog open={dialog !== null} onOpenChange={(next) => !next && close()}>
        <DialogContent className={dialog?.kind === "view" ? "w-[min(820px,calc(100vw-32px))]" : ""}>
          {dialog?.kind === "view" && <ViewSkill projectKey={project.key} skill={dialog.skill} />}
          {dialog?.kind === "install" && (
            <InstallSkill
              skill={dialog.skill}
              busy={busy}
              error={error}
              onCancel={close}
              onInstall={(scope) =>
                void act(
                  () => setup.installSkill(project.key, dialog.skill, scope),
                  `Installed ${dialog.skill.skillId} ${scope === "project" ? "in this project" : "for all projects"}.`,
                )
              }
            />
          )}
          {dialog?.kind === "remove" && (
            <>
              <DialogHeader>
                <DialogTitle>{`Remove ${dialog.skill.id}?`}</DialogTitle>
                <DialogDescription>
                  Deletes the folder{" "}
                  <span className="font-mono">
                    {dialog.skill.path.replace(/[\\/]SKILL\.md$/, "")}
                  </span>
                  {dialog.skill.scope === "global" ? " for every project." : " from this project."}
                </DialogDescription>
              </DialogHeader>
              {error && <Alert tone="error">{error}</Alert>}
              <div className={FOOTER}>
                <Button variant="secondary" size="md" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  size="md"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      () => setup.removeSkill(project.key, dialog.skill.scope, dialog.skill.id),
                      `Removed ${dialog.skill.id}.`,
                    )
                  }
                >
                  Remove
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

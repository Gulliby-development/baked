import { setup } from "../../client/setup.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { Hint } from "../../components/ui/tooltip.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { InstructionsPane } from "./InstructionsSection.js";
import { kb, WORKING_SET_MAX_BYTES, workingSetBudget } from "./logic.js";
import { LoadState, NOTE, ROW, SETUP, STACK, useLoad, WRAP } from "./shared.js";
import { WorkingSetPane } from "./WorkingSetSection.js";

const TABS = ["rules", "files", "preview"] as const;
type Tab = (typeof TABS)[number];

const RULES_FILL = "bg-[var(--fill-accent)]";
const FILES_FILL = "bg-[var(--fill-info)]";

const SWATCH = "inline-block size-[10px] rounded-[2px] border border-border align-[-1px]";

const BUDGET_HINT =
  "Rules have no size limit: every instruction file agents read goes in whole. The working set sends at most 64 KB of file contents; files past that reach agents by name only.";

function tabOf(id: string | null): Tab {
  return (TABS as readonly string[]).includes(id ?? "") ? (id as Tab) : "rules";
}

/**
 * The bytes both parts add to every agent's prompt, from the same lists the tabs edit, so the
 * meter follows each save.
 */
function Budget({ projectKey }: { projectKey: string }) {
  const [list] = useLoad(() => setup.instructions(projectKey), [projectKey, "instructions"]);
  const [summary] = useLoad(() => setup.project(projectKey), [projectKey, "project"]);
  const rules = list.state === "ready" ? list.data.promptBytes : null;
  const files =
    summary.state === "ready"
      ? workingSetBudget(summary.data.workingSet.files).used
      : summary.state === "no-project"
        ? 0
        : null;
  if (rules === null || files === null) return null;
  // The scale leaves room for a full working set, so the bar shows how much of it is left.
  const scale = Math.max(rules + WORKING_SET_MAX_BYTES, rules + files, 1);
  const width = (bytes: number) => `${(bytes / scale) * 100}%`;
  return (
    <section className={cn(PANEL, "flex flex-col gap-2")} aria-label="Prompt budget">
      <div className={ROW}>
        <span className={cn(LABEL, "flex items-center")}>
          In every agent's prompt
          <Hint label="the prompt budget">{BUDGET_HINT}</Hint>
        </span>
        <span className="ml-auto font-mono">{kb(rules + files)}</span>
      </div>
      <div
        className="flex h-[8px] overflow-hidden rounded-[3px] bg-hover"
        role="img"
        aria-label={`Rules ${kb(rules)}, files ${kb(files)} of ${kb(WORKING_SET_MAX_BYTES)}`}
      >
        <span className={cn("block h-full", RULES_FILL)} style={{ width: width(rules) }} />
        <span className={cn("block h-full", FILES_FILL)} style={{ width: width(files) }} />
      </div>
      <div className={cn(ROW, NOTE, "text-dim-foreground")}>
        <span>
          <span className={cn(SWATCH, RULES_FILL)} /> Rules{" "}
          <span className="font-mono">{kb(rules)}</span>
        </span>
        <span>
          <span className={cn(SWATCH, FILES_FILL)} /> Files{" "}
          <span className="font-mono">
            {kb(files)} of {kb(WORKING_SET_MAX_BYTES)}
          </span>
        </span>
      </div>
    </section>
  );
}

/** The project context exactly as the backend renders it into a prompt now. */
function Preview({ projectKey }: { projectKey: string }) {
  const [preview] = useLoad(() => setup.agentContext(projectKey), [projectKey, "agent-context"]);
  if (preview.state !== "ready")
    return <LoadState value={preview} what="the agent context preview" />;
  const parts = [
    { id: "rules", title: "Rules", part: preview.data.instructions },
    { id: "files", title: "Files", part: preview.data.workingSet },
  ];
  return (
    <div className={STACK}>
      <p className={LEDE}>
        The project context a new chat or run gets, rendered now. The rest of the prompt (tools,
        mode, skills, memory) depends on the agent and is not shown.
      </p>
      {parts.map(({ id, title, part }) => (
        <section key={id} className={cn(PANEL, STACK)} aria-labelledby={`preview-${id}`}>
          <div className={ROW}>
            <h2 id={`preview-${id}`} className={LABEL}>
              {title}
            </h2>
            <span className="ml-auto font-mono text-dim-foreground">{kb(part?.bytes ?? 0)}</span>
          </div>
          {part?.text ? (
            <pre
              className={cn(
                "m-0 max-h-[480px] overflow-auto rounded-base border-2 border-border bg-[var(--bg-code)] p-3 font-mono text-[12px] leading-[1.55] text-foreground",
                WRAP,
                "whitespace-pre-wrap",
              )}
            >
              {part.text}
            </pre>
          ) : (
            <span className={`text-dim-foreground ${NOTE}`}>
              Nothing: agents get no {id === "rules" ? "instruction files" : "working set"}.
            </span>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * Everything every chat and workflow agent of the project gets in its prompt, on one screen:
 * Rules (instruction files), Files (the working set), their shared budget and a preview. The tab
 * is the route's item, so `context/files` opens on the working set.
 */
export function AgentContextSection({ project, id }: SectionProps) {
  const tab = tabOf(id);
  return (
    <div className={SETUP}>
      <p className={LEDE}>
        What every chat and workflow agent of this project gets in its prompt: rules to follow and
        files to know. A run freezes both when it starts.
      </p>
      <Budget projectKey={project.key} />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          window.location.hash = projectHref(project.key, "context", String(value));
        }}
      >
        <TabsList aria-label="Agent context">
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "rules" && <InstructionsPane project={project} />}
      {tab === "files" && <WorkingSetPane project={project} />}
      {tab === "preview" && <Preview projectKey={project.key} />}
    </div>
  );
}

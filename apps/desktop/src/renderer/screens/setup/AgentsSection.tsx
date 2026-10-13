import { useState } from "react";
import {
  type AgentList,
  type AgentStage,
  type ConvertResult,
  type ProjectAgent,
  projectAgents,
} from "../../client/agents.js";
import { start } from "../../client/start.js";
import { Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { ConfirmDialog } from "../../components/ui/confirm-dialog.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog.js";
import { Empty } from "../../components/ui/empty.js";
import { fieldClass, Input } from "../../components/ui/input.js";
import { Switch } from "../../components/ui/switch.js";
import { Textarea } from "../../components/ui/textarea.js";
import { cn } from "../../lib/cn.js";
import { LABEL, LEDE, PANEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import {
  type Choices,
  choiceProblem,
  freeId,
  isWorkflowId,
  origins,
  placement,
  planSummary,
  plural,
  removable,
  resultLine,
  STAGE_LABEL,
  STATIONS,
  suggested,
} from "./agents-model.js";
import {
  ACTIONS,
  errorText,
  FL,
  GROW,
  LIST,
  LoadState,
  NOTE,
  SETUP,
  STACK,
  Tag,
  useLoad,
  WARN,
  WRAP,
} from "./shared.js";

const SELECT = cn(fieldClass, "h-9 w-auto py-1 pr-8");
const STAGES: AgentStage[] = ["research", "specify", "plan", "implement", "review", "skip"];

/** The project's agents from other tools, shared by the sidebar, Workflows and this section. */
export function useProjectAgents(projectKey: string) {
  return useLoad(() => projectAgents.list(projectKey), [projectKey, "project-agents"]);
}

/** An agent as a block that rides the line: waiting above its station, or landing on it. */
function AgentChip({
  agent,
  index,
  landed,
}: {
  agent: ProjectAgent;
  index: number;
  landed: boolean;
}) {
  return (
    <span
      className={cn(
        "max-w-full truncate rounded-base border-2 border-border bg-main px-2 py-0.5 font-mono text-[11px] font-bold text-main-foreground shadow-sm-hard motion-reduce:animate-none",
        landed ? "animate-agent-land" : "animate-agent-float",
      )}
      style={{ animationDelay: `${landed ? index * 140 : index * 320}ms` }}
      title={`${agent.name}: ${agent.description}`}
    >
      {agent.name}
    </span>
  );
}

/**
 * The workflow line the agents become: five stations over a moving belt, each agent above the
 * station it will fill. When the conversion is done the agents land and the stations light up.
 */
function AgentLine({
  agents,
  choices,
  landed,
}: {
  agents: readonly ProjectAgent[];
  choices: Choices;
  landed: boolean;
}) {
  const { byStage, unused } = placement(agents, choices);
  let order = 0;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[560px] grid-cols-5 gap-2.5">
          {STATIONS.map((station, i) => {
            const here = byStage[station.stage];
            return (
              <div key={station.stage} className="flex min-w-0 flex-col items-stretch gap-2">
                <div className="flex min-h-[52px] flex-col items-center justify-end gap-1">
                  {here.map((agent) => (
                    <AgentChip key={agent.key} agent={agent} index={order++} landed={landed} />
                  ))}
                </div>
                <div
                  className={cn(
                    "flex flex-col items-center rounded-base border-2 border-border px-2 py-2 text-center shadow-sm-hard transition-colors duration-300 motion-reduce:animate-none motion-reduce:transition-none",
                    here.length ? "bg-background" : "bg-secondary-background text-dim-foreground",
                    landed &&
                      here.length > 0 &&
                      "animate-station-lit bg-fill-ok text-main-foreground",
                  )}
                  style={landed ? { animationDelay: `${300 + i * 120}ms` } : undefined}
                >
                  <span className="font-heading text-[13px]">{station.label}</span>
                  <span className="text-[11px] opacity-80">{station.does}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div
          className="mt-2 h-3 min-w-[560px] animate-belt rounded-[9px] border-2 border-border bg-[repeating-linear-gradient(90deg,var(--bg-sunken)_0_14px,var(--line)_14px_18px)] bg-[length:18px_100%] motion-reduce:animate-none"
          aria-hidden="true"
        />
      </div>
      {unused.length > 0 && (
        <p className={cn(NOTE, "m-0 text-dim-foreground")}>
          Not used: {unused.map((a) => a.name).join(", ")}
          {unused.some((a) => a.orchestrator) &&
            ". An agent that hands work to other agents is the workflow itself now."}
        </p>
      )}
    </div>
  );
}

/** The heading panel: what the agents are, the line they would become, and the one action. */
function Hero({
  agents,
  choices,
  landed,
  onConvert,
}: {
  agents: readonly ProjectAgent[];
  choices: Choices;
  landed: boolean;
  onConvert: () => void;
}) {
  return (
    <section className={cn(PANEL, "flex flex-col gap-4")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 max-w-[620px] flex-col gap-1.5">
          <p className={LABEL}>
            {plural(agents.length, "agent")} from {origins(agents)}
          </p>
          <h2 className="m-0 text-[20px] font-bold">Make them a workflow</h2>
          <p className={LEDE}>
            BAKED runs agents as the steps of a workflow, with its checks, reviews and approvals
            around them. Convert these once, check the line below, and the agent files can go.
          </p>
        </div>
        <Button variant="default" onClick={onConvert} disabled={landed}>
          <Icon name="workflows" size={16} />
          Turn into a workflow
        </Button>
      </div>
      <AgentLine agents={agents} choices={choices} landed={landed} />
    </section>
  );
}

/** One agent: where it comes from, the station it fills, Edit and Remove. */
function AgentRow({
  agent,
  stage,
  onStage,
  onEdit,
  onRemove,
}: {
  agent: ProjectAgent;
  stage: AgentStage;
  onStage: (stage: AgentStage) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--line)] px-[14px] py-3 animate-rise motion-reduce:animate-none">
      <div className={cn(GROW, STACK, "gap-1")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-heading text-foreground">{agent.name}</span>
          <Badge tone="info">{agent.sourceLabel}</Badge>
          {agent.orchestrator && <Tag>hands work to other agents</Tag>}
          {agent.model && <Tag>asks for {agent.model}</Tag>}
        </div>
        <span className="truncate font-mono text-[12px] text-dim-foreground" title={agent.path}>
          {agent.path}
        </span>
        {agent.description && (
          <span className={cn(NOTE, WRAP, "text-muted-foreground")}>{agent.description}</span>
        )}
      </div>
      <label className="flex items-center gap-2 text-[12px] text-dim-foreground">
        Station
        <select
          className={SELECT}
          value={stage}
          onChange={(e) => onStage(e.target.value as AgentStage)}
          aria-label={`Station of ${agent.name}`}
        >
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <div className={ACTIONS}>
        <Button variant="secondary" size="md" onClick={onEdit}>
          Edit
        </Button>
        {agent.removable && (
          <Button variant="ghost" size="md" onClick={onRemove} aria-label={`Remove ${agent.name}`}>
            <Icon name="delete" size={14} />
          </Button>
        )}
      </div>
    </li>
  );
}

/** The agent's file in an editor, saved only over the version it opened. */
function EditDialog({
  projectKey,
  agent,
  onClose,
  onSaved,
}: {
  projectKey: string;
  agent: ProjectAgent | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(agent?.content ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!agent) return null;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await projectAgents.save(projectKey, agent, text);
      onSaved();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-[760px]">
        <DialogHeader>
          <DialogTitle>Edit {agent.name}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{agent.path}</span>, used by {agent.sourceLabel}. A workflow
            made from it later takes the text as it is then.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          id="agent-edit-text"
          className="min-h-[340px] font-mono text-[12px]"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={busy || text === agent.content}
            onClick={save}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Name the workflow, pick its base, decide whether the agent files go, then convert. */
function ConvertDialog({
  projectKey,
  open,
  list,
  choices,
  taken,
  onClose,
  onDone,
}: {
  projectKey: string;
  open: boolean;
  list: AgentList;
  choices: Choices;
  taken: readonly string[];
  onClose: () => void;
  onDone: (result: ConvertResult) => void;
}) {
  const [workflowId, setWorkflowId] = useState(() => freeId(taken));
  const [base, setBase] = useState(list.bases[0] ?? "standard");
  const [remove, setRemove] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem =
    choiceProblem(list.agents, choices) ??
    (isWorkflowId(workflowId) ? null : "The ID takes letters, digits, - and _.") ??
    (taken.includes(workflowId) ? `A workflow ${workflowId} exists already.` : null);
  const files = removable(list.agents, choices);
  const convert = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await projectAgents.convert(projectKey, {
        workflowId,
        from: base,
        agents: list.agents.map((a) => ({ key: a.key, stage: choices[a.key] ?? a.stage })),
        removeOriginals: remove,
      });
      onDone(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Turn the agents into a workflow</DialogTitle>
          <DialogDescription>
            {planSummary(list.agents, choices) || "No agent chosen."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-3">
          <label className={cn(FL, "flex-[1_1_200px]")} htmlFor="agents-workflow-id">
            <span>Workflow ID</span>
            <Input
              id="agents-workflow-id"
              value={workflowId}
              onChange={(e) => setWorkflowId(e.target.value.trim())}
            />
          </label>
          <label className={cn(FL, "flex-[1_1_160px]")} htmlFor="agents-workflow-base">
            <span>Based on</span>
            <select
              id="agents-workflow-base"
              className={cn(fieldClass, "h-10")}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              {list.bases.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={cn(NOTE, "m-0 text-muted-foreground")}>
          Each agent becomes the profile of its station, built on BAKED's own one with the agent's
          prompt added; a Review agent becomes a review gate. Approvals stay with a person.
        </p>
        {files.length > 0 && (
          <div className="flex items-start gap-3 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5">
            <Switch
              id="agents-remove-files"
              checked={remove}
              onCheckedChange={(next) => setRemove(next)}
              aria-label="Remove the agent files afterwards"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-[13px] font-heading">Remove the agent files afterwards</span>
              <span className={cn(NOTE, WRAP, "font-mono text-dim-foreground")}>
                {files.map((a) => a.path).join(", ")}
              </span>
            </div>
          </div>
        )}
        {problem && <Alert className={WARN}>{problem}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" size="md" disabled={busy} onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" size="md" disabled={busy || problem !== null} onClick={convert}>
            Make workflow {workflowId}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What the conversion made, with the next steps. */
function Done({ projectKey, result }: { projectKey: string; result: ConvertResult }) {
  return (
    <section
      className={cn(PANEL, "flex flex-col gap-3 animate-rise motion-reduce:animate-none")}
      style={{ animationDelay: "700ms" }}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="ok">Ready</Badge>
        <h2 className="m-0 text-[16px] font-bold">Workflow {result.workflowId}</h2>
      </div>
      <p className="m-0 text-[13px]">{resultLine(result)}</p>
      {result.notes.length > 0 && (
        <ul className={cn(NOTE, "m-0 pl-5 text-muted-foreground")}>
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {result.kept.map((k) => (
        <p key={k.key} className={cn(NOTE, "m-0 text-muted-foreground")}>
          Kept <span className="font-mono">{k.key}</span>: {k.reason}
        </p>
      ))}
      {result.problems.length > 0 && (
        <Alert className={WARN}>
          Fix before a run, in the editor: {result.problems.join("; ")}
        </Alert>
      )}
      <div className={ACTIONS}>
        <a
          className={cn(buttonVariants({ variant: "primary", size: "md" }))}
          href={projectHref(projectKey, "workflows", result.workflowId)}
        >
          Open in the editor
        </a>
        <a
          className={cn(buttonVariants({ variant: "secondary", size: "md" }))}
          href={projectHref(projectKey, "runs", "new")}
        >
          Start a run
        </a>
      </div>
    </section>
  );
}

/**
 * Agents the project brought from other tools (#832). The section is listed only while the
 * project has some: BAKED is customized through workflows, and this screen exists to turn such
 * agents into one. Until then they can be edited or removed here.
 */
export function AgentsSection({ project }: SectionProps) {
  const [loaded, reload] = useProjectAgents(project.key);
  const [definitions] = useLoad(() => start.definitions(project.key), [project.key, "definitions"]);
  const [choices, setChoices] = useState<Choices>({});
  const [editing, setEditing] = useState<ProjectAgent | null>(null);
  const [removing, setRemoving] = useState<ProjectAgent | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [landedOn, setLandedOn] = useState<ProjectAgent[] | null>(null);
  if (loaded.state !== "ready") return <LoadState value={loaded} what="agents" />;
  const list = loaded.data;
  const current: Choices = { ...suggested(list.agents), ...choices };
  const taken = definitions.state === "ready" ? definitions.data.map((d) => d.id) : [];
  const shown = landedOn ?? list.agents;

  if (!shown.length && !result)
    return (
      <div className={SETUP}>
        <Empty>
          This project has no agents from other tools. BAKED is customized through{" "}
          <a href={projectHref(project.key, "workflows")}>workflows</a>.
        </Empty>
        {list.problems.map((p) => (
          <Alert key={p} className={WARN}>
            Could not read {p}
          </Alert>
        ))}
      </div>
    );

  return (
    <div className={SETUP}>
      {shown.length > 0 && (
        <Hero
          agents={shown}
          choices={current}
          landed={result !== null}
          onConvert={() => setConverting(true)}
        />
      )}
      {result && <Done projectKey={project.key} result={result} />}
      {list.problems.map((p) => (
        <Alert key={p} className={WARN}>
          Could not read {p}
        </Alert>
      ))}
      {list.agents.length > 0 && (
        <section className={STACK}>
          <p className={cn(LABEL, "pb-2")}>{result ? "Still in the project" : "The agents"}</p>
          <ul className={cn(LIST, PANEL, "overflow-hidden p-0")}>
            {list.agents.map((agent) => (
              <AgentRow
                key={agent.key}
                agent={agent}
                stage={current[agent.key] ?? agent.stage}
                onStage={(stage) => setChoices((c) => ({ ...c, [agent.key]: stage }))}
                onEdit={() => setEditing(agent)}
                onRemove={() => {
                  setRemoveError(null);
                  setRemoving(agent);
                }}
              />
            ))}
          </ul>
        </section>
      )}
      {editing && (
        <EditDialog
          key={editing.key}
          projectKey={project.key}
          agent={editing}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.name ?? ""}?`}
        confirmLabel="Remove the file"
        danger
        error={removeError}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await projectAgents.remove(project.key, removing);
            setRemoving(null);
            reload();
          } catch (e) {
            setRemoveError(errorText(e));
          }
        }}
      >
        Deletes <span className="font-mono">{removing?.path}</span>. A workflow already made from it
        keeps working.
      </ConfirmDialog>
      {converting && (
        <ConvertDialog
          projectKey={project.key}
          open
          list={list}
          choices={current}
          taken={taken}
          onClose={() => setConverting(false)}
          onDone={(done) => {
            setConverting(false);
            setLandedOn(list.agents);
            setResult(done);
            reload();
          }}
        />
      )}
    </div>
  );
}

/**
 * A line on the Workflows screen while the project still has agents from other tools, pointing
 * at the Agents section. Renders nothing in a project without them.
 */
export function AgentsNudge({ projectKey }: { projectKey: string }) {
  const [loaded] = useProjectAgents(projectKey);
  if (loaded.state !== "ready" || loaded.data.agents.length === 0) return null;
  const agents = loaded.data.agents;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-base border-2 border-border bg-secondary-background px-3 py-2.5 shadow-sm-hard animate-rise motion-reduce:animate-none">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-pulse-dot rounded-full bg-main motion-reduce:animate-none" />
      </span>
      <span className="min-w-0 flex-1 text-[13px]">
        {plural(agents.length, "agent")} from {origins(agents)} can become a workflow.
      </span>
      <a
        className={cn(buttonVariants({ variant: "secondary", size: "md" }))}
        href={projectHref(projectKey, "agents")}
      >
        Convert
      </a>
    </div>
  );
}

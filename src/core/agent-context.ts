/**
 * The project context every chat and workflow agent gets in its prompt: the instruction files
 * (rules) and the working set (files). Front ends show it as one "Agent context" screen.
 */
import { buildInstructionPrompt, loadInstructions } from "./instructions.js";
import { activeProject } from "./projects/resolve.js";
import { renderWorkingSet, resolveWorkingSet } from "./projects/working-set.js";

export interface AgentContextPart {
  /** The text as an agent's prompt carries it; empty when nothing is sent. */
  text: string;
  bytes: number;
}

export interface AgentContextPreview {
  /** Instruction files, in prompt order. */
  instructions: AgentContextPart;
  /** The rendered working set; null when the folder has no project or the set is empty. */
  workingSet: AgentContextPart | null;
  /** Both parts together. */
  bytes: number;
}

function part(text: string): AgentContextPart {
  return { text, bytes: Buffer.byteLength(text) };
}

/** Renders both parts the way an agent's prompt does, as of now. */
export function agentContextPreview(
  cwd: string,
  instructionFiles: string[] | undefined,
  opts: { homeDir?: string; now?: Date } = {},
): AgentContextPreview {
  const instructions = part(
    buildInstructionPrompt(
      loadInstructions(cwd, instructionFiles, opts.homeDir ? { homeDir: opts.homeDir } : {}),
    ),
  );
  const project = activeProject(cwd);
  const rendered = project
    ? renderWorkingSet(project.id, resolveWorkingSet(project), {
        cwd,
        ...(opts.now ? { now: opts.now } : {}),
      })
    : null;
  const workingSet = rendered ? part(rendered.text) : null;
  return {
    instructions,
    workingSet,
    bytes: instructions.bytes + (workingSet?.bytes ?? 0),
  };
}

/** The preview as plain text: each part under a heading, for the terminal and the CLI. */
export function formatAgentContext(preview: AgentContextPreview): string {
  const lines = [
    `Rules (instruction files): ${preview.instructions.bytes} B`,
    preview.instructions.text || "(none)",
    "",
    `Files (working set): ${preview.workingSet?.bytes ?? 0} B`,
    preview.workingSet?.text || "(none)",
  ];
  return `${lines.join("\n")}\n`;
}

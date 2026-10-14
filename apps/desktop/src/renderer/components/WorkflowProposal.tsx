import { StageChips } from "./WorkflowStages.js";

/**
 * What a coordinator's "Run workflow?" card proposes: why, the workflow's stages, the request the
 * run starts with and why this workflow fits it.
 */
export function WorkflowProposal({
  prompt,
  onCard = false,
}: {
  prompt: {
    workflow: string;
    description: string;
    stages: string[];
    writes: boolean;
    prompt: string;
    why: string;
    reason: string;
    issue?: string;
  };
  /** Drawn on a coloured prompt card: dark text with dimmed details, in both themes. */
  onCard?: boolean;
}) {
  const dim = onCard ? "opacity-75" : "text-muted-foreground";
  return (
    <div className={`flex flex-col gap-2 text-[13px]${onCard ? " text-main-foreground" : ""}`}>
      <p className="m-0">{prompt.why}</p>
      {prompt.stages.length > 0 && <StageChips stages={prompt.stages} onCard={onCard} />}
      {prompt.description && <p className={`m-0 text-[12px] ${dim}`}>{prompt.description}</p>}
      <blockquote
        className={`m-0 max-h-32 overflow-y-auto border-l-4 border-border pl-2 whitespace-pre-wrap wrap-anywhere ${dim}`}
      >
        {prompt.prompt}
      </blockquote>
      <p className={`m-0 text-[12px] ${dim}`}>
        {prompt.issue ? `From issue ${prompt.issue}. ` : ""}
        {prompt.writes ? "Changes files" : "Read only"}; why this workflow: {prompt.reason}. The run
        still asks you before its own approvals.
      </p>
    </div>
  );
}

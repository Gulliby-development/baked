/** The flows of a coordinator's split card: their task, what each writes and what it waits for. */
export function SplitFlows({
  prompt,
  onCard = false,
}: {
  /** Drawn on a coloured prompt card: dark text with dimmed details, in both themes. */
  onCard?: boolean;
  prompt: {
    mode: "runs" | "initiative" | "chats";
    flows: {
      id: string;
      title: string;
      paths: string[];
      dependsOn: string[];
      /** The issue (`owner/name#N`), `new issue` or `local task`; missing from older servers. */
      task?: string;
    }[];
  };
}) {
  const dim = onCard ? "opacity-75" : "text-muted-foreground";
  return (
    <ol
      className={`m-0 pl-5 flex flex-col gap-1 text-[13px]${onCard ? " text-main-foreground" : ""}`}
    >
      {prompt.flows.map((flow) => (
        <li key={flow.id}>
          <span className="font-semibold">{flow.title}</span>{" "}
          <span className={`font-mono ${dim}`}>{flow.id}</span>
          {flow.task && (
            <div className="text-[12px]">
              {prompt.mode === "chats" ? flow.task : `Task: ${flow.task}`}
            </div>
          )}
          {flow.paths.length > 0 && (
            <div className={`font-mono text-[12px] wrap-anywhere ${dim}`}>
              {flow.paths.join(", ")}
            </div>
          )}
          {flow.dependsOn.length > 0 && (
            <div className="text-[12px]">After {flow.dependsOn.join(", ")}</div>
          )}
        </li>
      ))}
    </ol>
  );
}

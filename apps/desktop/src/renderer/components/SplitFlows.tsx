/** The flows of a coordinator's split card: their task, what each writes and what it waits for. */
export function SplitFlows({
  prompt,
}: {
  prompt: {
    mode: "runs" | "initiative";
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
  return (
    <ol className="m-0 pl-5 flex flex-col gap-1 text-[13px]">
      {prompt.flows.map((flow) => (
        <li key={flow.id}>
          <span className="font-semibold">{flow.title}</span>{" "}
          <span className="font-mono text-muted-foreground">{flow.id}</span>
          {flow.task && <div className="text-[12px]">Task: {flow.task}</div>}
          {flow.paths.length > 0 && (
            <div className="font-mono text-[12px] text-muted-foreground wrap-anywhere">
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

import { LABEL } from "../lib/styles.js";

/** The approval body of tests written first (#632): the criteria and the failing tests. */
export interface TestsFirstBody {
  testsFirst?: {
    mode: string;
    criteria: { id: string; text: string }[];
    tests: {
      taskId: string;
      title: string;
      criterionIds: string[];
      files: { path: string; content: string }[];
    }[];
  };
}

/** The criteria next to the test files that check them, for a person to approve. */
export function TestsFirstReview({ tests }: { tests: NonNullable<TestsFirstBody["testsFirst"]> }) {
  return (
    <div className="flex flex-col gap-3">
      <section aria-label="Criteria">
        <span className={LABEL}>Criteria</span>
        <ul className="m-[4px_0_0] pl-[18px] leading-[1.6] text-soft-foreground">
          {tests.criteria.map((c) => (
            <li key={c.id}>
              <span className="font-mono">{c.id}</span> {c.text}
            </li>
          ))}
        </ul>
      </section>
      {tests.tests.map((test) => (
        <section key={test.taskId} aria-label={`Tests of ${test.taskId}`}>
          <span className={LABEL}>
            {test.taskId} · {test.criterionIds.join(", ")}
          </span>
          <p>{test.title}</p>
          {test.files.map((file) => (
            <details key={file.path} open={test.files.length === 1}>
              <summary className="cursor-pointer font-mono text-[12px]">{file.path}</summary>
              <pre className="m-0 max-h-[320px] overflow-auto rounded-base border-2 border-border bg-background p-3 font-mono text-[12px]">
                {file.content}
              </pre>
            </details>
          ))}
        </section>
      ))}
    </div>
  );
}

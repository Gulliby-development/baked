import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { DecisionPrompt } from "../src/components/workflow/DecisionPrompt.js";
import type { Decision } from "../src/core/workflows/schemas.js";

const body = {
  testsFirst: {
    mode: "criteria",
    criteria: [{ id: "AC-001", text: "Given a value, when it is read, then it is ready" }],
    tests: [
      {
        taskId: "T001",
        title: "Test value",
        criterionIds: ["AC-001"],
        files: [{ path: "value.test.ts", content: 'it("value is ready", () => expect(read()).toBe("ready"));' }],
      },
    ],
  },
};

test("the tests-first approval shows the tests next to the criteria and approves by digest", async () => {
  const decisions: Decision[] = [];
  const request = { id: "r1", kind: "approval" as const, status: "pending", digest: "d".repeat(64), body_json: JSON.stringify(body), answer_json: null, actor: null };
  const view = await testRender(
    <DecisionPrompt request={request} details={null} active onBack={() => {}} onDecision={(d) => decisions.push(d)} />,
    { width: 100, height: 30 },
  );
  for (let i = 0; i < 3; i++) await act(async () => { await view.flush(); await view.renderOnce(); });
  const text = view.captureCharFrame();
  expect(text).toContain("Approve the tests written first");
  expect(text).toContain("AC-001");
  expect(text).toContain("value.test.ts");
  expect(text).toContain('expect(read()).toBe("ready")');
  await act(async () => view.mockInput.pressKey("a"));
  expect(decisions).toEqual([{ kind: "approve", requestId: "r1", digest: "d".repeat(64) }]);
  view.renderer.destroy();
});

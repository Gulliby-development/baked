import { describe, expect, test } from "bun:test";
import type { ChatMessage, SessionSummary, ToolCall } from "../src/renderer/client/chat.ts";
import { emptyTranscript, type Transcript } from "../src/renderer/screens/chat/transcript.ts";
import {
  firstLines,
  launchedSessionId,
  threadView,
} from "../src/renderer/screens/coordinator/thread.ts";

const ID = "e372f9bc-ae25-4098-96b0-3c7188fb7fd3";
const session: SessionSummary = {
  id: ID,
  title: "Survey",
  messageCount: 1,
  startedAt: 0,
  updatedAt: 0,
  state: "working",
  model: null,
  mode: "architect",
  parentId: "coordinator",
};
const message = (role: ChatMessage["role"], content: string): ChatMessage => ({
  id: content,
  role,
  content,
  timestamp: 0,
});

function transcript(over: Partial<Transcript>): Transcript {
  return { ...emptyTranscript(), session, ...over };
}

describe("coordinator thread cards", () => {
  test("find the session a launch_session call started", () => {
    const call: ToolCall = {
      id: "c",
      name: "launch_session",
      args: { title: "Survey" },
      result: { success: true, output: `Started session ${ID} (working). You will get a note.` },
    };
    expect(launchedSessionId(call)).toBe(ID);
    expect(launchedSessionId({ ...call, result: { success: false, output: "" } })).toBeNull();
    expect(launchedSessionId({ ...call, name: "start_run" })).toBeNull();
  });

  test("show the tool a working session is in", () => {
    const view = threadView(
      transcript({
        turnId: "t1",
        live: {
          ...message("assistant", ""),
          toolCalls: [{ id: "r", name: "read", args: { files: [{ path: "src/a.ts" }] } }],
        },
      }),
    );
    expect(view.state).toBe("working");
    expect(view.activity).toBe("Reading src/a.ts");
  });

  test("show what a waiting session asks, and a finished session's answer", () => {
    const waiting = threadView(
      transcript({
        turnId: "t1",
        prompts: [
          {
            prompt: {
              id: "p",
              createdAt: 0,
              kind: "question",
              question: "Which module?",
              allowSkip: false,
              options: [],
            },
          },
        ],
      }),
    );
    expect(waiting).toMatchObject({ state: "waiting", activity: "Asks: Which module?" });
    const done = threadView(
      transcript({
        messages: [message("user", "Go"), message("assistant", "One\n\nTwo\nThree\nFour")],
      }),
    );
    expect(done).toMatchObject({ state: "done", activity: null, answer: "One\nTwo\nThree …", turns: 1 });
  });

  test("a session that is gone or not loaded yet says so", () => {
    expect(threadView(null).state).toBe("loading");
    expect(threadView(null, true).state).toBe("gone");
    expect(firstLines("a\nb", 3)).toBe("a\nb");
  });
});

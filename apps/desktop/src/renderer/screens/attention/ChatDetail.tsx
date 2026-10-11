import { useState } from "react";
import { attentionApi, type ChatPrompt } from "../../client/attention.js";
import { projectHref } from "../../router.js";
import {
  ACTIONS,
  ActionError,
  BTN,
  DetailHeader,
  FORM,
  INPUT,
  LEDE,
  Loading,
  NOTE,
  useAction,
  useLoad,
} from "./common.js";
import { type DetailProps, Gone } from "./RunDetails.js";

/** What a chat prompt asks to do, in one sentence. */
export function promptSummary(prompt: ChatPrompt): string {
  switch (prompt.kind) {
    case "outside-cwd":
      return `${prompt.tool} wants to touch a file outside the project: ${prompt.path}`;
    case "destructive":
      return `The agent wants to run a destructive command: ${prompt.description}`;
    case "web-search":
      return `The agent wants to search the web for: ${prompt.query}`;
    case "fetch-page":
      return `The agent wants to fetch ${prompt.url}`;
    case "question":
      return prompt.question;
  }
}

export function ChatDetail({ item, onDone }: DetailProps) {
  const sessionId = item.sessionId ?? "";
  const [load] = useLoad(
    () => attentionApi.session(item.projectKey, sessionId),
    `${item.projectKey}:${sessionId}:${item.requestId}`,
  );
  const action = useAction();
  const [text, setText] = useState("");
  const send = (body: { approve: boolean } | { answer: string }, message: string): void =>
    void action.run(async () => {
      await attentionApi.answerPrompt(item.projectKey, sessionId, item.requestId ?? "", body);
      onDone(message);
    });
  const openChat = (
    <a className={`btn ${BTN}`} href={projectHref(item.projectKey, "chat", sessionId)}>
      Open chat
    </a>
  );
  return (
    <Loading load={load}>
      {(session) => {
        const prompt = session.prompts.find((p) => p.id === item.requestId);
        if (!prompt) return <Gone item={item} />;
        return (
          <>
            <DetailHeader item={item} />
            {prompt.kind === "question" ? (
              <form
                className={FORM}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (text.trim()) send({ answer: text.trim() }, "Answered. The chat continues.");
                }}
              >
                <p className="m-0 text-[15px] text-foreground">{prompt.question}</p>
                {prompt.options.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {prompt.options.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className="btn min-h-[42px] flex-col items-start px-[14px] py-2 text-left"
                        disabled={action.busy}
                        onClick={() =>
                          send({ answer: option.value }, `Answered "${option.label}".`)
                        }
                      >
                        <span>{option.label}</span>
                        {option.description && <span className="muted">{option.description}</span>}
                      </button>
                    ))}
                  </div>
                )}
                <label className="label" htmlFor="att-chat-answer">
                  {prompt.options.length ? "Or answer in your own words" : "Your answer"}
                </label>
                <textarea
                  id="att-chat-answer"
                  className={INPUT}
                  rows={3}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
                <ActionError error={action.error} />
                <div className={ACTIONS}>
                  <button
                    type="submit"
                    className={`btn-primary ${BTN}`}
                    disabled={action.busy || !text.trim()}
                  >
                    Send answer
                  </button>
                  {prompt.allowSkip && (
                    <button
                      type="button"
                      className={`btn ${BTN}`}
                      disabled={action.busy}
                      onClick={() => send({ answer: "" }, "Skipped the question.")}
                    >
                      Skip
                    </button>
                  )}
                  {openChat}
                </div>
              </form>
            ) : (
              <>
                <p className={LEDE}>{promptSummary(prompt)}</p>
                <p className={NOTE}>
                  The chat <strong>{session.title}</strong> waits until you decide.
                </p>
                <ActionError error={action.error} />
                <div className={ACTIONS}>
                  <button
                    type="button"
                    className={`btn-primary ${BTN}`}
                    disabled={action.busy}
                    onClick={() => send({ approve: true }, "Approved. The chat continues.")}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={`btn ${BTN}`}
                    disabled={action.busy}
                    onClick={() => send({ approve: false }, "Denied. The agent was told no.")}
                  >
                    Deny
                  </button>
                  {openChat}
                </div>
              </>
            )}
          </>
        );
      }}
    </Loading>
  );
}

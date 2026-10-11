import { useState } from "react";
import { attentionApi, type ChatPrompt } from "../../client/attention.js";
import { Button } from "../../components/ui/button.js";
import { LABEL } from "../../lib/styles.js";
import { projectHref } from "../../router.js";
import {
  ACTIONS,
  ActionError,
  BTN,
  DetailHeader,
  FORM,
  INPUT,
  LEDE,
  LINK_BTN,
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
    case "plan-review":
      return `The agent proposes a plan: ${prompt.title} (${prompt.steps.length} ${
        prompt.steps.length === 1 ? "step" : "steps"
      })`;
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
  const send = (
    body:
      | { approve: boolean }
      | { answer: string }
      | { action: "execute" | "clear-execute" | "cancel" },
    message: string,
  ): void =>
    void action.run(async () => {
      await attentionApi.answerPrompt(item.projectKey, sessionId, item.requestId ?? "", body);
      onDone(message);
    });
  const openChat = (
    <a className={LINK_BTN} href={projectHref(item.projectKey, "chat", sessionId)}>
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
                      <Button
                        key={option.value}
                        variant="secondary"
                        size="md"
                        className="min-h-[42px] flex-col items-start whitespace-normal px-[14px] py-2 text-left"
                        disabled={action.busy}
                        onClick={() =>
                          send({ answer: option.value }, `Answered "${option.label}".`)
                        }
                      >
                        <span>{option.label}</span>
                        {option.description && (
                          <span className="text-dim-foreground">{option.description}</span>
                        )}
                      </Button>
                    ))}
                  </div>
                )}
                <label className={LABEL} htmlFor="att-chat-answer">
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
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    className={BTN}
                    disabled={action.busy || !text.trim()}
                  >
                    Send answer
                  </Button>
                  {prompt.allowSkip && (
                    <Button
                      variant="secondary"
                      size="md"
                      className={BTN}
                      disabled={action.busy}
                      onClick={() => send({ answer: "" }, "Skipped the question.")}
                    >
                      Skip
                    </Button>
                  )}
                  {openChat}
                </div>
              </form>
            ) : prompt.kind === "plan-review" ? (
              <>
                <p className={LEDE}>{promptSummary(prompt)}</p>
                <ol>
                  {prompt.steps.map((step) => (
                    <li key={step.id}>{step.label}</li>
                  ))}
                </ol>
                <p className={NOTE}>
                  The chat <strong>{session.title}</strong> waits until you decide. Open the chat to
                  read the whole plan or ask for changes.
                </p>
                <ActionError error={action.error} />
                <div className={ACTIONS}>
                  <Button
                    variant="primary"
                    size="md"
                    className={BTN}
                    disabled={action.busy}
                    onClick={() => send({ action: "execute" }, "Plan accepted. The chat runs it.")}
                  >
                    Execute
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    className={BTN}
                    disabled={action.busy}
                    onClick={() => send({ action: "cancel" }, "Plan cancelled.")}
                  >
                    Cancel plan
                  </Button>
                  {openChat}
                </div>
              </>
            ) : (
              <>
                <p className={LEDE}>{promptSummary(prompt)}</p>
                <p className={NOTE}>
                  The chat <strong>{session.title}</strong> waits until you decide.
                </p>
                <ActionError error={action.error} />
                <div className={ACTIONS}>
                  <Button
                    variant="primary"
                    size="md"
                    className={BTN}
                    disabled={action.busy}
                    onClick={() => send({ approve: true }, "Approved. The chat continues.")}
                  >
                    Approve
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    className={BTN}
                    disabled={action.busy}
                    onClick={() => send({ approve: false }, "Denied. The agent was told no.")}
                  >
                    Deny
                  </Button>
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

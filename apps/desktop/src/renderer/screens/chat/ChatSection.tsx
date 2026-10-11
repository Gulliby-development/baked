import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { DesktopProject } from "../../../shared/api.js";
import { ApiError } from "../../client/api.js";
import { type ChatMode, chat, isMissingChatApi } from "../../client/chat.js";
import { chatSessionsChanged } from "../../client/chat-sessions.js";
import { Alert } from "../../components/ui/alert.js";
import { buttonVariants } from "../../components/ui/button.js";
import { emptyClass } from "../../components/ui/empty.js";
import { cn } from "../../lib/cn.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { peekDraft, takeDraft } from "../start/drafts.js";
import { Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { ChatHeader } from "./Header.js";
import { emptyTranscript, isBusy, reduceTranscript } from "./transcript.js";

const NEW = "new";

const CHAT = "flex-1 min-h-0 flex flex-col";
const SCROLL = "flex-1 min-h-0 overflow-y-auto flex justify-center px-6 pt-[18px] pb-2";
const COLUMN = "w-full max-w-[820px] flex flex-col gap-[18px] pb-3";
const EMPTY = cn(emptyClass, "mt-12 flex flex-col items-center gap-[10px]");
const LINK_BTN = buttonVariants({ variant: "secondary", size: "md" });
const EMPTY_TITLE = "text-[18px] font-bold text-foreground";
const EMPTY_P = "m-0 max-w-[480px]";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function NeedsNewer({ project }: { project: DesktopProject }) {
  return (
    <div data-chat className={CHAT}>
      <ChatHeader project={project} title="Chat" sessionId={null} />
      <div className={SCROLL}>
        <div className={COLUMN}>
          <div className={EMPTY}>
            <p className={cn(EMPTY_P, EMPTY_TITLE)}>Chat needs a newer BAKED</p>
            <p className={EMPTY_P}>
              The BAKED that serves {project.name} has no chat API yet. Update BAKED, or point
              Settings → BAKED executable at a newer one, then restart the project.
            </p>
            <a className={LINK_BTN} href={projectHref(project.key, "runs")}>
              Open runs instead
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({ project, children }: { project: DesktopProject; children: ReactNode }) {
  return (
    <div data-chat className={CHAT}>
      <ChatHeader project={project} title="Chat" sessionId={null} />
      <div className={SCROLL}>
        <div className={COLUMN}>{children}</div>
      </div>
    </div>
  );
}

/** `#/p/KEY/chat`: opens the latest session, or a new one when there is none. */
function LatestSession({ project }: { project: DesktopProject }) {
  const [state, setState] = useState<"loading" | "missing" | string>("loading");
  useEffect(() => {
    let live = true;
    chat.list(project.key, 1).then(
      ({ sessions }) => {
        if (!live) return;
        const latest = sessions[0];
        window.location.replace(projectHref(project.key, "chat", latest ? latest.id : NEW));
      },
      (error: unknown) => {
        if (live) setState(isMissingChatApi(error) ? "missing" : message(error));
      },
    );
    return () => {
      live = false;
    };
  }, [project.key]);
  if (state === "missing") return <NeedsNewer project={project} />;
  return (
    <Centered project={project}>
      {state === "loading" ? (
        <p className="text-dim-foreground">Loading sessions…</p>
      ) : (
        <Alert tone="error">{state}</Alert>
      )}
    </Centered>
  );
}

function useStickToBottom(dependency: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow new content while at the bottom
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);
  const stick = useCallback(() => {
    atBottom.current = true;
  }, []);
  return { scroller, onScroll, stick };
}

function SessionView({ project, sessionId }: { project: DesktopProject; sessionId: string }) {
  const key = project.key;
  const draft = sessionId === NEW;
  const [transcript, dispatch] = useReducer(reduceTranscript, undefined, emptyTranscript);
  const [load, setLoad] = useState<"loading" | "ready" | "missing" | "not-found" | string>(
    draft ? "ready" : "loading",
  );
  const [generation, setGeneration] = useState(0);
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState<ChatMode>("default");
  // A task typed on the project home ("Ask in chat") starts the new session's composer.
  const [initialText] = useState(() => (draft ? peekDraft("chat", key) : ""));
  useEffect(() => {
    if (draft) takeDraft("chat", key);
  }, [draft, key]);

  // Load the session and follow its events; a `reset` bumps the generation to start over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation restarts the subscription
  useEffect(() => {
    if (draft) return;
    let live = true;
    let stop = (): void => {};
    const refresh = (): void => {
      chat.get(key, sessionId).then(
        (detail) => live && dispatch({ type: "snapshot", detail }),
        () => {},
      );
    };
    chat.get(key, sessionId).then(
      (detail) => {
        if (!live) return;
        dispatch({ type: "snapshot", detail });
        setLoad("ready");
        stop = chat.subscribe(key, sessionId, detail.lastSeq, (event) => {
          if (!live) return;
          dispatch(event);
          // The saved session carries context fill and edited files the events leave out.
          if (event.type === "turn-done") {
            refresh();
            chatSessionsChanged();
          }
        });
      },
      async (error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 404) {
          const missing = await chat.list(key, 1).then(
            () => false,
            (e: unknown) => isMissingChatApi(e),
          );
          if (live) setLoad(missing ? "missing" : "not-found");
        } else setLoad(message(error));
      },
    );
    return () => {
      live = false;
      stop();
    };
  }, [key, sessionId, draft, generation]);

  useEffect(() => {
    if (transcript.needsReset) setGeneration((g) => g + 1);
  }, [transcript.needsReset]);

  const busy = !draft && isBusy(transcript);
  const canStop = busy;

  const interrupt = useCallback(() => {
    chat.interrupt(key, sessionId).catch((e: unknown) => setActionError(message(e)));
  }, [key, sessionId]);

  useEffect(() => {
    if (!canStop) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !event.defaultPrevented) interrupt();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canStop, interrupt]);

  const { scroller, onScroll, stick } = useStickToBottom(transcript);

  const send = async (text: string): Promise<boolean> => {
    setActionError(null);
    stick();
    if (draft) {
      try {
        const created = await chat.create(key, {
          text,
          mode: draftMode,
          ...(draftModel ? { model: draftModel } : {}),
        });
        chatSessionsChanged();
        window.location.replace(projectHref(key, "chat", created.id));
        return true;
      } catch (error) {
        setActionError(message(error));
        return false;
      }
    }
    dispatch({ type: "local-send", text });
    try {
      await chat.send(key, sessionId, text);
      return true;
    } catch (error) {
      dispatch({ type: "local-send-failed", text });
      setActionError(message(error));
      return false;
    }
  };

  const decide = (promptId: string, work: () => Promise<unknown>): void => {
    setDeciding((s) => new Set(s).add(promptId));
    setActionError(null);
    work()
      .catch((e: unknown) => setActionError(message(e)))
      .finally(() =>
        setDeciding((s) => {
          const next = new Set(s);
          next.delete(promptId);
          return next;
        }),
      );
  };

  const update = (changes: { model?: string; mode?: ChatMode }): void => {
    if (draft) {
      if (changes.model) setDraftModel(changes.model);
      if (changes.mode) setDraftMode(changes.mode);
      return;
    }
    chat.update(key, sessionId, changes).catch((e: unknown) => setActionError(message(e)));
  };

  const loadModels = useCallback(() => chat.models(key).then((result) => result.providers), [key]);

  if (load === "missing") return <NeedsNewer project={project} />;
  if (load === "not-found")
    return (
      <Centered project={project}>
        <div className={EMPTY}>
          <p className={cn(EMPTY_P, EMPTY_TITLE)}>This chat no longer exists</p>
          <a className={LINK_BTN} href={projectHref(key, "chat", NEW)}>
            Start a new chat
          </a>
        </div>
      </Centered>
    );

  const session = transcript.session;
  const empty = !draft && load === "ready" && transcript.messages.length === 0 && !transcript.live;
  return (
    <div data-chat className={CHAT}>
      <ChatHeader
        project={project}
        title={draft ? "New chat" : (session?.title ?? "Chat")}
        sessionId={draft ? null : sessionId}
        {...(draft
          ? {}
          : {
              context: transcript.context,
              usage: transcript.usage,
              model: session?.model ?? null,
              filesEdited: transcript.filesEdited,
            })}
      />
      <section className={SCROLL} aria-label="Conversation" ref={scroller} onScroll={onScroll}>
        <div className={COLUMN} aria-live="off">
          {load === "loading" && <p className="text-dim-foreground">Loading the session…</p>}
          {load !== "loading" && load !== "ready" && <Alert tone="error">{load}</Alert>}
          {(draft || empty) && transcript.pending.length === 0 && (
            <div className="pt-12 px-2 pb-2 flex flex-col gap-[6px]">
              <p className={cn("m-0", EMPTY_TITLE)}>What should BAKED do in {project.name}?</p>
              <p className="m-0 text-dim-foreground">
                Describe a change, ask about the code, or paste an error. Tool approvals show up
                here and in Needs you.
              </p>
            </div>
          )}
          <Conversation
            transcript={transcript}
            deciding={deciding}
            onApprove={(id, approve) => decide(id, () => chat.approve(key, sessionId, id, approve))}
            onAnswer={(id, answer) => decide(id, () => chat.answer(key, sessionId, id, answer))}
          />
          {actionError && (
            <p className="m-0 px-3 py-0 text-[13px] text-[var(--err)]" role="alert">
              {actionError}
            </p>
          )}
        </div>
      </section>
      <div className="flex justify-center px-6 pt-2 pb-5">
        <Composer
          busy={busy}
          canStop={canStop}
          model={draft ? draftModel : (session?.model ?? null)}
          mode={draft ? draftMode : (session?.mode ?? "default")}
          autoFocusKey={sessionId}
          initialText={initialText}
          onSend={send}
          onStop={interrupt}
          onModel={(model) => update({ model })}
          onMode={(mode) => update({ mode })}
          loadModels={loadModels}
        />
      </div>
    </div>
  );
}

/** The Chat section: one session in a centered column with the composer at the bottom. */
export function ChatSection({ project, id }: SectionProps) {
  if (id === null) return <LatestSession project={project} />;
  return <SessionView key={id} project={project} sessionId={id} />;
}

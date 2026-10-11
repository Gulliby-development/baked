import "../../styles/chat.css";
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
import {
  CHAT_UNDO_CAPABILITY,
  COMPACTION_CAPABILITY,
  DIFF_STATS_CAPABILITY,
  IMAGES_CAPABILITY,
} from "../../client/capabilities.js";
import {
  type ChatMode,
  chat,
  type ImageUpload,
  isMissingChatApi,
  type SessionDiffStats,
} from "../../client/chat.js";
import { chatSessionsChanged } from "../../client/chat-sessions.js";
import { projectHref } from "../../router.js";
import type { SectionProps } from "../sections.js";
import { peekDraft, takeDraft } from "../start/drafts.js";
import { Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { forkReportLines, rememberForkReport, rewindReportLines, takeForkReport } from "./fork.js";
import { ChatHeader, type CompactControl, type RewindControl } from "./Header.js";
import { pendingText } from "./images.js";
import { emptyTranscript, isBusy, reduceTranscript, turnCount } from "./transcript.js";

const NEW = "new";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function NeedsNewer({ project }: { project: DesktopProject }) {
  return (
    <div className="chat">
      <ChatHeader project={project} title="Chat" sessionId={null} />
      <div className="chat-scroll">
        <div className="chat-column">
          <div className="empty chat-empty">
            <p className="chat-empty-title">Chat needs a newer BAKED</p>
            <p>
              The BAKED that serves {project.name} has no chat API yet. Update BAKED, or point
              Settings → BAKED executable at a newer one, then restart the project.
            </p>
            <a className="btn" href={projectHref(project.key, "runs")}>
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
    <div className="chat">
      <ChatHeader project={project} title="Chat" sessionId={null} />
      <div className="chat-scroll">
        <div className="chat-column">{children}</div>
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
        <p className="muted">Loading sessions…</p>
      ) : (
        <div className="banner error">{state}</div>
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
  const [forking, setForking] = useState(false);
  const [forkReport] = useState(() => (draft ? null : takeForkReport(sessionId)));
  const [rewinding, setRewinding] = useState(false);
  const [rewindReport, setRewindReport] = useState<string[] | null>(null);
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
          // The saved session carries context fill and edited files the events leave out, and
          // the messages an undo or redo from another window left.
          if (
            event.type === "turn-done" ||
            event.type === "compaction-done" ||
            event.type === "rewind"
          ) {
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

  // Capabilities decide whether "Compact now" and line counts show; older servers have neither.
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    chat.capabilities(key).then((caps) => live && setCapabilities(caps));
    return () => {
      live = false;
    };
  }, [key]);
  const canCompact = capabilities?.includes(COMPACTION_CAPABILITY) === true;
  const canRewind = capabilities?.includes(CHAT_UNDO_CAPABILITY) === true;
  const hasDiffStats = capabilities?.includes(DIFF_STATS_CAPABILITY) === true;
  const acceptsImages = capabilities?.includes(IMAGES_CAPABILITY) === true;

  // Line counts follow the edited files; a turn that ends may also have changed them on disk.
  const [diff, setDiff] = useState<SessionDiffStats | null>(null);
  const editedKey = transcript.filesEdited.join("\n");
  const turnRunning = transcript.turnId !== null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when edits or turns change
  useEffect(() => {
    if (draft || !hasDiffStats || turnRunning) return;
    let live = true;
    chat.diff(key, sessionId).then(
      (stats) => live && setDiff(stats),
      () => live && setDiff(null),
    );
    return () => {
      live = false;
    };
  }, [key, sessionId, draft, hasDiffStats, editedKey, turnRunning]);

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

  const send = async (text: string, images: ImageUpload[]): Promise<boolean> => {
    setActionError(null);
    setRewindReport(null);
    stick();
    if (draft) {
      try {
        const created = await chat.create(key, {
          ...(text ? { text } : {}),
          ...(images.length > 0 ? { images } : {}),
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
    // The pending bubble shows the text; images appear once the server echoes the message.
    const shown = pendingText(text, images.length);
    dispatch({ type: "local-send", text: shown });
    try {
      await chat.send(key, sessionId, text, images);
      return true;
    } catch (error) {
      dispatch({ type: "local-send-failed", text: shown });
      setActionError(message(error));
      return false;
    }
  };

  const fork = (atMessageId: string, rollbackFiles: boolean): void => {
    setForking(true);
    setActionError(null);
    chat
      .fork(key, sessionId, { atMessageId, rollbackFiles })
      .then((created) => {
        rememberForkReport(created.id, forkReportLines(created.rollback));
        chatSessionsChanged();
        window.location.assign(projectHref(key, "chat", created.id));
      })
      .catch((e: unknown) => setActionError(message(e)))
      .finally(() => setForking(false));
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

  const compact = (): void => {
    setActionError(null);
    stick();
    chat.compact(key, sessionId).catch((e: unknown) => setActionError(message(e)));
  };
  const compactControl: CompactControl | undefined =
    canCompact && !draft
      ? {
          run: compact,
          disabled: transcript.compacting
            ? "Compacting…"
            : busy
              ? "Available when the turn ends."
              : null,
        }
      : undefined;

  const rewind = (action: "undo" | "redo"): void => {
    if (
      action === "undo" &&
      !window.confirm(
        "Undo the last turn? It is dropped from the chat and the files it edited are restored; files changed since then stay as they are. Redo puts it back until you send a new message.",
      )
    )
      return;
    setRewinding(true);
    setActionError(null);
    (action === "undo" ? chat.undo(key, sessionId) : chat.redo(key, sessionId))
      .then((detail) => {
        dispatch({ type: "snapshot", detail });
        setRewindReport(rewindReportLines(action, detail.rollback));
        chatSessionsChanged();
      })
      .catch((e: unknown) => setActionError(message(e)))
      .finally(() => setRewinding(false));
  };
  const turns = turnCount(transcript);
  const nextRedo = transcript.redo[0] ?? null;
  const rewindBlocked = rewinding ? "Working…" : busy ? "Available when the turn ends." : null;
  const rewindControl: RewindControl | undefined =
    canRewind && !draft
      ? {
          undo: () => rewind("undo"),
          redo: () => rewind("redo"),
          undoDisabled: rewindBlocked ?? (turns === 0 ? "Nothing to undo." : null),
          redoDisabled: rewindBlocked ?? (nextRedo ? null : "Nothing to redo."),
          redoPrompt: nextRedo?.prompt ?? null,
        }
      : undefined;

  const loadModels = useCallback(() => chat.models(key).then((result) => result.providers), [key]);
  const loadMentions = useCallback(
    (query: string) => chat.mentions(key, query).then((result) => result.mentions),
    [key],
  );

  if (load === "missing") return <NeedsNewer project={project} />;
  if (load === "not-found")
    return (
      <Centered project={project}>
        <div className="empty chat-empty">
          <p className="chat-empty-title">This chat no longer exists</p>
          <a className="btn" href={projectHref(key, "chat", NEW)}>
            Start a new chat
          </a>
        </div>
      </Centered>
    );

  const session = transcript.session;
  const empty = !draft && load === "ready" && transcript.messages.length === 0 && !transcript.live;
  return (
    <div className="chat">
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
              diff,
              ...(compactControl ? { compact: compactControl } : {}),
              ...(rewindControl ? { rewind: rewindControl } : {}),
            })}
      />
      <section className="chat-scroll" aria-label="Conversation" ref={scroller} onScroll={onScroll}>
        <div className="chat-column" aria-live="off">
          {load === "loading" && <p className="muted">Loading the session…</p>}
          {load !== "loading" && load !== "ready" && <div className="banner error">{load}</div>}
          {(draft || empty) && transcript.pending.length === 0 && (
            <div className="chat-welcome">
              <p className="chat-empty-title">What should BAKED do in {project.name}?</p>
              <p className="muted">
                Describe a change, ask about the code, or paste an error. Tool approvals show up
                here and in Needs you.
              </p>
            </div>
          )}
          {forkReport && (
            <div className="banner fork-report" role="status">
              {forkReport.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          )}
          {rewindReport && (
            <div className="banner fork-report rewind-report" role="status">
              <div>
                {rewindReport.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
              <button type="button" className="btn" onClick={() => setRewindReport(null)}>
                Dismiss
              </button>
            </div>
          )}
          <Conversation
            transcript={transcript}
            deciding={deciding}
            forking={forking}
            {...(draft ? {} : { onFork: fork })}
            onApprove={(id, approve) => decide(id, () => chat.approve(key, sessionId, id, approve))}
            onAnswer={(id, answer) => decide(id, () => chat.answer(key, sessionId, id, answer))}
          />
          {actionError && (
            <p className="notice error" role="alert">
              {actionError}
            </p>
          )}
        </div>
      </section>
      <div className="composer-wrap">
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
          loadMentions={loadMentions}
          acceptsImages={acceptsImages}
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

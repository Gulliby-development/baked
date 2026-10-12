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
  CHAT_EXPORT_CAPABILITY,
  CHAT_UNDO_CAPABILITY,
  CHECKPOINTS_CAPABILITY,
  COMPACTION_CAPABILITY,
  COORDINATOR_CAPABILITY,
  CUSTOM_COMMANDS_CAPABILITY,
  DIFF_STATS_CAPABILITY,
  IMAGES_CAPABILITY,
  PLAN_MODE_CAPABILITY,
} from "../../client/capabilities.js";
import {
  CHAT_MODES,
  type ChatMode,
  chat,
  type ImageUpload,
  isMissingChatApi,
  type SessionDiffStats,
} from "../../client/chat.js";
import { chatSessionsChanged } from "../../client/chat-sessions.js";
import { coordinator as coordinatorApi } from "../../client/coordinator.js";
import { setup } from "../../client/setup.js";
import { BlockIcon, Icon } from "../../components/Icon.js";
import { Alert } from "../../components/ui/alert.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { emptyClass } from "../../components/ui/empty.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { cn } from "../../lib/cn.js";
import { projectHref } from "../../router.js";
import { handOffText, SPLIT_EDIT_PREFIX } from "../coordinator/model.js";
import type { SectionProps } from "../sections.js";
import { peekDraft, takeDraft } from "../start/drafts.js";
import { BASE_MODES, Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { forkReportLines, rememberForkReport, rewindReportLines, takeForkReport } from "./fork.js";
import { ChatHeader, type CompactControl, type RewindControl } from "./Header.js";
import { pendingText } from "./images.js";
import { emptyTranscript, isBusy, reduceTranscript, turnCount } from "./transcript.js";
import { useVoiceInput } from "./useVoiceInput.js";

const NEW = "new";

const CHAT = "flex-1 min-w-0 min-h-0 flex flex-col";
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
        <Skeleton label="Loading sessions" />
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

/** The coordinator always runs in architect mode. */
const COORDINATOR_MODES: readonly ChatMode[] = ["architect"];

/**
 * One chat session. As the project `coordinator` it has no chat switcher, fork, undo or mode
 * choice, and its split cards offer Edit.
 */
export function SessionView({
  project,
  sessionId,
  coordinator = false,
}: {
  project: DesktopProject;
  sessionId: string;
  coordinator?: boolean;
}) {
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
  // Text put into the composer later, such as Edit on a split card; `n` remounts the composer.
  const [seed, setSeed] = useState({ text: "", n: 0 });
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
  const canRewind = !coordinator && capabilities?.includes(CHAT_UNDO_CAPABILITY) === true;
  const canHandOff = !coordinator && capabilities?.includes(COORDINATOR_CAPABILITY) === true;
  const canRewindTo = canRewind && capabilities?.includes(CHECKPOINTS_CAPABILITY) === true;
  const hasDiffStats = capabilities?.includes(DIFF_STATS_CAPABILITY) === true;
  const acceptsImages = capabilities?.includes(IMAGES_CAPABILITY) === true;
  const voice = useVoiceInput();
  // Older servers list commands under `library` but send them to the model unexpanded.
  const expandsCommands = capabilities?.includes(CUSTOM_COMMANDS_CAPABILITY) === true;
  const modes: readonly ChatMode[] = coordinator
    ? COORDINATOR_MODES
    : capabilities?.includes(PLAN_MODE_CAPABILITY) === true
      ? CHAT_MODES
      : BASE_MODES;

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

  /** Rejects a split card and starts a message saying what to change. */
  const editSplit = (promptId: string): void => {
    decide(promptId, () => chat.approve(key, sessionId, promptId, false));
    setSeed((s) => ({ text: SPLIT_EDIT_PREFIX, n: s.n + 1 }));
  };

  const handOff = async (): Promise<void> => {
    const target = await coordinatorApi.open(key);
    await chat.send(
      key,
      target.id,
      handOffText(transcript.session?.title ?? "Chat", transcript.messages),
    );
    window.location.assign(projectHref(key, "coordinator"));
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

  /** Undo (to `toCheckpoint` when given, already confirmed in the turn) or redo. */
  const rewind = (action: "undo" | "redo", toCheckpoint?: number): void => {
    if (
      action === "undo" &&
      toCheckpoint === undefined &&
      !window.confirm(
        "Undo the last turn? It is dropped from the chat and the files it edited are restored; files changed since then stay as they are. Redo puts it back until you send a new message.",
      )
    )
      return;
    setRewinding(true);
    setActionError(null);
    (action === "undo"
      ? chat.undo(key, sessionId, toCheckpoint === undefined ? {} : { toCheckpoint })
      : chat.redo(key, sessionId)
    )
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
  const loadCommands = useCallback(
    () => setup.commands(key).then((result) => result.commands),
    [key],
  );
  const loadMentions = useCallback(
    (query: string) => chat.mentions(key, query).then((result) => result.mentions),
    [key],
  );

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
        title={coordinator ? "Coordinator" : draft ? "New chat" : (session?.title ?? "Chat")}
        sessionId={draft ? null : sessionId}
        coordinator={coordinator}
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
              ...(coordinator
                ? {}
                : {
                    manage: {
                      canExport: capabilities?.includes(CHAT_EXPORT_CAPABILITY) === true,
                      deleteDisabled: turnRunning
                        ? "Stop the running turn before deleting the chat"
                        : null,
                      ...(canHandOff ? { handOff } : {}),
                    },
                  }),
            })}
      />
      <section className={SCROLL} aria-label="Conversation" ref={scroller} onScroll={onScroll}>
        <div className={COLUMN} aria-live="off">
          {load === "loading" && <Skeleton lines={5} label="Loading the session" />}
          {load !== "loading" && load !== "ready" && <Alert tone="error">{load}</Alert>}
          {(draft || empty) && transcript.pending.length === 0 && (
            <div className="pt-12 px-2 pb-2 flex flex-col gap-[6px]">
              <BlockIcon name="chat" className="mb-1" />
              <p className={cn("m-0", EMPTY_TITLE)}>What should BAKED do in {project.name}?</p>
              <p className="m-0 text-dim-foreground">
                Describe a change, ask about the code, or paste an error. Tool approvals show up
                here and in Needs you.
              </p>
            </div>
          )}
          {forkReport && (
            <Alert role="status" className="flex items-start gap-3">
              <Icon name="fork" size={15} className="mt-[2px] flex-none" />
              <div className="min-w-0 flex-1">
                {forkReport.map((line) => (
                  <p key={line} className="m-0">
                    {line}
                  </p>
                ))}
              </div>
            </Alert>
          )}
          {rewindReport && (
            <Alert role="status" className="flex items-start gap-3">
              <Icon name="rewind" size={15} className="mt-[2px] flex-none" />
              <div className="min-w-0 flex-1">
                {rewindReport.map((line) => (
                  <p key={line} className="m-0">
                    {line}
                  </p>
                ))}
              </div>
              <Button variant="secondary" size="md" onClick={() => setRewindReport(null)}>
                Dismiss
              </Button>
            </Alert>
          )}
          <Conversation
            transcript={transcript}
            deciding={deciding}
            forking={forking}
            {...(draft || coordinator ? {} : { onFork: fork })}
            {...(coordinator ? { onEditSplit: editSplit } : {})}
            {...(canRewindTo && !draft && !rewinding
              ? { onRewind: (checkpoint: number) => rewind("undo", checkpoint) }
              : {})}
            onApprove={(id, approve, digest) =>
              decide(id, () => chat.approve(key, sessionId, id, approve, digest))
            }
            onAnswer={(id, answer) => decide(id, () => chat.answer(key, sessionId, id, answer))}
            onReviewPlan={(id, review) =>
              decide(id, () => chat.reviewPlan(key, sessionId, id, review))
            }
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
          key={seed.n}
          busy={busy}
          canStop={canStop}
          model={draft ? draftModel : (session?.model ?? null)}
          mode={draft ? draftMode : (session?.mode ?? "default")}
          autoFocusKey={sessionId}
          initialText={seed.n > 0 ? seed.text : initialText}
          onSend={send}
          onStop={interrupt}
          onModel={(model) => update({ model })}
          onMode={(mode) => update({ mode })}
          modes={modes}
          loadModels={loadModels}
          loadMentions={loadMentions}
          {...(expandsCommands ? { loadCommands } : {})}
          acceptsImages={acceptsImages}
          voice={voice}
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

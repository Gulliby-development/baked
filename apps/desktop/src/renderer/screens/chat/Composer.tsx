import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import type {
  ChatEffort,
  ChatMode,
  ImageUpload,
  MentionSuggestion,
  ModelProvider,
} from "../../client/chat.js";
import type { CommandEntry } from "../../client/setup.js";
import { Icon } from "../../components/Icon.js";
import { cn } from "../../lib/cn.js";
import { LABEL } from "../../lib/styles.js";
import { matchCommands, slashAtCaret } from "./commands.js";
import { type Attachment, dataUrl, MAX_IMAGES, pickImages, readAttachment } from "./images.js";
import { MENU_ITEM, MENU_ITEM_STACKED, MENU_LIST, MENU_NOTE, Popover } from "./Popover.js";

const ROUND_BUTTON =
  "w-[38px] h-[38px] flex-none rounded-base border-2 border-border shadow-sm-hard flex items-center justify-center cursor-pointer hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none";

export const MODE_LABELS: Record<ChatMode, { name: string; detail: string }> = {
  default: {
    name: "Ask before risky actions",
    detail: "Writes outside the project, destructive commands and web access wait for you.",
  },
  architect: {
    name: "Architect",
    detail: "Read-only: design analysis and review, no edits.",
  },
  plan: {
    name: "Plan first",
    detail: "Researches read-only and proposes a plan; you execute, revise or cancel it.",
  },
  auto: { name: "Auto-approve", detail: "Runs everything without asking." },
};

/** The modes every backend with chat offers; `plan` needs the `plan-mode` capability. */
export const BASE_MODES: readonly ChatMode[] = ["default", "architect", "auto"];

const MAX_TEXTAREA_PX = 240;

/** The `@` token that ends at the caret; `@` on a `!command` line is shell text. */
export function mentionAtCaret(
  text: string,
  caret: number,
): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s([{,;])@([^\s"'`()<>[\]{},;@]*)$/.exec(before);
  if (!m) return null;
  if (!before.includes("\n") && before.trimStart().startsWith("!")) return null;
  return { query: m[2] ?? "", start: m.index + (m[1]?.length ?? 0) };
}

const MENTION_ICONS = { file: "·", directory: "▸", symbol: "ƒ" } as const;

export const EFFORT_LABELS: Record<ChatEffort, string> = {
  default: "Default effort",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * Reasoning effort of the chat: `Default` and the levels the current model takes, which the
 * model list reports. A model without effort leaves only `Default`, with a note why.
 */
function EffortMenu({
  model,
  effort,
  loadModels,
  onEffort,
  close,
}: {
  model: string | null;
  effort: ChatEffort;
  loadModels: () => Promise<ModelProvider[]>;
  onEffort: (effort: ChatEffort) => void;
  close: () => void;
}) {
  const [levels, setLevels] = useState<ChatEffort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadModels().then(
      (providers) => {
        const found = providers.flatMap((p) => p.models).find((m) => m.id === model);
        if (live) setLevels(found?.efforts ?? []);
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [loadModels, model]);
  if (error) return <p className={MENU_NOTE}>{error}</p>;
  if (!levels) return <p className={MENU_NOTE}>Loading efforts…</p>;
  const choices: ChatEffort[] = ["default", ...levels];
  if (!choices.includes(effort)) choices.push(effort);
  return (
    <div className={MENU_LIST}>
      {choices.map((level) => (
        <button
          key={level}
          type="button"
          className={MENU_ITEM_STACKED}
          aria-pressed={level === effort}
          onClick={() => {
            onEffort(level);
            close();
          }}
        >
          <span>{level === "default" ? "Default" : EFFORT_LABELS[level]}</span>
          {level === "default" ? (
            <span className="text-dim-foreground">The effort set in Settings, if any.</span>
          ) : !levels.includes(level) ? (
            <span className="text-dim-foreground">
              This model sends the next lower level it supports.
            </span>
          ) : null}
        </button>
      ))}
      <p className={MENU_NOTE}>
        {levels.length === 0
          ? "This model takes no reasoning effort; it runs at its provider's default."
          : "Applies from the next turn."}
      </p>
    </div>
  );
}

export function shortModel(model: string | null): string {
  if (!model) return "Default model";
  return model.slice(model.indexOf("/") + 1);
}

function ModelMenu({
  model,
  loadModels,
  onModel,
  close,
}: {
  model: string | null;
  loadModels: () => Promise<ModelProvider[]>;
  onModel: (model: string) => void;
  close: () => void;
}) {
  const [providers, setProviders] = useState<ModelProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadModels().then(
      (list) => live && setProviders(list),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [loadModels]);
  if (error) return <p className={MENU_NOTE}>{error}</p>;
  if (!providers) return <p className={MENU_NOTE}>Loading models…</p>;
  const usable = providers.filter((p) => p.configured && p.models.length > 0);
  if (usable.length === 0)
    return <p className={MENU_NOTE}>No provider is configured. Add a key in Settings.</p>;
  return (
    <div className={MENU_LIST}>
      {usable.map((provider) => (
        <fieldset key={provider.id} className="border-0 m-[0_0_6px] p-0 flex flex-col gap-[2px]">
          <legend className={cn(LABEL, "p-[4px_4px_2px]")}>{provider.name}</legend>
          {provider.models.map((m) => (
            <button
              key={m.id}
              type="button"
              className={MENU_ITEM}
              aria-pressed={m.id === model}
              onClick={() => {
                onModel(m.id);
                close();
              }}
            >
              {m.name}
              {m.contextWindow ? (
                <span className="ml-auto font-mono text-[12px] text-dim-foreground">
                  {Math.round(m.contextWindow / 1000)}k
                </span>
              ) : null}
            </button>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

export function Composer({
  busy,
  canStop,
  model,
  mode,
  effort = "default",
  autoFocusKey,
  initialText = "",
  onSend,
  onStop,
  onModel,
  onMode,
  onEffort,
  modes = BASE_MODES,
  loadModels,
  loadMentions,
  loadCommands,
  acceptsImages = false,
}: {
  busy: boolean;
  canStop: boolean;
  model: string | null;
  mode: ChatMode;
  effort?: ChatEffort;
  /** The modes the menu offers; defaults to the modes every backend has. */
  modes?: readonly ChatMode[];
  /** Changing it moves the focus to the textarea, e.g. when another session opens. */
  autoFocusKey: string;
  /** Text the composer starts with, e.g. a task typed on the project home. */
  initialText?: string;
  onSend: (text: string, images: ImageUpload[]) => Promise<boolean>;
  onStop: () => void;
  onModel: (model: string) => void;
  onMode: (mode: ChatMode) => void;
  /** Reasoning effort of the chat; without it the composer shows no effort control. */
  onEffort?: (effort: ChatEffort) => void;
  loadModels: () => Promise<ModelProvider[]>;
  /** `@` completions; without it the composer offers none. */
  loadMentions?: (query: string) => Promise<MentionSuggestion[]>;
  /** Custom slash commands offered when a message starts with `/`; without it the composer offers none. */
  loadCommands?: () => Promise<CommandEntry[]>;
  /** Paste and drop of images; only when the backend lists the `images` capability. */
  acceptsImages?: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(initialText.length);
  const [mentions, setMentions] = useState<MentionSuggestion[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const token = loadMentions ? mentionAtCaret(text, caret) : null;
  const query = token?.query ?? null;
  useEffect(() => {
    if (query === null || !loadMentions) {
      setMentions([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      loadMentions(query).then(
        (list) => {
          if (!live) return;
          setMentions(list);
          setMentionIdx(0);
        },
        () => live && setMentions([]),
      );
    }, 80);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, loadMentions]);
  const slash = loadCommands ? slashAtCaret(text, caret) : null;
  const [commands, setCommands] = useState<CommandEntry[] | null>(null);
  const typingSlash = slash !== null;
  // Read once a message starts with `/`, and again for the next one, so new files show up.
  useEffect(() => {
    if (!typingSlash || !loadCommands) return;
    let live = true;
    loadCommands().then(
      (list) => live && setCommands(list),
      () => live && setCommands([]),
    );
    return () => {
      live = false;
    };
  }, [typingSlash, loadCommands]);
  const commandMatches = slash && commands ? matchCommands(commands, slash.query) : [];
  const showCommands = commandMatches.length > 0 && dismissed !== text;
  const [commandIdx, setCommandIdx] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restart the selection as the name changes
  useEffect(() => setCommandIdx(0), [slash?.query]);
  const acceptCommand = (pick: CommandEntry | undefined): void => {
    if (!pick) return;
    const insert = `${pick.name} `;
    const next = insert + text.slice(caret).replace(/^\S*\s?/, "");
    const at = insert.length;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  const showMentions = !showCommands && token !== null && mentions.length > 0 && dismissed !== text;
  const acceptMention = (pick: MentionSuggestion | undefined): void => {
    if (!pick || !token) return;
    const target = /\s/.test(pick.insert) ? `"${pick.insert}"` : pick.insert;
    const insert = `@${target}${pick.kind === "directory" ? "" : " "}`;
    const next = text.slice(0, token.start) + insert + text.slice(caret);
    const at = token.start + insert.length;
    setText(next);
    setCaret(at);
    setMentions([]);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [reading, setReading] = useState(0);
  const [imageError, setImageError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const addImages = (files: File[]): boolean => {
    const { take, dropped } = pickImages(files, attachments.length + reading);
    if (take.length === 0 && dropped === 0) return false;
    setImageError(dropped > 0 ? `A message can carry at most ${MAX_IMAGES} images.` : null);
    setReading((n) => n + take.length);
    for (const file of take)
      readAttachment(file)
        .then((att) => setAttachments((list) => [...list, att].slice(0, MAX_IMAGES)))
        .catch((e: unknown) => setImageError(e instanceof Error ? e.message : String(e)))
        .finally(() => setReading((n) => n - 1));
    return true;
  };
  const area = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus when the session changes
  useEffect(() => {
    area.current?.focus();
  }, [autoFocusKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize whenever the text changes
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [text]);
  const canSend = (text.trim().length > 0 || attachments.length > 0) && !sending && reading === 0;
  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!canSend) return;
    const held = attachments;
    setSending(true);
    setText("");
    setAttachments([]);
    setImageError(null);
    const ok = await onSend(
      value,
      held.map(({ mediaType, data }) => ({ mediaType, data })),
    );
    setSending(false);
    if (!ok) {
      setText(value);
      setAttachments(held);
    }
  };
  return (
    <form
      className={cn(
        "relative w-full max-w-[820px] border-2 border-border rounded-base bg-background shadow-shadow px-[14px] py-3 flex flex-col gap-2 focus-within:outline-[3px] focus-within:outline-ring focus-within:outline-offset-2",
        text.trimStart().startsWith("!") && "border-fill-warn",
        dragging && "outline-dashed outline-[3px] outline-ring outline-offset-2",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      {...(acceptsImages
        ? {
            onDragOver: (event: DragEvent) => {
              if (!event.dataTransfer.types.includes("Files")) return;
              event.preventDefault();
              setDragging(true);
            },
            onDragLeave: (event: DragEvent) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                setDragging(false);
            },
            onDrop: (event: DragEvent) => {
              setDragging(false);
              if (addImages([...event.dataTransfer.files])) event.preventDefault();
            },
          }
        : {})}
    >
      {showCommands && (
        <div
          id="chat-commands"
          className="absolute left-0 right-0 bottom-[calc(100%+6px)] z-20 max-h-[280px] overflow-y-auto flex flex-col gap-[2px] p-[6px] border-2 border-border rounded-base bg-background shadow-shadow"
          role="listbox"
          aria-label="Custom commands"
        >
          {commandMatches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === commandIdx}
              className={`${MENU_ITEM} aria-selected:border-border aria-selected:bg-hover aria-selected:text-foreground`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptCommand(c)}
              title={c.path}
            >
              <span className="font-mono text-[13px]">
                {c.name}
                {c.argumentHint && <span className="text-dim-foreground"> {c.argumentHint}</span>}
              </span>
              <span className="ml-auto text-[12px] text-dim-foreground truncate">
                {c.description}
                {c.scope === "global" ? " · global" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
      {showMentions && (
        <div
          id="chat-mentions"
          className="absolute left-0 right-0 bottom-[calc(100%+6px)] z-20 max-h-[280px] overflow-y-auto flex flex-col gap-[2px] p-[6px] border-2 border-border rounded-base bg-background shadow-shadow"
          role="listbox"
          aria-label="Mentions"
        >
          {mentions.map((m, i) => (
            <button
              key={`${m.kind}:${m.insert}`}
              type="button"
              role="option"
              aria-selected={i === mentionIdx}
              // Not `cn`: tailwind-merge would drop MENU_ITEM's `leading-[inherit]` for its text size.
              className={`${MENU_ITEM} aria-selected:border-border aria-selected:bg-hover aria-selected:text-foreground`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => acceptMention(m)}
            >
              <span
                className={cn(
                  "w-[14px] text-center text-muted-foreground",
                  m.kind === "symbol" && "text-[var(--accent)]",
                )}
                aria-hidden="true"
              >
                {MENTION_ICONS[m.kind]}
              </span>
              <span className="font-mono text-[13px]">{m.label}</span>
              {m.kind === "symbol" && (
                <span className="ml-auto text-[12px] text-dim-foreground truncate">{m.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
      {(attachments.length > 0 || reading > 0) && (
        <ul className="list-none m-0 p-0 flex flex-wrap gap-2" aria-label="Attached images">
          {attachments.map((att) => (
            <li
              key={att.id}
              className="relative w-16 h-16 flex items-center justify-center overflow-hidden border-2 border-border rounded-base bg-secondary-background text-[11px]"
            >
              <img src={dataUrl(att)} alt={att.name} className="w-full h-full object-cover" />
              <button
                type="button"
                className="absolute top-[2px] right-[2px] w-5 h-5 p-0 leading-none border-2 border-border rounded-base bg-background text-foreground cursor-pointer"
                aria-label={`Remove ${att.name}`}
                onClick={() => setAttachments((list) => list.filter((a) => a.id !== att.id))}
              >
                ×
              </button>
            </li>
          ))}
          {reading > 0 && (
            <li
              className="relative w-16 h-16 flex items-center justify-center overflow-hidden border-2 border-border rounded-base bg-secondary-background text-[11px] text-dim-foreground"
              aria-live="polite"
            >
              Reading…
            </li>
          )}
        </ul>
      )}
      {imageError && (
        <p className="m-0 text-[13px] text-[var(--err)]" role="alert">
          {imageError}
        </p>
      )}
      <label htmlFor="chat-prompt" className="sr-only">
        Message BAKED
      </label>
      <textarea
        id="chat-prompt"
        ref={area}
        rows={2}
        className="resize-none rounded-base px-[10px] py-2 border-none outline-none bg-transparent text-foreground font-[inherit] text-[15px] leading-[1.5] max-h-[240px] placeholder:text-dim-foreground"
        value={text}
        placeholder={
          busy
            ? "Add to the running turn…"
            : `Ask BAKED to do something${loadCommands ? " · / runs a custom command" : ""} · @ adds a file or symbol · ! runs a command${
                acceptsImages ? " · paste or drop images" : ""
              }`
        }
        aria-autocomplete="list"
        aria-controls={showCommands ? "chat-commands" : showMentions ? "chat-mentions" : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        {...(acceptsImages
          ? {
              onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
                if (addImages([...event.clipboardData.files])) event.preventDefault();
              },
            }
          : {})}
        onKeyDown={(event) => {
          if (showCommands) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setCommandIdx((i) => (i + step + commandMatches.length) % commandMatches.length);
              return;
            }
            const picked = commandMatches[commandIdx];
            // Enter on a name typed in full sends it; Tab or Enter on a partial name completes it.
            if (
              event.key === "Tab" ||
              (event.key === "Enter" && !event.shiftKey && picked && picked.name !== text.trim())
            ) {
              event.preventDefault();
              acceptCommand(picked);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(text);
              return;
            }
          }
          if (showMentions) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setMentionIdx((i) => (i + step + mentions.length) % mentions.length);
              return;
            }
            if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
              event.preventDefault();
              acceptMention(mentions[mentionIdx]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setDismissed(text);
              return;
            }
          }
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-[6px]">
        <Popover
          label="Model"
          up
          buttonLabel={`Model: ${shortModel(model)}`}
          button={<span className="font-mono">{shortModel(model)}</span>}
        >
          {(close) => (
            <ModelMenu model={model} loadModels={loadModels} onModel={onModel} close={close} />
          )}
        </Popover>
        {onEffort && (
          <Popover
            label="Reasoning effort"
            up
            buttonLabel={`Reasoning effort: ${EFFORT_LABELS[effort]}`}
            button={EFFORT_LABELS[effort]}
          >
            {(close) => (
              <EffortMenu
                model={model}
                effort={effort}
                loadModels={loadModels}
                onEffort={onEffort}
                close={close}
              />
            )}
          </Popover>
        )}
        <Popover
          label="Approval mode"
          up
          buttonLabel={`Approval mode: ${MODE_LABELS[mode].name}`}
          button={MODE_LABELS[mode].name}
        >
          {(close) => (
            <div className={MENU_LIST}>
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={MENU_ITEM_STACKED}
                  aria-pressed={m === mode}
                  onClick={() => {
                    onMode(m);
                    close();
                  }}
                >
                  <span>{MODE_LABELS[m].name}</span>
                  <span className="text-dim-foreground">{MODE_LABELS[m].detail}</span>
                </button>
              ))}
              <p className={MENU_NOTE}>Applies from the next turn.</p>
            </div>
          )}
        </Popover>
        <span className="ml-auto text-[12px] text-dim-foreground [@media(max-width:720px)]:hidden">
          {busy ? "Esc stops · Enter adds to the turn" : "Enter sends · Shift+Enter new line"}
        </span>
        {canStop && (
          <button
            type="button"
            className={`${ROUND_BUTTON} bg-raised text-foreground hover:bg-fill-err hover:text-main-foreground`}
            aria-label="Stop"
            onClick={onStop}
          >
            <Icon name="stop" size={14} filled />
          </button>
        )}
        <button
          type="submit"
          className={`${ROUND_BUTTON} bg-main text-main-foreground disabled:opacity-[0.45] disabled:cursor-default disabled:translate-none disabled:shadow-sm-hard`}
          aria-label={busy ? "Add to the running turn" : "Send"}
          disabled={!canSend}
        >
          <Icon name="send" size={18} />
        </button>
      </div>
    </form>
  );
}

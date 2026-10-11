import { useEffect, useRef, useState } from "react";
import type { ChatMode, ModelProvider } from "../../client/chat.js";
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
  auto: { name: "Auto-approve", detail: "Runs everything without asking." },
};

const MAX_TEXTAREA_PX = 240;

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
          <legend className="label p-[4px_4px_2px]">{provider.name}</legend>
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
                <span className="mono muted ml-auto text-[12px]">
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
  autoFocusKey,
  initialText = "",
  onSend,
  onStop,
  onModel,
  onMode,
  loadModels,
}: {
  busy: boolean;
  canStop: boolean;
  model: string | null;
  mode: ChatMode;
  /** Changing it moves the focus to the textarea, e.g. when another session opens. */
  autoFocusKey: string;
  /** Text the composer starts with, e.g. a task typed on the project home. */
  initialText?: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  onModel: (model: string) => void;
  onMode: (mode: ChatMode) => void;
  loadModels: () => Promise<ModelProvider[]>;
}) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
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
  const submit = async (): Promise<void> => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setText("");
    const ok = await onSend(value);
    setSending(false);
    if (!ok) setText(value);
  };
  return (
    <form
      className="w-full max-w-[820px] border-2 border-border rounded-base bg-background shadow-shadow px-[14px] py-3 flex flex-col gap-2 focus-within:outline-[3px] focus-within:outline-ring focus-within:outline-offset-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="chat-prompt" className="sr-only">
        Message BAKED
      </label>
      <textarea
        id="chat-prompt"
        ref={area}
        rows={2}
        className="resize-none rounded-base px-[10px] py-2 border-none outline-none bg-transparent text-foreground font-[inherit] text-[15px] leading-[1.5] max-h-[240px] placeholder:text-dim-foreground"
        value={text}
        placeholder={busy ? "Add to the running turn…" : "Ask BAKED to do something"}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
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
          button={<span className="mono">{shortModel(model)}</span>}
        >
          {(close) => (
            <ModelMenu model={model} loadModels={loadModels} onModel={onModel} close={close} />
          )}
        </Popover>
        <Popover
          label="Approval mode"
          up
          buttonLabel={`Approval mode: ${MODE_LABELS[mode].name}`}
          button={MODE_LABELS[mode].name}
        >
          {(close) => (
            <div className={MENU_LIST}>
              {(Object.keys(MODE_LABELS) as ChatMode[]).map((m) => (
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
                  <span className="muted">{MODE_LABELS[m].detail}</span>
                </button>
              ))}
              <p className={MENU_NOTE}>Applies from the next turn.</p>
            </div>
          )}
        </Popover>
        <span className="muted ml-auto text-[12px] [@media(max-width:720px)]:hidden">
          {busy ? "Esc stops · Enter adds to the turn" : "Enter sends · Shift+Enter new line"}
        </span>
        {canStop && (
          <button
            type="button"
            className={`${ROUND_BUTTON} bg-raised text-foreground hover:bg-fill-err hover:text-main-foreground`}
            aria-label="Stop"
            onClick={onStop}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" fill="currentColor" />
            </svg>
          </button>
        )}
        <button
          type="submit"
          className={`${ROUND_BUTTON} bg-main text-main-foreground disabled:opacity-[0.45] disabled:cursor-default disabled:translate-none disabled:shadow-sm-hard`}
          aria-label={busy ? "Add to the running turn" : "Send"}
          disabled={!text.trim() || sending}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden="true"
          >
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
          </svg>
        </button>
      </div>
    </form>
  );
}

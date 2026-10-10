import { decodePasteBytes, type PasteEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../../../core/theme/index.js";
import { selectTopDialog, useDialogStore } from "../../../stores/dialog.js";
import { PremiumPopup } from "../PremiumPopup.js";
import { Search } from "../Search.js";

interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  initial?: string;
  icon?: string;
  /** Returns an error to show under the input, or null to accept the value. */
  validate?: (value: string) => string | null;
}

interface Props extends PromptOptions {
  width: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/** One-line text input: Enter submits once `validate` accepts the value, Esc cancels. */
export function PromptDialog({
  width,
  title,
  message,
  placeholder,
  initial,
  icon,
  validate,
  onSubmit,
  onCancel,
}: Props) {
  const t = useTheme();
  const renderer = useRenderer();
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const topId = useDialogStore((s) => selectTopDialog(s)?.id ?? null);
  const myIdRef = useRef<string | null>(null);
  if (myIdRef.current === null && topId) myIdRef.current = topId;
  const isTop = myIdRef.current === topId;

  useEffect(() => {
    const handler = (event: PasteEvent) => {
      const text = decodePasteBytes(event.bytes).replace(/[\n\r]/g, "");
      if (text) setValue((v) => v + text);
    };
    renderer.keyInput.on("paste", handler);
    return () => {
      renderer.keyInput.off("paste", handler);
    };
  }, [renderer]);

  useKeyboard((evt) => {
    if (!isTop) return;
    if (evt.name === "escape") {
      onCancel();
    } else if (evt.name === "return") {
      const problem = validate?.(value) ?? null;
      if (problem) setError(problem);
      else onSubmit(value);
    } else if (evt.name === "backspace" || evt.name === "delete") {
      setValue((v) => v.slice(0, -1));
      setError(null);
    } else if (evt.ctrl && evt.name === "u") {
      setValue("");
      setError(null);
    } else {
      const ch = evt.sequence;
      if (typeof ch === "string" && ch.length === 1 && ch >= " " && !evt.ctrl && !evt.meta) {
        setValue((v) => v + ch);
        setError(null);
      }
    }
    evt.preventDefault();
  });

  return (
    <PremiumPopup
      visible
      width={Math.max(50, width)}
      height={(message ? 13 : 11) + (error ? 3 : 0)}
      title={title}
      titleIcon={icon ?? "pencil"}
      footerHints={[
        { key: "Enter", label: "confirm" },
        { key: "Esc", label: "cancel" },
        { key: "^U", label: "clear" },
      ]}
    >
      <box flexDirection="column" paddingX={2} paddingY={1} gap={1}>
        {message ? <text fg={t.textSecondary}>{message}</text> : null}
        <Search value={value} placeholder={placeholder} focused icon={icon ?? "pencil"} />
        {error ? <text fg={t.error}>{error}</text> : null}
      </box>
    </PremiumPopup>
  );
}

/** Opens a text prompt and resolves with the accepted value, or null on cancel. */
export function promptText(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: string | null) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const id = useDialogStore.getState().push({
      size: "medium",
      payload: {
        kind: "custom",
        render: () =>
          (
            <PromptDialog
              {...opts}
              width={70}
              onSubmit={(value) => {
                settle(value);
                useDialogStore.getState().popById(id);
              }}
              onCancel={() => {
                settle(null);
                useDialogStore.getState().popById(id);
              }}
            />
          ) as unknown,
      },
      onClose: () => settle(null),
    });
  });
}

import { MENU_ITEM_STACKED, MENU_LIST, MENU_NOTE, Popover } from "./Popover.js";

/** The context windows a chat's model offers and the one its next turn runs with. */
export interface ContextSizeControl {
  /** Windows in tokens, smallest first; the control hides with fewer than two. */
  sizes: readonly number[];
  /** The window the next turn runs with; null when the server has not said. */
  tokens: number | null;
  onPick: (tokens: number) => void;
}

/** `200k`, `1M`, `1.05M`: a window as the picker shows it. */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/**
 * The context size chip of the composer: one row per window the model offers. A larger window
 * keeps more of the conversation before compaction and costs more per turn.
 */
export function ContextSizePicker({ control }: { control: ContextSizeControl }) {
  const { sizes, tokens, onPick } = control;
  if (sizes.length < 2) return null;
  const current = tokens ?? sizes[0] ?? 0;
  const largest = sizes.at(-1);
  return (
    <Popover
      label="Context size"
      up
      buttonLabel={`Context size: ${formatWindow(current)}`}
      button={`${formatWindow(current)} context`}
    >
      {(close) => (
        <div className={MENU_LIST}>
          {sizes.map((size) => (
            <button
              key={size}
              type="button"
              className={MENU_ITEM_STACKED}
              aria-pressed={size === current}
              onClick={() => {
                onPick(size);
                close();
              }}
            >
              <span>{formatWindow(size)}</span>
              <span className="text-dim-foreground">
                {size === largest
                  ? "The largest window: compacts later, costs more per turn."
                  : "A smaller window: cheaper per turn."}
              </span>
            </button>
          ))}
          <p className={MENU_NOTE}>Applies from the next turn.</p>
        </div>
      )}
    </Popover>
  );
}

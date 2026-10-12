import { type WatchConfig, watchOptions } from "../core/watch/config.js";
import { WatchController, type WatchEvent, type WatchTurn } from "../core/watch/controller.js";

/**
 * Prompts for `baked --headless --watch`: each `baked!` or `baked?` comment saved in the project
 * becomes the next chat turn. Turns found while one runs wait in order. `next()` resolves null once
 * the watch is closed (Ctrl+C), which ends the chat loop.
 */
export function watchPromptSource(
  cwd: string,
  config: WatchConfig | undefined,
  hooks: {
    onEvent(event: WatchEvent): void;
    /** Called as a queued turn is handed to the chat, with where it came from. */
    onTurn?(turn: WatchTurn): void;
    poll?: boolean;
  },
): { next(): Promise<string | null>; close(): void } {
  const queue: WatchTurn[] = [];
  let waiting: ((turn: WatchTurn | null) => void) | null = null;
  let closed = false;
  const options = watchOptions(config);
  const controller = new WatchController(
    cwd,
    { ...options, poll: hooks.poll === true || options.poll },
    {
      send: (turn) => {
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(turn);
        } else queue.push(turn);
      },
      onEvent: hooks.onEvent,
    },
  );
  controller.start();
  const close = (): void => {
    if (closed) return;
    closed = true;
    controller.stop("closed");
    waiting?.(null);
    waiting = null;
  };
  return {
    async next() {
      const turn =
        queue.shift() ??
        (closed
          ? null
          : await new Promise<WatchTurn | null>((resolve) => {
              waiting = resolve;
            }));
      if (!turn) return null;
      hooks.onTurn?.(turn);
      return turn.prompt;
    },
    close,
  };
}

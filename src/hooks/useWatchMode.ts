import { useEffect, useRef } from "react";
import { watchOptions } from "../core/watch/config.js";
import { WatchController, watchTurnDisplay } from "../core/watch/controller.js";
import { useWatchStore } from "../stores/watch.js";
import type { AppConfig } from "../types/index.js";
import type { ChatInstance } from "./useChat.js";

/**
 * Runs watch mode for a tab while the watch store names it. Each turn goes through the tab's
 * normal chat path: sent at once when the tab is idle, queued behind the running turn otherwise.
 */
export function useWatchMode(
  tabId: string,
  cwd: string,
  config: AppConfig["watch"],
  chat: ChatInstance,
): void {
  const active = useWatchStore((s) => s.tabId === tabId);
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const configRef = useRef(config);
  configRef.current = config;
  // A turn this hook started whose submit has not settled; `isLoading` lags a render behind it.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!active) return;
    const store = useWatchStore.getState();
    const system = (content: string): void =>
      chatRef.current.setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "system", content, timestamp: Date.now() },
      ]);
    const controller = new WatchController(cwd, watchOptions(configRef.current), {
      send: (turn) => {
        const options = { display: watchTurnDisplay(turn), verbatim: true };
        useWatchStore.getState().noteTurn(turn.label);
        const current = chatRef.current;
        if (current.isLoading || current.isCompacting || inFlight.current)
          current.setMessageQueue((prev) => [
            ...prev,
            { content: turn.prompt, queuedAt: Date.now(), options },
          ]);
        else {
          inFlight.current = true;
          void current.handleSubmit(turn.prompt, undefined, options).finally(() => {
            inFlight.current = false;
          });
        }
      },
      onEvent: (event) => {
        if (event.type === "started") useWatchStore.getState().setRunning(event.method);
        else if (event.type === "error") {
          useWatchStore.getState().setError(event.message);
          system(`Watch mode: ${event.message}`);
        }
      },
    });
    store.setError(null);
    controller.start();
    return () => {
      controller.stop("off");
      if (useWatchStore.getState().tabId === null) useWatchStore.getState().setRunning(null);
    };
  }, [active, cwd]);

  // A closed tab stops watching.
  useEffect(
    () => () => {
      if (useWatchStore.getState().tabId === tabId) useWatchStore.getState().disable();
    },
    [tabId],
  );
}

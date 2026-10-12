import { useEffect, useMemo, useState } from "react";
import type { VoiceStatus } from "../../../shared/api.js";
import { bridge } from "../../client/bridge.js";
import { useDesktop } from "../../store.js";
import type { VoiceInput } from "./Composer.js";

let status: Promise<VoiceStatus> | null = null;

/** Voice input for the composer: undefined when it is turned off in Settings > This app. */
export function useVoiceInput(): VoiceInput | undefined {
  const { settings } = useDesktop();
  const enabled = settings?.voiceInput === true;
  const language = settings?.voiceLanguage ?? "auto";
  const [unavailable, setUnavailable] = useState<string | null>("Checking the speech engine…");
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // The engine and model ship with the app, so one check per window is enough.
    status ??= bridge.voiceStatus();
    status.then(
      (s) =>
        live && setUnavailable(s.available ? null : (s.reason ?? "Voice input is unavailable.")),
      (e: unknown) => live && setUnavailable(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return useMemo(
    () =>
      enabled
        ? {
            unavailable,
            transcribe: async (samples: Float32Array) =>
              (await bridge.transcribe(samples, language === "auto" ? undefined : language)).text,
          }
        : undefined,
    [enabled, unavailable, language],
  );
}

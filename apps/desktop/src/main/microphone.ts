import type { MicrophoneAccess } from "../shared/api.js";

/** Electron's `systemPreferences` calls this module needs; a fake in tests. */
export interface MediaPreferences {
  getMediaAccessStatus(mediaType: "microphone"): string;
  /** macOS only: shows the system prompt the first time. */
  askForMediaAccess?(mediaType: "microphone"): Promise<boolean>;
}

/** The system page where the user allows the microphone, where one can be opened. */
export function microphoneSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform === "darwin")
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
  if (platform === "win32") return "ms-settings:privacy-microphone";
  return null;
}

/**
 * Whether the app may use the microphone, asking macOS the first time. Windows reports the
 * privacy switch for desktop apps; Linux has no system-wide permission, so it is always granted
 * there and a missing device shows when recording starts.
 */
export async function microphoneAccess(
  platform: NodeJS.Platform,
  prefs: MediaPreferences,
): Promise<MicrophoneAccess> {
  if (platform !== "darwin" && platform !== "win32")
    return { granted: true, canOpenSettings: false };
  let status = prefs.getMediaAccessStatus("microphone");
  if (platform === "darwin" && status === "not-determined" && prefs.askForMediaAccess) {
    status = (await prefs.askForMediaAccess("microphone")) ? "granted" : "denied";
  }
  // "unknown" is what Electron reports when the system offers no answer; let Chromium try.
  return { granted: status === "granted" || status === "unknown", canOpenSettings: true };
}

/**
 * Chromium's permission requests from the window. Only the app's own page may use the
 * microphone, and only for audio; the camera and screen are never granted. Other permissions keep
 * Electron's default of granting them.
 */
export function allowPermission(
  permission: string,
  details: { requestingUrl?: string; mediaTypes?: readonly string[] },
  isAppUrl: (url: string) => boolean,
): boolean {
  if (permission !== "media") return true;
  const types = details.mediaTypes ?? [];
  return (
    isAppUrl(details.requestingUrl ?? "") &&
    types.length > 0 &&
    types.every((type) => type === "audio")
  );
}

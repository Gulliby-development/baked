import { describe, expect, test } from "bun:test";
import {
  allowPermission,
  type MediaPreferences,
  microphoneAccess,
  microphoneSettingsUrl,
} from "../src/main/microphone.ts";

const isApp = (url: string): boolean => url.startsWith("file://");

function prefs(status: string, answer?: boolean): MediaPreferences & { asked: number } {
  const p = {
    asked: 0,
    getMediaAccessStatus: () => status,
    askForMediaAccess: async () => {
      p.asked++;
      return answer ?? false;
    },
  };
  return p;
}

describe("microphone access", () => {
  test("macOS asks the first time and remembers the answer", async () => {
    const first = prefs("not-determined", true);
    expect(await microphoneAccess("darwin", first)).toEqual({ granted: true, canOpenSettings: true });
    expect(first.asked).toBe(1);
    const refused = prefs("not-determined", false);
    expect((await microphoneAccess("darwin", refused)).granted).toBe(false);
    const denied = prefs("denied");
    expect(await microphoneAccess("darwin", denied)).toEqual({
      granted: false,
      canOpenSettings: true,
    });
    expect(denied.asked).toBe(0);
  });

  test("Windows reads the privacy switch without prompting", async () => {
    const off = prefs("denied");
    expect(await microphoneAccess("win32", off)).toEqual({ granted: false, canOpenSettings: true });
    expect(off.asked).toBe(0);
    expect((await microphoneAccess("win32", prefs("granted"))).granted).toBe(true);
  });

  test("Linux has no system permission", async () => {
    expect(await microphoneAccess("linux", prefs("denied"))).toEqual({
      granted: true,
      canOpenSettings: false,
    });
  });

  test("the privacy page exists on macOS and Windows", () => {
    expect(microphoneSettingsUrl("darwin")).toContain("Privacy_Microphone");
    expect(microphoneSettingsUrl("win32")).toBe("ms-settings:privacy-microphone");
    expect(microphoneSettingsUrl("linux")).toBeNull();
  });
});

describe("permission requests", () => {
  const page = "file:///app/out/renderer/index.html";

  test("the app page may record audio only", () => {
    expect(allowPermission("media", { requestingUrl: page, mediaTypes: ["audio"] }, isApp)).toBe(
      true,
    );
    expect(allowPermission("media", { requestingUrl: page, mediaTypes: ["video"] }, isApp)).toBe(
      false,
    );
    expect(
      allowPermission("media", { requestingUrl: page, mediaTypes: ["audio", "video"] }, isApp),
    ).toBe(false);
    expect(allowPermission("media", { requestingUrl: page, mediaTypes: [] }, isApp)).toBe(false);
  });

  test("other pages get no microphone; other permissions keep Electron's default", () => {
    expect(
      allowPermission(
        "media",
        { requestingUrl: "https://example.com/", mediaTypes: ["audio"] },
        isApp,
      ),
    ).toBe(false);
    expect(allowPermission("clipboard-sanitized-write", { requestingUrl: page }, isApp)).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, sanitizeSettings } from "../src/main/settings.ts";
import { DEFAULT_SETTINGS } from "../src/shared/api.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app settings", () => {
  test("invalid values fall back to defaults", () => {
    expect(sanitizeSettings({ theme: "neon", notifyAdvisory: "yes", openProjects: ["/a", 3] })).toEqual({
      ...DEFAULT_SETTINGS,
      openProjects: ["/a"],
    });
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  test("voice input keeps a supported language and drops an unknown one", () => {
    expect(sanitizeSettings({ voiceInput: false, voiceLanguage: "de" })).toMatchObject({
      voiceInput: false,
      voiceLanguage: "de",
    });
    expect(sanitizeSettings({ voiceLanguage: "ru" }).voiceLanguage).toBe("auto");
  });

  test("a damaged file means defaults and updates are written back", () => {
    const dir = mkdtempSync(join(tmpdir(), "baked-desktop-"));
    dirs.push(dir);
    const file = join(dir, "settings.json");
    writeFileSync(file, "{not json");
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    store.update({ theme: "light", bakedPath: "  " });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.theme).toBe("light");
    expect(saved.bakedPath).toBeNull();
    expect(new SettingsStore(file).get().theme).toBe("light");
  });
});

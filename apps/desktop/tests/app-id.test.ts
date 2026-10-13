import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_USER_MODEL_ID, appUserModelId } from "../src/main/app-id.ts";

describe("app user model id", () => {
  test("is the appId the installer registers", () => {
    const builder = readFileSync(join(import.meta.dir, "..", "electron-builder.yml"), "utf8");
    expect(builder.split(/\r?\n/)).toContain(`appId: ${APP_USER_MODEL_ID}`);
  });

  test("a packaged run uses it and an unpackaged run does not", () => {
    expect(appUserModelId(true)).toBe(APP_USER_MODEL_ID);
    expect(appUserModelId(false)).not.toBe(APP_USER_MODEL_ID);
  });
});

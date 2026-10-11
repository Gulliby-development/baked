import { describe, expect, test } from "bun:test";
import {
  applyNotificationsChange,
  describeNotifications,
  parseNotificationsArgs,
  parseOnOff,
} from "../src/core/notification-settings.js";

describe("notification settings", () => {
  test("parses on/off words", () => {
    expect(parseOnOff("ON")).toBe(true);
    expect(parseOnOff("off")).toBe(false);
    expect(parseOnOff("maybe")).toBeNull();
  });

  test("parses command arguments", () => {
    expect(parseNotificationsArgs([])).toEqual({ show: true });
    expect(parseNotificationsArgs(["system", "off"])).toEqual({ change: { system: false } });
    expect(parseNotificationsArgs(["webhook", "https://h.test/x"])).toEqual({
      change: { webhookUrl: "https://h.test/x" },
    });
    expect(parseNotificationsArgs(["webhook", "off"])).toEqual({ change: { webhookUrl: null } });
    expect(parseNotificationsArgs(["blocking-only", "on"])).toEqual({
      change: { blockingOnly: true },
    });
    expect("error" in parseNotificationsArgs(["system"])).toBe(true);
    expect("error" in parseNotificationsArgs(["volume", "on"])).toBe(true);
  });

  test("keeps headers when the URL changes and drops them with the webhook", () => {
    const current = {
      system: true,
      webhook: { url: "https://a.test", headers: { authorization: "x" }, blockingOnly: true },
    };
    expect(applyNotificationsChange(current, { webhookUrl: " https://b.test/hook " })).toEqual({
      ok: true,
      value: {
        system: true,
        webhook: { url: "https://b.test/hook", headers: { authorization: "x" }, blockingOnly: true },
      },
    });
    expect(applyNotificationsChange(current, { webhookUrl: null })).toEqual({
      ok: true,
      value: { system: true },
    });
  });

  test("rejects a non-http URL and blocking-only without a webhook", () => {
    expect(applyNotificationsChange(undefined, { webhookUrl: "ftp://x" }).ok).toBe(false);
    expect(applyNotificationsChange({}, { blockingOnly: true }).ok).toBe(false);
    expect(applyNotificationsChange(undefined, { system: false })).toEqual({
      ok: true,
      value: { system: false },
    });
  });

  test("describes the settings", () => {
    expect(describeNotifications(undefined)).toEqual([
      "System notifications: on",
      "Webhook: none (nothing is sent)",
    ]);
    expect(
      describeNotifications({
        system: false,
        webhook: { url: "https://a.test", headers: { a: "1" }, blockingOnly: true },
      }),
    ).toEqual([
      "System notifications: off",
      "Webhook: https://a.test (blocking requests only), 1 header(s) from the config file",
    ]);
  });
});
